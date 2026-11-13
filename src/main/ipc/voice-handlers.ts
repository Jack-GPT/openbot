// The speech recognition models (Parakeet and Whisper turbo on this computer, ElevenLabs Scribe in
// the cloud), their settings, and dictation. Also the speech model that reads replies aloud, and the
// user's own OpenAI-compatible voice server, which can take either route.

import type {
  DraftAttachment,
  SpeechAudio,
  SpeechModelStatus,
  SpeechSettings,
  VoiceLiveEvent,
  VoiceLiveSession,
  VoiceModelStatus,
  VoiceServerProbe,
  VoiceServerSettings,
  VoiceSettings,
  VoiceStream,
  VoiceTranscriptionResult,
} from "@openbot/contracts/ipc";
import { IPC_ENDPOINTS } from "@openbot/contracts/ipc";
import {
  decodeLiveVoiceSessionResponse,
  isLiveVoiceName,
  LIVE_VOICE_CAPABILITY,
  LIVE_VOICE_ROUTES,
} from "@openbot/contracts/team-protocol/live-voice-v1";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { BrowserWindow, type WebContents } from "electron";
import type { AgentService } from "../../backend/agent-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import { MossLiveSession } from "../moss-live";
import { acceptEmpty } from "../remote-host-decoding";
import type { RemoteServerManager } from "../remote-server-manager";
import { sendToRenderer } from "../renderer-ipc";
import { voiceLiveEventFromWire } from "../team-api/route-live-voice";
import type { VoiceApiKeyStore } from "../voice-api-key-store";
import type { VoiceServerService } from "../voice-server-service";
import type { VoiceSpeechService } from "../voice-speech-service";
import type { VoiceTranscriptionService } from "../voice-transcription-service";
import { agentRequest } from "./agent-inputs";
import { eventHandler, eventPayloadHandler, handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { routeToServer } from "./route-to-server";
import {
  parseMossAudio,
  parseMossControl,
  parseMossKey,
  parseSpeechApiKey,
  parseSpeechInput,
  parseSpeechSettings,
  parseVoiceApiKey,
  parseVoiceLiveStart,
  parseVoiceLiveStop,
  parseVoiceModelRequest,
  parseVoiceRecording,
  parseVoiceServerConnection,
  parseVoiceServerSave,
  parseVoiceSettings,
  parseVoiceStream,
  parseVoiceStreamAudio,
  parseVoiceTranscription,
} from "./voice-inputs";

export interface VoiceIpcDependencies {
  voice: VoiceTranscriptionService;
  speech: VoiceSpeechService;
  mossKey: VoiceApiKeyStore;
  /** The user's own server. While one of its routes is on, it replaces the model on this computer. */
  server: VoiceServerService;
  /** Keeps a voice turn's recording as an attachment draft. Voice turns go to this computer's host only. */
  service: Pick<AgentService, "prepareVoiceRecording" | "startLiveVoice" | "stopLiveVoice">;
  /** A joined server answers the WebRTC offer of an agent there with its own Codex sign-in (`live-voice-v1`). */
  remoteServers: Pick<RemoteServerManager, "request" | "supportsCapability" | "on">;
  /** Sends a live voice event of a joined server to the windows. */
  forwardLiveEvent(event: VoiceLiveEvent): void;
}

/** A start can wait for the host to start Codex, and then up to 20 seconds for the answer of OpenAI. */
const REMOTE_LIVE_START_TIMEOUT_MS = 60_000;

export function voiceIpcHandlers({
  voice,
  speech,
  mossKey,
  server,
  service,
  remoteServers,
  forwardLiveEvent,
}: VoiceIpcDependencies): Pick<IpcGroupHandlers, "voice"> {
  const mossSessions = new Map<WebContents, MossLiveSession>();
  const watchedMossOwners = new WeakSet<WebContents>();
  const stopMoss = (owner: WebContents) => {
    mossSessions.get(owner)?.close();
    mossSessions.delete(owner);
  };
  const stopAllMoss = (error: string) => {
    for (const owner of mossSessions.keys()) {
      stopMoss(owner);
      sendToRenderer(BrowserWindow.fromWebContents(owner), IPC_ENDPOINTS.voice.mossEvent, { type: "ended", error });
    }
  };
  // A window that closes, reloads or crashes cannot stop its live voice any more, so main stops it.
  const liveSessions = new Map<WebContents, Set<string>>();
  const watchedLiveOwners = new WeakSet<WebContents>();
  /** The joined server of each remote session. A session that is not here runs on this computer. */
  const remoteSessions = new Map<string, string>();
  const stopLive = (sessionId: string): Promise<void> => {
    const serverId = remoteSessions.get(sessionId);
    if (serverId === undefined) return runCauseEffect(service.stopLiveVoice(sessionId));
    remoteSessions.delete(sessionId);
    return runCauseEffect(
      remoteServers.request(serverId, LIVE_VOICE_ROUTES.stop, acceptEmpty, {
        method: "POST",
        body: { sessionId },
      }),
    );
  };
  // The host sends a member's live voice events only to that member's connections. A session that
  // the server ended needs no stop.
  remoteServers.on("liveVoice", (_serverId, event) => {
    if (event.kind === "ended") remoteSessions.delete(event.sessionId);
    forwardLiveEvent(voiceLiveEventFromWire(event));
  });
  // The host ends the sessions of a closed event connection, but its end cannot arrive any more. A
  // removed server is not in the list. A retry ("connecting") can restart the event connection too.
  // The stop is for a retry that keeps the connection open; on a closed connection it fails.
  remoteServers.on("changed", (servers) => {
    const online = new Set(servers.filter((summary) => summary.state === "online").map(({ id }) => id));
    for (const [sessionId, serverId] of remoteSessions)
      if (!online.has(serverId)) {
        void stopLive(sessionId).catch(() => undefined);
        forwardLiveEvent({ type: "ended", sessionId, error: null });
      }
  });
  const stopLiveSessions = (owner: WebContents, reason?: string) => {
    const sessions = liveSessions.get(owner);
    if (!sessions) return;
    liveSessions.delete(owner);
    for (const sessionId of sessions) {
      if (reason) forwardLiveEvent({ type: "ended", sessionId, error: reason });
      void stopLive(sessionId).catch(() => undefined);
    }
  };
  const watchLiveOwner = (owner: WebContents, sessionId: string) => {
    const sessions = liveSessions.get(owner);
    if (sessions) {
      sessions.add(sessionId);
      return;
    }
    liveSessions.set(owner, new Set([sessionId]));
    if (watchedLiveOwners.has(owner)) return;
    watchedLiveOwners.add(owner);
    owner.once("destroyed", () => stopLiveSessions(owner));
    owner.on("render-process-gone", () => stopLiveSessions(owner));
    owner.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) stopLiveSessions(owner);
    });
  };
  return {
    voice: {
      getModelStatus: handler((): Promise<VoiceModelStatus> => runCauseEffect(voice.getModelStatus())),
      getModelStatuses: handler((): Promise<VoiceModelStatus[]> => runCauseEffect(voice.getModelStatuses())),
      // The server's model is ready on the server: nothing on this computer is downloaded for it.
      prepareModel: handler(
        (): Promise<VoiceModelStatus> =>
          server.dictates()
            ? Promise.resolve({ modelId: voice.getSettings().modelId, phase: "ready", progress: 100, message: null })
            : runCauseEffect(voice.prepareModel()),
      ),
      downloadModel: payloadHandler(
        parseVoiceModelRequest,
        ({ modelId }): Promise<VoiceModelStatus> => runCauseEffect(voice.downloadModel(modelId)),
      ),
      cancelModelDownload: payloadHandler(
        parseVoiceModelRequest,
        ({ modelId }): Promise<VoiceModelStatus> => runCauseEffect(voice.cancelModelDownload(modelId)),
      ),
      removeModel: payloadHandler(
        parseVoiceModelRequest,
        ({ modelId }): Promise<VoiceModelStatus> => runCauseEffect(voice.removeModel(modelId)),
      ),
      getSettings: handler((): VoiceSettings => voice.getSettings()),
      setSettings: payloadHandler(
        parseVoiceSettings,
        (settings): Promise<VoiceSettings> => runCauseEffect(voice.setSettings(settings)),
      ),
      transcribe: payloadHandler(
        parseVoiceTranscription,
        ({ audio }): Promise<VoiceTranscriptionResult> =>
          runCauseEffect(
            server.dictates() ? server.transcribe(audio, voice.getSettings().language) : voice.transcribe(audio),
          ),
      ),
      setApiKey: payloadHandler(parseVoiceApiKey, async ({ provider, key }): Promise<VoiceModelStatus> => {
        const status = await runCauseEffect(voice.setApiKey(provider, key));
        // ElevenLabs reads replies aloud with the same key, so the speech status changes too.
        if (provider === "elevenlabs") await runCauseEffect(speech.announceStatus());
        return status;
      }),
      startStream: handler((): Promise<VoiceStream> => runCauseEffect(voice.startStream())),
      appendStream: payloadHandler(
        parseVoiceStreamAudio,
        (audio): Promise<void> => runCauseEffect(voice.appendStream(audio)),
      ),
      finishStream: payloadHandler(
        parseVoiceStream,
        (stream): Promise<VoiceTranscriptionResult> => runCauseEffect(voice.finishStream(stream)),
      ),
      cancelStream: payloadHandler(parseVoiceStream, (stream): void => voice.cancelStream(stream)),
      getSpeechSettings: handler((): SpeechSettings => speech.getSettings()),
      setSpeechSettings: payloadHandler(parseSpeechSettings, async (settings): Promise<SpeechSettings> => {
        const saved = await runCauseEffect(speech.setSettings(settings));
        if (!saved.mossLive) stopAllMoss(sourceText("error.voice.live.disconnected"));
        if (!saved.codexLive) {
          for (const owner of liveSessions.keys()) stopLiveSessions(owner, sourceText("error.voice.live.off"));
        }
        return saved;
      }),
      getSpeechModelStatus: handler((): Promise<SpeechModelStatus> => runCauseEffect(speech.getModelStatus())),
      setSpeechApiKey: payloadHandler(parseSpeechApiKey, async ({ provider, key }): Promise<SpeechModelStatus> => {
        if (provider === "xai") return runCauseEffect(speech.setXaiApiKey(key));
        await runCauseEffect(voice.setApiKey("elevenlabs", key));
        return runCauseEffect(speech.announceStatus());
      }),
      downloadSpeechModel: handler((): Promise<SpeechModelStatus> => runCauseEffect(speech.downloadModel())),
      cancelSpeechModelDownload: handler(
        (): Promise<SpeechModelStatus> => runCauseEffect(speech.cancelModelDownload()),
      ),
      removeSpeechModel: handler((): Promise<SpeechModelStatus> => runCauseEffect(speech.removeModel())),
      speak: payloadHandler(
        parseSpeechInput,
        (input): Promise<SpeechAudio> =>
          runCauseEffect(server.speaks() ? server.speak(input.text) : speech.speak(input)),
      ),
      // A server has nothing to load on this computer.
      warmSpeech: handler((): Promise<void> => (server.speaks() ? Promise.resolve() : runCauseEffect(speech.warm()))),
      keepRecording: payloadHandler(parseVoiceRecording, async ({ audio }): Promise<DraftAttachment> => {
        const [draft] = await runCauseEffect(service.prepareVoiceRecording(audio));
        if (!draft) throw new Error(sourceText("error.voice.recordingNotKept"));
        return draft;
      }),
      getServer: handler((): VoiceServerSettings | null => server.get()),
      probeServer: payloadHandler(
        parseVoiceServerConnection,
        (connection): Promise<VoiceServerProbe> => runCauseEffect(server.probe(connection)),
      ),
      setServer: payloadHandler(
        parseVoiceServerSave,
        (save): Promise<VoiceServerSettings | null> => runCauseEffect(server.set(save.server)),
      ),
      // Codex live voice: Codex App Server answers the renderer's WebRTC offer with the user's own
      // Codex sign-in, or a joined server's Codex answers it with that server's sign-in. Main never sees
      // the audio or the credentials.
      startLive: eventPayloadHandler(
        agentRequest(parseVoiceLiveStart),
        async (event, { serverId, payload: input }): Promise<VoiceLiveSession> => {
          // The opt-in is checked here, because the voice goes to OpenAI only while it is on.
          const { codexLive, codexLiveVoice } = speech.getSettings();
          if (!codexLive) throw new Error(sourceText("error.voice.live.off"));
          const session = await routeToServer(serverId, {
            local: () => runCauseEffect(service.startLiveVoice(input, codexLiveVoice)),
            remote: async (target) => {
              if (!remoteServers.supportsCapability(target, LIVE_VOICE_CAPABILITY))
                throw new Error(sourceText("error.team.liveVoiceUnsupported"));
              const started = await runCauseEffect(
                remoteServers.request(target, LIVE_VOICE_ROUTES.start, decodeLiveVoiceSessionResponse, {
                  method: "POST",
                  // The wire fields only, so that a new IPC field does not cross the frozen contract.
                  body: {
                    agentId: input.agentId,
                    sdp: input.sdp,
                    // A voice that this contract does not name would make the host refuse the start.
                    ...(isLiveVoiceName(codexLiveVoice) ? { voice: codexLiveVoice } : {}),
                  },
                  timeoutMs: REMOTE_LIVE_START_TIMEOUT_MS,
                }),
              );
              remoteSessions.set(started.sessionId, target);
              return started;
            },
          });
          if (event.sender.isDestroyed() || !speech.getSettings().codexLive) {
            await stopLive(session.sessionId);
            throw new Error(sourceText("error.voice.live.disconnected"));
          }
          watchLiveOwner(event.sender, session.sessionId);
          return session;
        },
      ),
      stopLive: eventPayloadHandler(parseVoiceLiveStop, ({ sender }, { sessionId }): Promise<void> => {
        const sessions = liveSessions.get(sender);
        sessions?.delete(sessionId);
        if (sessions?.size === 0) liveSessions.delete(sender);
        return stopLive(sessionId);
      }),
      mossKeySaved: handler(() => mossKey.get() !== null),
      setMossKey: payloadHandler(parseMossKey, ({ key }) =>
        Effect.runPromise(
          mossKey.set(key).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (key === null) stopAllMoss(sourceText("error.voice.cloud.keyRequired", { provider: "MOSS" }));
              }),
            ),
            Effect.as(key !== null),
            Effect.mapError(() => new Error(sourceText("error.voice.cloud.keySaveFailed", { provider: "MOSS" }))),
          ),
        ),
      ),
      startMoss: eventHandler(async ({ sender }) => {
        const { mossLive, mossLiveVoice } = speech.getSettings();
        if (!mossLive) throw new Error(sourceText("error.voice.moss.failed"));
        const key = mossKey.get();
        if (!key) throw new Error(sourceText("error.voice.cloud.keyRequired", { provider: "MOSS" }));
        stopMoss(sender);
        const session = new MossLiveSession(key, mossLiveVoice ?? null, (event) => {
          if (mossSessions.get(sender) !== session) return;
          sendToRenderer(BrowserWindow.fromWebContents(sender), IPC_ENDPOINTS.voice.mossEvent, event);
          if (event.type === "ended") mossSessions.delete(sender);
        });
        mossSessions.set(sender, session);
        if (!watchedMossOwners.has(sender)) {
          watchedMossOwners.add(sender);
          sender.once("destroyed", () => stopMoss(sender));
          sender.on("render-process-gone", () => stopMoss(sender));
          sender.on("did-start-navigation", (details) => {
            if (details.isMainFrame && !details.isSameDocument) stopMoss(sender);
          });
        }
        try {
          await Effect.runPromise(session.ready);
        } catch (error) {
          session.close();
          if (mossSessions.get(sender) === session) mossSessions.delete(sender);
          throw error;
        }
      }),
      stopMoss: eventHandler(({ sender }) => stopMoss(sender)),
      mossAudio: eventPayloadHandler(parseMossAudio, ({ sender }, pcm) => mossSessions.get(sender)?.audio(pcm)),
      mossControl: eventPayloadHandler(parseMossControl, ({ sender }, input) =>
        mossSessions.get(sender)?.control(input),
      ),
    },
  };
}
