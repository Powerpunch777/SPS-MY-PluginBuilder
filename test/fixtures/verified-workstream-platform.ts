import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { fixture, A, C, CTO, W, ctx, now, key, mapKey } from "./cto-platform.ts";
import { createDesignDraftStore } from "../../src/design-draft-store.ts";
import { createDesignBaselineStore } from "../../src/design-baseline-tools.ts";
import { createTechnologyDecisionStore } from "../../src/technology-decision-tools.ts";
import { createWorkstreamStore } from "../../src/workstream-tools.ts";
import { dispatchCtoWorkstream } from "../../src/cto-workstream-delivery.ts";
import { workstreamInstructionDigest } from "../../src/cto-delivery-store.ts";
import { proposeFirstDesignReview, approveFirstDesignReview, assertCurrentFirstDesignApproval } from "../../src/spec-assurance/review-first-design.ts";
import { createBaselineBodySource } from "../../src/project-documents/baseline-body-source.ts";
import { taskPacketRecordDigest } from "../../src/domain/task-packets.ts";
import { createTaskPacketStore } from "../../src/task-packet-tools.ts";
import { taskWorkerRegistryKey } from "../../src/domain/task-workers.ts";
import { deriveTaskWorkerFileBinding, taskWorkerRequestId } from "../../src/task-worker-runtime.ts";
import { acceptCtoTaskSourceSubmission } from "../../src/task-source-acceptance.ts";
import { taskQaCriteria, publishTaskQaReport, createTaskQaReportStore } from "../../src/task-qa-reports.ts";
import { createTaskQaRunReferenceStore } from "../../src/task-qa-run-references.ts";
import { requestProtectedTaskQa } from "../../src/task-protected-qa.ts";
import { createBuilderPlatform } from "../../src/platform.ts";
import type { RevisionState } from "../../src/solution-revision-store.ts";

const SOURCE = "99999999-9999-4999-8999-999999999999";
const DEV_AGENT = "33333333-3333-4333-8333-333333333333", DEV_SESSION = "12121212-1212-4212-8212-121212121212";
const DEV_RUN = "55555555-5555-4555-8555-555555555555";
const QA_AGENT = "66666666-6666-4666-8666-666666666666", QA_SESSION = "77777777-7777-4777-8777-777777777777";
const QA_RUN = "88888888-8888-4888-8888-888888888888", CORE_RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APPROVAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", PLAN = "c".repeat(64);
const COMMIT = "d".repeat(40), TREE = "e".repeat(40);
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const runDto = (runId: string, status: string) => ({ runId, status, cancellationRequested: false,
  termination: status === "running" ? "not_applicable" : "confirmed", errorCode: null, error: null });

/** All Core/Host contracts here are deterministic fixture DTOs, not a real AI or AppContainer run. */
export async function setupVerifiedWorkstreamPlatform(withUnmappedRequirement = false,
  options: Readonly<{ undecidedRequirementIds?: readonly string[]; omitDecisionModel?: boolean }> = {}) {
  const f = await fixture(W);
  // The generic fixture seeds an unapproved baseline/workstream. Start those journals empty
  // so this test exercises the actual initial approval and publication path.
  for (const storedKey of [...f.values.keys()]) {
    const address = JSON.parse(storedKey) as { stateKey: string };
    if (["design-baseline", "technology-decisions", "workstreams"].some(prefix => address.stateKey.startsWith(`${prefix}-`))) {
      f.values.delete(storedKey);
    }
  }
  const mainContext = { ...ctx(), projectId: W };
  const sourceId = `lead-turn:${mainContext.runId}`, sourceText = "User-approved test scope for the Builder verification fixture.";
  const unmapped = { id: "REQ-UNMAPPED", description: "A second approved requirement has not been assigned yet.",
    acceptanceCriteriaIds: ["AC-UNMAPPED"] };
  f.values.set(mapKey(key(`lead-chat.turn.v1.${mainContext.runId}`)), {
    workspaceId: W, selectionRevision: 1, agentId: A, sessionId: mainContext.sessionId, channel: "main", schemaVersion: 1,
    requestId: mainContext.runId, previousRequestId: null, sequence: 0, text: sourceText, createdAt: now,
    state: "submitted", runId: mainContext.runId, answer: null, outputState: "not_ready", cancellationRequested: false,
    termination: "not_applicable", inputKind: "user",
  } as never);
  const draft = { projectId: W, revisionId: "verify-design-draft-1", sourceIds: [sourceId],
    specification: { revisionId: "verify-spec-draft-1", productTier: "S" as const,
      requirements: [{ id: "REQ-1", description: "The assigned feature remains correct.", acceptanceCriteriaIds: ["AC-1"] },
        ...(withUnmappedRequirement ? [unmapped] : [])],
      targets: ["desktop" as const], dataPolicyRef: "local-test-data" },
    graph: { graphRevisionId: "verify-graph-draft-1", entities: [{ id: "feature", kind: "feature", specRef: "REQ-1" }],
      relations: [], viewLayoutRef: "verify-layout" }, questions: [] };
  const draftStore = createDesignDraftStore(W, W, { selectionRevision: 1, agentId: A }, f.state as never);
  await draftStore.publish({ expectedBaseRevisionId: null, revision: { status: "draft", selectionRevision: 1,
    author: { agentId: A, sessionId: mainContext.sessionId, runId: mainContext.runId },
    sourceDigests: [{ id: sourceId, sha256: sha(sourceText) }], createdAt: now, draft } });
  const pack = { packId: "fixture-approved-pack", version: "1.0.0", applicability: { all: ["design.gate"] },
    rules: [{ id: "feature-behavior", requirementIds: ["REQ-1"], appliesWhen: {}, requiresCheck: true,
      modelCases: [{ when: {}, state: "new", event: "open", allowedNextStates: ["ready"] }] }],
    transitions: [{ from: "new", event: "open", to: "ready" }], exceptions: [], excludedCombinations: [] };
  const designModel = { facts: ["design.gate"], rulesVersion: "approved-fixture-v1",
    coverageRules: [{ id: "feature-behavior", requiresCheck: true, requiredEvidenceKinds: ["specification", "source"] }],
    coverageTargets: [{ targetKind: "requirement", targetId: "REQ-1", ruleIds: ["feature-behavior"] },
      { targetKind: "ac", targetId: "AC-1", ruleIds: ["feature-behavior"] }],
    scenarios: [{ id: "open-ready", state: "new", event: "open", nextState: "ready", exceptionId: null }],
    itemDecisions: [{ requirementId: "REQ-1", status: options.undecidedRequirementIds?.includes("REQ-1") ? "UNDECIDED" : "RESOLVED",
      reason: "Approval-backed fixture relationship.", sourceIds: [sourceId] },
      ...(withUnmappedRequirement ? [{ requirementId: unmapped.id,
        status: options.undecidedRequirementIds?.includes(unmapped.id) ? "UNDECIDED" : "RESOLVED",
        reason: "Approved but not assigned.", sourceIds: [sourceId] }] : [])],
    acceptanceCriteria: [{ requirementId: "REQ-1", acId: "AC-1", sourceId, quote: sourceText },
      ...(withUnmappedRequirement ? [{ requirementId: unmapped.id, acId: unmapped.acceptanceCriteriaIds[0], sourceId, quote: sourceText }] : [])] };
  const proposal = await proposeFirstDesignReview({ projectId: W, expectedDraftRevisionId: draft.revisionId,
    expectedReviewHeadRevisionId: null, pack, ...(options.omitDecisionModel ? {} : { designModel }),
    sourcePins: [{ requirementId: "REQ-1", acId: null, sourceId }, { requirementId: "REQ-1", acId: "AC-1", sourceId },
      ...(withUnmappedRequirement ? [{ requirementId: unmapped.id, acId: unmapped.acceptanceCriteriaIds[0], sourceId }] : [])] },
  mainContext, f.platform);
  assert.ok(proposal.revision);
  const actionContext = { ...f.platform, companyId: W, actor: { type: "user", companyId: W, userId: "fixture-user" } };
  const approved = await approveFirstDesignReview({ projectId: W, expectedBundleRevisionId: proposal.revision.revisionId }, actionContext as never);
  assert.ok("revision" in approved);
  const binding = await assertCurrentFirstDesignApproval({ projectId: W, approvedRevisionId: approved.revision.revisionId }, mainContext, f.platform);
  assert.ok(binding);
  const spec = { ...binding.bundle.draft.specification, projectId: W, revisionId: "verify-spec-approved-1",
    approvalEvidenceRef: binding.reviewReference };
  const baseline = { projectId: W, revisionId: "verify-baseline-1", sourceDraftRevisionId: binding.bundle.draftRevisionId,
    draftDigest: digest(JSON.stringify((await draftStore.current())!.revision)), createdAt: now,
    author: { agentId: A, sessionId: mainContext.sessionId, runId: mainContext.runId, selectionRevision: 1 },
    userDecision: { sourceId: binding.reviewReference, sourceSha256: binding.bundleDigest, interpretation: "Approved first-design fixture." },
    specification: spec, graph: { ...binding.bundle.draft.graph, approvedSpecRevisionId: spec.revisionId } };
  await createDesignBaselineStore(W, W, f.state as never).publish({ expectedBaseRevisionId: null, revision: baseline });
  const baselineCurrent = (await createDesignBaselineStore(W, W, f.state as never).current())!.revision;
  const technology = { register: { projectId: W, revisionId: "verify-tech-1", sourceBaselineRevisionId: baselineCurrent.revisionId,
    sourceSpecRevisionId: spec.revisionId, sourceGraphRevisionId: baselineCurrent.graph.graphRevisionId, entries: [] },
    baselineDigest: digest(baselineCurrent), author: baselineCurrent.author, createdAt: now };
  await createTechnologyDecisionStore(W, W, f.state as never).publish({ expectedBaseRevisionId: null, revision: technology });
  const technologyCurrent = (await createTechnologyDecisionStore(W, W, f.state as never).current())!.revision;
  const workstream = { ...f.instruction, spec: { ...f.instruction.spec, revision: 1, sourceSpecRevisionId: spec.revisionId,
      technologyDecisionsRef: technologyCurrent.register.revisionId }, sourceBaselineRevisionId: baselineCurrent.revisionId,
    baselineDigest: digest(baselineCurrent), technologyDigest: digest(technologyCurrent), receipt: null };
  await createWorkstreamStore(W, W, f.state as never).publish({ expectedBaseRevisionId: null,
    revision: { projectId: W, revisionId: "verify-workstream-board-1", workstreams: [workstream] } });
  const currentWorkstreamBoard = await import("../../src/workstream-tools.ts").then(m => m.readWorkstreams(W, W, f.platform));
  const currentWorkstream = currentWorkstreamBoard!.revision.workstreams[0]!;
  const document = await createBaselineBodySource(W, W, f.state as never).publish({ documentRevisionId: "verify-baseline-document-1",
    expectedDocumentRevisionId: null, expectedBaselineRevisionId: baselineCurrent.revisionId });
  assert.equal(document.status, "published");
  const dispatch = await dispatchCtoWorkstream({ ...f.params, boardRevisionId: currentWorkstreamBoard!.revision.revisionId }, ctx(), f.platform);
  assert.equal((dispatch.data as { status: string }).status, "submitted");
  const delivery = (await f.deliveryStore().current())!.revision;
  assert.ok(delivery.executionPolicy.toolNames.includes("builder.verify-workstream"));
  const ctoRunId = delivery.runId!;
  const ctoContext = { companyId: W, projectId: W, agentId: A, sessionId: C, runId: ctoRunId };
  const workstreamSha = workstreamInstructionDigest(currentWorkstream);
  const source = { requestId: delivery.requestId, workstreamId: "ws-1", specRevision: 1, instructionSha256: workstreamSha };
  const workerSource = { requestId: delivery.requestId, specRevision: 1, instructionSha256: workstreamSha };
  const sourceAccess = { sourceId: SOURCE, folderKey: "project-source", branch: "feature/verify", expectedHead: "f".repeat(40),
    readPaths: ["src/feature.ts", "test/feature.test.ts"], writePaths: ["src/feature.ts"], qaWritePaths: ["test/feature.test.ts"] };
  const record = (taskId: string, kind: "development" | "qa", dependencies: string[] = []) => ({
    packet: { projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId, revision: 1, kind, title: taskId,
      goal: "Verify the assigned approved requirement.", scopeNodeIds: ["feature"], requirementIds: ["REQ-1"], dependencies,
      included: ["Approved feature"], excluded: [], constraints: [], acceptance: ["Feature behavior is correct"],
      evidenceRequired: ["Exact accepted source and independent protected QA"], reuse: [],
      testPlan: kind === "qa" ? { environment: "fixture pinned Node", steps: ["Check exact commit"],
        expectedResults: ["All criteria assessed"], passCriteria: ["No regression"] }
        : { environment: "fixture build", steps: ["Check the implementation"],
          expectedResults: ["Build and behavior are correct"], passCriteria: ["No build regression"] },
      sourceAccess: { ...sourceAccess, writePaths: kind === "development" ? sourceAccess.writePaths : [],
        qaWritePaths: kind === "qa" ? sourceAccess.qaWritePaths : [] } },
    source: { requestId: delivery.requestId, workstreamId: "ws-1", specRevision: 1, instructionSha256: workstreamSha },
    author: { agentId: A, sessionId: C, runId: ctoRunId }, createdAtISO: now, dependencyPins: [] as Array<{taskId:string;revision:number;recordSha256:string}>,
  });
  const dev = record("task-dev", "development"), devDigest = taskPacketRecordDigest(dev as never, W, CTO, "ws-1");
  const qa = record("task-qa", "qa", ["task-dev"]);
  qa.dependencyPins = [{ taskId: "task-dev", revision: 1, recordSha256: devDigest }];
  const packetStore = createTaskPacketStore(W, W, CTO, "ws-1", f.state as never);
  await packetStore.publish({ expectedBaseRevisionId: null, revision: { projectId: W, ctoId: CTO, workstreamId: "ws-1",
    revisionId: "verify-task-packets-1", packets: [dev, qa] } });
  const packets = (await packetStore.current())!.revision.packets, devRecord = packets[0]!, qaRecord = packets[1]!;
  const workers = [
    { workstreamId: "ws-1", taskId: "task-dev", packetRevision: 1, packetRecordSha256: devDigest, role: "worker" as const,
      agentId: DEV_AGENT, sessionId: DEV_SESSION, pluginAgentKey: `builder-task-worker:${sha(JSON.stringify([W,"ws-1","task-dev","worker"]))}`,
      source: workerSource, registeredAtISO: now },
    { workstreamId: "ws-1", taskId: "task-qa", packetRevision: 1,
      packetRecordSha256: taskPacketRecordDigest(qaRecord, W, CTO, "ws-1"), role: "qa" as const,
      agentId: QA_AGENT, sessionId: QA_SESSION, pluginAgentKey: `builder-task-qa:${sha(JSON.stringify([W,"ws-1","task-qa","qa"]))}`,
      source: workerSource, registeredAtISO: now },
  ];
  f.values.set(mapKey(key(taskWorkerRegistryKey(W, CTO))), { schemaVersion: 1, workspaceId: W, projectId: W, ctoId: CTO,
    revision: 2, records: workers } as never);
  const requests = new Map<string, { requestId: string; state: "submitted"; runId: string }>();
  const session = f.platform.agents.sessions as typeof f.platform.agents.sessions & Record<string, any>;
  const originalGetRequest = session.getRequest.bind(session), originalGetRun = session.getRun.bind(session);
  const runStates = new Map<string, string>([[ctoRunId, "running"], [DEV_RUN, "running"], [QA_RUN, "running"]]);
  session.getRequest = async (sessionId: string, workspaceId: string, requestId: string) =>
    requests.get(`${sessionId}:${requestId}`) ?? originalGetRequest(sessionId, workspaceId, requestId);
  (session as any).getRun = async (sessionId: string, workspaceId: string, runId: string) => runStates.has(runId)
    ? runDto(runId, runStates.get(runId)!) : originalGetRun(sessionId, workspaceId, runId);
  const profileByKey = new Map(workers.map(worker => [worker.pluginAgentKey, worker.agentId]));
  Object.assign(f.platform.agents, { owned: { async get({ pluginAgentKey }: { pluginAgentKey: string }) {
    if (pluginAgentKey === "integration-manager") return { status: "missing" };
    const id = profileByKey.get(pluginAgentKey);
    return id ? { status: "resolved", revision: 1, agent: { agentId: id, status: "idle" } } : { status: "missing" };
  } }, async list() { return [A, DEV_AGENT, QA_AGENT].map(id => ({ id, status: "idle", companyId: W })); } });
  Object.assign(f.platform, { localFolders: {
    async status(folderKey: string) { return { folderKey, configured: true, access: "read-write", readable: true, writable: true,
      healthy: true, requiredDirectories: [], requiredFiles: [], missingDirectories: [], missingFiles: [], checkedAt: now }; },
    async matchWorkspaceSourceV1(folderKey: string, sourceId: string) { return { folderKey, workspaceSourceId: sourceId, match: "same_root" }; },
    async readWorkspaceSourceGitTipV1(sourceId: string, folderKey: string, branch: string) {
      return { status: "current", sourceId, folderKey, branch, commitSha: COMMIT, treeSha: TREE, observedAt: now };
    },
    async commitTaskFilesV1(input: Record<string, unknown>) {
      assert.deepEqual(input.paths, ["src/feature.ts"]);
      return { status: "committed", commitSha: COMMIT, treeSha: TREE, changedPaths: ["src/feature.ts"] };
    },
  } });
  const devBinding = deriveTaskWorkerFileBinding({ workspaceId: W, projectId: W, ctoId: CTO,
    packet: devRecord, currentPackets: packets, worker: workers[0]! });
  const devRequest = taskWorkerRequestId(devBinding);
  const qaRequest = taskWorkerRequestId(deriveTaskWorkerFileBinding({ workspaceId: W, projectId: W, ctoId: CTO,
    packet: qaRecord, currentPackets: packets, worker: workers[1]! }));
  requests.set(`${DEV_SESSION}:${devRequest}`, { requestId: devRequest, state: "submitted", runId: DEV_RUN });
  requests.set(`${QA_SESSION}:${qaRequest}`, { requestId: qaRequest, state: "submitted", runId: QA_RUN });
  const registeredTools = createBuilderPlatform().tools;
  const submitTool = registeredTools.find(tool => tool.name === "builder.submit-task-source");
  assert.ok(submitTool);
  const submitted = await submitTool.handler({ paths: ["src/feature.ts"] },
    { companyId: W, projectId: W, agentId: DEV_AGENT, sessionId: DEV_SESSION, runId: DEV_RUN } as any, f.platform) as any;
  assert.equal(submitted.data.status, "submitted");
  const accepted = await acceptCtoTaskSourceSubmission({ projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId: "task-dev",
    submissionId: submitted.data.submission.submissionId }, ctoContext, f.platform);
  assert.equal(accepted.status, "accepted");

  const coreReceipt = { digest: "7".repeat(64), status: "completed", stdoutSha256: null, stderrSha256: null,
    stdoutBytes: 0, stderrBytes: 0, processExitCode: 0, timedOut: false, cancelled: false, outputLimit: false,
    appContainerVerified: true, capabilitiesCount: 0, childTerminationConfirmed: true, jobEmpty: true,
    profileCleanupSucceeded: true, sandboxCleanupSucceeded: true, fixtureMustBeRetained: false };
  const coreRun = (subjectKey: string, status: string) => ({ schemaVersion: 1, kind: "protected-node-test-v1", id: CORE_RUN,
    status, termination: status === "succeeded" ? "confirmed" : "not_applicable", pins: { approvalId: APPROVAL, sourceId: SOURCE,
      planSha256: PLAN, profileSha256: "1".repeat(64), commitSha: COMMIT, treeSha: TREE, manifestSha256: "2".repeat(64),
      inputTreeSha256: TREE, nodeSha256: "3".repeat(64), subjectKeySha256: sha(subjectKey), timeoutMs: 30000 },
    receipt: status === "succeeded" ? coreReceipt : null, timestamps: { createdAt: now, claimedAt: now, startedAt: now, finishedAt: now },
    qaVerdict: "not-established" });
  Object.assign(f.platform, { protectedTests: {
    async enqueueApprovedV1(input: Record<string, string>) { return coreRun(input.subjectKey, "queued"); },
    async getRunV1(_workspaceId: string, runId: string, subjectHash: string) {
      const reference = await createTaskQaRunReferenceStore({ workspaceId: W, projectId: W, ctoId: CTO,
        workstreamId: "ws-1", qaTaskId: "task-qa" }, f.state as never).findRun(runId);
      return reference.status === "found" && reference.reference.binding.subjectKeySha256 === subjectHash
        ? coreRun(reference.reference.binding.subjectKey, "succeeded") : null;
    },
  } });
  const qaContext = { companyId: W, projectId: W, agentId: QA_AGENT, sessionId: QA_SESSION, runId: QA_RUN };
  const queued = await requestProtectedTaskQa({ approvalId: APPROVAL, planSha256: PLAN }, qaContext, f.platform);
  assert.equal(queued.status, "queued", JSON.stringify(queued));
  const reportScope = { workspaceId: W, projectId: W, ctoId: CTO, workstreamId: "ws-1", qaTaskId: "task-qa" };
  const reference = (await createTaskQaRunReferenceStore(reportScope, f.state as never).current())!.revision;
  const criteria = taskQaCriteria(qaRecord.packet.acceptance, qaRecord.packet.testPlan!.passCriteria, devRecord.packet.acceptance);
  const revisionState = f.state as unknown as RevisionState;
  revisionState.guardedCompareAndSet = (async (target: any, expected: any, value: any) => {
    for (const guard of target.guards) if (JSON.stringify(f.values.get(mapKey({ scopeKind: "company", scopeId: target.scopeId,
      namespace: guard.namespace, stateKey: guard.stateKey }))) !== JSON.stringify(guard.expectedValue)) return { status: "conflict" };
    const address = mapKey({ scopeKind: target.scopeKind, scopeId: target.scopeId, namespace: target.namespace, stateKey: target.stateKey });
    const old = f.values.get(address);
    if (expected.exists ? JSON.stringify(old) !== JSON.stringify(expected.value) : old !== undefined) return { status: "conflict" };
    f.values.set(address, structuredClone(value)); return { status: "committed" };
  }) as never;
  const report = await publishTaskQaReport({ projectId: W, ctoId: CTO, workstreamId: "ws-1", qaTaskId: "task-qa",
    approvalId: APPROVAL, planSha256: PLAN, runId: CORE_RUN, expectedBaseRevisionId: null,
    checks: criteria.map(item => ({ criterionId: item.criterionId, verdict: "passed", note: "Fixture assertion only." })),
    summary: "Test-fixture assessment against a mocked Core DTO." }, qaContext, f.platform);
  assert.equal(report.status, "published");
  assert.equal(reference.binding.runId, CORE_RUN);
  runStates.set(QA_RUN, "succeeded");

  const wakes: unknown[] = [];
  let atomicWakeCalls = 0;
  revisionState.guardedCompareAndSetWithJobWakeV1 = (async (address: any, expected: any, value: any, wake: unknown) => {
    atomicWakeCalls++;
    for (const guard of address.guards) if (JSON.stringify(f.values.get(mapKey({ scopeKind: "company", scopeId: address.scopeId,
      namespace: guard.namespace, stateKey: guard.stateKey }))) !== JSON.stringify(guard.expectedValue)) return { status: "conflict" };
    const storageKey = mapKey({ scopeKind: address.scopeKind, scopeId: address.scopeId, namespace: address.namespace, stateKey: address.stateKey });
    const prior = f.values.get(storageKey);
    if (expected.exists ? JSON.stringify(prior) !== JSON.stringify(expected.value) : prior !== undefined) return { status: "conflict" };
    f.values.set(storageKey, structuredClone(value)); wakes.push(structuredClone(wake)); return { status: "committed" };
  }) as never;
  const verifyTool = registeredTools.find(tool => tool.name === "builder.verify-workstream");
  const dispatchTool = registeredTools.find(tool => tool.name === "builder.dispatch-task-worker");
  assert.ok(verifyTool);
  assert.ok(dispatchTool);
  return { f, verifyTool, dispatchTool, ctoContext, wakes, requests, sourceTurnKey: key(`lead-chat.turn.v1.${mainContext.runId}`),
    get atomicWakeCalls() { return atomicWakeCalls; }, async verify() {
    return verifyTool!.handler({ projectId: W, ctoId: CTO, workstreamId: "ws-1" }, ctoContext, f.platform) as Promise<any>;
  }, reportStore: () => createTaskQaReportStore(reportScope, revisionState) };
}
