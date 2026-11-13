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
server.on("connection", (socket, request) => {
  assert.equal(request.headers.authorization, "Bearer smoke-key");
  let voiceChanged = false;
  const send = (value: { action: string; data: DynamicRecord }) => socket.send(JSON.stringify(value));
  socket.on("message", (raw, binary) => {
    if (binary) {
      assert.equal(raw.toString("hex"), "01000200");
      send({ action: "input.transcript.done", data: { text: "你好" } });
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
      case "attach_session":
        send({ action: "session_attached", data: { session_id: "moss-smoke" } });
        break;
      case "change_voice":
        assert.ok(voice);
        assert.equal(message.voice_name, voiceId);
        voiceChanged = true;
        send({ action: "voice_changed", data: { name: voiceId } });
        break;
      case "session.update":
        assert.equal(voiceChanged, voice !== null);
        assert.ok(isDynamicRecord(message.session) && Array.isArray(message.session.tools));
        send({ action: "session.updated", data: { error: "" } });
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
  mkdirSync(".openbot-build/moss-live", { recursive: true });
  writeFileSync(
    `.openbot-build/moss-live/protocol${voice ? `-${voice}` : ""}-report.json`,
    JSON.stringify({ voice, controls, events: events.map((event) => event.type) }, null, 2),
  );
} finally {
  expected.abort();
  session.close();
  for (const socket of server.clients) socket.terminate();
  server.close();
}
