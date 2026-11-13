import type { MossLiveControl, MossLiveEvent, MossLiveVoice } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { redactText } from "@openbot/logging";
import { Effect } from "effect";
import WebSocket, { type RawData } from "ws";
import { rawDataBytes, rawDataText } from "./ws-raw-data";

const URL = "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0";
const TOOL = "ask_agent";
const OPEN_TIMEOUT_MS = 15_000;
const MAX_BUFFERED_AUDIO_BYTES = 64_000;
// The MOSS Live API reference lists these IDs for change_voice.
const VOICE_IDS: Record<MossLiveVoice, string> = {
  nuannuan: "6c3152b1-1d4f-4e49-ade3-09f447712fec",
  mumu: "6cc93520-3207-4f7a-bca9-2d560b9c306b",
};
type AudioChunk = Pick<Extract<MossLiveEvent, { type: "audio" }>, "runId" | "turnId" | "chunkId">;

/** One microphone session. The key and provider errors stay in main. */
export class MossLiveSession {
  readonly #socket: WebSocket;
  readonly #emit: (event: MossLiveEvent) => void;
  readonly #voiceId: string | null;
  readonly #calls = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #answers = new Set<string>();
  readonly #seenCalls = new Set<string>();
  #chunk: AudioChunk | undefined;
  #settle: ((error: Error | null) => void) | undefined;
  #phase: "attaching" | "setting-voice" | "configuring" | "ready" = "attaching";
  #closed = false;

  constructor(
    key: string,
    voice: MossLiveVoice | null,
    emit: (event: MossLiveEvent) => void,
    open: typeof openMossSocket = openMossSocket,
  ) {
    this.#emit = emit;
    this.#voiceId = voice === null ? null : VOICE_IDS[voice];
    this.#socket = open(key);
    this.#socket.on("open", () => this.#send({ action: "attach_session", session_id: null }));
    this.#socket.on("message", (data, binary) => this.#receive(data, binary));
    this.#socket.on("unexpected-response", (request, response) => {
      this.#fail(response.statusCode === 401 || response.statusCode === 403);
      request.destroy();
    });
    this.#socket.on("error", () => this.#fail());
    this.#socket.on("close", () => this.#fail());
  }

  readonly ready = Effect.callback<void, Error>((resume) => {
    this.#settle = (error) => resume(error ? Effect.fail(error) : Effect.void);
  }).pipe(
    Effect.timeoutOrElse({
      duration: OPEN_TIMEOUT_MS,
      orElse: () => Effect.fail(new Error(sourceText("error.voice.moss.failed"))),
    }),
  );

  audio(pcm: Uint8Array): void {
    if (
      this.#phase === "ready" &&
      this.#socket.readyState === WebSocket.OPEN &&
      this.#socket.bufferedAmount < MAX_BUFFERED_AUDIO_BYTES
    )
      this.#socket.send(pcm);
  }

  control(input: MossLiveControl): void {
    if (this.#phase !== "ready") return;
    if (input.action === "mic") {
      this.#send({ action: "mic_state", enabled: input.enabled });
      return;
    }
    if (input.action === "answer") {
      if (!this.#finishCall(input.callId)) return;
      this.#answers.add(input.callId);
      this.#send({
        action: "conversation.item.create",
        item: { type: "function_call_output", call_id: input.callId, output: redactText(input.text) },
      });
      return;
    }
    const ids = { run_id: input.runId, turn_id: input.turnId };
    if (input.action === "played") this.#send({ action: "playback.chunk.completed", ...ids, chunk_id: input.chunkId });
    if (input.action === "completed") this.#send({ action: "playback.completed", ...ids });
    if (input.action === "stopped") this.#send({ action: "playback.stopped", ...ids, played_audio_ms: input.playedMs });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const timer of this.#calls.values()) clearTimeout(timer);
    this.#calls.clear();
    this.#settle?.(new Error(sourceText("error.voice.moss.failed")));
    this.#settle = undefined;
    this.#socket.terminate();
  }

  #send(event: { action: string } & DynamicRecord): void {
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(event));
  }

  #configure(): void {
    this.#phase = "configuring";
    this.#send({
      action: "session.update",
      session: {
        instructions:
          "Speak in the user's language. Whenever the user asks you to contact, ask, or give a task to the OpenBot agent, call ask_agent with the user's request, even if you could answer it yourself. Read back its result. Never claim the agent completed a task before receiving the result.",
        tools: [
          {
            type: "function",
            name: TOOL,
            description: "Send the user's request to the OpenBot agent.",
            execution_mode: "async_effect",
            read_only: false,
            parameters: { type: "object", properties: { request: { type: "string" } }, required: ["request"] },
          },
        ],
      },
    });
  }

  #fail(rejected = false): void {
    if (this.#closed) return;
    const error = rejected
      ? sourceText("error.voice.cloud.keyRejected", { provider: "MOSS" })
      : sourceText("error.voice.moss.failed");
    const wasReady = this.#phase === "ready";
    this.#settle?.(new Error(error));
    this.#settle = undefined;
    if (wasReady) this.#emit({ type: "ended", error });
    this.close();
  }

  #receive(raw: RawData, binary: boolean): void {
    if (this.#closed) return;
    if (binary) {
      const chunk = this.#chunk;
      this.#chunk = undefined;
      const pcm = rawDataBytes(raw);
      if (chunk && pcm.byteLength % 2 === 0) this.#emit({ type: "audio", ...chunk, pcm });
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(rawDataText(raw));
    } catch {
      this.#fail();
      return;
    }
    if (!isDynamicRecord(value)) return;
    const data = isDynamicRecord(value.data) ? value.data : {};
    switch (value.action) {
      case "session_attached":
        if (this.#phase !== "attaching") return;
        if (this.#voiceId === null) this.#configure();
        else {
          this.#phase = "setting-voice";
          this.#send({ action: "change_voice", voice_name: this.#voiceId });
        }
        return;
      case "voice_changed":
        if (this.#phase !== "setting-voice") return;
        if (data.name === this.#voiceId) this.#configure();
        else this.#fail();
        return;
      case "session.updated":
        if (this.#phase !== "configuring") return;
        if (data.error !== "") {
          this.#fail();
          return;
        }
        this.#phase = "ready";
        this.#settle?.(null);
        this.#settle = undefined;
        return;
      case "error":
      case "session.closed":
        this.#fail();
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
        if (typeof data.run_id === "string" && typeof data.turn_id === "string")
          this.#emit({
            type: value.action === "response.audio.done" ? "done" : "stop",
            runId: data.run_id,
            turnId: data.turn_id,
          });
        return;
      case "response.function_call_arguments.done":
        this.#tool(data);
        return;
      case "response.done":
        if (isDynamicRecord(data.response) && Array.isArray(data.response.output)) {
          for (const item of data.response.output) {
            if (isDynamicRecord(item) && item.type === "function_call") this.#tool(item);
          }
        }
        return;
      case "response.function_call.cancel_requested":
        if (typeof data.call_id === "string" && this.#finishCall(data.call_id))
          this.#emit({ type: "cancel", callId: data.call_id });
        return;
      case "conversation.item.created": {
        const item = data.item;
        if (
          isDynamicRecord(item) &&
          item.type === "function_call_output" &&
          typeof item.call_id === "string" &&
          this.#answers.delete(item.call_id)
        )
          this.#send({ action: "response.create", response: { call_ids: [item.call_id] } });
      }
    }
  }

  #tool(data: DynamicRecord): void {
    const { call_id: callId, arguments: args } = data;
    if (
      this.#phase !== "ready" ||
      data.name !== TOOL ||
      typeof callId !== "string" ||
      !callId ||
      callId.length > 256 ||
      typeof args !== "string" ||
      args.length > 16_000 ||
      this.#seenCalls.has(callId) ||
      this.#seenCalls.size >= 2_000
    )
      return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch {
      return;
    }
    if (!isDynamicRecord(parsed) || typeof parsed.request !== "string" || !parsed.request.trim()) return;
    this.#seenCalls.add(callId);
    const timer = setTimeout(() => {
      this.control({ action: "answer", callId, text: "The agent did not respond in time." });
      this.#emit({ type: "cancel", callId });
    }, 120_000);
    this.#calls.set(callId, timer);
    this.#emit({ type: "request", callId, text: parsed.request.slice(0, 8_000) });
  }

  #finishCall(callId: string): boolean {
    const timer = this.#calls.get(callId);
    if (timer === undefined) return false;
    clearTimeout(timer);
    return this.#calls.delete(callId);
  }
}

function openMossSocket(key: string): WebSocket {
  return new WebSocket(URL, {
    headers: { Authorization: `Bearer ${key}` },
    handshakeTimeout: OPEN_TIMEOUT_MS,
    maxPayload: 1024 * 1024,
  });
}
