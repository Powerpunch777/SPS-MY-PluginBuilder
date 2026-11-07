import assert from "node:assert/strict";
import test from "node:test";
import { readBuilderExecutionMetrics, readExecutionTiming } from "../src/execution-metrics.ts";
import { createBuilderPlatform } from "../src/platform.ts";
import { taskWorkerRegistryKey } from "../src/domain/task-workers.ts";
import { setupVerifiedWorkstreamPlatform } from "./fixtures/verified-workstream-platform.ts";
import { W, CTO, key, mapKey } from "./fixtures/cto-platform.ts";

const timing = { createdAt: "2026-11-02T00:00:00.000Z", startedAt: "2026-11-02T00:00:02.000Z", finishedAt: "2026-11-02T00:00:07.000Z" };
const observedAt = "2026-11-02T01:00:00.000Z";

test("execution timing uses recorded timestamps, not successful status or current time", () => {
  assert.deepEqual(readExecutionTiming(timing, "succeeded", observedAt), { timing, queueMs: 2000, executionMs: 5000 });
  assert.deepEqual(readExecutionTiming({ ...timing, finishedAt: null }, "running", observedAt), {
    timing: { ...timing, finishedAt: null }, queueMs: 2000, executionMs: null,
  });
  assert.deepEqual(readExecutionTiming({ ...timing, startedAt: null, finishedAt: null }, "queued", observedAt), {
    timing: { ...timing, startedAt: null, finishedAt: null }, queueMs: null, executionMs: null,
  });
  assert.equal(readExecutionTiming(undefined, "succeeded", observedAt), null);
  assert.equal(readExecutionTiming(null, "succeeded", observedAt), null);
});

test("malformed, reversed, future, active-finished and accessor timing are unmeasured", () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({ ...timing }, "startedAt", { enumerable: true, get() { getterCalls++; return timing.startedAt; } });
  for (const invalid of [accessor, { ...timing, extra: true }, { ...timing, createdAt: "2026-11-02" },
    { ...timing, startedAt: "2026-11-01T00:00:00.000Z" }, { ...timing, finishedAt: "2026-11-02T00:00:01.000Z" },
    { ...timing, finishedAt: "2026-11-03T00:00:00.000Z" }, { ...timing, startedAt: null },
    { ...timing, createdAt: "+275760-09-13T00:00:00.000Z" }]) {
    assert.equal(readExecutionTiming(invalid, "succeeded", observedAt), null);
  }
  assert.equal(readExecutionTiming(timing, "running", observedAt), null);
  assert.equal(readExecutionTiming(timing, "queued", observedAt), null);
  assert.equal(getterCalls, 0);
});

test("old Host current Run observations stay read-only and unmeasured, never business completion", async () => {
  const { f } = await setupVerifiedWorkstreamPlatform();
  const before = { writes: f.writes, sends: f.sends, cancels: f.cancelCalls, values: JSON.stringify([...f.values]) };
  const result = await readBuilderExecutionMetrics(W, f.platform);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.runs.length, 2);
  assert.equal(result.summary.observedRuns, 2);
  assert.equal(result.summary.measuredRuns, 0);
  assert.equal(result.summary.totalExecutionMs, null);
  assert.equal(result.summary.totalQueueMs, null);
  assert.ok(result.runs.every(run => run.timing === null && run.executionMs === null && run.queueMs === null));
  assert.equal(result.completionAuthority, "not-established");
  assert.deepEqual(Object.values(result.unmeasured), [null, null, null, null, null]);
  assert.deepEqual({ writes: f.writes, sends: f.sends, cancels: f.cancelCalls, values: JSON.stringify([...f.values]) }, before);
});

test("exact Run timing aggregates observed AI duration without Task or QA authority", async () => {
  const { f } = await setupVerifiedWorkstreamPlatform();
  const sessions = f.platform.agents.sessions;
  const original = sessions.getRun.bind(sessions);
  sessions.getRun = async (...args) => ({ ...await original(...args), status: "succeeded", termination: "not_applicable", timing });
  const result = await readBuilderExecutionMetrics(W, f.platform);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.deepEqual(result.summary, { observedRuns: 2, normalEndedRuns: 2, measuredRuns: 2, totalExecutionMs: 10000,
    totalQueueMs: 4000, commitAcceptanceCount: 1, totalCommitAcceptanceMs: result.runs.find(run => run.role === "worker")!.commitAcceptanceMs });
  assert.deepEqual(result.runs.map(run => [run.role, run.executionMs, run.queueMs]), [["worker", 5000, 2000], ["qa", 5000, 2000]]);
  assert.equal(result.completionAuthority, "not-established");
  assert.equal(result.unmeasured.taskCompletionMs, null);
});

test("current Worker submission and exact CTO acceptance add only their recorded timestamp interval", async () => {
  const { f } = await setupVerifiedWorkstreamPlatform();
  const result = await readBuilderExecutionMetrics(W, f.platform);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  const worker = result.runs.find(run => run.role === "worker");
  const qa = result.runs.find(run => run.role === "qa");
  assert.ok(worker);
  assert.ok(worker.commitAcceptanceMs !== null && worker.commitAcceptanceMs >= 0);
  assert.equal(qa?.commitAcceptanceMs, null, "a QA source report is not a Worker implementation submission");
  assert.deepEqual([result.summary.commitAcceptanceCount, result.summary.totalCommitAcceptanceMs],
    [1, worker.commitAcceptanceMs]);
});

test("missing or invalid exact CTO acceptance timestamps remain unmeasured", async () => {
  const missing = await setupVerifiedWorkstreamPlatform();
  const acceptanceKey = [...missing.f.values.keys()].find(address => {
    const parsed = JSON.parse(address) as { stateKey?: string };
    return parsed.stateKey?.startsWith("task-source-acceptance.v1.");
  });
  assert.ok(acceptanceKey);
  missing.f.values.delete(acceptanceKey!);
  const withoutAcceptance = await readBuilderExecutionMetrics(W, missing.f.platform);
  assert.equal(withoutAcceptance.status, "ready");
  if (withoutAcceptance.status === "ready") {
    assert.ok(withoutAcceptance.runs.filter(run => run.role === "worker").every(run => run.commitAcceptanceMs === null));
    assert.equal(withoutAcceptance.summary.commitAcceptanceCount, 0);
    assert.equal(withoutAcceptance.summary.totalCommitAcceptanceMs, null);
  }

  const malformed = await setupVerifiedWorkstreamPlatform();
  const address = [...malformed.f.values.keys()].find(value => JSON.parse(value).stateKey?.startsWith("task-source-acceptance.v1."));
  assert.ok(address);
  const receipt = structuredClone(malformed.f.values.get(address!)) as Record<string, unknown>;
  receipt.receivedAt = "not-a-timestamp";
  malformed.f.values.set(address!, receipt as never);
  const invalidTime = await readBuilderExecutionMetrics(W, malformed.f.platform);
  assert.equal(invalidTime.status, "ready");
  if (invalidTime.status === "ready") {
    assert.ok(invalidTime.runs.filter(run => run.role === "worker").every(run => run.commitAcceptanceMs === null));
    assert.equal(invalidTime.summary.commitAcceptanceCount, 0);
  }

  const invalidSubmission = await setupVerifiedWorkstreamPlatform();
  const outcomeAddress = [...invalidSubmission.f.values.keys()].find(value => JSON.parse(value).stateKey?.startsWith("task-source-outcome.v2."));
  assert.ok(outcomeAddress);
  const outcome = structuredClone(invalidSubmission.f.values.get(outcomeAddress!)) as any;
  outcome.outcome.submission.submittedAt = "not-a-timestamp";
  invalidSubmission.f.values.set(outcomeAddress!, outcome);
  const invalidSubmittedAt = await readBuilderExecutionMetrics(W, invalidSubmission.f.platform);
  assert.equal(invalidSubmittedAt.status, "ready");
  if (invalidSubmittedAt.status === "ready") {
    assert.ok(invalidSubmittedAt.runs.filter(run => run.role === "worker").every(run => run.commitAcceptanceMs === null));
    assert.equal(invalidSubmittedAt.summary.commitAcceptanceCount, 0);
  }

  const reversed = await setupVerifiedWorkstreamPlatform();
  const reversedAcceptanceKey = [...reversed.f.values.keys()].find(value => JSON.parse(value).stateKey?.startsWith("task-source-acceptance.v1."));
  assert.ok(reversedAcceptanceKey);
  const reversedAcceptance = structuredClone(reversed.f.values.get(reversedAcceptanceKey!)) as any;
  reversedAcceptance.receivedAt = "2000-01-01T00:00:00.000Z";
  reversed.f.values.set(reversedAcceptanceKey!, reversedAcceptance);
  const reversedResult = await readBuilderExecutionMetrics(W, reversed.f.platform);
  assert.equal(reversedResult.status, "ready");
  if (reversedResult.status === "ready") {
    assert.ok(reversedResult.runs.filter(run => run.role === "worker").every(run => run.commitAcceptanceMs === null));
    assert.equal(reversedResult.summary.commitAcceptanceCount, 0);
  }
});

test("failed or cancellation-requested Run cannot become normally ended", async () => {
  const { f } = await setupVerifiedWorkstreamPlatform();
  const sessions = f.platform.agents.sessions, original = sessions.getRun.bind(sessions);
  sessions.getRun = async (...args) => ({ ...await original(...args), status: "failed", timing });
  const failed = await readBuilderExecutionMetrics(W, f.platform);
  assert.equal(failed.status, "ready");
  if (failed.status !== "ready") return;
  assert.equal(failed.summary.normalEndedRuns, 0);
  assert.equal(failed.summary.measuredRuns, 2);
  sessions.getRun = async (...args) => ({ ...await original(...args), status: "succeeded", termination: "not_applicable", cancellationRequested: true, timing });
  const cancelled = await readBuilderExecutionMetrics(W, f.platform);
  assert.equal(cancelled.status, "ready");
  if (cancelled.status === "ready") assert.equal(cancelled.summary.normalEndedRuns, 0);
});

test("timing accessors are not invoked and do not hide otherwise observed Runs", async () => {
  const { f } = await setupVerifiedWorkstreamPlatform();
  let getterCalls = 0;
  const sessions = f.platform.agents.sessions, original = sessions.getRun.bind(sessions);
  sessions.getRun = async (...args) => Object.defineProperty({ ...await original(...args) }, "timing", {
    enumerable: true, get() { getterCalls++; return timing; },
  });
  const result = await readBuilderExecutionMetrics(W, f.platform);
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.equal(result.summary.measuredRuns, 0);
  assert.equal(getterCalls, 0);
});

test("current Worker registry mutation during Run read invalidates the projection", async () => {
  const { f } = await setupVerifiedWorkstreamPlatform();
  const sessions = f.platform.agents.sessions, original = sessions.getRun.bind(sessions);
  let changed = false;
  sessions.getRun = async (...args) => {
    if (!changed) {
      changed = true;
      const address = mapKey(key(taskWorkerRegistryKey(W, CTO)));
      const value = f.values.get(address) as unknown as { revision: number };
      f.values.set(address, { ...value, revision: value.revision + 1 } as never);
    }
    return { ...await original(...args), timing };
  };
  assert.deepEqual(await readBuilderExecutionMetrics(W, f.platform), {
    status: "unknown", reason: "metrics-current-scope-or-run-observation-unavailable",
  });
});

test("a Worker record not bound to the exact current Task Packet is excluded", async () => {
  const { f } = await setupVerifiedWorkstreamPlatform();
  const address = mapKey(key(taskWorkerRegistryKey(W, CTO)));
  const registry = structuredClone(f.values.get(address)) as any;
  registry.records[0].packetRevision++;
  f.values.set(address, registry);
  const result = await readBuilderExecutionMetrics(W, f.platform);
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.deepEqual(result.runs.map(run => run.role), ["qa"]);
});

test("later Task observation does not reread an unrelated acceptance until the final consistency check", async () => {
  for (const drift of [false, true]) {
    const { f } = await setupVerifiedWorkstreamPlatform();
    const address = [...f.values.keys()].find(value => JSON.parse(value).stateKey?.startsWith("task-source-acceptance.v1."));
    assert.ok(address);
    const sessions = f.platform.agents.sessions;
    const originalRequest = sessions.getRequest.bind(sessions);
    const originalGet = f.platform.state.get.bind(f.platform.state);
    let requests = 0, priorAcceptanceReadsDuringQa = 0;
    sessions.getRequest = async (...args) => {
      if (++requests === 2 && drift) f.values.delete(address);
      return originalRequest(...args);
    };
    f.platform.state.get = async input => {
      if (requests >= 2 && mapKey(input) === address) priorAcceptanceReadsDuringQa++;
      return originalGet(input);
    };
    const result = await readBuilderExecutionMetrics(W, f.platform);
    assert.equal(requests, 2, "fixture contains one Worker and one QA request");
    assert.equal(priorAcceptanceReadsDuringQa, 1, "only the final check reads the other Task's acceptance");
    assert.equal(result.status, drift ? "unknown" : "ready");
  }
});

test("second Run read must agree with the exact observed Run identity and status", async () => {
  const { f } = await setupVerifiedWorkstreamPlatform();
  const sessions = f.platform.agents.sessions, original = sessions.getRun.bind(sessions);
  let calls = 0;
  sessions.getRun = async (...args) => ({ ...await original(...args), status: ++calls % 2 ? "running" : "succeeded", timing });
  assert.equal((await readBuilderExecutionMetrics(W, f.platform)).status, "unknown");
});

test("a known Run ID whose observation failed is not counted as an observed Run", async () => {
  const { f } = await setupVerifiedWorkstreamPlatform();
  const sessions = f.platform.agents.sessions, original = sessions.getRun.bind(sessions);
  sessions.getRun = async (...args) => ({ ...await original(...args), status: "invalid-status" });
  const result = await readBuilderExecutionMetrics(W, f.platform);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.runs.length, 2);
  assert.ok(result.runs.every(run => run.runId !== null && run.runStatus === "unknown"));
  assert.equal(result.summary.observedRuns, 0);
  assert.equal(result.summary.normalEndedRuns, 0);
  assert.equal(result.summary.measuredRuns, 0);
});

test("an exact Core skipped receipt remains a no-Run observation in execution metrics", async () => {
  const { f } = await setupVerifiedWorkstreamPlatform();
  const sessions = f.platform.agents.sessions;
  const read = sessions.getRequest.bind(sessions);
  let firstSession: string | null = null, diagnosticReads = 0;
  sessions.getRequest = async (sessionId: string, workspaceId: string, requestId: string, options?: { includeDiagnostic: true }) => {
    firstSession ??= sessionId;
    if (firstSession !== sessionId) return read(sessionId, workspaceId, requestId);
    if (options?.includeDiagnostic) diagnosticReads++;
    return { requestId, state: "uncertain" as const, runId: null,
      ...(options?.includeDiagnostic ? { diagnostic: { kind: "not_started", wakeupStatus: "skipped" } } : {}) };
  };
  const before = { writes: f.writes, sends: f.sends };
  const result = await readBuilderExecutionMetrics(W, f.platform);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(diagnosticReads, 1);
  assert.equal(result.summary.observedRuns, 1);
  assert.equal(result.runs[0]?.runStatus, "unknown");
  assert.equal(result.runs[0]?.runId, null);
  assert.equal(result.runs[0]?.reason, "worker-session-request-confirmed-not-started-no-automatic-retry");
  assert.deepEqual({ writes: f.writes, sends: f.sends }, before);
});

test("foreign registry and malformed Workspace fail before Run reads", async () => {
  const { f } = await setupVerifiedWorkstreamPlatform();
  let reads = 0;
  f.platform.agents.sessions.getRun = async () => { reads++; throw new Error("No cross-scope Run read"); };
  const registry = structuredClone(f.values.get(mapKey(f.registryKey))) as any;
  registry.projectId = "foreign-project";
  f.values.set(mapKey(f.registryKey), registry);
  assert.equal((await readBuilderExecutionMetrics(W, f.platform)).status, "unknown");
  await assert.rejects(() => readBuilderExecutionMetrics("foreign-workspace", f.platform), /current Workspace/u);
  assert.equal(reads, 0);
});

test("registered data endpoint rejects cross-Workspace project selection before any Host read", async () => {
  const { f } = await setupVerifiedWorkstreamPlatform();
  const data = createBuilderPlatform().data.find(item => item.key === "builder.execution-metrics");
  assert.ok(data);
  let reads = 0;
  f.platform.state.get = async () => { reads++; throw new Error("No foreign reads"); };
  await assert.rejects(async () => data.handler({ companyId: W, projectId: "22222222-2222-4222-8222-222222222222" }, f.platform), /authenticated Workspace/u);
  assert.equal(reads, 0);
});

test("empty current board is explicit unmeasured data, not zero-duration completion", async () => {
  const { f } = await setupVerifiedWorkstreamPlatform();
  f.platform.state.get = async () => null;
  const result = await readBuilderExecutionMetrics(W, f.platform);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.deepEqual(result.runs, []);
  assert.equal(result.summary.observedRuns, 0);
  assert.equal(result.summary.totalExecutionMs, null);
  assert.equal(result.completionAuthority, "not-established");
});
