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
import { readTaskQaEventOrigin, readTaskWorkerFile } from "../src/task-worker-tools.ts";
import { publishTaskQaReport, createTaskQaReportStore, taskQaCriteria } from "../src/task-qa-reports.ts";
import { MANAGER_SESSION_TERMINAL_JOB } from "../src/builder-gates/integration-manager-job.ts";
import { WORKSTREAM_VERIFIED_JOB } from "../src/builder-gates/workstream-verification-publication.ts";
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
type Fixture = Awaited<ReturnType<typeof fixture>>;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const runKey = (runId: string) => ({ runId, status: "running", cancellationRequested: false,
  termination: "not_applicable", errorCode: null, error: null });

async function runRegisteredProtectedTerminalJob(job: unknown, platform: Fixture["platform"]) {
  const registered = createBuilderPlatform().jobs.find(item => item.jobKey === WORKSTREAM_VERIFIED_JOB);
  assert.ok(registered, "protected terminal consumer remains registered on WORKSTREAM_VERIFIED_JOB");
  await registered.handler(job as never, platform);
}

async function runRegisteredSessionTerminalJob(job: unknown, platform: Fixture["platform"]) {
  const registered = createBuilderPlatform().jobs.find(item => item.jobKey === MANAGER_SESSION_TERMINAL_JOB);
  assert.ok(registered, "QA origin terminal consumer remains registered on agent-session-terminal");
  await registered.handler(job as never, platform);
}

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
  const systemEvents = new Map<string, Record<string, unknown>>();
  const dispatchCalls: Array<{ sessionId: string; companyId: string; input: Record<string, unknown>; replayed: boolean }> = [];
  const dispatchReceipts = new Map<string, { requestId: string; runId: string }>();
  const sessions = f.platform.agents.sessions as typeof f.platform.agents.sessions;
  const originalGetRequest = sessions.getRequest.bind(sessions), originalGetRun = sessions.getRun.bind(sessions);
  (sessions as any).getRequest = async (sessionId: string, companyId: string, requestId: string) =>
    requests.get(`${sessionId}:${requestId}`) ?? originalGetRequest(sessionId, companyId, requestId);
  (sessions as any).getRun = async (sessionId: string, companyId: string, runId: string) => {
    if (runStates.has(runId)) return { ...runKey(runId), status: runStates.get(runId),
      ...(systemEvents.has(runId) ? { systemEvent: systemEvents.get(runId) } : {}) };
    return originalGetRun(sessionId, companyId, runId);
  };
  const fakeDispatch = async (sessionId: string, companyId: string, input: Record<string, unknown>) => {
    const eventId = String(input.eventId);
    const existing = dispatchReceipts.get(eventId);
    if (existing) {
      dispatchCalls.push({ sessionId, companyId, input: structuredClone(input), replayed: true });
      return { ...existing, replayed: true };
    }
    const receipt = { requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc", runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd" };
    dispatchReceipts.set(eventId, receipt);
    dispatchCalls.push({ sessionId, companyId, input: structuredClone(input), replayed: false });
    return { ...receipt, replayed: false };
  };
  (sessions as any).dispatchProtectedEventV1 = fakeDispatch;
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
  const qaDispatchRequestId = taskWorkerRequestId(deriveTaskWorkerFileBinding({ workspaceId: W, projectId: P, ctoId: CTO,
    packet: qaRecord, currentPackets: board.packets, worker: workers[1]! }));
  requests.set(`${QA_SESSION}:${qaDispatchRequestId}`, { requestId: qaDispatchRequestId, state: "submitted", runId: QA_RUN });
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
  const coreSubjectKeySha256 = (coreRows.get(CORE_RUN) as { pins: { subjectKeySha256: string } }).pins.subjectKeySha256;
  const terminalEvent = (eventNonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") => ({ jobKey: WORKSTREAM_VERIFIED_JOB,
    trigger: "event" as const, eventId: `sps-protected-test-terminal-v1:${CORE_RUN}:${"4".repeat(64)}:${coreSubjectKeySha256}:${eventNonce}`,
    companyId: W, runId: QA_RUN, event: { eventType: "sps.protected-test.terminal",
      payload: { schemaVersion: 1, kind: "protected-node-test-v1", companyId: W, pluginId: P,
        pluginKey: "com.sonparkserver.my-plugin-builder", runId: CORE_RUN, status: "succeeded",
        receiptDigest: "4".repeat(64), subjectKeySha256: coreSubjectKeySha256 } } });
  return { f, params, criteria, reportStore, qaContext, workers, runStates, qaDispatchRequestId, terminalEvent,
    dispatchCalls, dispatchReceipts, coreSubjectKeySha256, fakeDispatch,
    setDispatchAvailable(available: boolean) {
      if (available) (sessions as any).dispatchProtectedEventV1 = fakeDispatch;
      else delete (sessions as any).dispatchProtectedEventV1;
    }, setCore(status: string, receipt: Record<string, unknown>) {
    coreStatus = status; coreReceipt = receipt;
  }, setTip(commitSha: string) {
    hostPlatform.localFolders.readWorkspaceSourceGitTipV1 = async (sourceId: string, folderKey: string, branch: string) =>
      ({ status: "current", sourceId, folderKey, branch, commitSha, treeSha: TREE, observedAt: now });
  }, enqueueCalls: () => enqueueCalls, setGuarded(value: typeof guarded) { revisionState.guardedCompareAndSet = value as never; },
    registered: createBuilderPlatform().tools.find(tool => tool.name === "builder.publish-task-qa-report"),
    resumeQa(overrides: Record<string, unknown> = {}) {
      const runId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const requestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const subjectKeySha256 = (coreRows.get(CORE_RUN) as { pins: { subjectKeySha256: string } }).pins.subjectKeySha256;
      const receiptDigest = String(coreReceipt!.digest);
      const eventReceiptDigest = Object.hasOwn(overrides, "receiptDigest") ? overrides.receiptDigest : receiptDigest;
      const eventSubjectHash = Object.hasOwn(overrides, "subjectKeySha256") ? overrides.subjectKeySha256 : subjectKeySha256;
      const eventId = Object.hasOwn(overrides, "eventId") ? overrides.eventId
        : `sps-protected-test-terminal-v1:${CORE_RUN}:${String(eventReceiptDigest)}:${String(eventSubjectHash)}:dddddddd-dddd-4ddd-8ddd-dddddddddddd`;
      runStates.set(QA_RUN, "succeeded"); runStates.set(runId, "running");
      systemEvents.set(runId, { schemaVersion: 1, kind: "protected-test-terminal-event", requestId,
        previousRunId: QA_RUN, eventId, protectedRunId: CORE_RUN, receiptDigest, subjectKeySha256, ...overrides });
      requests.set(`${QA_SESSION}:${requestId}`, { requestId, state: "submitted", runId });
      return { ...qaContext, runId };
    },
  };
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

test("registered QA report accepts one exact Core event continuation, not the closed original author Run", async () => {
  const f = await setup();
  const resumed = f.resumeQa();
  const result = await f.registered!.handler(f.params, resumed, f.f.platform) as unknown as {
    data: { status: string; report: { author: { runId: string }; coreReceiptDigest: string } } };
  assert.equal(result.data.status, "published");
  assert.equal(result.data.report.author.runId, resumed.runId);
  assert.equal(result.data.report.coreReceiptDigest, "4".repeat(64));
  await assert.rejects(publishTaskQaReport(f.params, f.qaContext, f.f.platform));
  assert.equal(f.enqueueCalls(), 1, "a continuation report must not enqueue another protected test");
});

async function terminalAssessmentFixture(protectedStatus: "succeeded" | "failed") {
  const f = await setup();
  if (protectedStatus === "failed") f.setCore("failed", { digest: "4".repeat(64), status: "failed",
    stdoutSha256: null, stderrSha256: null, stdoutBytes: 0, stderrBytes: 0, processExitCode: 1,
    timedOut: false, cancelled: false, outputLimit: false, appContainerVerified: true, capabilitiesCount: 0,
    childTerminationConfirmed: true, jobEmpty: true, profileCleanupSucceeded: true,
    sandboxCleanupSucceeded: true, fixtureMustBeRetained: false });
  const author = f.resumeQa();
  const published = await publishTaskQaReport(f.params, author, f.f.platform);
  assert.equal(published.status, "published");
  const report = (await f.reportStore().current())!.revision;
  assert.equal(report.verdict, protectedStatus === "succeeded" ? "passed" : "failed");
  f.runStates.set(author.runId, "succeeded");
  f.runStates.set(DEV_RUN, "succeeded");
  const parent = (await f.f.deliveryStore().current())!.revision;
  f.runStates.set(parent.runId!, "succeeded");
  const sessions = f.f.platform.agents.sessions as typeof f.f.platform.agents.sessions & Record<string, any>;
  sessions.list = async (agentId: string, workspaceId: string) => {
    assert.equal(workspaceId, W);
    return agentId === A ? [{ sessionId: C, agentId: A, companyId: W, status: "active",
      closedAt: null, lastRunId: parent.runId }] : agentId === QA_AGENT ? [{
      sessionId: QA_SESSION, agentId: QA_AGENT, companyId: W, status: "active", closedAt: null,
      lastRunId: author.runId, taskKey: `plugin:com.sonparkserver.my-plugin-builder:session:${f.workers[1]!.pluginAgentKey}`,
    }] : [];
  };
  const dispatches: Array<Record<string, unknown>> = [];
  let beforeTaskHandoff = async () => {};
  sessions.dispatchSessionTerminalEventV1 = async (sessionId: string, workspaceId: string, input: Record<string, unknown>) => {
    assert.equal(sessionId, C); assert.equal(workspaceId, W);
    await beforeTaskHandoff();
    const guards = input.guards as Array<{ stateKey: string; namespace?: string; expectedValue: unknown }>;
    for (const guard of guards) assert.deepEqual(await f.f.state.get({ scopeKind: "company", scopeId: W,
      namespace: guard.namespace, stateKey: guard.stateKey }), guard.expectedValue);
    dispatches.push(structuredClone(input));
    return { requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      runId: "ffffffff-ffff-4fff-8fff-ffffffffffff", replayed: false };
  };
  const terminal = { jobKey: MANAGER_SESSION_TERMINAL_JOB, trigger: "event",
    companyId: W, runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    eventId: `agent-session-terminal-v1:${"a".repeat(64)}`,
    event: { eventType: "agent.session.run.terminal", payload: { schemaVersion: 1, runId: author.runId,
      sessionId: QA_SESSION, requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      status: "succeeded", resultSha256: "b".repeat(64), finishedAt: now } } };
  return { ...f, author, report, dispatches, terminal,
    setBeforeTaskHandoff(hook: typeof beforeTaskHandoff) { beforeTaskHandoff = hook; } };
}

for (const protectedStatus of ["succeeded", "failed"] as const) {
  test(`registered QA author terminal hands off its exact ${protectedStatus} protected assessment without conflating Run IDs`, async () => {
    const f = await terminalAssessmentFixture(protectedStatus);
    assert.notEqual(f.report.reference.binding.requestId, f.terminal.event.payload.requestId);
    assert.notEqual(f.report.reference.binding.runId, f.author.runId);
    await runRegisteredSessionTerminalJob(f.terminal, f.f.platform);
    assert.equal(f.dispatches.length, 1);
    assert.equal(f.dispatches[0]!.sourceRunId, f.author.runId);
    const handoff = (await f.f.deliveryStore().current())!.revision.taskResultHandoffs![0]!;
    assert.equal(handoff.qaReportRevisionId, f.report.revisionId);
    assert.equal(handoff.sourceStatus, "succeeded");
    assert.equal(handoff.sourceCommitSha, COMMIT);
    assert.equal((await f.reportStore().current())!.revision.verdict,
      protectedStatus === "succeeded" ? "passed" : "failed");
    await runRegisteredSessionTerminalJob(f.terminal, f.f.platform);
    assert.equal(f.dispatches.length, 1, "a duplicate author terminal cannot create a second child");
  });
}

test("registered QA terminal refuses a changed Source instead of forwarding an old assessment", async () => {
  const f = await terminalAssessmentFixture("succeeded");
  f.setTip("e".repeat(40));
  await assert.rejects(runRegisteredSessionTerminalJob(f.terminal, f.f.platform), /handoff unresolved/u);
  assert.equal(f.dispatches.length, 0);
  assert.equal((await f.reportStore().current())!.revision.revisionId, f.report.revisionId);
});

for (const prefix of ["task-packets-head.v1.", "task-qa-reports-head.v1.",
  "task-protected-qa-runs-head.v1.", "task-source-acceptance.v1."]) {
  test(`registered QA handoff atomically guards the actual ${prefix} producer key`, async () => {
    const f = await terminalAssessmentFixture("succeeded");
    const entry = [...f.f.values.entries()].find(([key]) => key.includes(prefix));
    assert.ok(entry, "use the key from the real fixture producer, not a reimplemented key hash");
    const [key, value] = entry;
    f.setBeforeTaskHandoff(async () => {
      f.f.values.set(key, { ...(value as object), changedAtAdmission: true } as never);
    });
    try {
      await assert.rejects(runRegisteredSessionTerminalJob(f.terminal, f.f.platform), /handoff unresolved/u);
      assert.equal(f.dispatches.length, 0);
    } finally {
      f.f.values.set(key, value);
    }
    assert.equal((await f.reportStore().current())!.revision.revisionId, f.report.revisionId);
  });
}

test("continuation cannot borrow another Run, event, protected reference or cancelled QA author", async t => {
  for (const [name, override] of [
    ["wrong previous Run", { previousRunId: DEV_RUN }],
    ["unaccepted request", { requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }],
    ["wrong protected Run", { protectedRunId: DEV_RUN }],
    ["wrong event subject", { subjectKeySha256: "0".repeat(64) }],
    ["missing Core receipt", { receiptDigest: null }],
  ] as const) await t.test(name, async () => {
    const f = await setup();
    const resumed = f.resumeQa(override);
    await assert.rejects(publishTaskQaReport(f.params, resumed, f.f.platform));
    assert.equal(await f.reportStore().current(), null);
  });
  await t.test("cancelled previous author", async () => {
    const f = await setup(); const resumed = f.resumeQa(); f.runStates.set(QA_RUN, "cancelled");
    await assert.rejects(publishTaskQaReport(f.params, resumed, f.f.platform));
    assert.equal(await f.reportStore().current(), null);
  });
  await t.test("changed source after continuation", async () => {
    const f = await setup(); const resumed = f.resumeQa(); f.setTip("e".repeat(40));
    const result = await publishTaskQaReport(f.params, resumed, f.f.platform);
    assert.equal(result.status, "stale");
    assert.equal(await f.reportStore().current(), null);
  });
  await t.test("well-formed event digest and event ID cannot disagree with the actual Core receipt", async () => {
    const f = await setup();
    const wrongDigest = "f".repeat(64);
    const resumed = f.resumeQa({ receiptDigest: wrongDigest });
    await assert.rejects(async () => f.registered!.handler(f.params, resumed, f.f.platform));
    assert.equal(await f.reportStore().current(), null);
  });
  await t.test("source root identity changing while the Core receipt read is pending cannot publish", async () => {
    const f = await setup(); const resumed = f.resumeQa();
    const api = (f.f.platform as any).protectedTests;
    const read = api.getRunV1.bind(api);
    api.getRunV1 = async (...args: unknown[]) => {
      const result = await read(...args);
      (f.f.platform as any).localFolders.matchWorkspaceSourceV1 = async (folderKey: string, sourceId: string) =>
        ({ folderKey, workspaceSourceId: sourceId, match: "different_root" });
      return result;
    };
    await assert.rejects(async () => f.registered!.handler(f.params, resumed, f.f.platform));
    assert.equal(await f.reportStore().current(), null);
  });
  await t.test("a newly closed continuation QA Run cannot be borrowed for reporting", async () => {
    const f = await setup(); const resumed = f.resumeQa(); f.runStates.set(resumed.runId, "succeeded");
    await assert.rejects(async () => f.registered!.handler(f.params, resumed, f.f.platform));
    assert.equal(await f.reportStore().current(), null);
  });
});

test("registered protected-terminal job resumes only the exact QA Worker through Core event dispatch", async t => {
  await t.test("closed QA origin dispatches exact six-field Core request and duplicate delivery replays one wake", async () => {
    const f = await setup(); f.runStates.set(QA_RUN, "succeeded");
    const eventId = `sps-protected-test-terminal-v1:${CORE_RUN}:${"4".repeat(64)}:${f.coreSubjectKeySha256}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    const job = f.terminalEvent();
    await runRegisteredProtectedTerminalJob(job, f.f.platform);
    await runRegisteredProtectedTerminalJob(job, f.f.platform);
    assert.equal(f.dispatchCalls.length, 2);
    assert.deepEqual(f.dispatchCalls.map(call => call.replayed), [false, true]);
    assert.equal(f.dispatchReceipts.size, 1, "same Core event ID is idempotently replayed, not a second wake");
    assert.deepEqual(f.dispatchCalls.map(call => [call.sessionId, call.companyId]), [[QA_SESSION, W], [QA_SESSION, W]]);
    for (const call of f.dispatchCalls) {
      assert.deepEqual(Object.keys(call.input).sort(), ["eventId", "guards", "previousRunId", "protectedRunId"]);
      assert.equal(call.input.previousRunId, QA_RUN);
      assert.equal(call.input.eventId, eventId);
      assert.equal(call.input.protectedRunId, CORE_RUN);
      assert.ok(Array.isArray(call.input.guards) && call.input.guards.length > 0);
    }
    const guards = f.dispatchCalls[0]!.input.guards as Array<{ stateKey: string; namespace?: string; expectedValue: unknown }>;
    const stateKeys = guards.map(guard => guard.stateKey);
    const packetHead = guards.find(guard => guard.stateKey.startsWith("task-packets-head.v1."));
    const qaReferenceHead = guards.find(guard => guard.stateKey.startsWith("task-protected-qa-runs-head.v1."));
    const registryKey = taskWorkerRegistryKey(P, CTO);
    const workerRegistry = guards.find(guard => guard.stateKey === registryKey);
    assert.ok(packetHead, `current Task packet head must be guarded: ${JSON.stringify(stateKeys)}`);
    assert.ok(qaReferenceHead, `current QA run-reference head must be guarded: ${JSON.stringify(stateKeys)}`);
    assert.ok(workerRegistry, `current owned Worker registry must be guarded: ${JSON.stringify(stateKeys)}`);
    for (const guard of [packetHead, qaReferenceHead, workerRegistry]) {
      const currentValue = f.f.values.get(mapKey({ scopeKind: "company", scopeId: W,
        namespace: guard.namespace, stateKey: guard.stateKey }));
      assert.notEqual(currentValue, undefined);
      assert.deepEqual(guard.expectedValue, currentValue, `CAS guard must pin the current value for ${guard.stateKey}`);
    }
  });

  await t.test("protected event first stores a deferred pointer and origin terminal later emits one wake", async () => {
    const f = await setup();
    const eventId = `sps-protected-test-terminal-v1:${CORE_RUN}:${"4".repeat(64)}:${f.coreSubjectKeySha256}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab`;
    await runRegisteredProtectedTerminalJob(f.terminalEvent("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab"), f.f.platform);
    assert.equal(f.dispatchCalls.length, 0);
    assert.equal(f.dispatchReceipts.size, 0);

    f.runStates.set(QA_RUN, "succeeded");
    await runRegisteredSessionTerminalJob({ jobKey: MANAGER_SESSION_TERMINAL_JOB, trigger: "event", companyId: W,
      runId: QA_RUN, eventId: `agent-session-terminal-v1:${"a".repeat(64)}`, event: { eventType: "agent.session.run.terminal",
        payload: { schemaVersion: 1, runId: QA_RUN, sessionId: QA_SESSION, requestId: f.qaDispatchRequestId,
          status: "succeeded", resultSha256: "b".repeat(64), finishedAt: now } } }, f.f.platform);
    assert.equal(f.dispatchCalls.length, 1);
    assert.equal(f.dispatchReceipts.size, 1);
    assert.equal(f.dispatchCalls[0]!.input.eventId, eventId);
    assert.equal(f.dispatchCalls[0]!.input.previousRunId, QA_RUN);
  });

  await t.test("existing exact QA report suppresses automatic wake", async () => {
    const f = await setup();
    const published = await f.registered!.handler(f.params, f.qaContext, f.f.platform) as any;
    assert.equal(published.data.status, "published");
    await runRegisteredProtectedTerminalJob(f.terminalEvent("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac"), f.f.platform);
    assert.equal(f.dispatchCalls.length, 0);
    assert.equal(f.dispatchReceipts.size, 0);
  });

  await t.test("legacy SDK and moved source fail closed without dispatch fallback", async () => {
    const legacy = await setup(); legacy.runStates.set(QA_RUN, "succeeded"); legacy.setDispatchAvailable(false);
    await assert.rejects(async () => runRegisteredProtectedTerminalJob(
      legacy.terminalEvent("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad"), legacy.f.platform));
    assert.equal(legacy.dispatchCalls.length, 0);
    assert.equal(legacy.enqueueCalls(), 1, "unsupported continuation never enqueues another Task run");

    const moved = await setup(); moved.runStates.set(QA_RUN, "succeeded"); moved.setTip("e".repeat(40));
    await assert.rejects(async () => runRegisteredProtectedTerminalJob(
      moved.terminalEvent("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaae"), moved.f.platform));
    assert.equal(moved.dispatchCalls.length, 0);
    assert.equal(moved.dispatchReceipts.size, 0);
    assert.equal(moved.enqueueCalls(), 1);
  });
});

test("read-only QA origin observation is not active file authority and accepts only a current uncancelled origin", async t => {
  const f = await setup();
  f.runStates.set(QA_RUN, "succeeded");
  const origin = await readTaskQaEventOrigin(f.qaContext, f.f.platform);
  assert.equal(origin.worker.role, "qa");
  await assert.rejects(readTaskWorkerFile({ relativePath: "test/feature.test.ts" }, f.qaContext, f.f.platform));
  await assert.rejects(readTaskWorkerFile({ relativePath: "test/feature.test.ts" },
    { ...f.qaContext, observation: "qa-event-origin" }, f.f.platform));
  assert.equal(f.dispatchCalls.length, 0, "read-only origin inspection does not dispatch or wake a session");

  await t.test("queued origin is not eligible", async () => {
    const queued = await setup(); queued.runStates.set(QA_RUN, "queued");
    await assert.rejects(readTaskQaEventOrigin(queued.qaContext, queued.f.platform));
  });
  await t.test("cancelled origin is not eligible", async () => {
    const cancelled = await setup(); cancelled.runStates.set(QA_RUN, "cancelled");
    await assert.rejects(readTaskQaEventOrigin(cancelled.qaContext, cancelled.f.platform));
  });
  await t.test("a different current Run cannot be presented as the QA request origin", async () => {
    const foreign = await setup();
    await assert.rejects(readTaskQaEventOrigin({ ...foreign.qaContext, runId: DEV_RUN }, foreign.f.platform));
  });
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
