import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as deadline } from "node:timers/promises";
import { isMossLiveVoice, type MossLiveEvent } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import WebSocket, { WebSocketServer } from "ws";
import { MossLiveSession } from "../src/main/moss-live";

const voice = Bun.argv[2] ?? null;
assert.ok(voice === null || isMossLiveVoice(voice), "Choose nuannuan or mumu, or omit the argument for the default.");
const voiceId = voice === "nuannuan" ? "6c3152b1-1d4f-4e49-ade3-09f447712fec" : "6cc93520-3207-4f7a-bca9-2d560b9c306b";
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const events: MossLiveEvent[] = [];
const controls: string[] = [];
const expected = new AbortController();
let completed: (() => void) | undefined;
const done = new Promise<void>((resolve) => {
  completed = resolve;
});
const timer = deadline(10_000, undefined, { signal: expected.signal }).then(() => {
  throw new Error("MOSS protocol smoke test timed out.");
});
const run = { run_id: "run-1", turn_id: "turn-1" };
const attachIds: Array<string | null> = [];
const recovery = new EventTarget();
let connectionNumber = 0;
server.on("connection", (socket, request) => {
  const connection = ++connectionNumber;
  assert.equal(request.headers.authorization, "Bearer smoke-key");
  let voiceChanged = false;
  const send = (value: { action: string; data: DynamicRecord }) => socket.send(JSON.stringify(value));
  socket.on("message", (raw, binary) => {
    if (binary) {
      assert.equal(raw.toString("hex"), "01000200");
      send({ action: "input.transcript.done", data: { text: "你好" } });
      if (connection !== 1) return;
      send({
        action: "response.function_call_arguments.done",
        data: {
          name: "ask_agent",
          call_id: "call-1",
          arguments: JSON.stringify({ request: "你好" }),
        },
      });
      return;
    }
    const message = JSON.parse(raw.toString());
    assert.ok(isDynamicRecord(message) && typeof message.action === "string");
    controls.push(message.action);
    switch (message.action) {
      case "attach_session": {
        const id = message.session_id;
        assert.ok(id === null || typeof id === "string");
        attachIds.push(id);
        if (connection === 3) {
          send({ action: "error", data: { error: { code: "session_option_mismatch" } } });
          break;
        }
        send({
          action: "session_attached",
          data: { session_id: connection === 1 ? "moss-smoke" : (id ?? "new-smoke") },
        });
        break;
      }
      case "change_voice":
        assert.ok(voice);
        assert.equal(message.voice_name, voiceId);
        voiceChanged = true;
        send({ action: "voice_changed", data: { name: voiceId } });
        break;
      case "session.update":
        assert.equal(voiceChanged, voice !== null);
        assert.ok(isDynamicRecord(message.session) && Array.isArray(message.session.tools));
        assert.match(String(message.session.instructions), /general questions directly/u);
        assert.match(String(message.session.instructions), /without announcing the handoff/u);
        send({ action: "session.updated", data: { error: "" } });
        break;
      case "mic_state":
        if (connection > 1) {
          assert.equal(message.enabled, true);
          recovery.dispatchEvent(new Event(`mic-${connection}`));
        }
        break;
      case "conversation.item.create":
        assert.ok(isDynamicRecord(message.item));
        assert.equal(message.item.call_id, "call-1");
        assert.equal(message.item.output, "你好，我是 OpenBot。");
        send({
          action: "conversation.item.created",
          data: { item: { type: "function_call_output", call_id: "call-1" } },
        });
        break;
      case "response.create":
        send({ action: "output.transcript.done", data: { text: "你好，我是 OpenBot。" } });
        send({ action: "response.audio.context", data: { ...run, chunk_id: "chunk-1" } });
        socket.send(Buffer.from([1, 0, 2, 0]));
        send({ action: "response.audio.done", data: run });
        break;
      case "playback.completed":
        completed?.();
        break;
    }
  });
});
const session = new MossLiveSession(
  "smoke-key",
  voice,
  (event) => {
    events.push(event);
    recovery.dispatchEvent(new Event(event.type));
    if (event.type === "request")
      session.control({ action: "answer", callId: event.callId, text: "你好，我是 OpenBot。" });
    if (event.type === "audio") {
      assert.deepEqual([...event.pcm], [1, 0, 2, 0]);
      session.control({ action: "played", runId: event.runId, turnId: event.turnId, chunkId: event.chunkId });
    }
    if (event.type === "done") session.control({ action: "completed", runId: event.runId, turnId: event.turnId });
  },
  (key) => new WebSocket(`ws://127.0.0.1:${address.port}`, { headers: { Authorization: `Bearer ${key}` } }),
);
try {
  await Effect.runPromise(session.ready);
  session.control({ action: "mic", enabled: true });
  session.audio(new Uint8Array([1, 0, 2, 0]));
  await Promise.race([done, timer]);
  assert.deepEqual(
    events.map((event) => event.type),
    ["transcript", "request", "transcript", "audio", "done"],
  );
  assert.deepEqual(controls, [
    "attach_session",
    ...(voice ? ["change_voice"] : []),
    "session.update",
    "mic_state",
    "conversation.item.create",
    "response.create",
    "playback.chunk.completed",
    "playback.completed",
  ]);

  const first = [...server.clients][0];
  assert.ok(first);
  const afterRequestError = once(recovery, "transcript");
  first.send(JSON.stringify({ action: "error", data: { error: { code: "invalid_public_request" } } }));
  first.send(JSON.stringify({ action: "input.transcript.done", data: { text: "still connected" } }));
  await Promise.race([afterRequestError, timer]);
  assert.equal(
    events.some((event) => event.type === "ended"),
    false,
  );

  const restored = Promise.all([once(recovery, "reconnected"), once(recovery, "mic-2")]);
  first.terminate();
  await Promise.race([restored, timer]);
  assert.deepEqual(events.at(-1), { type: "reconnected", resumed: true });
  const afterReconnect = once(recovery, "transcript");
  session.audio(new Uint8Array([1, 0, 2, 0]));
  await Promise.race([afterReconnect, timer]);

  const second = [...server.clients][0];
  assert.ok(second);
  const replaced = Promise.all([once(recovery, "reconnected"), once(recovery, "mic-4")]);
  second.terminate();
  await Promise.race([replaced, timer]);
  assert.deepEqual(events.at(-1), { type: "reconnected", resumed: false });
  assert.deepEqual(attachIds, [null, "moss-smoke", "moss-smoke", null]);

  const fourth = [...server.clients][0];
  assert.ok(fourth);
  const reconnecting = once(recovery, "reconnecting");
  fourth.terminate();
  await Promise.race([reconnecting, timer]);
  session.close();
  assert.equal(connectionNumber, 4);
  assert.ok(events.every((event) => event.type !== "ended"));
  mkdirSync(".openbot-build/moss-live", { recursive: true });
  writeFileSync(
    `.openbot-build/moss-live/protocol${voice ? `-${voice}` : ""}-report.json`,
    JSON.stringify({ voice, controls, attachIds, events: events.map((event) => event.type), passed: true }, null, 2),
  );
} finally {
  expected.abort();
  session.close();
  for (const socket of server.clients) socket.terminate();
  server.close();
}
