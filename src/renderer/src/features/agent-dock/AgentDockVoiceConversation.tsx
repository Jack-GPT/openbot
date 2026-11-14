import { isNarrationItemId } from "@openbot/contracts/conversation-narration";
import { LOCAL_SERVER_ID, type ServerSummary } from "@openbot/contracts/ipc";
import type { ComposerAgent } from "@openbot/ui/data";
import { VoicePanel } from "@openbot/ui/features/conversation/VoicePanel";
import { createSignal, onCleanup, Show, untrack } from "solid-js";
import { conversationPort } from "../conversation/conversation-port";
import { conversationRuntime } from "../conversation/conversation-runtime";
import { createCodexLiveConversation } from "../conversation/stores/codex-live-conversation-store";
import { createMossLiveConversation } from "../conversation/stores/moss-live-conversation-store";
import { createVoiceConversation } from "../conversation/stores/voice-conversation-store";
import type { VoiceConversationKind } from "../conversation/stores/voice-session-store";
import { serverSupportsCapability } from "../servers/server-capabilities";
import { serversPort } from "../servers/servers-port";
import { codexLiveAccess } from "../speech/codex-live-access";
import { speechPort } from "../speech/speech-port";
import { claimDictatedSend, readDictatedReplies } from "../speech/speech-replies";
import { cycleSpeechSpeed, speechSpeed } from "../speech/speech-speed";

export function AgentDockVoiceConversation(props: {
  agent: ComposerAgent;
  serverId: string;
  onEnd: () => void;
  screen?: boolean;
}) {
  const { agent, serverId, screen } = untrack(() => props);
  const [kind, setKind] = createSignal<VoiceConversationKind>();
  const [server, setServer] = createSignal<ServerSummary>();
  let closed = false;
  let provider: Parameters<typeof isNarrationItemId>[1];
  const port = serversPort();
  const updateServer = (servers: readonly ServerSummary[]) => setServer(servers.find((entry) => entry.id === serverId));
  let receivedServers = false;
  const stopServers = port.servers.onEvent((servers) => {
    receivedServers = true;
    updateServer(servers);
  });
  const refreshServers = port.servers.list().then(
    (servers) => {
      if (!closed && !receivedServers) updateServer(servers);
      return servers.find((entry) => entry.id === serverId);
    },
    () => undefined,
  );
  const settings = speechPort()
    .voice.getSpeechSettings()
    .catch(() => undefined);
  void Promise.all([settings, refreshServers]).then(async ([settings, host]) => {
    if (closed) return;
    if (settings?.mossLive) {
      setKind("moss-live");
      return;
    }
    const canUseCodex = serverId === LOCAL_SERVER_ID || serverSupportsCapability(host, "live-voice-v1");
    if (settings?.codexLive && canUseCodex) {
      const status = await port.agent.getStatus(serverId).catch(() => undefined);
      if (closed) return;
      if (codexLiveAccess(status?.providers) !== "signIn") {
        setKind("codex-live");
        return;
      }
    }
    void port.agent.listAgents(serverId).then(
      (agents) => {
        provider = agents.find((entry) => entry.id === agent.id)?.provider;
      },
      () => undefined,
    );
    setKind("transcribed");
  });
  onCleanup(() => {
    closed = true;
    stopServers();
  });

  function start(mode: VoiceConversationKind) {
    const calls = conversationPort().agent;
    const target = { agentId: agent.id, serverId };
    if (mode === "moss-live") return createMossLiveConversation(speechPort().voice, calls, target);
    if (mode === "codex-live") return createCodexLiveConversation(target);
    if (screen) {
      onCleanup(
        calls.onScopedEvent(({ serverId: from, event }) => {
          if (from === serverId) readDictatedReplies(event, from);
        }),
      );
    }
    return createVoiceConversation({
      ...target,
      voice: conversationRuntime({}).voice,
      submit: async (draft, _target, _snapshot, voice) => {
        const sent = claimDictatedSend(target);
        try {
          const receipt = await calls.sendMessage(
            {
              agentId: agent.id,
              text: draft.text,
              ...(voice.recordingDraftId ? { voiceRecordingDraftId: voice.recordingDraftId } : {}),
            },
            serverId,
          );
          sent?.(receipt.messageId);
          return true;
        } catch {
          return false;
        }
      },
      serverOnline: () => serverId === LOCAL_SERVER_ID || server()?.state === "online",
      progressUpdate: (message) => isNarrationItemId(message.id, provider),
    });
  }

  return (
    <Show
      when={kind()}
      keyed
      fallback={
        <VoicePanel
          agent={agent}
          phase="starting"
          muted={false}
          heard=""
          said=""
          levels={[]}
          error={null}
          showCaptions={false}
          onToggleMute={() => {}}
          onInterrupt={() => {}}
          onEnd={props.onEnd}
        />
      }
    >
      {(mode) => {
        const conversation = start(mode);
        return (
          <VoicePanel
            agent={agent}
            phase={conversation.phase()}
            muted={conversation.muted()}
            heard=""
            said=""
            levels={conversation.levels()}
            error={conversation.error()}
            showCaptions={false}
            onToggleMute={conversation.toggleMute}
            onInterrupt={conversation.interrupt}
            onEnd={props.onEnd}
            speed={mode === "transcribed" ? speechSpeed() : undefined}
            onCycleSpeed={mode === "transcribed" ? cycleSpeechSpeed : undefined}
          />
        );
      }}
    </Show>
  );
}
