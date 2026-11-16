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
import { consumeTaskQaOriginTerminal } from "../src/task-qa-event-job.ts";
import { createTaskQaReportStore } from "../src/task-qa-reports.ts";
import { createBuilderPlatform } from "../src/platform.ts";
import { fixture, A, C, CTO, W, ctx, now, key, mapKey } from "./fixtures/cto-platform.ts";

const QA_AGENT = "66666666-6666-4666-8666-666666666666";
const QA_SESSION = "77777777-7777-4777-8777-777777777777";
const QA_RUN = "88888888-8888-4888-8888-888888888888";
const CORE_RUN = "99999999-9999-4999-8999-999999999999";
const APPROVAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const DEV_AGENT = "33333333-3333-4333-8333-333333333333";
const DEV_SESSION = "44444444-4444-4444-8444-444444444444";
const DEV_RUN = "55555555-5555-4555-8555-555555555555";
const COMMIT = "b".repeat(40), TREE = "c".repeat(40), PLAN = "d".repeat(64);
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const runKey = (runId: string) => ({ runId, status: "running", cancellationRequested: false,
  termination: "not_applicable", errorCode: null, error: null });
const terminalPayload = (subjectKeySha256: string, receiptDigest: string) => ({ runId: CORE_RUN, status: "succeeded",
  receiptDigest, subjectKeySha256 });

async function setup() {
  const f = await fixture(W);
  await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  const ctoRunId = [...f.runs.keys()][0]!;
  const ctoContext = { companyId: W, projectId: W, agentId: A, sessionId: C, runId: ctoRunId };
  const delivery = (await f.deliveryStore().current())!.revision;
  const source = { requestId: delivery.requestId, workstreamId: "ws-1", specRevision: 1,
    instructionSha256: workstreamInstructionDigest(delivery.instruction) };
  const access = { sourceId: SOURCE, folderKey: "project-source", branch: "feature/task", expectedHead: "a".repeat(40),
    readPaths: ["src/feature.ts", "test/feature.test.ts"], writePaths: ["src/feature.ts"], qaWritePaths: ["test/feature.test.ts"] };
  const packetRecord = (taskId: string, kind: "development" | "qa", dependencies: string[] = []) => ({
    packet: { projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId, revision: 1, kind, title: taskId,
      goal: "Check the exact accepted implementation.", scopeNodeIds: ["feature"], requirementIds: ["REQ-1"], dependencies,
      included: ["Assigned behavior"], excluded: [], constraints: [], acceptance: ["Acceptance criterion one", "Acceptance criterion two"],
      evidenceRequired: ["Protected run reference", "Criterion evidence"], reuse: [],
      testPlan: kind === "qa" ? { environment: "Pinned Node runtime", steps: ["Inspect exact accepted commit"],
        expectedResults: ["Evidence is recorded for every criterion"], passCriteria: ["Pinned behavior is correct", "No regression is present"] } : null,
      sourceAccess: { ...access, writePaths: kind === "development" ? access.writePaths : [],
        qaWritePaths: kind === "qa" ? access.qaWritePaths : [] } },
    source, author: { agentId: A, sessionId: C, runId: ctoRunId }, createdAtISO: now,
    dependencyPins: [] as Array<{ taskId: string; revision: number; recordSha256: string }>,
  });
  const dev = packetRecord("task-dev", "development");
  const devDigest = taskPacketRecordDigest(dev, W, CTO, "ws-1");
  const qa = packetRecord("task-qa", "qa", ["task-dev"]);
  qa.dependencyPins = [{ taskId: "task-dev", revision: 1, recordSha256: devDigest }];
  const taskStore = createTaskPacketStore(W, W, CTO, "ws-1", f.state);
  await taskStore.publish({ expectedBaseRevisionId: null, revision: { projectId: W, ctoId: CTO, workstreamId: "ws-1",
    revisionId: "qa-event-continuation-packets", packets: [dev, qa] } });
  const board = (await taskStore.current())!.revision;
  const devRecord = board.packets.find(row => row.packet.taskId === "task-dev")!;
  const qaRecord = board.packets.find(row => row.packet.taskId === "task-qa")!;
  const workers = [
    { workstreamId: "ws-1", taskId: "task-dev", packetRevision: 1, packetRecordSha256: devDigest, role: "worker" as const,
      agentId: DEV_AGENT, sessionId: DEV_SESSION,
      pluginAgentKey: `builder-task-worker:${sha256(JSON.stringify([W, "ws-1", "task-dev", "worker"]))}`,
      source: { requestId: delivery.requestId, specRevision: 1, instructionSha256: source.instructionSha256 }, registeredAtISO: now },
    { workstreamId: "ws-1", taskId: "task-qa", packetRevision: 1,
      packetRecordSha256: taskPacketRecordDigest(qaRecord, W, CTO, "ws-1"), role: "qa" as const,
      agentId: QA_AGENT, sessionId: QA_SESSION,
      pluginAgentKey: `builder-task-qa:${sha256(JSON.stringify([W, "ws-1", "task-qa", "qa"]))}`,
      source: { requestId: delivery.requestId, specRevision: 1, instructionSha256: source.instructionSha256 }, registeredAtISO: now },
  ];
  f.values.set(mapKey(key(taskWorkerRegistryKey(W, CTO))), { schemaVersion: 1, workspaceId: W,
    projectId: W, ctoId: CTO, revision: 2, records: workers });

  const profiles = new Map([[DEV_AGENT, "idle"], [QA_AGENT, "idle"]]);
  Object.assign(f.platform.agents, { owned: { async get({ pluginAgentKey }: { pluginAgentKey: string }) {
    const worker = workers.find(row => row.pluginAgentKey === pluginAgentKey);
    return worker ? { status: "resolved", revision: 1, agent: { agentId: worker.agentId, status: profiles.get(worker.agentId)! } }
      : { status: "missing" };
  } }, async list() { return [{ id: A, status: "idle" }, ...workers.map(row => ({ id: row.agentId, status: profiles.get(row.agentId)! }))]; } });

  const requests = new Map<string, { requestId: string; state: "submitted"; runId: string }>();
  const runStates = new Map<string, string>([[ctoRunId, "running"], [DEV_RUN, "running"], [QA_RUN, "running"]]);
  const sessions = f.platform.agents.sessions as typeof f.platform.agents.sessions;
  const originalGetRequest = sessions.getRequest.bind(sessions), originalGetRun = sessions.getRun.bind(sessions);
  (sessions as any).getRequest = async (sessionId: string, companyId: string, requestId: string) =>
    requests.get(`${sessionId}:${requestId}`) ?? originalGetRequest(sessionId, companyId, requestId);
  (sessions as any).getRun = async (sessionId: string, companyId: string, runId: string) => runStates.has(runId)
    ? { ...runKey(runId), status: runStates.get(runId) } : originalGetRun(sessionId, companyId, runId);
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

  const devBinding = { schemaVersion: 1 as const, workspaceId: W, projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId: "task-dev",
    packetRevision: 1, packetRecordSha256: devDigest, dependencyPins: devRecord.dependencyPins, role: "worker" as const,
    agentId: DEV_AGENT, sessionId: DEV_SESSION, runId: DEV_RUN,
    source: { sourceId: SOURCE, folderKey: access.folderKey, branch: access.branch, expectedHead: access.expectedHead },
    readPaths: access.readPaths, writePaths: access.writePaths, qaWritePaths: [] };
  const submitted = await submitTaskSourceFiles({ runContext: { companyId: W, projectId: W, agentId: DEV_AGENT, sessionId: DEV_SESSION, runId: DEV_RUN },
    paths: ["src/feature.ts"], platform: f.platform, state: f.state,
    async resolveAuthority() { return { binding: devBinding, async assertCurrent() {} }; } });
  assert.equal(submitted.status, "submitted");
  const devRequestId = taskWorkerRequestId(deriveTaskWorkerFileBinding({ workspaceId: W, projectId: W, ctoId: CTO,
    packet: devRecord, currentPackets: board.packets, worker: workers[0]! }));
  requests.set(`${DEV_SESSION}:${devRequestId}`, { requestId: devRequestId, state: "submitted", runId: DEV_RUN });
  const qaRequestId = taskWorkerRequestId(deriveTaskWorkerFileBinding({ workspaceId: W, projectId: W, ctoId: CTO,
    packet: qaRecord, currentPackets: board.packets, worker: workers[1]! }));
  requests.set(`${QA_SESSION}:${qaRequestId}`, { requestId: qaRequestId, state: "submitted", runId: QA_RUN });
  const accepted = await acceptCtoTaskSourceSubmission({ projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId: "task-dev",
    submissionId: submitted.submission!.submissionId }, ctoContext, f.platform);
  assert.equal(accepted.status, "accepted");

  let coreStatus = "queued", coreReceipt: Record<string, unknown> | null = null;
  const coreRows = new Map<string, any>();
  Object.assign(f.platform, { protectedTests: {
    async enqueueApprovedV1(input: Record<string, string>) {
      const row = { schemaVersion: 1, kind: "protected-node-test-v1", id: CORE_RUN, status: "queued", termination: "not_applicable",
        pins: { approvalId: input.approvalId, sourceId: input.sourceId, planSha256: input.planSha256, profileSha256: "1".repeat(64),
          commitSha: input.commitSha, treeSha: input.treeSha, manifestSha256: "2".repeat(64), inputTreeSha256: TREE,
          nodeSha256: "3".repeat(64), subjectKeySha256: sha256(input.subjectKey), timeoutMs: 30000 }, receipt: null,
        timestamps: { createdAt: now, claimedAt: null, startedAt: null, finishedAt: null }, qaVerdict: "not-established" };
      coreRows.set(CORE_RUN, row); return row;
    },
    async getRunV1(_workspaceId: string, runId: string) {
      if (!coreReceipt) return coreRows.get(runId) ?? null;
      return { ...coreRows.get(runId), status: coreStatus, termination: "confirmed", receipt: coreReceipt };
    },
  } });
  const qaContext = { companyId: W, projectId: W, agentId: QA_AGENT, sessionId: QA_SESSION, runId: QA_RUN };
  const queued = await (await import("../src/task-protected-qa.ts")).requestProtectedTaskQa({ approvalId: APPROVAL, planSha256: PLAN }, qaContext, f.platform);
  assert.equal(queued.status, "queued", JSON.stringify(queued));
  coreStatus = "succeeded";
  const receiptDigest = "4".repeat(64);
  coreReceipt = { digest: receiptDigest, status: "completed", stdoutSha256: null, stderrSha256: null, stdoutBytes: 0, stderrBytes: 0,
    processExitCode: 0, timedOut: false, cancelled: false, outputLimit: false, appContainerVerified: true, capabilitiesCount: 0,
    childTerminationConfirmed: true, jobEmpty: true, profileCleanupSucceeded: true, sandboxCleanupSucceeded: true, fixtureMustBeRetained: false };
  const foundReference = await (await import("../src/task-qa-run-references.ts")).createTaskQaRunReferenceStore({
    workspaceId: W, projectId: W, ctoId: CTO, workstreamId: "ws-1", qaTaskId: "task-qa" }, f.state as RevisionState).findRun(CORE_RUN);
  if (foundReference.status !== "found") throw new Error("QA reference fixture was not published.");
  const reference = foundReference.reference;
  const eventId = `sps-protected-test-terminal-v1:${CORE_RUN}:${receiptDigest}:${reference.binding.subjectKeySha256}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
  const payload = terminalPayload(reference.binding.subjectKeySha256, receiptDigest);
  const qaTerminal = { sessionId: QA_SESSION, runId: QA_RUN, requestId: qaRequestId };

  let actualCoreRuns = 0;
  const dispatchCalls: Array<{ sessionId: string; companyId: string; input: Record<string, any>; replayed: boolean }> = [];
  const receipts = new Map<string, { requestId: string; runId: string }>();
  (sessions as any).dispatchProtectedEventV1 = async (sessionId: string, companyId: string, input: Record<string, any>) => {
    const key = JSON.stringify([sessionId, companyId, input.eventId, input.previousRunId]);
    const old = receipts.get(key);
    if (old) {
      dispatchCalls.push({ sessionId, companyId, input: structuredClone(input), replayed: true });
      return { ...old, replayed: true };
    }
    const receipt = { requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc", runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd" };
    receipts.set(key, receipt); actualCoreRuns++;
    dispatchCalls.push({ sessionId, companyId, input: structuredClone(input), replayed: false });
    return { ...receipt, replayed: false };
  };

  const guarded = async (targetKey: any, expected: any, value: any) => {
    for (const guard of targetKey.guards) {
      const actual = f.values.get(mapKey({ scopeKind: "company", scopeId: targetKey.scopeId,
        namespace: guard.namespace, stateKey: guard.stateKey }));
      if (JSON.stringify(actual) !== JSON.stringify(guard.expectedValue)) return { status: "conflict" as const };
    }
    const target = mapKey({ scopeKind: targetKey.scopeKind, scopeId: targetKey.scopeId,
      namespace: targetKey.namespace, stateKey: targetKey.stateKey });
    const current = f.values.get(target);
    if (expected.exists ? JSON.stringify(current) !== JSON.stringify(expected.value) : current !== undefined) return { status: "conflict" as const };
    f.values.set(target, structuredClone(value)); return { status: "committed" as const };
  };
  const revisionState = f.state as unknown as RevisionState;
  revisionState.guardedCompareAndSet = guarded as never;
  const runRegisteredProtectedTerminal = async () => {
    const handler = createBuilderPlatform().jobs.find(item => item.jobKey === "builder.integrate-verified-workstream");
    assert.ok(handler);
    await handler.handler({ jobKey: "builder.integrate-verified-workstream", trigger: "event", companyId: W,
      runId: QA_RUN, eventId, event: { eventType: "sps.protected-test.terminal", payload: {
        schemaVersion: 1, kind: "protected-node-test-v1", companyId: W, pluginId: SOURCE,
        pluginKey: "com.sonparkserver.my-plugin-builder", ...payload } } } as never, f.platform);
  };
  const originTerminal = () => consumeTaskQaOriginTerminal(W, qaTerminal, f.platform);
  const publishReport = async () => {
    const content = { schemaVersion: 1 as const, reference, coreReceiptDigest: receiptDigest, coreStatus: "succeeded" as const,
      author: { agentId: QA_AGENT, sessionId: QA_SESSION, runId: QA_RUN },
      checks: [{ criterionId: "criterion-1", text: "Inspect the pinned result", verdict: "not-tested" as const, note: "Pending independent assessment" }],
      summary: "Independent assessment recorded.", verdict: "incomplete" as const };
    const report = { ...content, revisionId: `task-qa-report-v1:${sha256(JSON.stringify(content))}` };
    const reportScope = { workspaceId: W, projectId: W, ctoId: CTO, workstreamId: "ws-1", qaTaskId: "task-qa" };
    const store = createTaskQaReportStore(reportScope, f.state as RevisionState);
    return store.publish({ expectedBaseRevisionId: null, revision: report });
  };
  return { f, revisionState, runStates, reference, eventId, payload, runRegisteredProtectedTerminal, originTerminal,
    qaTerminal, dispatchCalls, receipts, publishReport, get actualCoreRuns() { return actualCoreRuns; }, receiptDigest };
}

test("pointer-CAS race reobserves a newly terminal QA origin and Core-dedupes a concurrent callback", async () => {
  const f = await setup();
  let before: unknown, concurrent: unknown, injected = false;
  const guarded = f.revisionState.guardedCompareAndSet!;
  f.revisionState.guardedCompareAndSet = async (targetKey, expected, value) => {
    const isPointerHead = targetKey.stateKey.startsWith("task-protected-qa-runs-head.v1.");
    if (isPointerHead && !injected) {
      injected = true;
      f.runStates.set(QA_RUN, "succeeded");
      before = await f.originTerminal();
    }
    const committed = await guarded(targetKey, expected, value);
    if (isPointerHead && committed.status === "committed") concurrent = await f.originTerminal();
    return committed;
  };

  await f.runRegisteredProtectedTerminal();
  assert.equal(injected, true, "interleave hook must run at the deferred pointer publication boundary");
  assert.deepEqual(before, { status: "not-applicable" }, "the callback before pointer publication cannot see the event link");
  assert.equal((concurrent as { status: string }).status, "accepted", JSON.stringify(concurrent));
  assert.equal(f.dispatchCalls.length, 2, "the callback and resumed protected handler can both reach Core");
  assert.deepEqual(f.dispatchCalls.map(call => call.replayed), [false, true]);
  assert.deepEqual(f.dispatchCalls[0]!.input, f.dispatchCalls[1]!.input, "both contenders must use the same canonical inputs");
  assert.equal(f.dispatchCalls[0]!.sessionId, QA_SESSION);
  assert.equal(f.dispatchCalls[0]!.companyId, W);
  assert.equal(f.dispatchCalls[0]!.input.previousRunId, QA_RUN);
  assert.equal(f.dispatchCalls[0]!.input.eventId, f.eventId);
  assert.equal(f.dispatchCalls[0]!.input.protectedRunId, CORE_RUN);
  assert.equal(f.receipts.size, 1);
  assert.equal(f.actualCoreRuns, 1, "fake Core canonical receipt is one fixture run, not actual Core/model evidence");
});

test("pointer publication still waits without a wake while the original QA Run is active", async () => {
  const f = await setup();
  await f.runRegisteredProtectedTerminal();
  const ref = await (await import("../src/task-qa-run-references.ts")).createTaskQaRunReferenceStore({
    workspaceId: W, projectId: W, ctoId: CTO, workstreamId: "ws-1", qaTaskId: "task-qa" }, f.f.state as RevisionState).current();
  assert.equal(ref?.revision.deferredEvent?.eventId, f.eventId);
  assert.equal(f.dispatchCalls.length, 0);
  assert.equal(f.receipts.size, 0);
});

test("a report published at pointer CAS is reread after terminal observation and prevents a wake", async () => {
  const f = await setup();
  let reportPublished = false, concurrent: unknown, interleaveError: unknown;
  const guarded = f.revisionState.guardedCompareAndSet!;
  f.revisionState.guardedCompareAndSet = async (targetKey, expected, value) => {
    const isPointerHead = targetKey.stateKey.startsWith("task-protected-qa-runs-head.v1.");
    if (isPointerHead && !reportPublished) {
      reportPublished = true;
      try { await f.publishReport(); } catch (error) { interleaveError = error; }
      f.runStates.set(QA_RUN, "succeeded");
      await f.originTerminal();
    }
    const committed = await guarded(targetKey, expected, value);
    if (isPointerHead && committed.status === "committed") concurrent = await f.originTerminal();
    return committed;
  };

  await f.runRegisteredProtectedTerminal();
  assert.equal(reportPublished, true, "report interleave must occur immediately before the deferred pointer CAS");
  assert.equal(interleaveError, undefined, String(interleaveError));
  assert.equal((concurrent as { status: string }).status, "ignored", JSON.stringify(concurrent));
  assert.equal(f.dispatchCalls.length, 0, "already-assessed receipt must not wake a second QA turn");
  assert.equal(f.receipts.size, 0);
  const report = await createTaskQaReportStore({ workspaceId: W, projectId: W, ctoId: CTO, workstreamId: "ws-1", qaTaskId: "task-qa" },
    f.f.state as RevisionState).current();
  assert.equal(report?.revision.reference.binding.runId, CORE_RUN);
  assert.equal(report?.revision.coreReceiptDigest, f.receiptDigest);
});
