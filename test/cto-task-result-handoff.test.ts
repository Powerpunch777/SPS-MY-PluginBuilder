import assert from "node:assert/strict";
import test from "node:test";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { consumeCtoTaskResultTerminal } from "../src/cto-task-result-handoff.ts";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const event = Object.freeze({ schemaVersion: 1, runId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222", requestId: "33333333-3333-4333-8333-333333333333",
  status: "succeeded", resultSha256: "a".repeat(64), finishedAt: "2026-11-08T00:00:00.000Z" });
const eventId = `agent-session-terminal-v1:${"b".repeat(64)}`;

function platform() {
  const calls: string[] = [];
  const value = { state: { async get() { return null; } }, agents: { sessions: {
    async getRequest() { calls.push("getRequest"); return null; },
    async getRun() { calls.push("getRun"); return null; },
  } } } as unknown as SpsPlatformInvocationContext;
  return { value, calls };
}

test("returns not-applicable for unrelated terminal events even when the optional Core event API is unsupported", async () => {
  const fixture = platform();
  const result = await consumeCtoTaskResultTerminal(workspaceId, eventId, event, fixture.value);
  assert.deepEqual(result, { status: "not-applicable", reason: "no-current-workstream-board" });
  assert.deepEqual(fixture.calls, []);
});

test("rejects malformed terminal facts before reading state or dispatching", async () => {
  const fixture = platform();
  let stateReads = 0;
  (fixture.value.state as unknown as { get(): Promise<null> }).get = async () => { stateReads += 1; return null; };
  await assert.rejects(() => consumeCtoTaskResultTerminal(workspaceId, eventId, { ...event, status: "running" }, fixture.value),
    /canonical actual Core terminal observation/);
  assert.equal(stateReads, 0);
  assert.deepEqual(fixture.calls, []);
});

test("malformed source job event identity fails closed", async () => {
  const fixture = platform();
  const result = await consumeCtoTaskResultTerminal(workspaceId, "not-an-event-id", event, fixture.value);
  assert.deepEqual(result, { status: "unknown", reason: "invalid-terminal-event-identity" });
  assert.deepEqual(fixture.calls, []);
});
