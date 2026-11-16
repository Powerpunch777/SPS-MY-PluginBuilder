import assert from "node:assert/strict";
import test from "node:test";
import { consumeVerifiedWorkstreamJob } from "../src/builder-gates/integration-manager-job.ts";
import { WORKSTREAM_VERIFIED_JOB } from "../src/builder-gates/workstream-verification-publication.ts";
import { preparedFixture, MANAGER_SESSION } from "./fixtures/integration-manager-platform.ts";
import { W } from "./fixtures/cto-platform.ts";

test("a Core skipped/no-Run diagnostic preserves Manager uncertainty without granting a resend", async () => {
  const setup = await preparedFixture();
  const { f } = setup;
  assert.equal(setup.job.status, "accepted");
  const stored = [...f.values].find(([address]) => JSON.parse(address).stateKey.startsWith("verified-consumption.v1."));
  assert.ok(stored);
  const ledger = structuredClone(stored[1]) as any;
  ledger.revision++;
  ledger.events[0].status = "uncertain";
  ledger.events[0].receipt = null;
  f.values.set(stored[0], ledger);
  let sends = 0, runReads = 0, diagnosticReads = 0;
  const sessions = f.platform.agents.sessions;
  sessions.sendMessage = async () => { sends++; throw new Error("A diagnostic cannot authorize a replacement Run"); };
  sessions.getRun = async () => { runReads++; throw new Error("No Run exists for this receipt"); };
  (sessions as any).getRequest = async (sessionId: string, workspaceId: string, requestId: string, options?: { includeDiagnostic: true }) => {
    assert.equal(sessionId, MANAGER_SESSION);
    assert.equal(workspaceId, W);
    if (options) diagnosticReads++;
    return { requestId, state: "uncertain", runId: null,
      ...(options ? { diagnostic: { kind: "not_started", wakeupStatus: "skipped" } } : {}) };
  };
  for (let index = 0; index < 2; index++) {
    const result = await consumeVerifiedWorkstreamJob({ jobKey: WORKSTREAM_VERIFIED_JOB, trigger: "event", eventId: setup.eventId,
      companyId: W, runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, f.platform);
    assert.equal(result.status, "uncertain");
    assert.equal(result.reason, "manager-request-confirmed-not-started-no-automatic-retry");
  }
  const current = f.values.get(stored[0]) as any;
  assert.equal(current.events[0].status, "uncertain");
  assert.equal(current.events[0].dispatchAttempts, 1);
  assert.equal(current.events[0].receipt, null);
  assert.deepEqual({ sends, runReads, diagnosticReads }, { sends: 0, runReads: 0, diagnosticReads: 2 });
});
