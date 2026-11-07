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
import { publishTaskQaReport, createTaskQaReportStore, taskQaCriteria } from "../src/task-qa-reports.ts";
import { REQUEST_PROTECTED_TASK_QA_TOOL } from "../src/task-packet-tool-declarations.mjs";
import { createBuilderPlatform } from "../src/platform.ts";
import { fixture, A, C, CTO, W, ctx, now, key, mapKey } from "./fixtures/cto-platform.ts";

const P = W;
const SOURCE = "22222222-2222-4222-8222-222222222222";
const DEV_AGENT = "33333333-3333-4333-8333-333333333333";
const DEV_SESSION = "44444444-4444-4444-8444-444444444444";
const DEV_RUN = "55555555-5555-4555-8555-555555555555";
const QA_AGENT = "66666666-6666-4666-8666-666666666666";
const QA_SESSION = "77777777-7777-4777-8777-777777777777";
const QA_RUN = "88888888-8888-4888-8888-888888888888";
const CORE_RUN = "99999999-9999-4999-8999-999999999999";
const APPROVAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMMIT = "b".repeat(40), TREE = "c".repeat(40), PLAN = "d".repeat(64);
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const runKey = (runId: string) => ({ runId, status: "running", cancellationRequested: false,
  termination: "not_applicable", errorCode: null, error: null });

/** Host/Core callbacks below are deterministic contract fixtures; they do not run a Node test or AppContainer. */
async function setup() {
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
      goal: "Check the exact accepted implementation.", scopeNodeIds: ["feature"], requirementIds: ["REQ-1"], dependencies,
      included: ["Assigned behavior"], excluded: [], constraints: [], acceptance: ["Acceptance criterion one", "Acceptance criterion two"],
      evidenceRequired: ["Protected run reference", "Criterion evidence"], reuse: [],
      testPlan: kind === "qa" ? { environment: "Pinned Node runtime", steps: ["Inspect exact accepted commit"],
        expectedResults: ["Evidence is recorded for every criterion"], passCriteria: ["Pinned behavior is correct", "No regression is present"] } : null,
      sourceAccess: { ...access, writePaths: kind === "development" ? access.writePaths : [],
        qaWritePaths: kind === "qa" ? access.qaWritePaths : [] } },
    source, author: { agentId: A, sessionId: C, runId: ctoRunId }, createdAtISO: now, dependencyPins: [] as Array<{taskId:string;revision:number;recordSha256:string}>,
  });
  const dev = record("task-dev", "development");
  const devDigest = taskPacketRecordDigest(dev as never, P, CTO, "ws-1");
  const qa = record("task-qa", "qa", ["task-dev"]);
  qa.dependencyPins = [{ taskId: "task-dev", revision: 1, recordSha256: devDigest }];
  const packetStore = createTaskPacketStore(W, P, CTO, "ws-1", f.state);
  await packetStore.publish({ expectedBaseRevisionId: null, revision: { projectId: P, ctoId: CTO, workstreamId: "ws-1",
    revisionId: "qa-report-packets-1", packets: [dev, qa] } });
  const board = (await packetStore.current())!.revision;
  const devRecord = board.packets.find(row => row.packet.taskId === "task-dev")!;
  const qaRecord = board.packets.find(row => row.packet.taskId === "task-qa")!;
  const workers = [
    { workstreamId: "ws-1", taskId: "task-dev", packetRevision: 1, packetRecordSha256: devDigest, role: "worker" as const,
      agentId: DEV_AGENT, sessionId: DEV_SESSION, pluginAgentKey: `builder-task-worker:${sha256(JSON.stringify([P,"ws-1","task-dev","worker"]))}`,
      source: { requestId: delivery.requestId, specRevision: 1, instructionSha256: source.instructionSha256 }, registeredAtISO: now },
    { workstreamId: "ws-1", taskId: "task-qa", packetRevision: 1, packetRecordSha256: taskPacketRecordDigest(qaRecord, P, CTO, "ws-1"), role: "qa" as const,
      agentId: QA_AGENT, sessionId: QA_SESSION, pluginAgentKey: `builder-task-qa:${sha256(JSON.stringify([P,"ws-1","task-qa","qa"]))}`,
      source: { requestId: delivery.requestId, specRevision: 1, instructionSha256: source.instructionSha256 }, registeredAtISO: now },
  ];
  const registryKey = key(taskWorkerRegistryKey(P, CTO));
  f.values.set(mapKey(registryKey), { schemaVersion: 1, workspaceId: W, projectId: P, ctoId: CTO, revision: 2, records: workers });

  const profiles = new Map([[DEV_AGENT, "idle"], [QA_AGENT, "idle"]]);
  Object.assign(f.platform.agents, { owned: { async get({ pluginAgentKey }: { pluginAgentKey: string }) {
    if (pluginAgentKey === "integration-manager") return { status: "missing" };
    const row = workers.find(worker => worker.pluginAgentKey === pluginAgentKey);
    return row ? { status: "resolved", revision: 1, agent: { agentId: row.agentId, status: profiles.get(row.agentId)! } } : { status: "missing" };
  } }, async list() { return [{ id: A, status: "idle" }, ...workers.map(row => ({ id: row.agentId, status: profiles.get(row.agentId)! }))]; } });

  const requests = new Map<string, { requestId: string; state: "submitted"; runId: string }>();
  const runStates = new Map<string, string>([[ctoRunId, "running"], [DEV_RUN, "running"], [QA_RUN, "running"]]);
  const sessions = f.platform.agents.sessions as typeof f.platform.agents.sessions;
  const originalGetRequest = sessions.getRequest.bind(sessions), originalGetRun = sessions.getRun.bind(sessions);
  (sessions as any).getRequest = async (sessionId: string, companyId: string, requestId: string) =>
    requests.get(`${sessionId}:${requestId}`) ?? originalGetRequest(sessionId, companyId, requestId);
  (sessions as any).getRun = async (sessionId: string, companyId: string, runId: string) => {
    if (runStates.has(runId)) return { ...runKey(runId), status: runStates.get(runId) };
    return originalGetRun(sessionId, companyId, runId);
  };
  const hostPlatform = f.platform as typeof f.platform & { localFolders: Record<string, (...args: any[]) => any> };
  Object.assign(hostPlatform, { localFolders: {
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
  requests.set(`${DEV_SESSION}:${taskWorkerRequestId(deriveTaskWorkerFileBinding({ workspaceId: W, projectId: P, ctoId: CTO,
    packet: devRecord, currentPackets: board.packets, worker: workers[0]! }))}`, {
    requestId: taskWorkerRequestId(deriveTaskWorkerFileBinding({ workspaceId: W, projectId: P, ctoId: CTO,
      packet: devRecord, currentPackets: board.packets, worker: workers[0]! })), state: "submitted", runId: DEV_RUN });
  requests.set(`${QA_SESSION}:${taskWorkerRequestId(deriveTaskWorkerFileBinding({ workspaceId: W, projectId: P, ctoId: CTO,
    packet: qaRecord, currentPackets: board.packets, worker: workers[1]! }))}`, {
    requestId: taskWorkerRequestId(deriveTaskWorkerFileBinding({ workspaceId: W, projectId: P, ctoId: CTO,
      packet: qaRecord, currentPackets: board.packets, worker: workers[1]! })), state: "submitted", runId: QA_RUN });
  const accepted = await acceptCtoTaskSourceSubmission({ projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId: "task-dev",
    submissionId: submitted.submission!.submissionId }, ctoContext, f.platform);
  assert.equal(accepted.status, "accepted");

  let coreStatus = "queued", coreReceipt: Record<string, unknown> | null = null, enqueueCalls = 0;
  const coreRows = new Map<string, unknown>();
  Object.assign(f.platform, { protectedTests: {
    async enqueueApprovedV1(input: Record<string, string>) {
      enqueueCalls++;
      const row = { schemaVersion: 1, kind: "protected-node-test-v1", id: CORE_RUN, status: "queued", termination: "not_applicable",
        pins: { approvalId: input.approvalId, sourceId: input.sourceId, planSha256: input.planSha256, profileSha256: "1".repeat(64),
          commitSha: input.commitSha, treeSha: input.treeSha, manifestSha256: "2".repeat(64), inputTreeSha256: TREE,
          nodeSha256: "3".repeat(64), subjectKeySha256: sha256(input.subjectKey), timeoutMs: 30000 }, receipt: null,
        timestamps: { createdAt: now, claimedAt: null, startedAt: null, finishedAt: null }, qaVerdict: "not-established" };
      coreRows.set(CORE_RUN, row); return row;
    },
    async getRunV1(_companyId: string, runId: string) {
      if (!coreReceipt) return coreRows.get(runId) ?? null;
      return { ...coreRows.get(runId) as object, status: coreStatus, termination: "confirmed", receipt: coreReceipt };
    },
  } });
  const queued = await (await import("../src/task-protected-qa.ts")).requestProtectedTaskQa({ approvalId: APPROVAL, planSha256: PLAN },
    { companyId: W, projectId: P, agentId: QA_AGENT, sessionId: QA_SESSION, runId: QA_RUN }, f.platform);
  assert.equal(queued.status, "queued", JSON.stringify(queued));
  assert.equal(enqueueCalls, 1);
  coreStatus = "succeeded";
  // A DTO-shaped fixture returned by a mocked Core reader; this asserts receipt validation only, not OS execution.
  coreReceipt = { digest: "4".repeat(64), status: "completed", stdoutSha256: null, stderrSha256: null, stdoutBytes: 0, stderrBytes: 0,
    processExitCode: 0, timedOut: false, cancelled: false, outputLimit: false, appContainerVerified: true, capabilitiesCount: 0,
    childTerminationConfirmed: true, jobEmpty: true, profileCleanupSucceeded: true, sandboxCleanupSucceeded: true, fixtureMustBeRetained: false };
  const criteria = taskQaCriteria(qaRecord.packet.acceptance, qaRecord.packet.testPlan!.passCriteria, devRecord.packet.acceptance);
  const reportParams = (checks = criteria.map(item => ({ criterionId: item.criterionId, verdict: "passed", note: "Checked against the mocked exact Core receipt." }))) => ({
    projectId: P, ctoId: CTO, workstreamId: "ws-1", qaTaskId: "task-qa", approvalId: APPROVAL, planSha256: PLAN,
    runId: CORE_RUN, expectedBaseRevisionId: null, checks, summary: "Fixture-only assessment of every assigned criterion." });

  const guarded = async (targetKey: any, expected: any, value: any) => {
    for (const guard of targetKey.guards) {
      const actual = f.values.get(mapKey({ scopeKind: "company", scopeId: targetKey.scopeId,
        namespace: guard.namespace, stateKey: guard.stateKey }));
      if (JSON.stringify(actual) !== JSON.stringify(guard.expectedValue)) return { status: "conflict" as const };
    }
    const k = mapKey({ scopeKind: targetKey.scopeKind, scopeId: targetKey.scopeId,
      namespace: targetKey.namespace, stateKey: targetKey.stateKey }), actual = f.values.get(k);
    if (expected.exists ? JSON.stringify(actual) !== JSON.stringify(expected.value) : actual !== undefined) return { status: "conflict" as const };
    f.values.set(k, structuredClone(value)); return { status: "committed" as const };
  };
  const revisionState = f.state as unknown as RevisionState;
  revisionState.guardedCompareAndSet = guarded as never;
  const reportScope = { workspaceId: W, projectId: P, ctoId: CTO, workstreamId: "ws-1", qaTaskId: "task-qa" };
  const reportStore = () => createTaskQaReportStore(reportScope, revisionState);
  const params = reportParams();
  const qaContext = { companyId: W, projectId: P, agentId: QA_AGENT, sessionId: QA_SESSION, runId: QA_RUN };
  return { f, params, criteria, reportStore, qaContext, workers, runStates, setCore(status: string, receipt: Record<string, unknown>) {
    coreStatus = status; coreReceipt = receipt;
  }, setTip(commitSha: string) {
    hostPlatform.localFolders.readWorkspaceSourceGitTipV1 = async (sourceId: string, folderKey: string, branch: string) =>
      ({ status: "current", sourceId, folderKey, branch, commitSha, treeSha: TREE, observedAt: now });
  }, enqueueCalls: () => enqueueCalls, setGuarded(value: typeof guarded) { revisionState.guardedCompareAndSet = value as never; },
    registered: createBuilderPlatform().tools.find(tool => tool.name === "builder.publish-task-qa-report"), };
}

test("registered report author publishes only the full exact current QA assessment; mocked Core DTO is not an execution claim", async () => {
  const f = await setup();
  assert.ok(f.registered);
  const result = await f.registered!.handler(f.params, f.qaContext, f.f.platform) as unknown as { data?: {
    status: string; report?: { verdict: string; checks: readonly unknown[]; coreReceiptDigest: string; workstreamVerification?: unknown } } };
  assert.ok(result.data);
  assert.ok(result.data.report);
  assert.equal(result.data.status, "published");
  assert.equal(result.data.report.verdict, "passed");
  assert.equal(result.data.report.checks.length, f.criteria.length);
  assert.equal(result.data.report.coreReceiptDigest, "4".repeat(64));
  assert.equal(result.data.report.workstreamVerification, undefined);
  assert.equal((await f.reportStore().current())!.revision.verdict, "passed");
  assert.equal(f.enqueueCalls(), 1, "report publication must not trigger another execution");
  assert.equal(REQUEST_PROTECTED_TASK_QA_TOOL.name, "builder.request-protected-task-qa");
});

test("Workspace UUID is the authenticated single-project scope; another UUID cannot publish", async () => {
  const f = await setup();
  const result = await publishTaskQaReport(f.params, { ...f.qaContext, projectId: W }, f.f.platform);
  assert.equal(result.status, "published");
  const otherProject = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
  await assert.rejects(publishTaskQaReport(f.params, { ...f.qaContext, projectId: otherProject }, f.f.platform));
  assert.equal((await f.reportStore().current())!.revision.verdict, "passed");
});

test("not-tested remains incomplete and an all-passed checklist cannot override failed Core execution", async () => {
  const f = await setup();
  const partial = f.params.checks.map((check, index) => ({ ...check, verdict: index === 1 ? "not-tested" : check.verdict }));
  const partialResult = await publishTaskQaReport({ ...f.params, checks: partial }, f.qaContext, f.f.platform) as {
    status: string; report?: { verdict: string; checks: readonly { verdict: string }[] } };
  assert.equal(partialResult.status, "published");
  assert.equal(partialResult.report?.verdict, "incomplete");
  assert.equal(partialResult.report?.checks.some(item => item.verdict === "not-tested"), true);
  const failed = await setup();
  failed.setCore("failed", { digest: "5".repeat(64), status: "failed", stdoutSha256: null, stderrSha256: null,
    stdoutBytes: 0, stderrBytes: 0, processExitCode: 1, timedOut: false, cancelled: false, outputLimit: false,
    appContainerVerified: true, capabilitiesCount: 0, childTerminationConfirmed: true, jobEmpty: true,
    profileCleanupSucceeded: true, sandboxCleanupSucceeded: true, fixtureMustBeRetained: false });
  const failedResult = await publishTaskQaReport(failed.params, failed.qaContext, failed.f.platform) as {
    status: string; report?: { verdict: string } };
  assert.equal(failedResult.status, "published");
  assert.equal(failedResult.report?.verdict, "failed");
});

test("wrong role, moved source, superseded QA packet, and ended QA lease cannot publish", async t => {
  await t.test("wrong role", async () => {
    const f = await setup();
    await assert.rejects(publishTaskQaReport(f.params, { ...f.qaContext, agentId: DEV_AGENT, sessionId: DEV_SESSION, runId: DEV_RUN }, f.f.platform));
    assert.equal((await f.reportStore().current()), null);
  });
  await t.test("source moved", async () => {
    const f = await setup(); f.setTip("e".repeat(40));
    const result = await publishTaskQaReport(f.params, f.qaContext, f.f.platform);
    assert.equal(result.status, "stale");
    assert.equal((await f.reportStore().current()), null);
  });
  await t.test("old QA Task revision", async () => {
    const f = await setup();
    const packetStore = createTaskPacketStore(W, P, CTO, "ws-1", f.f.state as never);
    const current = (await packetStore.current())!.revision;
    await packetStore.publish({ expectedBaseRevisionId: current.revisionId, revision: { ...current, revisionId: "qa-report-packet-2",
      packets: current.packets.map(row => row.packet.taskId === "task-qa" ? { ...row, packet: { ...row.packet, revision: 2 } } : row) } });
    await assert.rejects(publishTaskQaReport(f.params, f.qaContext, f.f.platform));
    assert.equal((await f.reportStore().current()), null);
  });
  await t.test("QA session ended", async () => {
    const f = await setup(); f.runStates.set(QA_RUN, "succeeded");
    await assert.rejects(publishTaskQaReport(f.params, f.qaContext, f.f.platform));
    assert.equal((await f.reportStore().current()), null);
  });
});

test("guarded publication conflict after source-state drift leaves no published report", async () => {
  const f = await setup();
  const state = f.f.state as unknown as RevisionState;
  const original = state.guardedCompareAndSet!;
  f.setGuarded(async (targetKey, expected, value) => {
    const keyValue = mapKey(key(taskWorkerRegistryKey(P, CTO)));
    const raw = f.f.values.get(keyValue) as any;
    f.f.values.set(keyValue, { ...raw, revision: raw.revision + 1 });
    const result = await original(targetKey, expected, value);
    assert.equal(result.status, "conflict");
    return result;
  });
  const result = await publishTaskQaReport(f.params, f.qaContext, f.f.platform);
  assert.equal(result.status, "stale");
  assert.equal((await f.reportStore().current()), null);
  assert.equal(f.enqueueCalls(), 1);
});

test("guarded publication includes the current Task Packet head, not only its immutable journal entry", async () => {
  const f = await setup();
  const packetScopeHash = sha256(JSON.stringify([P, CTO, "ws-1"]));
  const packetJournalProject = `packets:${packetScopeHash}`;
  const packetHeadKey = `task-packets-head.v1.${sha256(packetJournalProject)}`;
  const state = f.f.state as unknown as RevisionState;
  const original = state.guardedCompareAndSet!;
  f.setGuarded(async (targetKey, expected, value) => {
    assert.ok(targetKey.guards.some((guard: any) => guard.stateKey === packetHeadKey
      && guard.namespace === "sonpark.my-builder"), "published Task head must be a mutable publication guard");
    const keyValue = mapKey(key(packetHeadKey));
    const raw = f.f.values.get(keyValue) as any;
    f.f.values.set(keyValue, { ...raw, digest: "e".repeat(64) });
    const result = await original(targetKey, expected, value);
    assert.equal(result.status, "conflict");
    return result;
  });
  const result = await publishTaskQaReport(f.params, f.qaContext, f.f.platform);
  assert.equal(result.status, "stale");
  assert.equal((await f.reportStore().current()), null);
  assert.equal(f.enqueueCalls(), 1);
});
