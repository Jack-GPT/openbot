import { randomUUID } from "node:crypto";
import type { MossLiveControl, MossLiveEvent, MossLiveVoice } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger, redactText } from "@openbot/logging";
import { Effect } from "effect";
import WebSocket, { type RawData } from "ws";
import { rawDataBytes, rawDataText } from "./ws-raw-data";

const URL = "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0";
const OPEN_TIMEOUT_MS = 15_000;
const KEEPALIVE_MS = 15_000;
const MAX_RETRY_DELAY_MS = 15_000;
const MAX_BUFFERED_AUDIO_BYTES = 64_000;
const MAX_PENDING_PLAYBACK_RECEIPTS = 512;
const MAX_DELEGATION_RESULT_LENGTH = 2_000;
const MAX_SEEN_DELEGATIONS = 2_000;
const logger = createOpenBotLogger("moss-live");
const REQUEST_ERRORS = new Set([
  "content_too_long",
  "delegation_terminal",
  "event_id_conflict",
  "instructions_full",
  "invalid_content",
  "invalid_event_id",
  "invalid_public_request",
  "invalid_session_option",
  "invalid_status",
  "presentation_capacity",
  "session_option_mismatch",
  "tool_task_conflict",
  "unknown_call_id",
  "unknown_tool_task",
  "unsupported_control",
]);
// The MOSS Live API reference lists these IDs for change_voice.
const VOICE_IDS: Record<MossLiveVoice, string> = {
  nuannuan: "6c3152b1-1d4f-4e49-ade3-09f447712fec",
  mumu: "6cc93520-3207-4f7a-bca9-2d560b9c306b",
};
type AudioChunk = Pick<Extract<MossLiveEvent, { type: "audio" }>, "runId" | "turnId" | "chunkId">;
type PlaybackReceipt = Extract<MossLiveControl, { runId: string }>;
type Delegation = {
  readonly startedAt: number;
  result?: {
    action: "session.commentary.append";
    delegation_id: string;
    event_id: string;
    content: string;
    status: "completed" | "failed";
  };
};
export type MossStopReason =
  | "stopped"
  | "replaced"
  | "disabled"
  | "key-removed"
  | "window-closed"
  | "renderer-exited"
  | "navigation";

/** One microphone session. The key and provider errors stay in main. */
export class MossLiveSession {
  readonly #emit: (event: MossLiveEvent) => void;
  readonly #voiceId: string | null;
  readonly #open: () => WebSocket;
  readonly #delegations = new Map<string, Delegation>();
  readonly #seenDelegations = new Set<string>();
  readonly #playbackReceipts: PlaybackReceipt[] = [];
  #socket: WebSocket | undefined;
  #chunk: AudioChunk | undefined;
  #settle: ((error: Error | null) => void) | undefined;
  #phase: "waiting" | "attaching" | "setting-voice" | "configuring" | "ready" = "waiting";
  #sessionId: string | null = null;
  #resumeId: string | null = null;
  #resumed = false;
  #connected = false;
  #closed = false;
  #micEnabled: boolean | undefined;
  #connectTimer: ReturnType<typeof setTimeout> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #pingTimestamp: number | undefined;
  #retryDelayMs = 1_000;
  #connectedAt = 0;
  #lastInputAt = 0;
  #lastOutputAt = 0;

  constructor(
    key: string,
    voice: MossLiveVoice | null,
    emit: (event: MossLiveEvent) => void,
    open: typeof openMossSocket = openMossSocket,
  ) {
    this.#emit = emit;
    this.#voiceId = voice === null ? null : VOICE_IDS[voice];
    this.#open = () => open(key);
  }

  readonly ready = Effect.callback<void, Error>((resume) => {
    if (this.#closed) {
      resume(Effect.fail(new Error(sourceText("error.voice.moss.failed"))));
      return;
    }
    this.#settle = (error) => resume(error ? Effect.fail(error) : Effect.void);
    this.#connect();
    return Effect.sync(() => {
      if (!this.#connected) this.close();
    });
  });

  #connect(): void {
    if (this.#closed) return;
    this.#phase = "attaching";
    this.#resumeId = this.#sessionId;
    this.#resumed = false;
    logger.info("Connecting MOSS Live.", { resume: this.#resumeId !== null });
    let socket: WebSocket;
    try {
      socket = this.#open();
    } catch {
      this.#disconnect("open-failed");
      return;
    }
    this.#socket = socket;
    this.#connectTimer = setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN && this.#phase === "attaching") this.#sessionId = null;
      this.#disconnect("setup-timeout");
    }, OPEN_TIMEOUT_MS);
    socket.on("open", () => {
      if (this.#socket === socket) {
        this.#send({ action: "attach_session", session_id: this.#resumeId, delegation: { type: "client" } });
      }
    });
    socket.on("message", (data, binary) => {
      if (this.#socket === socket) this.#receive(data, binary);
    });
    socket.on("unexpected-response", (request, response) => {
      if (this.#socket === socket) {
        const status = response.statusCode;
        this.#disconnect("http-response", status, status === 401 || status === 403);
      }
      request.destroy();
    });
    socket.on("error", (error) => {
      if (this.#socket === socket) this.#disconnect("socket-error", socketErrorCode(error));
    });
    socket.on("close", (code) => {
      if (this.#socket !== socket) return;
      if (this.#phase === "attaching" && code === 1008) this.#sessionId = null;
      this.#disconnect("socket-close", code);
    });
  }

  audio(pcm: Uint8Array): void {
    if (
      this.#phase === "ready" &&
      this.#socket?.readyState === WebSocket.OPEN &&
      this.#micEnabled !== false &&
      this.#socket.bufferedAmount < MAX_BUFFERED_AUDIO_BYTES
    ) {
      this.#lastInputAt = Date.now();
      this.#socket.send(pcm);
    }
  }

  control(input: MossLiveControl): void {
    if (this.#closed) return;
    if (input.action === "mic") {
      this.#micEnabled = input.enabled;
      if (this.#phase === "ready") this.#send({ action: "mic_state", enabled: input.enabled });
      return;
    }
    if (input.action === "answer") {
      const delegation = this.#delegations.get(input.callId);
      if (!delegation || delegation.result) return;
      const text = redactText(input.text).trim();
      const failed = input.failed === true || !text;
      delegation.result = {
        action: "session.commentary.append",
        delegation_id: input.callId,
        event_id: randomUUID(),
        content: text
          ? Array.from(text).slice(0, MAX_DELEGATION_RESULT_LENGTH).join("")
          : "The agent returned no result.",
        status: failed ? "failed" : "completed",
      };
      logger.info("MOSS Live delegation finished locally.", {
        elapsedMs: Date.now() - delegation.startedAt,
        failed,
      });
      if (this.#phase === "ready") this.#send(delegation.result);
      return;
    }
    if (this.#phase === "ready") this.#sendReceipt(input);
    else if (this.#playbackReceipts.length < MAX_PENDING_PLAYBACK_RECEIPTS) this.#playbackReceipts.push(input);
  }

  #sendReceipt(input: PlaybackReceipt): void {
    const ids = { run_id: input.runId, turn_id: input.turnId };
    if (input.action === "played") this.#send({ action: "playback.chunk.completed", ...ids, chunk_id: input.chunkId });
    if (input.action === "completed") this.#send({ action: "playback.completed", ...ids });
    if (input.action === "stopped") this.#send({ action: "playback.stopped", ...ids, played_audio_ms: input.playedMs });
  }

  close(reason: MossStopReason = "stopped"): void {
    if (this.#closed) return;
    logger.info("MOSS Live ended locally.", { reason, ...this.#activity() });
    this.#close(new Error(sourceText("error.voice.moss.failed")));
  }

  #close(error: Error): void {
    this.#closed = true;
    clearTimeout(this.#retryTimer);
    this.#clearSession(false);
    this.#settle?.(error);
    this.#settle = undefined;
    this.#detachSocket()?.terminate();
  }

  #clearSession(notify: boolean): void {
    for (const [callId, delegation] of this.#delegations) {
      if (notify && !delegation.result) this.#emit({ type: "cancel", callId });
    }
    this.#delegations.clear();
    this.#seenDelegations.clear();
    this.#playbackReceipts.length = 0;
  }

  #detachSocket(): WebSocket | undefined {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#chunk = undefined;
    clearTimeout(this.#connectTimer);
    clearInterval(this.#heartbeat);
    this.#pingTimestamp = undefined;
    return socket;
  }

  #send(event: { action: string } & DynamicRecord): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(event));
  }

  #configure(): void {
    this.#phase = "configuring";
    this.#send({
      action: "session.update",
      session: {
        instructions:
          "Speak naturally in the user's language. Answer casual conversation and general questions directly. Delegate a background task only when the user explicitly asks you to involve the selected agent or requests work that needs it, such as reading project files or taking action in the workspace. Put the user's request and relevant details in the objective. Start work without announcing the handoff or naming OpenBot. If the task takes time, briefly say you are checking and keep the conversation open. When the result arrives, share it naturally. Only report success after you receive the result.",
        tools: [],
      },
    });
  }

  #activity() {
    const now = Date.now();
    return {
      phase: this.#phase,
      connectedMs: this.#connectedAt ? now - this.#connectedAt : null,
      lastInputMsAgo: this.#lastInputAt ? now - this.#lastInputAt : null,
      lastOutputMsAgo: this.#lastOutputAt ? now - this.#lastOutputAt : null,
    };
  }

  #disconnect(reason: string, code?: string | number, rejected = false): void {
    if (this.#closed) return;
    const activity = this.#activity();
    const socket = this.#detachSocket();
    if (!this.#connected || rejected) {
      logger.warn("MOSS Live connection ended.", { reason, code, ...activity });
      const error = rejected
        ? sourceText("error.voice.cloud.keyRejected", { provider: "MOSS" })
        : sourceText("error.voice.moss.failed");
      this.#close(new Error(error));
      socket?.terminate();
      if (this.#connected) this.#emit({ type: "ended", error });
      return;
    }

    this.#phase = "waiting";
    const delayMs = this.#retryDelayMs;
    this.#retryDelayMs = Math.min(delayMs * 2, MAX_RETRY_DELAY_MS);
    logger.warn("MOSS Live will reconnect.", { reason, code, retryInMs: delayMs, ...activity });
    if (activity.phase === "ready") this.#emit({ type: "reconnecting" });
    socket?.terminate();
    this.#retryTimer = setTimeout(() => this.#connect(), delayMs);
    this.#retryTimer.unref();
  }

  #onReady(): void {
    clearTimeout(this.#connectTimer);
    this.#phase = "ready";
    this.#connectedAt = Date.now();
    this.#lastInputAt = 0;
    this.#lastOutputAt = 0;
    this.#retryDelayMs = 1_000;
    logger.info("MOSS Live connected.", { reconnected: this.#connected, resumed: this.#resumed });
    if (this.#connected) {
      if (!this.#resumed) this.#clearSession(true);
      if (this.#micEnabled !== undefined) this.control({ action: "mic", enabled: this.#micEnabled });
      for (const receipt of this.#playbackReceipts) this.#sendReceipt(receipt);
      this.#playbackReceipts.length = 0;
      for (const { result } of this.#delegations.values()) if (result) this.#send(result);
      this.#emit({ type: "reconnected", resumed: this.#resumed });
    }
    this.#connected = true;
    this.#settle?.(null);
    this.#settle = undefined;
    this.#heartbeat = setInterval(() => {
      if (this.#pingTimestamp !== undefined) {
        this.#disconnect("keepalive-timeout");
        return;
      }
      this.#pingTimestamp = Date.now();
      this.#send({ action: "ping", timestamp: this.#pingTimestamp });
    }, KEEPALIVE_MS);
    this.#heartbeat.unref();
  }

  #receive(raw: RawData, binary: boolean): void {
    if (this.#closed) return;
    if (binary) {
      const chunk = this.#chunk;
      this.#chunk = undefined;
      const pcm = rawDataBytes(raw);
      if (chunk && pcm.byteLength % 2 === 0) {
        this.#lastOutputAt = Date.now();
        this.#emit({ type: "audio", ...chunk, pcm });
      }
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(rawDataText(raw));
    } catch {
      this.#disconnect("invalid-json");
      return;
    }
    if (!isDynamicRecord(value)) return;
    const data = isDynamicRecord(value.data) ? value.data : {};
    switch (value.action) {
      case "session_attached":
        if (this.#phase !== "attaching") return;
        if (data.delegation !== "client") {
          this.#sessionId = null;
          this.#disconnect("delegation-unavailable");
          return;
        }
        this.#sessionId = typeof data.session_id === "string" && data.session_id ? data.session_id : null;
        this.#resumed = this.#sessionId !== null && this.#sessionId === this.#resumeId;
        if (this.#voiceId === null) this.#configure();
        else {
          this.#phase = "setting-voice";
          this.#send({ action: "change_voice", voice_name: this.#voiceId });
        }
        return;
      case "voice_changed":
        if (this.#phase !== "setting-voice") return;
        if (data.name === this.#voiceId) this.#configure();
        else this.#disconnect("voice-mismatch");
        return;
      case "session.updated":
        if (this.#phase !== "configuring") return;
        if (data.error !== "") {
          this.#disconnect("configuration-rejected");
          return;
        }
        this.#onReady();
        return;
      case "pong":
        if (data.client_timestamp === this.#pingTimestamp) this.#pingTimestamp = undefined;
        return;
      case "session.closing":
        if (data.reconnect === false) this.#sessionId = null;
        logger.info("MOSS Live server is closing the connection.", {
          code: typeof data.code === "number" ? data.code : undefined,
          resume: data.reconnect === true,
        });
        return;
      case "error": {
        const error = isDynamicRecord(data.error) ? data.error : {};
        const code = typeof error.code === "string" && REQUEST_ERRORS.has(error.code) ? error.code : "other";
        if (this.#phase === "ready") {
          logger.warn("MOSS Live reported a request or session error.", { code, ...this.#activity() });
          return;
        }
        if (this.#phase === "attaching") this.#sessionId = null;
        this.#disconnect("provider-setup-error", code);
        return;
      }
      case "session.closed":
        if (data.reconnect === false) this.#sessionId = null;
        this.#disconnect("provider-closed");
        return;
      case "input.transcript.updated":
      case "input.transcript.done":
      case "output.transcript.updated":
      case "output.transcript.done":
        if (typeof data.text === "string")
          this.#emit({
            type: "transcript",
            role: value.action.startsWith("input") ? "user" : "assistant",
            text: data.text,
          });
        return;
      case "response.audio.context":
        if (typeof data.run_id === "string" && typeof data.turn_id === "string" && typeof data.chunk_id === "string")
          this.#chunk = { runId: data.run_id, turnId: data.turn_id, chunkId: data.chunk_id };
        return;
      case "response.audio.done":
      case "response.audio.stop":
        if (value.action === "response.audio.stop") logger.info("MOSS Live stopped a reply.", this.#activity());
        if (typeof data.run_id === "string" && typeof data.turn_id === "string")
          this.#emit({
            type: value.action === "response.audio.done" ? "done" : "stop",
            runId: data.run_id,
            turnId: data.turn_id,
          });
        return;
      case "response.interrupted":
        logger.info("MOSS Live interrupted a reply.", this.#activity());
        return;
      case "session.delegation.created":
        this.#delegate(data);
        return;
      case "session.delegation.cancelled": {
        const callId = data.delegation_id;
        if (typeof callId !== "string") return;
        const delegation = this.#delegations.get(callId);
        if (!delegation) return;
        this.#delegations.delete(callId);
        logger.info("MOSS Live cancelled a delegation.", { elapsedMs: Date.now() - delegation.startedAt });
        if (!delegation.result) this.#emit({ type: "cancel", callId });
        return;
      }
      case "session.commentary.appended": {
        const callId = data.delegation_id;
        if (typeof callId !== "string") return;
        const result = this.#delegations.get(callId)?.result;
        if (result && result.event_id === data.client_event_id) this.#delegations.delete(callId);
      }
    }
  }

  #delegate(data: DynamicRecord): void {
    const delegation = data.delegation;
    if (!isDynamicRecord(delegation) || delegation.target !== "client") return;
    const { id: callId } = delegation;
    const { objective } = data;
    if (
      this.#phase !== "ready" ||
      typeof callId !== "string" ||
      !callId ||
      callId.length > 256 ||
      typeof objective !== "string" ||
      !objective.trim() ||
      this.#seenDelegations.has(callId) ||
      this.#delegations.has(callId)
    )
      return;
    this.#seenDelegations.add(callId);
    if (this.#seenDelegations.size > MAX_SEEN_DELEGATIONS) {
      const oldest = this.#seenDelegations.values().next().value;
      if (oldest !== undefined) this.#seenDelegations.delete(oldest);
    }
    logger.info("MOSS Live started a delegation.", { active: this.#delegations.size + 1 });
    this.#delegations.set(callId, { startedAt: Date.now() });
    this.#emit({ type: "request", callId, text: objective.slice(0, 8_000) });
  }
}

function socketErrorCode(error: Error): string | undefined {
  if (!("code" in error)) return undefined;
  switch (error.code) {
    case "ECONNRESET":
    case "ECONNREFUSED":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "EPIPE":
    case "ETIMEDOUT":
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return error.code;
    default:
      return "other";
  }
}

function openMossSocket(key: string): WebSocket {
  return new WebSocket(URL, {
    headers: { Authorization: `Bearer ${key}` },
    handshakeTimeout: OPEN_TIMEOUT_MS,
    maxPayload: 1024 * 1024,
  });
}
