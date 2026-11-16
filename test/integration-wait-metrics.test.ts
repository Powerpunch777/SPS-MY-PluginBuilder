import assert from "node:assert/strict";
import test from "node:test";
import { readIntegrationWaitMetrics } from "../src/integration-wait-metrics.ts";
import { createWorkstreamStore } from "../src/workstream-tools.ts";
import { createWorkstreamVerificationPublication, WORKSTREAM_VERIFIED_EVENT,
  WORKSTREAM_VERIFIED_JOB } from "../src/builder-gates/workstream-verification-publication.ts";
import { preparedFixture, MANAGER, MANAGER_SESSION, MANAGER_RUN } from "./fixtures/integration-manager-platform.ts";
import { W, mapKey } from "./fixtures/cto-platform.ts";

const scope = { workspaceId: W, projectId: W };
const base = Date.parse("2026-11-02T00:00:00.000Z");
const at = (ms: number) => new Date(base + ms).toISOString();
const JOB_RUN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/** Builder publication and Manager reservation are real producer paths. All Core Job,
 * AgentSession and timing replies are synthetic DTOs, not Core, model or OS execution. */
async function setup() {
  const fixture = await preparedFixture();
  const { f, eventId } = fixture;
  assert.equal(fixture.job.status, "accepted", JSON.stringify(fixture.job));
  const payload = { status: "observed", event: { eventId, eventType: WORKSTREAM_VERIFIED_EVENT, jobKey: WORKSTREAM_VERIFIED_JOB,
    status: "delivered", attemptCount: 1, createdAt: at(0), deliveredAt: at(6000), nextAttemptAt: at(0) },
  run: { runId: JOB_RUN, status: "succeeded", createdAt: at(1000), startedAt: at(3000), finishedAt: at(5000) } };
  let wakeReads = 0;
  const calls: unknown[] = [];
  let afterWake = () => {};
  Object.assign(f.platform, { hostSupport: { state: "reported", contractVersion: "1.0", operations: ["events.observeJobWakeV1"] } });
  Object.assign(f.platform, { events: { async observeJobWakeV1(input: unknown) {
    wakeReads++; calls.push(structuredClone(input));
    assert.deepEqual(input, { jobKey: WORKSTREAM_VERIFIED_JOB, eventId });
    const result = structuredClone(payload); afterWake(); return result;
  }, async emit() { assert.fail("A metrics read must never emit an event"); } } });
  const managerRun = { runId: MANAGER_RUN, status: "running", cancellationRequested: false,
    termination: "not_applicable" as "not_applicable" | "pending" | "confirmed", errorCode: null, error: null,
    timing: { createdAt: at(3500), startedAt: at(7000) as string | null, finishedAt: null as string | null } };
  f.platform.agents.sessions.getRun = async (sessionId, companyId, runId) => {
    assert.equal(sessionId, MANAGER_SESSION); assert.equal(companyId, W); assert.equal(runId, MANAGER_RUN);
    return structuredClone(managerRun);
  };
  f.platform.agents.sessions.sendMessage = async () => assert.fail("A metrics read must never send a message");
  f.platform.events.emit = async () => assert.fail("A metrics read must never emit an event");
  return { ...fixture, payload, managerRun, calls, get wakeReads() { return wakeReads; },
    setAfterWake(hook: typeof afterWake) { afterWake = hook; } };
}

test("exact current VERIFIED publication and Manager receipt yield separate Job and AI waits without business authority or writes", async () => {
  const f = await setup(), before = structuredClone(f.f.values), sends = f.sends;
  const result = await readIntegrationWaitMetrics(scope, f.f.platform);
  assert.equal(result.status, "ready"); if (result.status !== "ready") return;
  assert.equal(result.completionAuthority, "not-established");
  assert.equal(result.timeSource, "core-verified-wake-created-at-not-a-separate-publication-clock");
  assert.equal(result.planCoverage, "current-plan-context-not-historical-manager-plan-attestation");
  const row = result.workstreams[0]!;
  assert.equal(row.status, "current"); assert.equal(row.eventId, f.eventId);
  const verified = await createWorkstreamVerificationPublication(f.f.state).readLatestCurrent({ ...scope, workstreamId: "ws-1" });
  assert.equal(verified.status, "current"); if (verified.status !== "current") return;
  assert.deepEqual(row.sourcePins, verified.snapshot.sourcePins);
  assert.deepEqual(row.queueWait, { status: "measured", fromAt: at(0), toAt: at(3000), durationMs: 3000, reason: null });
  assert.deepEqual(row.verifiedWakeToManagerStart,
    { status: "measured", fromAt: at(0), toAt: at(7000), durationMs: 7000, reason: null });
  assert.equal(row.jobRunId, JOB_RUN); assert.equal(row.manager?.agentId, MANAGER);
  assert.equal(row.jobStatus, "delivered"); assert.equal(row.jobRunStatus, "succeeded");
  assert.equal(row.manager?.sessionId, MANAGER_SESSION); assert.equal(row.manager?.runId, MANAGER_RUN);
  assert.equal(row.currentPlanRevisionId, f.plan.revisionId);
  assert.deepEqual(f.calls, [{ jobKey: WORKSTREAM_VERIFIED_JOB, eventId: f.eventId }]);
  assert.deepEqual(f.f.values, before); assert.equal(f.sends, sends);
});

test("pending metadata never invents a completed zero-duration wait", async () => {
  const f = await setup();
  Object.assign(f.payload.event, { status: "pending", deliveredAt: null });
  Object.assign(f.payload.run, { status: "queued", startedAt: null, finishedAt: null });
  f.managerRun.status = "queued"; f.managerRun.timing.startedAt = null;
  const result = await readIntegrationWaitMetrics(scope, f.f.platform);
  assert.equal(result.status, "ready"); if (result.status !== "ready") return;
  const row = result.workstreams[0]!;
  assert.equal(row.jobStatus, "pending"); assert.equal(row.jobRunStatus, "queued");
  assert.equal(row.queueWait.status, "waiting"); assert.equal(row.queueWait.durationMs, null);
  assert.equal(row.verifiedWakeToManagerStart.status, "waiting"); assert.equal(row.verifiedWakeToManagerStart.durationMs, null);
});

test("dead event and failed Job Run preserve observed error states without erasing queue timing or granting completion", async () => {
  const f = await setup();
  Object.assign(f.payload.event, { status: "dead", deliveredAt: null });
  f.payload.run.status = "failed";
  const result = await readIntegrationWaitMetrics(scope, f.f.platform);
  assert.equal(result.status, "ready"); if (result.status !== "ready") return;
  const row = result.workstreams[0]!;
  assert.equal(row.jobStatus, "dead"); assert.equal(row.jobRunStatus, "failed");
  assert.equal(row.queueWait.durationMs, 3000);
  assert.equal(row.status, "current", "current refers only to VERIFIED evidence, not successful Job execution");
  assert.equal(result.completionAuthority, "not-established");
});

test("absent or malformed Host advertisement and absent method never fall back", async t => {
  for (const shape of ["absent", "unknown", "wrong-version", "wrong-operation", "duplicate", "getter", "no-method"] as const) {
    await t.test(shape, async () => {
      const f = await setup(), platform = f.f.platform as any;
      if (shape === "absent") delete platform.hostSupport;
      if (shape === "unknown") platform.hostSupport = { state: "unknown", contractVersion: null, operations: [] };
      if (shape === "wrong-version") platform.hostSupport.contractVersion = "2.0";
      if (shape === "wrong-operation") platform.hostSupport.operations = ["events.emitDurableJobWakeV1"];
      if (shape === "duplicate") platform.hostSupport.operations.push("events.observeJobWakeV1");
      if (shape === "getter") Object.defineProperty(platform.hostSupport, "contractVersion", { enumerable: true,
        get() { assert.fail("Host support accessors must not run"); } });
      if (shape === "no-method") delete platform.events.observeJobWakeV1;
      const result = await readIntegrationWaitMetrics(scope, f.f.platform);
      assert.equal(result.status, "ready"); if (result.status !== "ready") return;
      const row = result.workstreams[0]!;
      assert.equal(row.reason, "integration-wait-job-observation-unsupported");
      assert.equal(row.jobStatus, null); assert.equal(row.jobRunStatus, null);
      assert.equal(row.queueWait.durationMs, null); assert.equal(row.verifiedWakeToManagerStart.durationMs, null);
      assert.equal(f.wakeReads, 0);
    });
  }
});

test("permission denial, malformed tuples and invalid Job lifecycle produce no measured intervals or raw reasons", async t => {
  for (const invalid of ["denied", "missing", "foreign-event", "foreign-job", "wrong-type", "invalid-time", "getter",
    "leased-no-run", "delivered-running", "cancelling-finished", "delivery-before-finish", "pending-delivery"] as const) {
    await t.test(invalid, async () => {
      const f = await setup(), api = f.f.platform.events as any;
      if (invalid === "denied") api.observeJobWakeV1 = async () => { throw new Error("PRIVATE_PERMISSION_REASON"); };
      if (invalid === "missing") api.observeJobWakeV1 = async () => ({ status: "missing" });
      if (invalid === "foreign-event") f.payload.event.eventId = "foreign-event";
      if (invalid === "foreign-job") f.payload.event.jobKey = "other-job";
      if (invalid === "wrong-type") f.payload.event.eventType = "sps.protected-test.terminal";
      if (invalid === "invalid-time") f.payload.run.startedAt = at(-1000);
      if (invalid === "getter") api.observeJobWakeV1 = async () => ({ status: "observed", event: {
        ...f.payload.event, get createdAt() { return assert.fail("Observation accessors must not run"); } }, run: f.payload.run });
      if (invalid === "leased-no-run") { f.payload.event.status = "leased"; f.payload.event.deliveredAt = null as any; (f.payload as any).run = null; }
      if (invalid === "delivered-running") { f.payload.run.status = "running"; f.payload.run.finishedAt = null as any; }
      if (invalid === "cancelling-finished") { f.payload.event.status = "leased"; f.payload.event.deliveredAt = null as any; f.payload.run.status = "cancelling"; }
      if (invalid === "delivery-before-finish") f.payload.event.deliveredAt = at(4000);
      if (invalid === "pending-delivery") f.payload.event.status = "pending";
      const result = await readIntegrationWaitMetrics(scope, f.f.platform);
      assert.equal(result.status, "ready"); if (result.status !== "ready") return;
      assert.equal(result.workstreams[0]!.queueWait.durationMs, null);
      assert.equal(result.workstreams[0]!.verifiedWakeToManagerStart.durationMs, null);
      assert(!JSON.stringify(result).includes("PRIVATE_PERMISSION_REASON"));
    });
  }
});

test("missing or mismatched Manager receipt/timing cannot become an AI wait, while exact Job timing remains", async t => {
  for (const invalid of ["no-timing", "foreign-receipt", "foreign-run", "finished-running", "revoked-manager"] as const) {
    await t.test(invalid, async () => {
      const f = await setup(), sessions = f.f.platform.agents.sessions;
      if (invalid === "no-timing") sessions.getRun = async () => {
        const { timing: _timing, ...run } = f.managerRun; return run;
      };
      if (invalid === "foreign-receipt") sessions.getRequest = async () => ({ requestId: JOB_RUN, state: "submitted", runId: MANAGER_RUN });
      if (invalid === "foreign-run") f.managerRun.runId = JOB_RUN;
      if (invalid === "finished-running") f.managerRun.timing.finishedAt = at(8000);
      if (invalid === "revoked-manager") (f.f.platform.agents as any).owned.get = async () => ({ status: "denied" });
      const result = await readIntegrationWaitMetrics(scope, f.f.platform);
      assert.equal(result.status, "ready"); if (result.status !== "ready") return;
      assert.equal(result.workstreams[0]!.queueWait.durationMs, 3000);
      assert.equal(result.workstreams[0]!.verifiedWakeToManagerStart.durationMs, null);
    });
  }
});

test("design, plan, reservation and Manager head drift during observation fail closed", async t => {
  for (const prefix of ["design-baseline-head.v1.", "integration-plan-head.v1.", "verified-consumption.v1.", "integration-manager-agent.v1"]) {
    await t.test(prefix, async () => {
      const f = await setup(); let injected = false;
      f.setAfterWake(() => {
        const key = [...f.f.values.keys()].find(key => JSON.parse(key).stateKey.startsWith(prefix));
        assert(key); f.f.values.delete(key); injected = true;
      });
      const result = await readIntegrationWaitMetrics(scope, f.f.platform);
      assert.equal(injected, true);
      assert.equal(result.status, "unknown");
    });
  }
});

test("unverified additional Workstream remains unavailable without erasing an unrelated exact observation", async () => {
  const f = await setup(), store = createWorkstreamStore(W, W, f.f.state);
  const current = (await store.current())!.revision;
  const record = current.workstreams[0]!;
  assert.equal((await store.publish({ expectedBaseRevisionId: current.revisionId, revision: { ...current,
    revisionId: "wait-metrics-extra-workstream", workstreams: [...current.workstreams,
      { ...record, spec: { ...record.spec, id: "ws-unverified" } }] } })).status, "published");
  const result = await readIntegrationWaitMetrics(scope, f.f.platform);
  assert.equal(result.status, "ready"); if (result.status !== "ready") return;
  assert.equal(result.workstreams.length, 2);
  assert.equal(result.workstreams.find(row => row.workstreamId === "ws-1")!.queueWait.durationMs, 3000);
  assert.equal(result.workstreams.find(row => row.workstreamId === "ws-unverified")!.queueWait.durationMs, null);
  assert.equal(f.wakeReads, 1);
});

test("scope snapshot rejects foreign project/getters and cannot change across an await", async () => {
  const f = await setup();
  assert.deepEqual(await readIntegrationWaitMetrics({ workspaceId: W, projectId: "foreign" }, f.f.platform),
    { status: "unknown", reason: "integration-wait-scope-invalid" });
  assert.deepEqual(await readIntegrationWaitMetrics({ get workspaceId() { return assert.fail("scope getter must not run"); }, projectId: W }, f.f.platform),
    { status: "unknown", reason: "integration-wait-scope-invalid" });
  const input = { ...scope };
  f.setAfterWake(() => { input.workspaceId = JOB_RUN; input.projectId = JOB_RUN; });
  const result = await readIntegrationWaitMetrics(input, f.f.platform);
  assert.equal(result.status, "ready"); if (result.status !== "ready") return;
  assert.equal(result.workspaceId, W); assert.equal(result.projectId, W);
  assert.equal(f.wakeReads, 1);
});
