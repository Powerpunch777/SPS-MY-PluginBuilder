import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { dispatchCtoWorkstream } from "../src/cto-workstream-delivery.ts";
import { workstreamInstructionDigest } from "../src/cto-delivery-store.ts";
import { taskWorkerRegistryKey } from "../src/domain/task-workers.ts";
import { taskPacketRecordDigest } from "../src/domain/task-packets.ts";
import { createTaskPacketStore } from "../src/task-packet-tools.ts";
import { acceptCtoTaskSourceSubmission } from "../src/task-source-acceptance.ts";
import { submitTaskSourceFiles } from "../src/task-source-submissions.ts";
import type { RevisionState } from "../src/solution-revision-store.ts";
import { deriveTaskWorkerFileBinding, taskWorkerRequestId } from "../src/task-worker-runtime.ts";
import { createTaskQaReportStore, parseTaskQaReport, publishTaskQaReport, taskQaCriteria } from "../src/task-qa-reports.ts";
import { createTaskQaRunReferenceStore, parseTaskQaRunReference } from "../src/task-qa-run-references.ts";
import { readCurrentProtectedTaskQaEvidence } from "../src/builder-gates/protected-task-qa-evidence.ts";
import { fixture, A, C, CTO, W, ctx, now, key, mapKey } from "./fixtures/cto-platform.ts";

const P = W;
const SOURCE = "22222222-2222-4222-8222-222222222222";
const DEV_AGENT = "33333333-3333-4333-8333-333333333333", DEV_SESSION = "44444444-4444-4444-8444-444444444444";
const DEV_RUN = "55555555-5555-4555-8555-555555555555";
const QA_AGENT = "66666666-6666-4666-8666-666666666666", QA_SESSION = "77777777-7777-4777-8777-777777777777";
const QA_RUN = "88888888-8888-4888-8888-888888888888", CORE_RUN = "99999999-9999-4999-8999-999999999999";
const APPROVAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMMIT = "b".repeat(40), TREE = "c".repeat(40), PLAN = "d".repeat(64);
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const runKey = (runId: string) => ({ runId, status: "running", cancellationRequested: false,
  termination: "not_applicable", errorCode: null, error: null });

// The Core and Host methods are DTO fixtures. This does not run a protected process or QA model.
async function setup(options: Readonly<{ timing?: boolean; wrongProducerRun?: boolean; cancelQaRun?: boolean;
  unrelatedRunField?: boolean; onEnqueue?: () => void }> = {}) {
  const f = await fixture(P);
  await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  const ctoRunId = [...f.runs.keys()][0]!;
  const ctoContext = { companyId: W, projectId: P, agentId: A, sessionId: C, runId: ctoRunId };
  const delivery = (await f.deliveryStore().current())!.revision;
  const source = { requestId: delivery.requestId, workstreamId: "ws-1", specRevision: 1,
    instructionSha256: workstreamInstructionDigest(delivery.instruction) };
  const access = { sourceId: SOURCE, folderKey: "project-source", branch: "feature/task", expectedHead: "a".repeat(40),
    readPaths: ["src/feature.ts", "test/feature.test.ts"], writePaths: ["src/feature.ts"], qaWritePaths: ["test/feature.test.ts"] };
  const record = (taskId: string, kind: "development" | "qa", dependencies: string[] = []) => ({
    packet: { projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId, revision: 1, kind, title: taskId,
      goal: "Verify the precise accepted implementation.", scopeNodeIds: ["feature"], requirementIds: ["REQ-1"], dependencies,
      included: ["Assigned behavior"], excluded: [], constraints: [], acceptance: ["Implementation criterion"],
      evidenceRequired: ["Exact protected run"], reuse: [],
      testPlan: kind === "qa" ? { environment: "Pinned Node", steps: ["Check exact commit"], expectedResults: ["All criteria have evidence"],
        passCriteria: ["No regression"] } : null,
      sourceAccess: { ...access, writePaths: kind === "development" ? access.writePaths : [],
        qaWritePaths: kind === "qa" ? access.qaWritePaths : [] } },
    source, author: { agentId: A, sessionId: C, runId: ctoRunId }, createdAtISO: now,
    dependencyPins: [] as Array<{ taskId: string; revision: number; recordSha256: string }>,
  });
  const dev = record("task-dev", "development");
  const devDigest = taskPacketRecordDigest(dev as never, P, CTO, "ws-1");
  const qa = record("task-qa", "qa", ["task-dev"]);
  qa.dependencyPins = [{ taskId: "task-dev", revision: 1, recordSha256: devDigest }];
  const packetStore = createTaskPacketStore(W, P, CTO, "ws-1", f.state);
  await packetStore.publish({ expectedBaseRevisionId: null, revision: { projectId: P, ctoId: CTO, workstreamId: "ws-1",
    revisionId: "evidence-packets-1", packets: [dev, qa] } });
  const packets = (await packetStore.current())!.revision.packets;
  const devRecord = packets.find(row => row.packet.taskId === "task-dev")!;
  const qaRecord = packets.find(row => row.packet.taskId === "task-qa")!;
  const workers = [
    { workstreamId: "ws-1", taskId: "task-dev", packetRevision: 1, packetRecordSha256: devDigest, role: "worker" as const,
      agentId: DEV_AGENT, sessionId: DEV_SESSION, pluginAgentKey: `builder-task-worker:${hash(JSON.stringify([P,"ws-1","task-dev","worker"]))}`,
      source: { requestId: delivery.requestId, specRevision: 1, instructionSha256: source.instructionSha256 }, registeredAtISO: now },
    { workstreamId: "ws-1", taskId: "task-qa", packetRevision: 1,
      packetRecordSha256: taskPacketRecordDigest(qaRecord, P, CTO, "ws-1"), role: "qa" as const,
      agentId: QA_AGENT, sessionId: QA_SESSION, pluginAgentKey: `builder-task-qa:${hash(JSON.stringify([P,"ws-1","task-qa","qa"]))}`,
      source: { requestId: delivery.requestId, specRevision: 1, instructionSha256: source.instructionSha256 }, registeredAtISO: now },
  ];
  f.values.set(mapKey(key(taskWorkerRegistryKey(P, CTO))),
    { schemaVersion: 1, workspaceId: W, projectId: P, ctoId: CTO, revision: 2, records: workers });
  const sessions = f.platform.agents.sessions as typeof f.platform.agents.sessions;
  Object.assign(f.platform.agents, { owned: { async get({ pluginAgentKey }: { pluginAgentKey: string }) {
    const worker = workers.find(row => row.pluginAgentKey === pluginAgentKey);
    return worker ? { status: "resolved", revision: 1, agent: { agentId: worker.agentId, status: "idle" } } : { status: "missing" };
  } }, async list() { return [{ id: A, status: "idle" }, ...workers.map(row => ({ id: row.agentId, status: "idle" }))]; } });

  const requests = new Map<string, { requestId: string; state: "submitted"; runId: string }>();
  const originalGetRequest = sessions.getRequest.bind(sessions);
  (sessions as any).getRequest = async (sessionId: string, companyId: string, requestId: string) =>
    [...requests.values()].find(row => row.requestId === requestId) ?? originalGetRequest(sessionId, companyId, requestId);
  Object.assign(f.platform, { localFolders: {
    async status(folderKey: string) { return { folderKey, configured: true, access: "read-write", readable: true, writable: true,
      healthy: true, requiredDirectories: [], requiredFiles: [], missingDirectories: [], missingFiles: [], checkedAt: now }; },
    async matchWorkspaceSourceV1(folderKey: string, sourceId: string) { return { folderKey, workspaceSourceId: sourceId, match: "same_root" }; },
    async readWorkspaceSourceGitTipV1(sourceId: string, folderKey: string, branch: string) {
      return { status: "current", sourceId, folderKey, branch, commitSha: COMMIT, treeSha: TREE, observedAt: now };
    },
    async commitTaskFilesV1() { return { status: "committed", commitSha: COMMIT, treeSha: TREE, changedPaths: ["src/feature.ts"] }; },
  } });

  const devBinding = { schemaVersion: 1 as const, workspaceId: W, projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId: "task-dev",
    packetRevision: 1, packetRecordSha256: devDigest, dependencyPins: devRecord.dependencyPins, role: "worker" as const,
    agentId: DEV_AGENT, sessionId: DEV_SESSION, runId: DEV_RUN,
    source: { sourceId: SOURCE, folderKey: access.folderKey, branch: access.branch, expectedHead: access.expectedHead },
    readPaths: access.readPaths, writePaths: access.writePaths, qaWritePaths: [] };
  const submitted = await submitTaskSourceFiles({ runContext: { companyId: W, projectId: P, agentId: DEV_AGENT, sessionId: DEV_SESSION, runId: DEV_RUN },
    paths: ["src/feature.ts"], platform: f.platform, state: f.state,
    async resolveAuthority() { return { binding: devBinding, async assertCurrent() {} }; } });
  assert.equal(submitted.status, "submitted");
  const devRequest = taskWorkerRequestId(deriveTaskWorkerFileBinding({ workspaceId: W, projectId: P, ctoId: CTO,
    packet: devRecord, currentPackets: packets, worker: workers[0]! }));
  const qaRequest = taskWorkerRequestId(deriveTaskWorkerFileBinding({ workspaceId: W, projectId: P, ctoId: CTO,
    packet: qaRecord, currentPackets: packets, worker: workers[1]! }));
  requests.set(devRequest, { requestId: devRequest, state: "submitted", runId: DEV_RUN });
  requests.set(qaRequest, { requestId: qaRequest, state: "submitted", runId: QA_RUN });
  const originalGetRun = sessions.getRun.bind(sessions);
  const runStatuses = new Map([[DEV_RUN, "running"], [QA_RUN, "running"]]);
  (sessions as any).getRun = async (sessionId: string, companyId: string, runId: string) => runStatuses.has(runId)
    ? { ...runKey(options.wrongProducerRun && runId === DEV_RUN ? QA_RUN : runId), status: runStatuses.get(runId),
      ...(options.timing ? { timing: { createdAt: now, startedAt: now, finishedAt: null } } : {}),
      ...(options.unrelatedRunField ? { callerApproved: true } : {}) } : originalGetRun(sessionId, companyId, runId);
  const accepted = await acceptCtoTaskSourceSubmission({ projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId: "task-dev",
    submissionId: submitted.submission!.submissionId }, ctoContext, f.platform);
  assert.equal(accepted.status, "accepted");
  (sessions as any).getRun = async (sessionId: string, companyId: string, runId: string) => runStatuses.has(runId)
    ? { ...runKey(runId), status: runStatuses.get(runId),
      termination: options.cancelQaRun && runId === QA_RUN ? "pending"
        : runStatuses.get(runId) === "succeeded" ? "confirmed" : "not_applicable",
      cancellationRequested: options.cancelQaRun === true && runId === QA_RUN,
      ...(options.timing ? { timing: { createdAt: now, startedAt: now, finishedAt: null } } : {}),
      ...(options.unrelatedRunField ? { callerApproved: true } : {}) }
    : originalGetRun(sessionId, companyId, runId);

  let reportReceiptDigest = "4".repeat(64);
  const coreRow = (subjectKey: string) => ({ schemaVersion: 1, kind: "protected-node-test-v1", id: CORE_RUN,
    status: "succeeded", termination: "confirmed", pins: { approvalId: APPROVAL, sourceId: SOURCE, planSha256: PLAN,
      profileSha256: "1".repeat(64), commitSha: COMMIT, treeSha: TREE, manifestSha256: "2".repeat(64), inputTreeSha256: TREE,
      nodeSha256: "3".repeat(64), subjectKeySha256: hash(subjectKey), timeoutMs: 30000 }, receipt: {
      digest: reportReceiptDigest, status: "completed", stdoutSha256: null, stderrSha256: null, stdoutBytes: 0, stderrBytes: 0,
      processExitCode: 0, timedOut: false, cancelled: false, outputLimit: false, appContainerVerified: true, capabilitiesCount: 0,
      childTerminationConfirmed: true, jobEmpty: true, profileCleanupSucceeded: true, sandboxCleanupSucceeded: true, fixtureMustBeRetained: false },
    timestamps: { createdAt: now, claimedAt: now, startedAt: now, finishedAt: now }, qaVerdict: "not-established" });
  Object.assign(f.platform, { protectedTests: {
    async enqueueApprovedV1(input: Record<string, string>) { options.onEnqueue?.(); return { ...coreRow(input.subjectKey), status: "queued", termination: "not_applicable", receipt: null }; },
    async getRunV1(_companyId: string, _runId: string, subjectKeyHash: string) {
      const targetSubject = (await import("../src/task-qa-run-references.ts")).createTaskQaRunReferenceStore(
        { workspaceId: W, projectId: P, ctoId: CTO, workstreamId: "ws-1", qaTaskId: "task-qa" }, f.state as never);
      const refs = await targetSubject.findRun(CORE_RUN);
      return refs.status === "found" && refs.reference.binding.subjectKeySha256 === subjectKeyHash
        ? coreRow(refs.reference.binding.subjectKey) : null;
    },
  } });
  const qaContext = { companyId: W, projectId: P, agentId: QA_AGENT, sessionId: QA_SESSION, runId: QA_RUN };
  const queued = await (await import("../src/task-protected-qa.ts")).requestProtectedTaskQa({ approvalId: APPROVAL, planSha256: PLAN }, qaContext, f.platform);
  assert.equal(queued.status, "queued", JSON.stringify(queued));
  const criteria = taskQaCriteria(qaRecord.packet.acceptance, qaRecord.packet.testPlan!.passCriteria, devRecord.packet.acceptance);
  const checks = criteria.map(item => ({ criterionId: item.criterionId, verdict: "passed", note: "Fixture-only criterion evidence." }));
  const reportParams = { projectId: P, ctoId: CTO, workstreamId: "ws-1", qaTaskId: "task-qa", approvalId: APPROVAL,
    planSha256: PLAN, runId: CORE_RUN, expectedBaseRevisionId: null, checks, summary: "Fixture-only report." };
  const ctoNow = { ...ctoContext, projectId: P };
  const revisionState = f.state as unknown as RevisionState;
  revisionState.guardedCompareAndSet = (async (target: any, expected: any, value: any) => {
    for (const guard of target.guards) {
      const actual = f.values.get(mapKey({ scopeKind: "company", scopeId: target.scopeId,
        namespace: guard.namespace, stateKey: guard.stateKey }));
      if (JSON.stringify(actual) !== JSON.stringify(guard.expectedValue)) return { status: "conflict" as const };
    }
    const targetKey = mapKey({ scopeKind: target.scopeKind, scopeId: target.scopeId,
      namespace: target.namespace, stateKey: target.stateKey });
    const actual = f.values.get(targetKey);
    if (expected.exists ? JSON.stringify(actual) !== JSON.stringify(expected.value) : actual !== undefined) return { status: "conflict" as const };
    f.values.set(targetKey, structuredClone(value));
    return { status: "committed" as const };
  }) as never;
  const report = await publishTaskQaReport(reportParams, qaContext, f.platform) as { status: string };
  assert.equal(report.status, "published");
  runStatuses.set(QA_RUN, "succeeded");
  const reportScope = { workspaceId: W, projectId: P, ctoId: CTO, workstreamId: "ws-1", qaTaskId: "task-qa" };
  const reportStore = () => createTaskQaReportStore(reportScope, f.state as never);
  const referenceStore = () => createTaskQaRunReferenceStore(reportScope, f.state as never);
  const reportCurrent = await reportStore().current();
  assert.ok(reportCurrent);
  return { f, ctoNow, reportStore, referenceStore, reportParams, workers, read() { return readCurrentProtectedTaskQaEvidence({ scope: { workspaceId: W, projectId: P, workstreamId: "ws-1", taskId: "task-dev" },
    ctoId: CTO, runContext: ctoNow, platform: f.platform }); } };
}

test("registered source acceptance and QA admission accept optional Run timing without loosening authority", async t => {
  await t.test("current producer and QA Runs with timing complete the existing scoped path", async () => {
    const f = await setup({ timing: true });
    assert.equal((await f.read()).status, "available");
  });
  await t.test("a different producer Run identity still blocks source acceptance", async () => {
    await assert.rejects(setup({ timing: true, wrongProducerRun: true }), /Task producer Run identity could not be verified/u);
  });
  await t.test("cancelled QA Run still blocks admission before protected enqueue", async () => {
    let enqueues = 0;
    await assert.rejects(setup({ timing: true, cancelQaRun: true, onEnqueue: () => { enqueues += 1; } }),
      /active uncancelled Worker\/QA Run/u);
    assert.equal(enqueues, 0);
  });
  await t.test("unrelated Run fields remain rejected", async () => {
    await assert.rejects(setup({ timing: true, unrelatedRunField: true }), /Invalid Builder tool fields/u);
  });
});

test("current CTO can read exact current Task/report/Core evidence without another run", async () => {
  const f = await setup();
  const result = await f.read();
  assert.equal(result.status, "available", JSON.stringify(result));
  if (result.status !== "available") return;
  assert.equal(result.value.implementationRecord.packet.taskId, "task-dev");
  assert.equal(result.value.qaRecord.packet.taskId, "task-qa");
  assert.equal(result.value.report.verdict, "passed");
  assert.notEqual(result.value.report.author.runId, result.value.report.reference.binding.runId);
  assert.equal(result.value.coreRun.id, result.value.report.reference.binding.runId);
  assert.equal(result.value.coreRun.status, "succeeded");
  await result.check();
});

test("latest failed or incomplete report and changed source tip never fall back to an older pass", async t => {
  await t.test("newer failed report", async () => {
    const f = await setup();
    const current = (await f.reportStore().current())!.revision;
    const content = { schemaVersion: 1 as const, reference: current.reference, coreReceiptDigest: current.coreReceiptDigest,
      coreStatus: "succeeded" as const, author: current.author,
      checks: current.checks.map((check, index) => ({ ...check, verdict: index === 0 ? "failed" as const : "passed" as const })),
      summary: "Fixture-seeded newer failed report.", verdict: "failed" as const };
    const newer = parseTaskQaReport({ ...content, revisionId: `task-qa-report-v1:${digest(content)}` });
    const result = await f.reportStore().publish({ expectedBaseRevisionId: current.revisionId, revision: newer });
    assert.equal(result.status, "published");
    assert.equal((await f.read()).status, "unknown");
  });
  await t.test("source tip drift", async () => {
    const f = await setup();
    const folders = (f.f.platform as any).localFolders;
    folders.readWorkspaceSourceGitTipV1 = async (sourceId: string, folderKey: string, branch: string) =>
      ({ status: "current", sourceId, folderKey, branch, commitSha: "e".repeat(40), treeSha: TREE, observedAt: now });
    const result = await f.read();
    assert.equal(result.status, "unknown");
    if (result.status === "unknown") assert.match(result.reason, /tip|stale|source/iu);
  });
});

test("a newer immutable Core run reference makes the old report non-current", async () => {
  const f = await setup();
  const store = f.referenceStore();
  const current = (await store.current())!.revision;
  const body = { schemaVersion: 1 as const, scope: current.scope,
    binding: { ...current.binding, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab" } };
  const newer = parseTaskQaRunReference({ ...body, revisionId: `task-qa-run-v1:${digest(body)}` });
  const result = await store.publish({ expectedBaseRevisionId: current.revisionId, revision: newer });
  assert.equal(result.status, "published");
  const evidence = await f.read();
  assert.equal(evidence.status, "unknown");
  if (evidence.status === "unknown") assert.equal(evidence.reason, "report-does-not-reference-current-protected-qa-run");
});

test("a non-current Host Git tip response is not a malformed request or verification evidence", async t => {
  for (const [status, reason] of [["unknown", "source_unavailable"], ["denied", "branch_not_authorized"]] as const) {
    await t.test(status, async () => {
      const f = await setup();
      const folders = (f.f.platform as any).localFolders;
      folders.readWorkspaceSourceGitTipV1 = async () => ({ status, reason });
      const result = await f.read();
      assert.equal(result.status, "unknown");
      if (result.status === "unknown") assert.match(result.reason, new RegExp(`host-git-tip-proof-${status}$`, "u"));
    });
  }
});

test("wrong CTO context and missing session/Core readers fail closed", async t => {
  await t.test("wrong CTO identity", async () => {
    const f = await setup();
    assert.equal((await readCurrentProtectedTaskQaEvidence({ scope: { workspaceId: W, projectId: P, workstreamId: "ws-1", taskId: "task-dev" },
      ctoId: CTO, runContext: { ...f.ctoNow, agentId: QA_AGENT, sessionId: QA_SESSION, runId: QA_RUN }, platform: f.f.platform })).status, "unknown");
  });
  await t.test("Core reader absent", async () => {
    const f = await setup(); delete (f.f.platform as any).protectedTests;
    assert.equal((await f.read()).status, "unknown");
  });
});
