import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { observedExecutionWindowMs, readBuilderExecutionMetrics, readExecutionTiming } from "../src/execution-metrics.ts";
import { createTaskQaRunReferenceStore, parseTaskQaRunReference } from "../src/task-qa-run-references.ts";
import { parseTaskQaReport } from "../src/task-qa-reports.ts";
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
  assert.deepEqual(Object.values(result.unmeasured), [null, null, null, 0, null]);
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

test("parallel Run intervals retain cumulative work and measure only their observed union, never Task completion", async () => {
  const { f } = await setupVerifiedWorkstreamPlatform();
  const sessions = f.platform.agents.sessions, original = sessions.getRun.bind(sessions);
  sessions.getRun = async (...args) => ({ ...await original(...args), status: "succeeded", termination: "not_applicable", timing });
  const result = await readBuilderExecutionMetrics(W, f.platform);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.summary.totalExecutionMs, 10000);
  assert.equal(result.development?.observedExecutionWindowMs, 5000);
  assert.equal(result.unmeasured.taskCompletionMs, null);
  const row = (start: string, end: string) => ({ executionMs: Date.parse(end) - Date.parse(start),
    timing: { ...timing, startedAt: start, finishedAt: end } });
  assert.equal(observedExecutionWindowMs([row(timing.startedAt, timing.finishedAt),
    row("2026-11-02T00:00:04.000Z", "2026-11-02T00:00:09.000Z"),
    row("2026-11-02T00:00:12.000Z", "2026-11-02T00:00:13.000Z")]), 8000);
  assert.equal(observedExecutionWindowMs([]), null);
});

test("Task preparation to exact submitted source uses immutable timestamps without writes, and approvals are not manual intervention", async () => {
  const { f } = await setupVerifiedWorkstreamPlatform();
  const before = { writes: f.writes, sends: f.sends, cancels: f.cancelCalls, values: JSON.stringify([...f.values]) };
  const result = await readBuilderExecutionMetrics(W, f.platform);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  const task = result.development!.tasks[0]!;
  assert.equal(task.taskId, "task-dev");
  assert.equal(task.sourceSubmissionMs, Date.parse(task.submittedAt!) - Date.parse(task.preparedAt));
  assert.ok(task.sourceSubmissionMs! >= 0);
  assert.equal(task.reworkCount, 0);
  assert.equal(task.historyCoverage, "complete-current-task-scope");
  assert.deepEqual(result.unmeasured, { taskCompletionMs: null, permissionWaitMs: null, integrationWaitMs: null,
    reworkCount: 0, manualInterventionCount: null });
  assert.deepEqual({ writes: f.writes, sends: f.sends, cancels: f.cancelCalls, values: JSON.stringify([...f.values]) }, before);
});

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
async function reworkFixture(changedSource = true) {
  const setup = await setupVerifiedWorkstreamPlatform();
  const { f } = setup;
  const scope = { workspaceId: W, projectId: W, ctoId: CTO, workstreamId: "ws-1", qaTaskId: "task-qa" };
  const references = createTaskQaRunReferenceStore(scope, f.state as never), reports = setup.reportStore();
  const originalReference = (await references.current())!.revision;
  const originalReport = (await reports.current())!.revision;
  const makeReference = (binding: typeof originalReference.binding) => {
    const content = { schemaVersion: 1 as const, scope, binding };
    return parseTaskQaRunReference({ ...content, revisionId: `task-qa-run-v1:${digest(content)}` });
  };
  const old = makeReference({ ...originalReference.binding, commitSha: changedSource ? "1".repeat(40) : originalReference.binding.commitSha,
    submissionId: "2".repeat(64), runId: randomUUID() });
  assert.equal((await references.publish({ expectedBaseRevisionId: originalReference.revisionId, revision: old })).status, "published");
  const failed = (() => {
    const { revisionId: _revision, ...base } = originalReport;
    const content = { ...base, reference: old, checks: base.checks.map(check => ({ ...check, verdict: "failed" as const })),
      verdict: "failed" as const, summary: "Fixture failed independent checks; not actual AI or protected execution." };
    return parseTaskQaReport({ ...content, revisionId: `task-qa-report-v1:${digest(content)}` });
  })();
  assert.equal((await reports.publish({ expectedBaseRevisionId: originalReport.revisionId, revision: failed })).status, "published");
  const next = makeReference({ ...originalReference.binding, runId: randomUUID() });
  assert.equal((await references.publish({ expectedBaseRevisionId: old.revisionId, revision: next })).status, "published");
  const sessions = f.platform.agents.sessions, getRun = sessions.getRun.bind(sessions);
  sessions.getRun = async (...args) => args[0] === failed.author.sessionId && args[2] === failed.author.runId
    ? { ...await getRun(...args), status: "succeeded", cancellationRequested: false, termination: "not_applicable", timing }
    : getRun(...args);
  const protectedApi = (f.platform as any).protectedTests;
  const originalGet = protectedApi.getRunV1.bind(protectedApi);
  const core = await originalGet(W, originalReference.binding.runId, originalReference.binding.subjectKeySha256);
  core.id = next.binding.runId;
  core.timestamps.createdAt = new Date().toISOString();
  protectedApi.getRunV1 = async (_workspaceId: string, runId: string, subjectHash: string) => runId === next.binding.runId
    && subjectHash === next.binding.subjectKeySha256 ? structuredClone(core) : null;
  return { ...setup, references, reports, failed, next, core };
}

test("only failed QA followed by changed accepted source and a later exact Core QA run counts rework", async () => {
  const { f } = await reworkFixture();
  const result = await readBuilderExecutionMetrics(W, f.platform);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.unmeasured.reworkCount, 1);
  assert.equal(result.development!.tasks[0]!.reworkCount, 1);
  assert.equal(result.completionAuthority, "not-established");
  const same = await reworkFixture(false);
  const retry = await readBuilderExecutionMetrics(W, same.f.platform);
  assert.equal(retry.status === "ready" && retry.unmeasured.reworkCount, 0, "same-source rerun does not establish source rework");
});

test("missing/reversed Core times, mismatched source pins and running report authors cannot establish rework", async () => {
  for (const invalid of ["missing-time", "reversed-time", "wrong-source", "active-author", "invalid-core-status", "revoked-acceptance"] as const) {
    const fixture = await reworkFixture();
    if (invalid === "missing-time") delete fixture.core.timestamps.createdAt;
    if (invalid === "reversed-time") fixture.core.timestamps.createdAt = "2026-11-02T00:00:06.000Z";
    if (invalid === "wrong-source") fixture.core.pins.sourceId = randomUUID();
    if (invalid === "invalid-core-status") fixture.core.status = "unsupported";
    if (invalid === "revoked-acceptance") {
      const address = [...fixture.f.values.keys()].find(value => JSON.parse(value).stateKey.startsWith("task-source-acceptance.v1."))!;
      fixture.f.values.delete(address);
    }
    if (invalid === "active-author") {
      const sessions = fixture.f.platform.agents.sessions, get = sessions.getRun.bind(sessions);
      sessions.getRun = async (...args) => ({ ...await get(...args), status: "running" });
    }
    const result = await readBuilderExecutionMetrics(W, fixture.f.platform);
    assert.equal(result.status, "ready", invalid);
    if (result.status === "ready") assert.equal(result.unmeasured.reworkCount, null, invalid);
  }
});

test("duplicate failed assessments for one replaced submission do not multiply the recorded rework cycle", async () => {
  const fixture = await reworkFixture();
  const { revisionId: _revision, ...original } = fixture.failed;
  const content = { ...original, summary: "Additional fixture assessment, same source-replacement cycle." };
  const report = parseTaskQaReport({ ...content, revisionId: `task-qa-report-v1:${digest(content)}` });
  await fixture.reports.publish({ expectedBaseRevisionId: fixture.failed.revisionId, revision: report });
  const result = await readBuilderExecutionMetrics(W, fixture.f.platform);
  assert.equal(result.status === "ready" && result.unmeasured.reworkCount, 1);
});

test("AgentSession report authors require not_applicable termination, not protected-test confirmed termination", async () => {
  for (const termination of ["confirmed", "pending"] as const) {
    const fixture = await reworkFixture();
    assert.equal(fixture.core.termination, "confirmed", "the separate protected-test fixture has its own closure contract");
    const sessions = fixture.f.platform.agents.sessions, get = sessions.getRun.bind(sessions);
    sessions.getRun = async (...args) => {
      const run = await get(...args);
      return args[0] === fixture.failed.author.sessionId && args[2] === fixture.failed.author.runId
        ? { ...run, status: "succeeded", cancellationRequested: false, termination } : run;
    };
    const result = await readBuilderExecutionMetrics(W, fixture.f.platform);
    assert.equal(result.status, "ready");
    if (result.status !== "ready") continue;
    assert.equal(result.unmeasured.reworkCount, null, termination);
    assert.equal(result.development!.tasks[0]!.historyCoverage, "unavailable-or-incomplete", termination);
  }
});

async function continuationCollectorFixture(originalObserved: boolean) {
  const { f } = await setupVerifiedWorkstreamPlatform();
  const scope = { workspaceId: W, projectId: W, ctoId: CTO, workstreamId: "ws-1", qaTaskId: "task-qa" };
  const store = createTaskQaRunReferenceStore(scope, f.state as never);
  const current = (await store.current())!.revision;
  const originalRun = "88888888-8888-4888-8888-888888888888", childRun = randomUUID(), childRequest = randomUUID();
  const receiptDigest = "7".repeat(64);
  const eventId = `sps-protected-test-terminal-v1:${current.binding.runId}:${receiptDigest}:${current.binding.subjectKeySha256}:${randomUUID()}`;
  const content = { schemaVersion: 1 as const, scope, binding: current.binding,
    deferredEvent: { eventId, previousRunId: originalRun, receiptDigest } };
  const reference = parseTaskQaRunReference({ ...content, revisionId: `task-qa-run-v1:${digest(content)}` });
  assert.equal((await store.publish({ expectedBaseRevisionId: current.revisionId, revision: reference })).status, "published");
  const registry = f.values.get(mapKey(key(taskWorkerRegistryKey(W, CTO)))) as any;
  const worker = registry.records.find((row: any) => row.role === "qa");
  const sessions = f.platform.agents.sessions, getRun = sessions.getRun.bind(sessions), getRequest = sessions.getRequest.bind(sessions);
  sessions.getRun = async (...args) => args[2] === childRun ? {
    runId: childRun, status: "succeeded", cancellationRequested: false, termination: "not_applicable", errorCode: null, error: null,
    timing, systemEvent: { schemaVersion: 1, kind: "protected-test-terminal-event", requestId: childRequest,
      previousRunId: originalRun, eventId, protectedRunId: current.binding.runId, receiptDigest,
      subjectKeySha256: current.binding.subjectKeySha256 },
  } : { ...await getRun(...args), ...(!originalObserved && args[2] === originalRun ? { runId: randomUUID() } : {}) };
  sessions.getRequest = async (...args) => args[2] === childRequest
    ? { requestId: childRequest, state: "submitted", runId: childRun } : getRequest(...args);
  sessions.list = async (agentId, companyId) => [{ sessionId: worker.sessionId, agentId, companyId,
    taskKey: `plugin:com.sonparkserver.my-plugin-builder:session:${worker.pluginAgentKey}`,
    status: "active", closedAt: null, lastRunId: childRun }];
  // Unusable acceptance timing keeps the Worker rework reader out of this QA-only head;
  // the exact acceptance identity is still present for continuation lineage checks.
  const acceptanceAddress = [...f.values.keys()].find(value => JSON.parse(value).stateKey.startsWith("task-source-acceptance.v1."))!;
  const acceptance = structuredClone(f.values.get(acceptanceAddress)) as any;
  acceptance.receivedAt = "2099-01-01T00:00:00.000Z";
  f.values.set(acceptanceAddress, acceptance);
  const api = (f.platform as any).localFolders, readTip = api.readWorkspaceSourceGitTipV1;
  let tipReads = 0, revoked = false;
  api.readWorkspaceSourceGitTipV1 = async (...args: any[]) => { tipReads++; return readTip(...args); };
  const stateGet = f.platform.state.get.bind(f.platform.state);
  f.platform.state.get = async input => {
    const value = await stateGet(input);
    if (!revoked && tipReads === 2 && input.stateKey.startsWith("task-protected-qa-runs-head.v1.")) {
      revoked = true;
      f.values.delete(mapKey(input));
    }
    return value;
  };
  return { f, childRun, get revoked() { return revoked; } };
}

test("continuation state heads join the final metrics collector in observed and unobserved origin branches", async t => {
  for (const originalObserved of [true, false]) await t.test(originalObserved ? "observed origin" : "unobserved origin", async () => {
    const fixture = await continuationCollectorFixture(originalObserved);
    const before = { writes: fixture.f.writes, sends: fixture.f.sends, cancels: fixture.f.cancelCalls };
    const result = await readBuilderExecutionMetrics(W, fixture.f.platform);
    assert.equal(fixture.revoked, true, "the QA-only head changes immediately after its last local observation");
    assert.equal(result.status, "unknown", "the final collector must reject the revoked head rather than return measured lineage");
    assert.deepEqual({ writes: fixture.f.writes, sends: fixture.f.sends, cancels: fixture.f.cancelCalls }, before);
  });
});

test("truncated QA history is unmeasured and mutable history heads are rechecked without repair", async () => {
  const fixture = await reworkFixture();
  let previous = fixture.next;
  for (let index = 0; index < 49; index++) {
    const content = { schemaVersion: 1 as const, scope: previous.scope, binding: { ...previous.binding, runId: randomUUID() } };
    const next = parseTaskQaRunReference({ ...content, revisionId: `task-qa-run-v1:${digest(content)}` });
    await fixture.references.publish({ expectedBaseRevisionId: previous.revisionId, revision: next }); previous = next;
  }
  const result = await readBuilderExecutionMetrics(W, fixture.f.platform);
  assert.equal(result.status === "ready" && result.unmeasured.reworkCount, null);
  const changed = await reworkFixture();
  const api = (changed.f.platform as any).protectedTests, get = api.getRunV1;
  api.getRunV1 = async (...args: any[]) => {
    const value = await get(...args);
    const address = [...changed.f.values.keys()].find(value => JSON.parse(value).stateKey.startsWith("task-qa-reports-head.v1."))!;
    changed.f.values.delete(address);
    return value;
  };
  assert.equal((await readBuilderExecutionMetrics(W, changed.f.platform)).status, "unknown");
});
