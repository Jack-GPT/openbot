import { latestTurnAnswer, type MossLiveEvent, type OpenBotDesktopApi } from "@openbot/contracts/ipc";
import { currentText } from "@openbot/ui/text";
import { createStore, onCleanup } from "solid-js";
import { encodePcm16, resample } from "../../../voice-recording";
import { SPEECH_LEVEL_COUNT } from "../../speech/speech-playback";
import { voiceCaptureError } from "../voice-status";

type AudioChunk = Extract<MossLiveEvent, { type: "audio" }>;
interface ScheduledChunk {
  chunk: AudioChunk;
  source: AudioBufferSourceNode;
  startsAt: number;
  endsAt: number;
}
type Phase = "starting" | "listening" | "thinking" | "speaking";
interface MossLiveState {
  phase: Phase;
  heard: string;
  said: string;
  muted: boolean;
  error: string | null;
  levels: number[];
}
const INPUT_RATE = 16_000;
const OUTPUT_RATE = 48_000;
const MAX_QUEUED_BYTES = OUTPUT_RATE * 2 * 30;
const PLAYBACK_BUFFER_SECONDS = 0.12;
const quiet = () => new Array<number>(SPEECH_LEVEL_COUNT).fill(0);

export type MossLivePort = Pick<
  OpenBotDesktopApi["voice"],
  "startMoss" | "stopMoss" | "mossAudio" | "mossControl" | "onMossEvent"
>;

export function createMossLiveConversation(
  voice: MossLivePort,
  agent: Pick<OpenBotDesktopApi["agent"], "sendMessage" | "listQueue" | "readConversationPage" | "onScopedEvent">,
  target: { agentId: string; serverId: string },
) {
  const [state, setState] = createStore<MossLiveState>({
    phase: "starting",
    heard: "",
    said: "",
    muted: false,
    error: null,
    levels: quiet(),
  });
  let microphone: MediaStream | undefined;
  let context: AudioContext | undefined;
  let processor: ScriptProcessorNode | undefined;
  let active = false;
  let disposed = false;
  let muted = false;
  let sending = false;
  let reconnecting = false;
  const scheduled = new Set<ScheduledChunk>();
  let playUntil = 0;
  let queuedBytes = 0;
  const done = new Map<string, string>();
  const stoppedRuns = new Set<string>();
  const pending = new Map<string, AbortController>();
  const phase = (next: Phase) =>
    setState((draft) => {
      draft.phase = reconnecting ? "starting" : next;
    });

  function control(input: Parameters<MossLivePort["mossControl"]>[0]): void {
    if (active) void voice.mossControl(input).catch(() => undefined);
  }

  function complete(runId: string): void {
    const turnId = done.get(runId);
    if (turnId === undefined) return;
    for (const item of scheduled) if (item.chunk.runId === runId) return;
    done.delete(runId);
    control({ action: "completed", runId, turnId });
  }

  function removeChunk(item: ScheduledChunk): void {
    scheduled.delete(item);
    queuedBytes -= item.chunk.pcm.byteLength;
    item.source.onended = null;
    item.source.disconnect();
  }

  function play(chunk: AudioChunk): void {
    if (!context) return;
    const { runId, turnId, chunkId, pcm } = chunk;
    if (pcm.byteLength === 0) {
      control({ action: "played", runId, turnId, chunkId });
      complete(runId);
      return;
    }
    const buffer = context.createBuffer(1, pcm.byteLength / 2, OUTPUT_RATE);
    const samples = buffer.getChannelData(0);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true) / 32_768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    // Schedule on the audio clock. onended runs on the UI thread and can arrive a few frames late.
    const now = context.currentTime;
    const startsAt = playUntil > now ? playUntil : now + PLAYBACK_BUFFER_SECONDS;
    const endsAt = startsAt + buffer.duration;
    playUntil = endsAt;
    const item = { chunk, source, startsAt, endsAt };
    scheduled.add(item);
    queuedBytes += pcm.byteLength;
    phase("speaking");
    source.onended = () => {
      removeChunk(item);
      control({ action: "played", runId, turnId, chunkId });
      complete(runId);
      if (!scheduled.size) phase(pending.size > 0 ? "thinking" : "listening");
    };
    source.start(startsAt);
  }

  function stopPlayback(runId: string, turnId: string): void {
    if (stoppedRuns.has(runId)) return;
    stoppedRuns.add(runId);
    if (stoppedRuns.size > 128) {
      const oldest = stoppedRuns.values().next().value;
      if (oldest !== undefined) stoppedRuns.delete(oldest);
    }
    let playedMs = 0;
    const now = context?.currentTime ?? 0;
    playUntil = 0;
    for (const item of scheduled) {
      if (item.chunk.runId !== runId) {
        playUntil = Math.max(playUntil, item.endsAt);
        continue;
      }
      removeChunk(item);
      if (item.endsAt <= now) control({ action: "played", runId, turnId, chunkId: item.chunk.chunkId });
      else {
        if (item.startsAt < now) playedMs = Math.round((now - item.startsAt) * 1_000);
        item.source.stop();
      }
    }
    done.delete(runId);
    control({ action: "stopped", runId, turnId, playedMs });
    if (!scheduled.size) phase(pending.size > 0 ? "thinking" : "listening");
  }

  async function askAgent(text: string, signal: AbortSignal): Promise<string> {
    const { agentId, serverId } = target;
    let wake: (() => void) | undefined;
    const onEvent = agent.onScopedEvent(({ serverId: sender, event }) => {
      if (sender !== serverId) return;
      if (
        (event.type === "queue-changed" && event.snapshot.agentId === agentId) ||
        (event.type === "turn-completed" && event.agentId === agentId)
      )
        wake?.();
    });
    const abort = () => wake?.();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const receipt = await agent.sendMessage({ agentId, text }, serverId);
      const deliveryId = receipt.deliveries[0]?.id;
      if (!deliveryId) throw new Error("No delivery.");
      while (!signal.aborted) {
        const changed = new Promise<void>((resolve) => {
          wake = resolve;
        });
        const queue = await agent.listQueue(agentId, serverId);
        if (signal.aborted) return "";
        const delivery = queue.deliveries.find((item) => item.id === deliveryId);
        if (!delivery || ["completed", "failed", "cancelled", "interrupted"].includes(delivery.status)) {
          if (!delivery?.turnId || delivery.status !== "completed") throw new Error("The agent did not answer.");
          const page = await agent.readConversationPage({ agentId, anchor: { type: "latest" }, limit: 50 }, serverId);
          const answer = latestTurnAnswer(page.messages, delivery.turnId);
          if (!answer) throw new Error("The agent did not answer.");
          return answer.text.slice(0, 16_000);
        }
        await changed;
      }
      return "";
    } finally {
      onEvent();
      signal.removeEventListener("abort", abort);
    }
  }

  function clearPlayback(): void {
    for (const item of scheduled) {
      removeChunk(item);
      item.source.stop();
    }
    playUntil = 0;
    done.clear();
    stoppedRuns.clear();
  }

  function release(): void {
    active = false;
    reconnecting = false;
    void voice.stopMoss().catch(() => undefined);
    for (const call of pending.values()) call.abort();
    pending.clear();
    clearPlayback();
    processor?.disconnect();
    if (processor) processor.onaudioprocess = null;
    processor = undefined;
    for (const track of microphone?.getTracks() ?? []) track.stop();
    microphone = undefined;
    void context?.close().catch(() => undefined);
    context = undefined;
  }

  function fail(error: unknown): void {
    if (disposed) return;
    release();
    muted = true;
    const { t, errorMessage } = currentText();
    setState((draft) => {
      draft.phase = "listening";
      draft.muted = true;
      draft.error = errorMessage(error, t("error.voice.moss.failed"));
      draft.levels = quiet();
    });
  }

  const stopEvents = voice.onMossEvent((event) => {
    if (disposed) return;
    switch (event.type) {
      case "reconnecting":
        reconnecting = true;
        phase("starting");
        return;
      case "reconnected":
        reconnecting = false;
        if (!event.resumed) clearPlayback();
        phase(scheduled.size > 0 ? "speaking" : pending.size > 0 ? "thinking" : "listening");
        return;
      case "ended":
        fail(new Error(event.error));
        return;
      case "transcript":
        setState((draft) => {
          if (event.role === "user") draft.heard = event.text;
          else draft.said = event.text;
        });
        return;
      case "audio":
        if (!active || stoppedRuns.has(event.runId)) return;
        if (queuedBytes + event.pcm.byteLength > MAX_QUEUED_BYTES) {
          stopPlayback(event.runId, event.turnId);
          return;
        }
        play(event);
        return;
      case "done":
        if (stoppedRuns.has(event.runId)) return;
        done.set(event.runId, event.turnId);
        complete(event.runId);
        return;
      case "stop":
        stopPlayback(event.runId, event.turnId);
        return;
      case "cancel":
        pending.get(event.callId)?.abort();
        return;
      case "request": {
        if (!active || pending.has(event.callId)) return;
        const call = new AbortController();
        pending.set(event.callId, call);
        phase("thinking");
        void askAgent(event.text, call.signal)
          .then((text) => {
            if (!call.signal.aborted) control({ action: "answer", callId: event.callId, text });
          })
          .catch(() => {
            if (!call.signal.aborted)
              control({ action: "answer", callId: event.callId, text: "The agent could not complete this request." });
          })
          .finally(() => {
            pending.delete(event.callId);
            if (!scheduled.size) phase(pending.size > 0 ? "thinking" : "listening");
          });
      }
    }
  });

  async function start(): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (error) {
      fail(new Error(voiceCaptureError(error)));
      return;
    }
    if (disposed) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    try {
      microphone = stream;
      context = new AudioContext({ sampleRate: OUTPUT_RATE });
      await context.resume();
      if (disposed) return;
      await voice.startMoss();
      if (disposed || !context) return;
      active = true;
      control({ action: "mic", enabled: !muted });
      const input = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = ({ inputBuffer }) => {
        if (!active || muted || sending) return;
        const samples = inputBuffer.getChannelData(0);
        const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
        setState((draft) => {
          draft.levels = [...draft.levels.slice(1), Math.min(1, peak * 5)];
        });
        const pcm = encodePcm16(resample(samples, inputBuffer.sampleRate, INPUT_RATE));
        sending = true;
        void voice
          .mossAudio(pcm)
          .catch(fail)
          .finally(() => {
            sending = false;
          });
      };
      input.connect(processor);
      processor.connect(context.destination);
      phase("listening");
    } catch (error) {
      fail(error);
    }
  }

  onCleanup(() => {
    disposed = true;
    stopEvents();
    release();
  });
  void start();
  return {
    phase: () => state.phase,
    heard: () => state.heard,
    said: () => state.said,
    error: () => state.error,
    muted: () => state.muted,
    levels: () => state.levels,
    toggleMute() {
      muted = !muted;
      setState((draft) => {
        draft.muted = muted;
      });
      control({ action: "mic", enabled: !muted });
      if (!muted && state.error) {
        setState((draft) => {
          draft.error = null;
        });
        phase("starting");
        void start();
      }
    },
    interrupt() {
      const chunk = scheduled.values().next().value?.chunk;
      if (chunk) stopPlayback(chunk.runId, chunk.turnId);
    },
  };
}
