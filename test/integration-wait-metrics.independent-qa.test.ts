import assert from "node:assert/strict";
import test from "node:test";
import { readBuilderExecutionMetrics } from "../src/execution-metrics.ts";
import { createWorkstreamVerificationPublication } from "../src/builder-gates/workstream-verification-publication.ts";
import { preparedFixture, MANAGER, MANAGER_SESSION, MANAGER_RUN } from "./fixtures/integration-manager-platform.ts";
import { W, mapKey } from "./fixtures/cto-platform.ts";

const scope = { workspaceId: W, projectId: W };
const base = Date.parse("2026-11-02T00:00:00.000Z");
const at = (ms: number) => new Date(base + ms).toISOString();
const JOB_RUN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const privateReason = "PRIVATE_CORE_PERMISSION_DETAIL";

async function fixture() {
  const prepared = await preparedFixture();
  const { f, eventId } = prepared;
  const payload: any = { status: "observed", event: { eventId,
    eventType: "builder.workstream.verified", jobKey: "builder.integrate-verified-workstream",
    status: "delivered", attemptCount: 1, createdAt: at(0), deliveredAt: at(6000), nextAttemptAt: at(0) },
  run: { runId: JOB_RUN, status: "succeeded", createdAt: at(1000), startedAt: at(3000), finishedAt: at(5000) } };
  let reads = 0;
  let afterRead = () => {};
  let managerStartedAt: string | null = at(7000);
  const platform = f.platform as any;
  platform.hostSupport = { state: "reported", contractVersion: "1.0", operations: ["events.observeJobWakeV1"] };
  platform.events = { async observeJobWakeV1(input: unknown) {
    reads++;
    assert.deepEqual(input, { jobKey: payload.event.jobKey, eventId });
    const result = structuredClone(payload);
    afterRead();
    return result;
  }, async emit() { assert.fail("Metrics observation must not emit an event"); } };
  platform.agents.sessions.getRun = async (sessionId: string, workspaceId: string, runId: string) => {
    assert.equal(sessionId, MANAGER_SESSION); assert.equal(workspaceId, W); assert.equal(runId, MANAGER_RUN);
    return { runId: MANAGER_RUN, status: "running", cancellationRequested: false, termination: "not_applicable",
      errorCode: null, error: null, timing: { createdAt: at(3500), startedAt: managerStartedAt, finishedAt: null } };
  };
  platform.agents.sessions.sendMessage = async () => assert.fail("Metrics observation must not dispatch a Manager request");

  const state = f.state as any;
  const originalWake = state.guardedCompareAndSetWithJobWakeV1;
  let wakeWrites = 0;
  state.guardedCompareAndSetWithJobWakeV1 = async (...args: unknown[]) => {
    wakeWrites++;
    return originalWake(...args);
  };
  return { ...prepared, f, payload, setAfterRead(hook: typeof afterRead) { afterRead = hook; },
    setManagerStarted(value: boolean) { managerStartedAt = value ? at(7000) : null; },
    get reads() { return reads; }, get wakeWrites() { return wakeWrites; } };
}

function cloneValues(values: Map<string, unknown>) {
  return new Map([...values].map(([key, value]) => [key, structuredClone(value)]));
}

function onlyRemovedKey(before: Map<string, unknown>, after: Map<string, unknown>, removed: string) {
  assert.equal(after.has(removed), false, "the injected source-head revocation remains the only change");
  assert.equal(after.size, before.size - 1);
  for (const [key, value] of before) if (key !== removed) assert.deepEqual(after.get(key), value, `unexpected state change: ${key}`);
}

test("Main metrics connection projects real current verification without creating work or claiming completion", async () => {
  const f = await fixture(), before = cloneValues(f.f.values), writes = f.f.writes, sends = f.sends;
  const result = await readBuilderExecutionMetrics(W, f.f.platform);
  assert.equal(result.status, "ready"); if (result.status !== "ready") return;
  assert.equal(result.completionAuthority, "not-established");
  assert.equal(result.integration?.status, "ready"); if (result.integration?.status !== "ready") return;
  const row = result.integration.workstreams.find(item => item.workstreamId === "ws-1");
  assert.ok(row);
  assert.equal(row.eventId, f.eventId);
  const verified = await createWorkstreamVerificationPublication(f.f.state).readLatestCurrent({
    ...scope, workstreamId: row.workstreamId,
  });
  assert.equal(verified.status, "current"); if (verified.status !== "current") return;
  assert.deepEqual(row.sourcePins, verified.snapshot.sourcePins);
  assert.deepEqual([row.jobStatus, row.jobRunStatus, row.jobRunId], ["delivered", "succeeded", JOB_RUN]);
  assert.deepEqual([row.queueWait.status, row.queueWait.durationMs], ["measured", 3000]);
  assert.deepEqual([row.verifiedWakeToManagerStart.status, row.verifiedWakeToManagerStart.durationMs], ["measured", 7000]);
  assert.deepEqual(row.manager, { agentId: MANAGER, sessionId: MANAGER_SESSION,
    requestId: row.manager?.requestId, runId: MANAGER_RUN });
  assert.equal(f.reads, 1); assert.equal(f.wakeWrites, 0);
  assert.deepEqual([...f.f.values], [...before]); assert.equal(f.f.writes, writes); assert.equal(f.sends, sends);
});

test("denied, unadvertised, and mismatched Core observations remain unavailable rather than zero", async t => {
  for (const mode of ["denied", "unadvertised", "foreign-event"] as const) {
    await t.test(mode, async () => {
      const f = await fixture(), before = cloneValues(f.f.values), writes = f.f.writes, sends = f.sends;
      const platform = f.f.platform as any;
      let deniedCalls = 0;
      if (mode === "denied") platform.events.observeJobWakeV1 = async () => { deniedCalls++; throw new Error(privateReason); };
      if (mode === "unadvertised") platform.hostSupport.operations = ["events.emitDurableJobWakeV1"];
      if (mode === "foreign-event") f.payload.event.eventId = "foreign-event";
      const result = await readBuilderExecutionMetrics(W, f.f.platform);
      assert.equal(result.status, "ready"); if (result.status !== "ready") return;
      assert.equal(result.integration?.status, "ready"); if (result.integration?.status !== "ready") return;
      const row = result.integration.workstreams.find(item => item.workstreamId === "ws-1"); assert.ok(row);
      assert.equal(row.jobStatus, null); assert.equal(row.jobRunStatus, null); assert.equal(row.jobRunId, null);
      assert.equal(row.queueWait.durationMs, null); assert.equal(row.verifiedWakeToManagerStart.durationMs, null);
      assert.notEqual(row.queueWait.status, "measured"); assert.notEqual(row.verifiedWakeToManagerStart.status, "measured");
      assert(!JSON.stringify(result).includes(privateReason));
      assert.equal(mode === "denied" ? deniedCalls : f.reads, mode === "unadvertised" ? 0 : 1);
      assert.equal(f.wakeWrites, 0);
      assert.deepEqual([...f.f.values], [...before]); assert.equal(f.f.writes, writes); assert.equal(f.sends, sends);
    });
  }
});

test("failed/dead metadata stays distinct from a pending wait and never implies completion", async t => {
  for (const mode of ["failed", "waiting"] as const) {
    await t.test(mode, async () => {
      const f = await fixture();
      if (mode === "failed") {
        Object.assign(f.payload.event, { status: "dead", deliveredAt: null });
        f.payload.run.status = "failed";
      } else {
        f.setManagerStarted(false);
        Object.assign(f.payload.event, { status: "pending", deliveredAt: null });
        Object.assign(f.payload.run, { status: "queued", startedAt: null, finishedAt: null });
      }
      const result = await readBuilderExecutionMetrics(W, f.f.platform);
      assert.equal(result.status, "ready"); if (result.status !== "ready") return;
      assert.equal(result.completionAuthority, "not-established");
      assert.equal(result.integration?.status, "ready"); if (result.integration?.status !== "ready") return;
      const row = result.integration.workstreams.find(item => item.workstreamId === "ws-1"); assert.ok(row);
      if (mode === "failed") {
        assert.deepEqual([row.jobStatus, row.jobRunStatus], ["dead", "failed"]);
        assert.deepEqual([row.queueWait.status, row.queueWait.durationMs], ["measured", 3000]);
        assert.equal(row.status, "current", "current denotes source verification, not successful Job execution");
      } else {
        assert.deepEqual([row.jobStatus, row.jobRunStatus], ["pending", "queued"]);
        assert.deepEqual([row.queueWait.status, row.queueWait.durationMs], ["waiting", null]);
        assert.deepEqual([row.verifiedWakeToManagerStart.status, row.verifiedWakeToManagerStart.durationMs], ["waiting", null]);
      }
      assert.equal(f.wakeWrites, 0);
    });
  }
});

test("final guarded verification reread catches a design-baseline-head race", async () => {
  const f = await fixture(), values = f.f.values as Map<string, any>;
  const guardedHead = [...values.keys()].find(key => JSON.parse(key).stateKey.startsWith("design-baseline-head.v1."));
  assert.ok(guardedHead, "the actual G5 verification publication binds a design-baseline guard");
  const before = cloneValues(values), writes = f.f.writes, sends = f.sends;
  let guardedHeadReads = 0;
  const platform = f.f.platform as any, originalGet = platform.state.get.bind(platform.state);
  platform.state.get = async (key: unknown) => {
    if (mapKey(key as never) === guardedHead) guardedHeadReads++;
    return originalGet(key);
  };
  f.setAfterRead(() => values.delete(guardedHead));

  const result = await readBuilderExecutionMetrics(W, f.f.platform);
  assert.ok(guardedHeadReads >= 1, "the design head participates in current verification guard reads");
  assert.equal(result.status, "ready", "the unrelated execution metrics remain readable");
  if (result.status !== "ready") return;
  assert.equal(result.integration?.status, "unknown", "head revocation invalidates the complete integration projection");
  onlyRemovedKey(before, values, guardedHead);
  assert.equal(f.reads, 1); assert.equal(f.wakeWrites, 0);
  assert.equal(f.f.writes, writes); assert.equal(f.sends, sends);
});

test("Manager authority drift during the observation cannot retain its timing or trigger work", async () => {
  const f = await fixture(), values = f.f.values as Map<string, any>;
  const managerHead = [...values.keys()].find(key => JSON.parse(key).stateKey.startsWith("integration-manager-agent.v1"));
  assert.ok(managerHead);
  const before = cloneValues(values), writes = f.f.writes, sends = f.sends;
  f.setAfterRead(() => values.delete(managerHead));

  const result = await readBuilderExecutionMetrics(W, f.f.platform);
  assert.equal(result.status, "unknown", "root-captured Manager authority drift invalidates the combined read");
  onlyRemovedKey(before, values, managerHead);
  assert.equal(f.reads, 1); assert.equal(f.wakeWrites, 0);
  assert.equal(f.f.writes, writes); assert.equal(f.sends, sends);
});
