import assert from "node:assert/strict";
import test from "node:test";
import { hasConfirmedNotStartedSessionRequest } from "../src/session-request-diagnostic.ts";

const sessionId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const receipt = { requestId, state: "uncertain", runId: null, diagnostic: { kind: "not_started", wakeupStatus: "skipped" } };

test("requests one exact read-only opt-in diagnostic and rechecks the caller's current scope", async () => {
  const calls: unknown[] = [];
  let checks = 0;
  const result = await hasConfirmedNotStartedSessionRequest({ sessions: { async getRequest(...args) { calls.push(args); return receipt; } },
    sessionId, workspaceId, requestId, async assertCurrent() { checks++; } });
  assert.equal(result, true);
  assert.deepEqual(calls, [[sessionId, workspaceId, requestId, { includeDiagnostic: true }]]);
  assert.equal(checks, 2);
});

test("legacy, late Run, malformed and unrelated diagnostics do not establish non-execution", async () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({ ...receipt }, "diagnostic", { enumerable: true, get() { getterCalls++; return receipt.diagnostic; } });
  for (const value of [null, { requestId, state: "uncertain", runId: null }, { ...receipt, state: "submitted" },
    { ...receipt, runId: sessionId }, { ...receipt, requestId: workspaceId }, { ...receipt, state: "queued" },
    { ...receipt, diagnostic: { kind: "not_started", wakeupStatus: "deferred" } },
    { ...receipt, diagnostic: { ...receipt.diagnostic, retryAllowed: true } }, accessor]) {
    const result = await hasConfirmedNotStartedSessionRequest({ sessions: { async getRequest() { return value; } },
      sessionId, workspaceId, requestId, async assertCurrent() {} });
    assert.equal(result, false);
  }
  assert.equal(getterCalls, 0);
});

test("unsupported or failed lookup stays unknown but does not hide revoked scope", async () => {
  const sessions = { async getRequest(): Promise<unknown> { throw new Error("Host does not accept this opt-in"); } };
  assert.equal(await hasConfirmedNotStartedSessionRequest({ sessions, sessionId, workspaceId, requestId, async assertCurrent() {} }), false);
  let checks = 0;
  await assert.rejects(() => hasConfirmedNotStartedSessionRequest({ sessions, sessionId, workspaceId, requestId,
    async assertCurrent() { if (++checks === 2) throw new Error("Current scope revoked"); } }), /scope revoked/u);
});
