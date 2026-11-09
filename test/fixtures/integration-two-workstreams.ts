import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRevisionJournal, type RevisionState } from "../../src/solution-revision-store.ts";
import { createTaskPacketStore } from "../../src/task-packet-tools.ts";
import { createTaskQaReportStore } from "../../src/task-qa-reports.ts";
import { parseTaskQaRunReference } from "../../src/task-qa-run-references.ts";
import { taskPacketRecordDigest } from "../../src/domain/task-packets.ts";
import { createWorkstreamStore, readWorkstreams } from "../../src/workstream-tools.ts";
import { createWorkstreamVerificationPublication } from "../../src/builder-gates/workstream-verification-publication.ts";
import { consumeVerifiedWorkstream, normalizeVerifiedWorkstreamSnapshot, type VerifiedWorkstreamSnapshot } from "../../src/builder-gates/workstream-verification-consumer.ts";
import { validationFixture, integrationTool, validationTool } from "./integration-manager-platform.ts";
import { W, CTO, mapKey } from "./cto-platform.ts";
import { workstreamInstructionDigest } from "../../src/cto-delivery-store.ts";
import { managerRequestUuidForLedgerKey } from "../../src/builder-gates/integration-manager-job.ts";
import { taskWorkerRegistryKey } from "../../src/domain/task-workers.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const CTO_TWO = "cto-two";
const CTO_TWO_AGENT = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
const CTO_TWO_SESSION = "cececece-cece-4ece-8ece-cececececece";
const CTO_TWO_RUN = "cfcfcfcf-cfcf-4fcf-8fcf-cfcfcfcfcfcf";
const WORKER_TWO_AGENT = "d0d0d0d0-d0d0-40d0-80d0-d0d0d0d0d0d0";
const WORKER_TWO_SESSION = "d1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1";
const WORKER_TWO_RUN = "d2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2";
const QA_TWO_AGENT = "d3d3d3d3-d3d3-43d3-83d3-d3d3d3d3d3d3";
const QA_TWO_SESSION = "d4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4";
const QA_TWO_RUN = "d5d5d5d5-d5d5-45d5-85d5-d5d5d5d5d5d5";
const SOURCE_TWO = "99999999-9999-4999-8999-999999999999";
const SOURCE_TWO_COMMIT = "6".repeat(40), SOURCE_TWO_TREE = "7".repeat(40);

/** Adds an independently scoped second journal set to the existing registered
 * Manager fixture. All Core/QA/Git receipts remain synthetic fixture DTOs. */
export async function setupTwoWorkstreamCandidate(options: { omitSecondEffect?: boolean; mismatchSecondQaSource?: boolean } = {}) {
  const base = await validationFixture();
  const state = base.f.state as unknown as RevisionState;
  const boardStore = createWorkstreamStore(W, W, state);
  const board = (await readWorkstreams(W, W, base.f.platform))!.revision;
  const first = board.workstreams[0]!;
  const second = { ...structuredClone(first), spec: { ...first.spec, id: "ws-two", revision: 1, dependencies: [],
    assignedCtoId: CTO_TWO, scopeNodeIds: ["feature-two"] }, ctoAgentId: CTO_TWO_AGENT, ctoSessionId: CTO_TWO_SESSION,
    author: { ...first.author, agentId: CTO_TWO_AGENT, sessionId: CTO_TWO_SESSION, runId: CTO_TWO_RUN }, receipt: null };
  const publishedBoard = await boardStore.publish({ expectedBaseRevisionId: board.revisionId,
    revision: { projectId: W, revisionId: "fixture-two-workstream-board", workstreams: [first, second] } });
  assert.equal(publishedBoard.status, "published");

  const firstPackets = (await createTaskPacketStore(W, W, CTO, first.spec.id, state).current())!.revision;
  const originalDev = structuredClone(firstPackets.packets.find(item => item.packet.kind === "development")!);
  const originalQa = structuredClone(firstPackets.packets.find(item => item.packet.kind === "qa")!);
  const instructionSha = workstreamInstructionDigest(second);
  const dev = { ...originalDev, packet: { ...originalDev.packet, ctoId: CTO_TWO, workstreamId: "ws-two", taskId: "task-two-dev",
    title: "task-two-dev", scopeNodeIds: ["feature-two"], sourceAccess: { ...originalDev.packet.sourceAccess!, sourceId: SOURCE_TWO,
      branch: "feature/two", expectedHead: "f".repeat(40) } },
    source: { ...originalDev.source, workstreamId: "ws-two", instructionSha256: instructionSha },
    author: { agentId: CTO_TWO_AGENT, sessionId: CTO_TWO_SESSION, runId: CTO_TWO_RUN } };
  const qaBase = { ...originalQa, packet: { ...originalQa.packet, ctoId: CTO_TWO, workstreamId: "ws-two", taskId: "task-two-qa",
    title: "task-two-qa", scopeNodeIds: ["feature-two"], dependencies: ["task-two-dev"], sourceAccess: {
      ...originalQa.packet.sourceAccess!, sourceId: SOURCE_TWO, branch: "feature/two", expectedHead: "f".repeat(40) } },
    source: { ...originalQa.source, workstreamId: "ws-two", instructionSha256: instructionSha } };
  const devDigest = taskPacketRecordDigest(dev as never, W, CTO_TWO, "ws-two");
  const qa = { ...qaBase, author: { agentId: CTO_TWO_AGENT, sessionId: CTO_TWO_SESSION, runId: CTO_TWO_RUN },
    dependencyPins: [{ taskId: "task-two-dev", revision: dev.packet.revision, recordSha256: devDigest }] };
  const packets = [dev, qa];
  const packetStore = createTaskPacketStore(W, W, CTO_TWO, "ws-two", state);
  const packetResult = await packetStore.publish({ expectedBaseRevisionId: null,
    revision: { projectId: W, ctoId: CTO_TWO, workstreamId: "ws-two", revisionId: "fixture-two-task-board", packets } });
  assert.equal(packetResult.status, "published");
  const qaDigest = taskPacketRecordDigest(qa as never, W, CTO_TWO, "ws-two");
  const workerKey = (taskId: string, role: "worker" | "qa") => `builder-task-${role}:${hash([W, "ws-two", taskId, role])}`;
  base.f.values.set(mapKey({ scopeKind: "company", scopeId: W, namespace: "sonpark.my-builder",
    stateKey: taskWorkerRegistryKey(W, CTO_TWO) }), { schemaVersion: 1, workspaceId: W, projectId: W, ctoId: CTO_TWO,
    revision: 2, records: [
      { workstreamId: "ws-two", taskId: "task-two-dev", packetRevision: dev.packet.revision,
        packetRecordSha256: devDigest, role: "worker", agentId: WORKER_TWO_AGENT, sessionId: WORKER_TWO_SESSION,
        pluginAgentKey: workerKey("task-two-dev", "worker"), source: { requestId: "d7d7d7d7-d7d7-47d7-87d7-d7d7d7d7d7d7",
          specRevision: 1, instructionSha256: instructionSha }, registeredAtISO: "2026-11-07T12:00:00.000Z" },
      { workstreamId: "ws-two", taskId: "task-two-qa", packetRevision: qa.packet.revision,
        packetRecordSha256: qaDigest, role: "qa", agentId: QA_TWO_AGENT, sessionId: QA_TWO_SESSION,
        pluginAgentKey: workerKey("task-two-qa", "qa"), source: { requestId: "d8d8d8d8-d8d8-48d8-88d8-d8d8d8d8d8d8",
          specRevision: 1, instructionSha256: instructionSha }, registeredAtISO: "2026-11-07T12:00:00.000Z" },
    ] });

  const refScope = { workspaceId: W, projectId: W, ctoId: CTO_TWO, workstreamId: "ws-two", qaTaskId: "task-two-qa" };
  const refBinding = {
      implementationTaskId: "task-two-dev", implementationRevision: dev.packet.revision, implementationDigest: devDigest,
      qaRevision: qa.packet.revision, qaDigest, qaAgentId: QA_TWO_AGENT, qaSessionId: QA_TWO_SESSION,
      sourceId: options.mismatchSecondQaSource ? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" : SOURCE_TWO,
      folderKey: "project-source", branch: "feature/two", commitSha: SOURCE_TWO_COMMIT, treeSha: SOURCE_TWO_TREE,
      acceptanceId: "1".repeat(64), submissionId: "2".repeat(64),
      approvalId: "12121212-1212-4212-8212-121212121212", planSha256: "a".repeat(64), requestId: "fixture-two-request",
      subjectKey: "fixture-two-subject", subjectKeySha256: sha("fixture-two-subject"), runId: "dededede-dede-4ded-8ded-dededededede" };
  const refContent = { schemaVersion: 1 as const, scope: refScope, binding: refBinding };
  const taskReference = parseTaskQaRunReference({ ...refContent, revisionId: `task-qa-run-v1:${hash(refContent)}` });
  const reference = taskReference;
  const firstReport = (await base.reportStore().current())!.revision;
  const reportContent = { schemaVersion: 1 as const, reference, coreReceiptDigest: "8".repeat(64), coreStatus: "succeeded" as const,
    author: { agentId: QA_TWO_AGENT, sessionId: QA_TWO_SESSION, runId: QA_TWO_RUN },
    checks: firstReport.checks, summary: "Synthetic independent QA fixture; not a real protected execution.", verdict: "passed" as const };
  const report = { ...reportContent, revisionId: `task-qa-report-v1:${hash(reportContent)}` };
  const reports = createTaskQaReportStore({ workspaceId: W, projectId: W, ctoId: CTO_TWO, workstreamId: "ws-two", qaTaskId: "task-two-qa" }, state);
  const reportWrite = await reports.publish({ expectedBaseRevisionId: null, revision: report as never });
  assert.equal(reportWrite.status, "published");
  const reportSha = hash(report);

  const firstVerification = createWorkstreamVerificationPublication(state);
  const firstCurrent = await firstVerification.readLatestCurrent({ workspaceId: W, projectId: W, workstreamId: first.spec.id });
  assert.equal(firstCurrent.status, "current");
  if (firstCurrent.status !== "current") throw new Error("Expected initial fixture verification.");
  const snapshot = structuredClone(firstCurrent.snapshot) as VerifiedWorkstreamSnapshot;
  const devPin = { sourceId: "builder-v1:task-packet:task-two-dev", revisionId: `task-two-dev:${dev.packet.revision}`, sha256: devDigest };
  const qaPin = { sourceId: "builder-v1:task-packet:task-two-qa", revisionId: `task-two-qa:${qa.packet.revision}`, sha256: qaDigest };
  const reportPin = { sourceId: "builder-v1:task-qa-report:task-two-qa", revisionId: report.revisionId, sha256: reportSha };
  const referencePin = { sourceId: "builder-v1:task-qa-run:task-two-qa", revisionId: reference.revisionId, sha256: hash(reference) };
  const oldBinding = firstReport.reference.binding;
  const replacements = new Map([
    ["builder-v1:workstream:ws-1", { sourceId: "builder-v1:workstream:ws-two", revisionId: String(second.spec.revision), sha256: hash(second) }],
    ["builder-v1:task-packet:task-dev", devPin], ["builder-v1:task-packet:task-qa", qaPin],
    ["builder-v1:task-qa-report:task-qa", reportPin], ["builder-v1:task-qa-run:task-qa", referencePin],
    [`core:protected-test-run:${oldBinding.runId}`, { sourceId: `core:protected-test-run:${refBinding.runId}`,
      revisionId: refBinding.runId, sha256: hash(refBinding) }],
    [`core:protected-test-receipt:${oldBinding.runId}`, { sourceId: `core:protected-test-receipt:${refBinding.runId}`,
      revisionId: report.coreReceiptDigest, sha256: report.coreReceiptDigest }],
  ]);
  const pins = snapshot.sourcePins.map(pin => replacements.get(pin.sourceId) ?? pin);
  const nextSnapshot = { ...snapshot, eventId: "", workstreamId: "ws-two", sourcePins: pins,
    gateDecisions: snapshot.gateDecisions.map(gate => ({ ...gate, evidenceRefs: gate.evidenceRefs.map(pin => replacements.get(pin.sourceId) ?? pin) })),
    qaEvidence: [{ result: "passed" as const, report: reportPin }] };
  const snapshotForId = { ...nextSnapshot, eventId: "" };
  const taskPins = [{ taskId: "task-two-dev", taskRevision: dev.packet.revision, taskRecordSha256: devDigest }];
  const eventId = "builder-verified-v1:" + hash([taskPins,
    normalizeVerifiedWorkstreamSnapshot(snapshotForId as VerifiedWorkstreamSnapshot)]);
  const verified = { ...nextSnapshot, eventId } as VerifiedWorkstreamSnapshot;

  const workspaceKey = { scopeKind: "company" as const, scopeId: W, namespace: "sonpark.my-builder",
    stateKey: `workstreams-head.v1.${createHash("sha256").update(W, "utf8").digest("hex")}` };
  const boardPointer = await state.get(workspaceKey);
  assert.ok(boardPointer);
  const guards = verified.sourcePins.filter(pin => pin.sourceId !== "builder-v1:workstream:ws-two").map((pin, index) => {
    const namespace = "two-workstream-fixture";
    const stateKey = `pin-${index}`;
    const expectedValue = { sourceId: pin.sourceId, revisionId: pin.revisionId, sha256: pin.sha256 };
    return { namespace, stateKey, expectedValue, sourceIds: [pin.sourceId] };
  });
  guards.push({ namespace: "sonpark.my-builder", stateKey: workspaceKey.stateKey, expectedValue: boardPointer,
    sourceIds: ["builder-v1:workstream:ws-two"] } as never);
  for (const guard of guards) if (guard.namespace !== "sonpark.my-builder") {
    base.f.values.set(mapKey({ scopeKind: "company", scopeId: W, namespace: guard.namespace, stateKey: guard.stateKey }), guard.expectedValue);
  }
  const verificationJournal = createRevisionJournal(W, hash([W, "ws-two"]), state, {
    prefix: "workstream-verification", revisionId: (value: any) => value.eventId,
    parse: (value: unknown) => value as any,
  });
  const stored = { schemaVersion: 1 as const, eventId, tasks: taskPins, snapshot: verified, guards };
  const verificationWrite = await verificationJournal.publish({ expectedBaseRevisionId: null, revision: stored as never });
  assert.equal(verificationWrite.status, "published");
  const secondCurrent = await createWorkstreamVerificationPublication(state).readLatestCurrent({ workspaceId: W, projectId: W, workstreamId: "ws-two" });
  assert.equal(secondCurrent.status, "current", JSON.stringify(secondCurrent));

  const secondInput = { workstreamId: "ws-two", eventId, taskId: "task-two-dev" };
  if (options.omitSecondEffect) return { ...base, secondInput, secondEventId: eventId,
    secondOwnership: { ctoId: CTO_TWO, ctoAgentId: CTO_TWO_AGENT, ctoSessionId: CTO_TWO_SESSION,
      workerAgentId: WORKER_TWO_AGENT, workerSessionId: WORKER_TWO_SESSION, qaAgentId: QA_TWO_AGENT, qaSessionId: QA_TWO_SESSION },
    syntheticEvidence: "Core protected runs, QA report, and Git receipts are deterministic fixture DTOs; no actual Core/AppContainer/AI execution." };
  const currentReader = async () => createWorkstreamVerificationPublication(state).readLatestCurrent({
    workspaceId: W, projectId: W, workstreamId: "ws-two" });
  const managerAdmission = await consumeVerifiedWorkstream({ workspaceId: W, projectId: W, workstreamId: "ws-two", eventId },
    state, currentReader, { async dispatch(request) { assert.equal(request.eventId, eventId); }, async readReceipt(requestId) {
      const receiptId = managerRequestUuidForLedgerKey(requestId);
      (base.f.platform.agents.sessions as any).getRequest = async (_sessionId: string, _companyId: string, actual: string) =>
        actual === receiptId ? { requestId: receiptId, state: "submitted", runId: "eaeaeaea-eaea-4aea-8aea-eaeaeaeaeaea" } : null;
      return { status: "accepted", requestId, receiptId, runId: "eaeaeaea-eaea-4aea-8aea-eaeaeaeaeaea" };
    } });
  assert.equal(managerAdmission.status, "accepted", JSON.stringify(managerAdmission));

  if (options.mismatchSecondQaSource) {
    const secondManagerContext = { ...base.managerContext, runId: "eaeaeaea-eaea-4aea-8aea-eaeaeaeaeaea" };
    await integrationTool()!.handler(secondInput, secondManagerContext, base.f.platform);
    assert.fail("Expected a source-mismatched QA run reference to be refused.");
  }

  let candidateHead = { commitSha: "b".repeat(40), treeSha: "c".repeat(40) };
  Object.assign(base.f.platform, { localFolders: {
    async readWorkspaceSourceGitTipV1(sourceId: string, folderKey: string, branch: string) {
      return { status: "current", sourceId, folderKey, branch,
        commitSha: branch === "main" ? "f".repeat(40) : candidateHead.commitSha,
        treeSha: branch === "main" ? "a".repeat(40) : candidateHead.treeSha, observedAt: "2026-11-07T12:00:00.000Z" };
    },
    async integrateWorkspaceSourceCommitV2(input: any) {
      assert.equal(input.expectedHead, candidateHead.commitSha);
      candidateHead = { commitSha: "d".repeat(40), treeSha: "e".repeat(40) };
      return { status: "observed", git: { status: "integrated", commitSha: candidateHead.commitSha,
        treeSha: candidateHead.treeSha, changedPaths: ["src/task-two.ts"] } };
    },
  } });
  const secondManagerContext = { ...base.managerContext, runId: "eaeaeaea-eaea-4aea-8aea-eaeaeaeaeaea" };
  const managerResult = await integrationTool()!.handler(secondInput, secondManagerContext, base.f.platform) as any;
  assert.equal(managerResult.data.status, "published", JSON.stringify(managerResult));
  const validationResults = [];
  for (const phase of ["ci", "e2e"] as const) {
    const result = await validationTool().handler({ ...secondInput, phase }, secondManagerContext, base.f.platform) as any;
    validationResults.push(result);
    const id = result.data.reference.runId;
    const run = (base as any).runs.get(id);
    run.status = "succeeded";
    run.termination = "confirmed";
    run.receipt = { digest: "9".repeat(64), status: "completed", stdoutSha256: null, stderrSha256: null,
      stdoutBytes: 0, stderrBytes: 0, processExitCode: 0, timedOut: false, cancelled: false, outputLimit: false,
      appContainerVerified: true, capabilitiesCount: 0, childTerminationConfirmed: true, jobEmpty: true,
      profileCleanupSucceeded: true, sandboxCleanupSucceeded: true, fixtureMustBeRetained: false };
  }
  return { ...base, secondInput, secondEventId: eventId, validationResults,
    secondOwnership: { ctoId: CTO_TWO, ctoAgentId: CTO_TWO_AGENT, ctoSessionId: CTO_TWO_SESSION,
      workerAgentId: WORKER_TWO_AGENT, workerSessionId: WORKER_TWO_SESSION, qaAgentId: QA_TWO_AGENT, qaSessionId: QA_TWO_SESSION },
    syntheticEvidence: "Core protected runs, QA report, and Git receipts are deterministic fixture DTOs; no actual Core/AppContainer/AI execution." };
}
