import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { readBuilderExecutionMetrics } from "../src/execution-metrics.ts";
import { createTaskPacketStore, publishCtoTaskPacket } from "../src/task-packet-tools.ts";
import { parseTaskWorkerRegistry, taskWorkerRegistryKey } from "../src/domain/task-workers.ts";
import { deriveTaskWorkerFileBinding, taskWorkerRequestId } from "../src/task-worker-runtime.ts";
import { taskPacketRecordDigest } from "../src/domain/task-packets.ts";
import { prepareTaskWorker } from "../src/task-worker-tools.ts";
import { acceptCtoTaskSourceSubmission } from "../src/task-source-acceptance.ts";
import { createTaskQaRunReferenceStore, parseTaskQaRunReference } from "../src/task-qa-run-references.ts";
import { publishTaskQaReport, parseTaskQaReport } from "../src/task-qa-reports.ts";
import { createBuilderPlatform } from "../src/platform.ts";
import { setupVerifiedWorkstreamPlatform } from "./fixtures/verified-workstream-platform.ts";
import { W, CTO, key } from "./fixtures/cto-platform.ts";

const scope = { workspaceId: W, projectId: W, ctoId: CTO, workstreamId: "ws-1", qaTaskId: "task-qa" };
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const runs = (runId: string, status = "running") => ({ runId, status, cancellationRequested: false,
  termination: "not_applicable" as "not_applicable" | "pending" | "confirmed", errorCode: null, error: null,
  timing: { createdAt: new Date(Date.now() - 3000).toISOString(), startedAt: new Date(Date.now() - 2000).toISOString(),
    finishedAt: null as string | null } });

/** Real Builder producers over synthetic Host/session responses; no Core or model execution. */
async function produceAcceptedSourceRework() {
  const setup = await setupVerifiedWorkstreamPlatform(), { f } = setup;
  const references = createTaskQaRunReferenceStore(scope, f.state);
  const originalReference = (await references.current())!.revision;
  const originalReport = (await setup.reportStore().current())!.revision;
  const oldQaRun = runs(originalReport.author.runId);
  const observed = new Map([[oldQaRun.runId, oldQaRun]]);
  const sessions = f.platform.agents.sessions, originalGetRun = sessions.getRun.bind(sessions);
  sessions.getRun = async (...args) => observed.has(args[2]) ? structuredClone(observed.get(args[2])!) : originalGetRun(...args);
  const failed = await publishTaskQaReport({ projectId: W, ctoId: CTO, workstreamId: "ws-1", qaTaskId: "task-qa",
    approvalId: originalReference.binding.approvalId, planSha256: originalReference.binding.planSha256,
    runId: originalReference.binding.runId, expectedBaseRevisionId: originalReport.revisionId,
    checks: originalReport.checks.map(check => ({ criterionId: check.criterionId, verdict: "failed", note: "Synthetic independent assessment failed." })),
    summary: "Real report producer over fixture evidence; no actual QA verdict claimed." },
  { companyId: W, projectId: W, ...originalReport.author }, f.platform);
  assert.equal(failed.status, "published", JSON.stringify(failed));
  oldQaRun.status = "succeeded";
  oldQaRun.timing.finishedAt = new Date().toISOString();

  const packets = createTaskPacketStore(W, W, CTO, "ws-1", f.state);
  const firstBoard = (await packets.current())!.revision;
  const oldDev = firstBoard.packets.find(row => row.packet.kind === "development")!;
  const oldQa = firstBoard.packets.find(row => row.packet.kind === "qa")!;
  const publishTask = async (packet: typeof oldDev.packet, revisionId: string) => {
    const result = await publishCtoTaskPacket({ projectId: W, ctoId: CTO, workstreamId: "ws-1",
      expectedBaseRevisionId: (await packets.current())!.revision.revisionId, revisionId, packet }, setup.ctoContext, f.platform);
    assert.equal((result.data as { status: string }).status, "published", JSON.stringify(result));
  };
  await publishTask({ ...oldDev.packet, revision: 2, sourceAccess: { ...oldDev.packet.sourceAccess!,
    expectedHead: originalReference.binding.commitSha } }, "development-rework-packets-2");
  await publishTask({ ...oldQa.packet, revision: 2 }, "development-rework-packets-3");
  const board = (await packets.current())!.revision;
  const dev = board.packets.find(row => row.packet.kind === "development")!;
  const qa = board.packets.find(row => row.packet.kind === "qa")!;
  const oldWorkers = parseTaskWorkerRegistry(await f.state.get(key(taskWorkerRegistryKey(W, CTO))), W, W, CTO);
  const devWorker = oldWorkers.records.find(row => row.role === "worker")!, qaWorker = oldWorkers.records.find(row => row.role === "qa")!;
  Object.assign(f.platform.agents, { owned: { ...(f.platform.agents as any).owned,
    async ensure() { assert.fail("No new Agent is needed for fixture rework"); } } });
  Object.assign(sessions, { async ensure(agentId: string) {
    return { sessionId: agentId === devWorker.agentId ? devWorker.sessionId : qaWorker.sessionId, created: false };
  } });
  for (const [packet, role] of [[dev, "worker"], [qa, "qa"]] as const) {
    const prepared = await prepareTaskWorker({ projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId: packet.packet.taskId,
      packetRevision: 2, role }, setup.ctoContext, f.platform);
    assert.equal((prepared.data as { status: string }).status, "registered", JSON.stringify(prepared));
  }
  const workers = parseTaskWorkerRegistry(await f.state.get(key(taskWorkerRegistryKey(W, CTO))), W, W, CTO);
  const currentDevWorker = workers.records.filter(row => row.role === "worker" && row.packetRevision === 2).at(-1)!;
  const currentQaWorker = workers.records.filter(row => row.role === "qa" && row.packetRevision === 2).at(-1)!;
  const devRun = runs(randomUUID()), qaRun = runs(randomUUID());
  for (const [packet, role, run] of [[dev, "worker", devRun], [qa, "qa", qaRun]] as const) {
    const worker = workers.records.filter(row => row.role === role && row.packetRevision === 2).at(-1)!;
    const binding = deriveTaskWorkerFileBinding({ workspaceId: W, projectId: W, ctoId: CTO,
      packet, currentPackets: board.packets, worker });
    const requestId = taskWorkerRequestId(binding);
    setup.requests.set(`${worker.sessionId}:${requestId}`, { requestId, state: "submitted", runId: run.runId });
    observed.set(run.runId, run);
  }
  const commitSha = "1".repeat(40), treeSha = "2".repeat(40);
  const folders = (f.platform as any).localFolders;
  folders.commitTaskFilesV1 = async () => ({ status: "committed", commitSha, treeSha, changedPaths: ["src/feature.ts"] });
  folders.readWorkspaceSourceGitTipV1 = async (sourceId: string, folderKey: string, branch: string) => ({
    status: "current", sourceId, folderKey, branch, commitSha, treeSha, observedAt: new Date().toISOString(),
  });
  const submit = createBuilderPlatform().tools.find(tool => tool.name === "builder.submit-task-source")!;
  const submitted = await submit.handler({ paths: ["src/feature.ts"] }, { companyId: W, projectId: W,
    agentId: currentDevWorker.agentId, sessionId: currentDevWorker.sessionId, runId: devRun.runId }, f.platform) as any;
  assert.equal(submitted.data.status, "submitted", JSON.stringify(submitted));
  const accepted = await acceptCtoTaskSourceSubmission({ projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId: dev.packet.taskId,
    submissionId: submitted.data.submission.submissionId }, setup.ctoContext, f.platform);
  assert.equal(accepted.status, "accepted", JSON.stringify(accepted));
  assert(accepted.acceptance);
  return { ...setup, originalReference, originalReport, oldQaRun, dev, qa, qaRun, currentQaWorker, references,
    accepted: accepted.acceptance, submission: submitted.data.submission };
}

/** The later protected reference is injected only for metrics-reader fault isolation. */
async function produceSourceRework(missingIntermediateProof = false) {
  const setup = await produceAcceptedSourceRework();
  const { f, originalReference, dev, qa, accepted, submission, references } = setup;
  const { commitSha, treeSha } = submission;
  const content = { schemaVersion: 1 as const, scope, binding: { ...originalReference.binding,
    implementationRevision: 2, implementationDigest: taskPacketRecordDigest(dev, W, CTO, "ws-1"),
    qaRevision: 2, qaDigest: taskPacketRecordDigest(qa, W, CTO, "ws-1"),
    acceptanceId: accepted.acceptanceId, submissionId: submission.submissionId,
    commitSha, treeSha, runId: randomUUID() } };
  const nextReference = parseTaskQaRunReference({ ...content,
    revisionId: `task-qa-run-v1:${sha(JSON.stringify(content))}` });
  let intermediateReference: typeof nextReference | null = null;
  if (missingIntermediateProof) {
    const middle = { ...content, binding: { ...content.binding, submissionId: "7".repeat(64), acceptanceId: "8".repeat(64),
      commitSha: "9".repeat(40), treeSha: "a".repeat(40), runId: randomUUID() } };
    intermediateReference = parseTaskQaRunReference({ ...middle, revisionId: `task-qa-run-v1:${sha(JSON.stringify(middle))}` });
    assert.equal((await references.publish({ expectedBaseRevisionId: originalReference.revisionId,
      revision: intermediateReference })).status, "published");
    const reports = setup.reportStore(), prior = (await reports.current())!.revision;
    const { revisionId: _revisionId, ...failed } = prior;
    const report = { ...failed, reference: intermediateReference,
      summary: "Synthetic intermediate failed assessment without a durable source submission/acceptance." };
    const revision = parseTaskQaReport({ ...report, revisionId: `task-qa-report-v1:${sha(JSON.stringify(report))}` });
    assert.equal((await reports.publish({ expectedBaseRevisionId: prior.revisionId, revision })).status, "published");
  }
  const recorded = await references.publish({ expectedBaseRevisionId: intermediateReference?.revisionId ?? originalReference.revisionId,
    revision: nextReference });
  assert.equal(recorded.status, "published");
  const core = { schemaVersion: 1, kind: "protected-node-test-v1", id: nextReference.binding.runId,
    status: "queued", termination: "not_applicable",
    pins: { approvalId: nextReference.binding.approvalId, sourceId: nextReference.binding.sourceId,
      planSha256: nextReference.binding.planSha256, profileSha256: "3".repeat(64), commitSha, treeSha,
      manifestSha256: "4".repeat(64), inputTreeSha256: "5".repeat(64), nodeSha256: "6".repeat(64),
      subjectKeySha256: nextReference.binding.subjectKeySha256, timeoutMs: 30000 },
    receipt: null, timestamps: { createdAt: new Date().toISOString(), claimedAt: null, startedAt: null, finishedAt: null },
    qaVerdict: "not-established" };
  let afterCoreRead = () => {};
  const coreReadRunIds: string[] = [];
  const api = (f.platform as any).protectedTests;
  api.getRunV1 = async (companyId: string, runId: string, subjectHash: string) => {
    assert.equal(companyId, W); assert.equal(subjectHash, core.pins.subjectKeySha256);
    coreReadRunIds.push(runId);
    const result = structuredClone(core);
    if (intermediateReference && runId === intermediateReference.binding.runId) {
      result.id = runId;
      result.pins.commitSha = intermediateReference.binding.commitSha;
      result.pins.treeSha = intermediateReference.binding.treeSha;
    } else assert.equal(runId, core.id);
    afterCoreRead(); return result;
  };
  const latest = (await references.current())!.revision;
  assert.equal(latest.binding.submissionId, submission.submissionId);
  assert.equal(latest.binding.runId, core.id);
  assert.notEqual(latest.binding.commitSha, originalReference.binding.commitSha);
  return { ...setup, core, latest, intermediateReference, coreReadRunIds,
    setAfterCoreRead(hook: typeof afterCoreRead) { afterCoreRead = hook; } };
}

test("registered protected QA handler accepts revision 2 with retained keyed sessions and exact historical/current producer rows", async () => {
  const setup = await produceAcceptedSourceRework();
  const { f, dev, qa, accepted, submission, references, originalReference, currentQaWorker, qaRun } = setup;
  const registryKey = key(taskWorkerRegistryKey(W, CTO));
  const registryBefore = await f.state.get(registryKey);
  const registry = parseTaskWorkerRegistry(registryBefore, W, W, CTO);
  for (const role of ["worker", "qa"] as const) {
    const history = registry.records.filter(row => row.role === role && row.workstreamId === "ws-1");
    assert.deepEqual(history.map(row => row.packetRevision), [1, 2]);
    assert.equal(history[0]!.agentId, history[1]!.agentId);
    assert.equal(history[0]!.sessionId, history[1]!.sessionId);
    assert.notEqual(history[0]!.packetRecordSha256, history[1]!.packetRecordSha256);
  }
  assert.equal((await references.current())!.revision.revisionId, originalReference.revisionId);
  assert.equal((await references.recent(50)).revisions.length, 1, "no direct next-reference injection");
  let enqueueCalls = 0;
  let enqueued: Record<string, string> | null = null;
  const coreRunId = randomUUID();
  // Exact public DTO fixture only: this callback does not execute Core, Node or protected tests.
  (f.platform as any).protectedTests.enqueueApprovedV1 = async (input: Record<string, string>) => {
    enqueueCalls++;
    assert.deepEqual(Object.keys(input).sort(), ["approvalId", "commitSha", "companyId", "planSha256", "requestId",
      "sourceId", "subjectKey", "treeSha"]);
    assert.equal(input.companyId, W);
    assert.equal(input.sourceId, submission.source.sourceId);
    assert.equal(input.commitSha, submission.commitSha);
    assert.equal(input.treeSha, submission.treeSha);
    assert.equal(input.approvalId, originalReference.binding.approvalId);
    assert.equal(input.planSha256, originalReference.binding.planSha256);
    enqueued = structuredClone(input);
    return { schemaVersion: 1, kind: "protected-node-test-v1", id: coreRunId, status: "queued", termination: "not_applicable",
      pins: { approvalId: input.approvalId, sourceId: input.sourceId, planSha256: input.planSha256,
        profileSha256: "3".repeat(64), commitSha: input.commitSha, treeSha: input.treeSha,
        manifestSha256: "4".repeat(64), inputTreeSha256: "5".repeat(64), nodeSha256: "6".repeat(64),
        subjectKeySha256: sha(input.subjectKey!), timeoutMs: 30000 }, receipt: null,
      timestamps: { createdAt: new Date().toISOString(), claimedAt: null, startedAt: null, finishedAt: null },
      qaVerdict: "not-established" };
  };
  const tool = createBuilderPlatform().tools.find(row => row.name === "builder.request-protected-task-qa");
  assert(tool);
  const response = await tool.handler({ approvalId: originalReference.binding.approvalId,
    planSha256: originalReference.binding.planSha256 }, { companyId: W, projectId: W,
    agentId: currentQaWorker.agentId, sessionId: currentQaWorker.sessionId, runId: qaRun.runId }, f.platform);
  const result = response.data as Record<string, unknown>;
  assert.equal(result.status, "queued", JSON.stringify(response));
  assert.equal(result.qaVerdict, "not-established");
  assert.equal(result.taskRunReference, "recorded");
  assert.equal(result.runId, coreRunId);
  assert.equal(enqueueCalls, 1);
  assert(enqueued);
  const request = enqueued as Record<string, string>;
  const latest = (await references.current())!.revision;
  assert.equal(latest.binding.implementationRevision, 2);
  assert.equal(latest.binding.implementationDigest, taskPacketRecordDigest(dev, W, CTO, "ws-1"));
  assert.equal(latest.binding.qaRevision, 2);
  assert.equal(latest.binding.qaDigest, taskPacketRecordDigest(qa, W, CTO, "ws-1"));
  assert.equal(latest.binding.qaAgentId, currentQaWorker.agentId);
  assert.equal(latest.binding.qaSessionId, currentQaWorker.sessionId);
  assert.equal(latest.binding.acceptanceId, accepted.acceptanceId);
  assert.equal(latest.binding.submissionId, submission.submissionId);
  assert.equal(latest.binding.commitSha, submission.commitSha);
  assert.equal(latest.binding.treeSha, submission.treeSha);
  assert.equal(latest.binding.runId, coreRunId);
  assert.equal(latest.binding.requestId, request.requestId);
  assert.equal(latest.binding.subjectKey, request.subjectKey);
  assert.equal(latest.binding.subjectKeySha256, sha(request.subjectKey!));
  assert.notEqual(latest.binding.requestId, originalReference.binding.requestId);
  assert.equal((await references.recent(50)).revisions.length, 2);
  assert.deepEqual((await references.publishedRevision(originalReference.revisionId))!.revision, originalReference);
  assert.deepEqual(await f.state.get(registryKey), registryBefore, "historical and current identities remain unchanged");
});

test("producer preparation/source/CTO timestamps stay separate from parallel Run window and business completion", async () => {
  const { f } = await setupVerifiedWorkstreamPlatform();
  const sessions = f.platform.agents.sessions, get = sessions.getRun.bind(sessions);
  let index = 0;
  const starts = new Map<string, number>();
  sessions.getRun = async (...args) => {
    const run = await get(...args);
    if (!starts.has(args[2])) starts.set(args[2], index++ === 0 ? 0 : 5000);
    const start = Date.parse("2026-11-02T00:00:00.000Z") + starts.get(args[2])!;
    return { ...run, status: "succeeded", cancellationRequested: false, termination: "not_applicable", timing: {
      createdAt: new Date(start).toISOString(), startedAt: new Date(start).toISOString(), finishedAt: new Date(start + 10000).toISOString(),
    } };
  };
  const before = structuredClone(f.values), result = await readBuilderExecutionMetrics(W, f.platform);
  assert.equal(result.status, "ready"); if (result.status !== "ready") return;
  assert.equal(result.summary.totalExecutionMs, 20000);
  assert.equal(result.development?.observedExecutionWindowMs, 15000);
  const task = result.development!.tasks[0]!;
  assert.equal(task.sourceSubmissionMs, Date.parse(task.submittedAt!) - Date.parse(task.preparedAt));
  assert.equal(result.completionAuthority, "not-established");
  assert.equal(result.unmeasured.taskCompletionMs, null); assert.equal(result.unmeasured.manualInterventionCount, null);
  assert.deepEqual(f.values, before);
});

test("real failed-report and revised Task/source acceptance with a synthetic protected reference yield one observed rework cycle", async () => {
  const f = await produceSourceRework(), before = structuredClone(f.f.values);
  const result = await readBuilderExecutionMetrics(W, f.f.platform);
  assert.equal(result.status, "ready"); if (result.status !== "ready") return;
  const task = result.development!.tasks[0]!;
  assert.equal(task.packetRevision, 2); assert.equal(task.preparedAt, f.dev.createdAtISO);
  assert.equal(task.submittedAt, f.submission.submittedAt);
  assert.equal(task.sourceSubmissionMs, Date.parse(f.submission.submittedAt) - Date.parse(f.dev.createdAtISO));
  assert.equal(result.runs.find(row => row.role === "worker")?.commitAcceptanceMs,
    Date.parse(f.accepted.receivedAt) - Date.parse(f.submission.submittedAt));
  assert.equal(task.reworkCount, 1); assert.equal(result.unmeasured.reworkCount, 1);
  assert.equal(task.historyCoverage, "complete-current-task-scope");
  assert.equal(result.summary.totalExecutionMs, null, "the new active fixture Runs have no finished timing");
  assert.equal(result.completionAuthority, "not-established"); assert.deepEqual(f.f.values, before);
});

test("source submitted before the failed QA author finishes cannot establish subsequent source rework", async () => {
  const f = await produceSourceRework();
  const submittedAt = Date.parse(f.submission.submittedAt);
  const finishedAt = submittedAt + 1, createdAt = submittedAt + 2;
  // Only synthetic Host timings change; the actual immutable submission/acceptance stays intact.
  f.oldQaRun.timing.finishedAt = new Date(finishedAt).toISOString();
  f.core.timestamps.createdAt = new Date(createdAt).toISOString();
  if (createdAt > Date.now()) await new Promise(resolve => setTimeout(resolve, createdAt - Date.now()));
  assert(submittedAt < finishedAt && finishedAt < createdAt && createdAt <= Date.now());
  const before = structuredClone(f.f.values);
  const result = await readBuilderExecutionMetrics(W, f.f.platform);
  assert.equal(result.status, "ready"); if (result.status !== "ready") return;
  const task = result.development!.tasks[0]!;
  assert.equal(task.submittedAt, f.submission.submittedAt);
  assert.equal(result.completionAuthority, "not-established");
  assert.deepEqual(f.f.values, before);
  assert.deepEqual({ aggregate: result.unmeasured.reworkCount, task: task.reworkCount, coverage: task.historyCoverage },
    { aggregate: null, task: null, coverage: "unavailable-or-incomplete" },
    "later Core creation cannot prove that source was changed/submitted after the failed QA");
});

test("multiple source-change cycles with missing intermediate submission proof remain incomplete, not a partial count or zero", async () => {
  const f = await produceSourceRework(true);
  assert(f.intermediateReference);
  assert.equal((await f.references.recent(50)).revisions.length, 3);
  assert.equal((await f.reportStore().recent(50)).revisions.filter(row => row.revision.verdict === "failed").length, 2);
  const missingKey = `task-source-outcome.v1.${f.intermediateReference.binding.submissionId}`;
  const state = f.f.platform.state, get = state.get.bind(state);
  let missingSubmissionRead = false;
  state.get = async input => {
    const value = await get(input);
    if (input.stateKey === missingKey) { missingSubmissionRead = true; assert.equal(value, null); }
    return value;
  };
  const before = structuredClone(f.f.values);
  const result = await readBuilderExecutionMetrics(W, f.f.platform);
  assert.equal(missingSubmissionRead, true, "the historical source receipt lookup must actually execute");
  assert.deepEqual(f.coreReadRunIds, [f.latest.binding.runId, f.intermediateReference.binding.runId]);
  assert.equal(result.status, "ready"); if (result.status !== "ready") return;
  assert.equal(result.unmeasured.reworkCount, null);
  assert.equal(result.development!.tasks[0]!.reworkCount, null);
  assert.equal(result.development!.tasks[0]!.historyCoverage, "unavailable-or-incomplete");
  assert.equal(result.completionAuthority, "not-established");
  assert.deepEqual(f.f.values, before);
});

test("foreign Core pins, non-normal QA authors and missing historical author timing remain unmeasured", async t => {
  for (const invalid of ["foreign-commit", "foreign-tree", "foreign-subject", "confirmed-author", "pending-author", "failed-author", "missing-author-time"] as const)
    await t.test(invalid, async () => {
      const f = await produceSourceRework();
      if (invalid === "foreign-commit") f.core.pins.commitSha = "f".repeat(40);
      if (invalid === "foreign-tree") f.core.pins.treeSha = "f".repeat(40);
      if (invalid === "foreign-subject") f.core.pins.subjectKeySha256 = "f".repeat(64);
      if (invalid === "confirmed-author") f.oldQaRun.termination = "confirmed";
      if (invalid === "pending-author") f.oldQaRun.termination = "pending";
      if (invalid === "failed-author") f.oldQaRun.status = "failed";
      if (invalid === "missing-author-time") f.oldQaRun.timing.finishedAt = null;
      const result = await readBuilderExecutionMetrics(W, f.f.platform);
      assert.equal(result.status, "ready"); if (result.status !== "ready") return;
      assert.equal(result.unmeasured.reworkCount, null);
      assert.equal(result.development!.tasks[0]!.historyCoverage, "unavailable-or-incomplete");
    });
});

test("missing immutable report ancestry cannot become a complete zero rework history", async () => {
  const f = await produceSourceRework();
  const address = [...f.f.values.keys()].find(address => {
    const row = f.f.values.get(address) as any;
    return JSON.parse(address).stateKey.startsWith("task-qa-reports-revision.v1.")
      && row?.revision?.revisionId === f.originalReport.revisionId;
  });
  assert(address); f.f.values.delete(address);
  const result = await readBuilderExecutionMetrics(W, f.f.platform);
  assert.equal(result.status, "ready"); if (result.status !== "ready") return;
  assert.equal(result.unmeasured.reworkCount, null);
});

test("reference head drift during the actual Core read invalidates the metrics snapshot without repair", async () => {
  const f = await produceSourceRework(); let injected = false;
  f.setAfterCoreRead(() => {
    injected = true;
    const address = [...f.f.values.keys()].find(address => JSON.parse(address).stateKey.startsWith("task-protected-qa-runs-head.v1."));
    assert(address); f.f.values.delete(address);
  });
  assert.deepEqual(await readBuilderExecutionMetrics(W, f.f.platform), {
    status: "unknown", reason: "metrics-current-scope-or-run-observation-unavailable",
  });
  assert.equal(injected, true);
});

test("an unavailable report history head cannot be relabeled complete with zero rework", async () => {
  const f = await produceSourceRework();
  assert.equal((await f.reportStore().recent(50)).revisions.length, 2);
  assert.equal((await f.references.recent(50)).revisions.length, 2);
  const address = [...f.f.values.keys()].find(address => JSON.parse(address).stateKey.startsWith("task-qa-reports-head.v1."));
  assert(address); f.f.values.delete(address);
  const result = await readBuilderExecutionMetrics(W, f.f.platform);
  assert.equal(result.status, "ready"); if (result.status !== "ready") return;
  assert.equal(result.unmeasured.reworkCount, null);
  assert.equal(result.development!.tasks[0]!.historyCoverage, "unavailable-or-incomplete");
});
