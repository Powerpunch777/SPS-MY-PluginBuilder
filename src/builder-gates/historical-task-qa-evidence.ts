import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { exactToolRecord, parseLeadToolContext } from "../lead-tool-authority.ts";
import { readDesignBaseline } from "../design-baseline-tools.ts";
import { taskPacketRecordDigest, type TaskPacketRecord } from "../domain/task-packets.ts";
import { parseTaskWorkerRegistry, taskWorkerRegistryKey } from "../domain/task-workers.ts";
import { createTaskPacketStore, resolveCtoTaskAuthority } from "../task-packet-tools.ts";
import { createTaskQaReportStore, taskQaCriteria, type TaskQaReport } from "../task-qa-reports.ts";
import { createTaskQaRunReferenceStore, parseTaskQaReferenceScope, type TaskQaRunReference } from "../task-qa-run-references.ts";
import { deriveProtectedTaskQaRequestIdentity, parseProtectedRun } from "../task-protected-qa.ts";
import { deriveTaskWorkerFileBinding, taskWorkerRequestId } from "../task-worker-runtime.ts";
import { readCtoTaskSourceAcceptanceForSubmission } from "../task-source-acceptance.ts";
import { readTaskSourceSubmission } from "../task-source-submissions.ts";
import { assertProtectedOutputMetadata, PROTECTED_OUTPUT_RECEIPT_FIELDS } from "../protected-test-output-metadata.ts";
import { readWorkspaceSourceGitTipProof } from "../workspace-source-git-tip.ts";

const SHA = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const TOOL = "builder.verify-workstream";

export type HistoricalTaskQaEvidenceInput = Readonly<{
  scope: Readonly<{ workspaceId: string; projectId: string; workstreamId: string; taskId: string }>;
  ctoId: string; taskBoardRevisionId: string; implementationDigest: string; qaTaskId: string; qaDigest: string;
  runContext: unknown; platform: SpsPlatformInvocationContext;
}>;

class Unavailable extends Error {}
function requireEvidence(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Unavailable(reason);
}
function identifier(value: unknown): string {
  requireEvidence(typeof value === "string" && value.trim() && value.length <= 160
    && !/[\u0000-\u001f\u007f]/u.test(value), "historical-qa-scope-invalid");
  return value;
}
function sessionRun(value: unknown) {
  return exactToolRecord(value, ["runId", "status", "cancellationRequested", "termination", "errorCode", "error"],
    ["execution", "output", "timing", "systemEvent"]);
}
async function submittedRun(platform: SpsPlatformInvocationContext, workspaceId: string, sessionId: string, requestId: string) {
  const request = exactToolRecord(await platform.agents.sessions.getRequest(sessionId, workspaceId, requestId), ["requestId", "state", "runId"]);
  requireEvidence(request.requestId === requestId && request.state === "submitted" && typeof request.runId === "string"
    && UUID.test(request.runId), "historical-qa-session-request-mismatch");
  return request.runId;
}

async function checkAuthor(platform: SpsPlatformInvocationContext, report: TaskQaReport, reference: TaskQaRunReference, originalRunId: string) {
  const { author } = report, { workspaceId } = reference.scope, { binding, deferredEvent } = reference;
  const authorRun = sessionRun(await platform.agents.sessions.getRun(author.sessionId, workspaceId, author.runId));
  requireEvidence(authorRun.runId === author.runId && authorRun.status === "succeeded" && authorRun.cancellationRequested === false
    && authorRun.termination === "not_applicable", "historical-qa-author-not-normally-ended");
  if (author.runId === originalRunId) {
    requireEvidence(authorRun.systemEvent === undefined, "historical-qa-original-author-has-unexpected-lineage");
    return;
  }
  // Historical counterpart to the live QA continuation guard; never treats a terminal Run as active.
  const event = exactToolRecord(authorRun.systemEvent, ["schemaVersion", "kind", "requestId", "previousRunId", "eventId",
    "protectedRunId", "receiptDigest", "subjectKeySha256"]);
  requireEvidence(deferredEvent && deferredEvent.previousRunId === originalRunId && deferredEvent.eventId === event.eventId
    && deferredEvent.receiptDigest === report.coreReceiptDigest && event.schemaVersion === 1 && event.kind === "protected-test-terminal-event"
    && event.previousRunId === originalRunId && event.protectedRunId === binding.runId && event.receiptDigest === report.coreReceiptDigest
    && event.subjectKeySha256 === binding.subjectKeySha256 && typeof event.requestId === "string" && UUID.test(event.requestId),
  "historical-qa-author-lineage-mismatch");
  requireEvidence(await submittedRun(platform, workspaceId, author.sessionId, event.requestId) === author.runId,
    "historical-qa-continuation-request-mismatch");
  const previous = sessionRun(await platform.agents.sessions.getRun(author.sessionId, workspaceId, originalRunId));
  requireEvidence(previous.runId === originalRunId && ["succeeded", "failed", "interrupted", "timed_out"].includes(String(previous.status))
    && previous.cancellationRequested === false && previous.termination === "not_applicable", "historical-qa-origin-not-closed");
}

function technicalReceipt(raw: unknown, reference: TaskQaRunReference, report: TaskQaReport) {
  const run = parseProtectedRun(raw), { binding } = reference;
  const receipt = exactToolRecord(run.receipt, ["digest", "status", "stdoutSha256", "stderrSha256", "stdoutBytes", "stderrBytes",
    "processExitCode", "timedOut", "cancelled", "outputLimit", "appContainerVerified", "capabilitiesCount",
    "childTerminationConfirmed", "jobEmpty", "profileCleanupSucceeded", "sandboxCleanupSucceeded", "fixtureMustBeRetained"],
  PROTECTED_OUTPUT_RECEIPT_FIELDS);
  assertProtectedOutputMetadata(receipt);
  const timestamps = exactToolRecord(run.timestamps, ["createdAt", "claimedAt", "startedAt", "finishedAt"]);
  requireEvidence(run.id === binding.runId && run.status === "succeeded" && run.termination === "confirmed"
    && run.pins.approvalId === binding.approvalId && run.pins.sourceId === binding.sourceId && run.pins.planSha256 === binding.planSha256
    && run.pins.commitSha === binding.commitSha && run.pins.treeSha === binding.treeSha && run.pins.subjectKeySha256 === binding.subjectKeySha256
    && receipt.digest === report.coreReceiptDigest && receipt.status === "completed" && receipt.processExitCode === 0
    && receipt.timedOut === false && receipt.cancelled === false && receipt.outputLimit === false && receipt.appContainerVerified === true
    && receipt.capabilitiesCount === 0 && receipt.childTerminationConfirmed === true && receipt.jobEmpty === true
    && receipt.profileCleanupSucceeded === true && receipt.sandboxCleanupSucceeded === true && receipt.fixtureMustBeRetained === false
    && [receipt.stdoutSha256, receipt.stderrSha256].every(item => item === null || typeof item === "string" && SHA.test(item))
    && [receipt.stdoutBytes, receipt.stderrBytes].every(item => Number.isSafeInteger(item) && (item as number) >= 0)
    && Object.values(timestamps).every(item => item === null || typeof item === "string" && Number.isFinite(Date.parse(item)))
    && typeof timestamps.createdAt === "string" && typeof timestamps.finishedAt === "string",
  "historical-qa-protected-receipt-mismatch");
  const detached = { ...receipt };
  if (Array.isArray(receipt.outputManifest)) detached.outputManifest = Object.freeze(receipt.outputManifest
    .map(item => Object.freeze({ ...exactToolRecord(item, ["path", "byteLength", "sha256"]) })));
  return Object.freeze({ ...run, pins: Object.freeze({ ...run.pins }), receipt: Object.freeze(detached), timestamps: Object.freeze(timestamps) });
}

/** Server-only historical proof for one exact published Task pair. This never resolves
 * a current gate, reuses an old dispatch authority, or starts another execution. */
export async function readHistoricalTaskQaEvidence(input: HistoricalTaskQaEvidenceInput) {
  try {
    const row = exactToolRecord(input, ["scope", "ctoId", "taskBoardRevisionId", "implementationDigest", "qaTaskId", "qaDigest", "runContext", "platform"]);
    const selected = exactToolRecord(row.scope, ["workspaceId", "projectId", "workstreamId", "taskId"]);
    const { workspaceId, projectId, workstreamId, ctoId, qaTaskId } = parseTaskQaReferenceScope({
      workspaceId: selected.workspaceId, projectId: selected.projectId, workstreamId: selected.workstreamId, ctoId: row.ctoId, qaTaskId: row.qaTaskId,
    });
    const taskId = identifier(selected.taskId), taskBoardRevisionId = identifier(row.taskBoardRevisionId);
    const implementationDigest = row.implementationDigest, qaDigest = row.qaDigest;
    requireEvidence(typeof implementationDigest === "string" && SHA.test(implementationDigest) && typeof qaDigest === "string"
      && SHA.test(qaDigest) && taskId !== qaTaskId, "historical-qa-task-pins-invalid");
    const context = parseLeadToolContext(row.runContext), platform = row.platform as SpsPlatformInvocationContext;
    requireEvidence(workspaceId === projectId && context.companyId === workspaceId
      && (context.projectId === undefined || context.projectId === projectId), "historical-qa-cto-scope-mismatch");
    const authority = await resolveCtoTaskAuthority(projectId, ctoId, workstreamId, context, platform, TOOL);
    const expectedBaseline = authority.sources.baseline;
    const state = platform.state;
    const store = createTaskPacketStore(workspaceId, projectId, ctoId, workstreamId, state);
    const reportScope = { workspaceId, projectId, ctoId, workstreamId, qaTaskId };
    const reports = createTaskQaReportStore(reportScope, state), references = createTaskQaRunReferenceStore(reportScope, state);
    const registryKey = { scopeKind: "company" as const, scopeId: workspaceId, namespace: "sonpark.my-builder",
      stateKey: taskWorkerRegistryKey(projectId, ctoId) };
    const recordDigest = (record: TaskPacketRecord) => taskPacketRecordDigest(record, projectId, ctoId, workstreamId);
    const assertCurrentCto = async () => {
      await authority.check();
      const baseline = await readDesignBaseline(workspaceId, projectId, platform);
      requireEvidence(baseline && baseline.revision.revisionId === expectedBaseline.revisionId
        && hash(baseline.revision) === hash(expectedBaseline), "historical-qa-current-cto-design-changed");
    };

    const inspect = async () => {
      await assertCurrentCto();
      const [current, historical, reportHead, referenceHead, registryRaw] = await Promise.all([
        store.current(), store.publishedRevision(taskBoardRevisionId), reports.current(), references.current(), state.get(registryKey),
      ]);
      requireEvidence(current && historical && historical.sequence < current.sequence, "historical-qa-task-board-not-published-ancestor");
      const packets = historical.revision.packets;
      const implementation = packets.find(item => item.packet.taskId === taskId), qa = packets.find(item => item.packet.taskId === qaTaskId);
      requireEvidence(implementation?.packet.kind === "development" && qa?.packet.kind === "qa" && qa.packet.testPlan
        && recordDigest(implementation) === implementationDigest && recordDigest(qa) === qaDigest
        && JSON.stringify(implementation.source) === JSON.stringify(qa.source)
        && qa.dependencyPins.some(pin => pin.taskId === taskId && pin.revision === implementation.packet.revision && pin.recordSha256 === implementationDigest),
      "historical-qa-task-pair-mismatch");
      requireEvidence(reportHead && referenceHead && reportHead.revision.reference.revisionId === referenceHead.revision.revisionId,
        "historical-qa-report-reference-head-mismatch");
      const report = reportHead.revision, reference = referenceHead.revision, { binding } = reference;
      const criteria = taskQaCriteria(qa.packet.acceptance, qa.packet.testPlan.passCriteria, implementation.packet.acceptance);
      requireEvidence(report.verdict === "passed" && report.coreStatus === "succeeded" && report.checks.length === criteria.length
        && criteria.every((criterion, index) => report.checks[index]?.criterionId === criterion.criterionId
          && report.checks[index]?.text === criterion.text && report.checks[index]?.verdict === "passed"), "historical-qa-head-is-not-exact-passing-report");
      requireEvidence(binding.implementationTaskId === taskId && binding.implementationRevision === implementation.packet.revision
        && binding.implementationDigest === implementationDigest && binding.qaRevision === qa.packet.revision && binding.qaDigest === qaDigest,
      "historical-qa-reference-task-pins-mismatch");
      const found = await references.findRun(binding.runId);
      requireEvidence(found.status === "found" && found.reference.revisionId === reference.revisionId, "historical-qa-run-reference-conflict");

      const registry = parseTaskWorkerRegistry(registryRaw, workspaceId, projectId, ctoId);
      const workerBinding = (packet: TaskPacketRecord, role: "worker" | "qa", digest: string) => {
        const matches = registry.records.filter(worker => worker.workstreamId === workstreamId && worker.role === role
          && worker.taskId === packet.packet.taskId && worker.packetRevision === packet.packet.revision && worker.packetRecordSha256 === digest);
        requireEvidence(matches.length === 1, "historical-qa-worker-registration-not-exact");
        return deriveTaskWorkerFileBinding({ workspaceId, projectId, ctoId, packet, currentPackets: packets, worker: matches[0]! });
      };
      const devWorker = workerBinding(implementation, "worker", implementationDigest), qaWorker = workerBinding(qa, "qa", qaDigest);
      const source = devWorker.sourceAccess, qaSource = qaWorker.sourceAccess;
      requireEvidence(source.branch && source.expectedHead && [source, qaSource].every(access => access.sourceId === binding.sourceId
        && access.folderKey === binding.folderKey && access.branch === binding.branch)
        && qaWorker.agentId === binding.qaAgentId && qaWorker.sessionId === binding.qaSessionId,
      "historical-qa-worker-source-mismatch");
      const submitted = await readTaskSourceSubmission({ state, submissionId: binding.submissionId, binding: {
        schemaVersion: 1, workspaceId, projectId, ctoId, workstreamId, taskId, packetRevision: implementation.packet.revision,
        packetRecordSha256: implementationDigest, dependencyPins: implementation.dependencyPins, role: "worker",
        agentId: devWorker.agentId, sessionId: devWorker.sessionId,
        source: { sourceId: source.sourceId, folderKey: source.folderKey, branch: source.branch, expectedHead: source.expectedHead },
        readPaths: source.readPaths, writePaths: source.writePaths, qaWritePaths: source.qaWritePaths,
      } });
      requireEvidence(submitted.status === "submitted" && submitted.submission.authorityAfterCommit === "current"
        && submitted.submission.commitSha === binding.commitSha && submitted.submission.treeSha === binding.treeSha,
      "historical-qa-accepted-source-unavailable");
      const submission = submitted.submission;
      const acceptance = await readCtoTaskSourceAcceptanceForSubmission({ workspaceId, submission, state });
      requireEvidence(acceptance?.acceptanceId === binding.acceptanceId, "historical-qa-cto-acceptance-mismatch");
      const identity = deriveProtectedTaskQaRequestIdentity({ ...binding, workspaceId, projectId, ctoId, workstreamId, qaTaskId });
      requireEvidence(identity.requestId === binding.requestId && identity.subjectKey === binding.subjectKey
        && identity.subjectKeySha256 === binding.subjectKeySha256, "historical-qa-protected-request-mismatch");
      requireEvidence(report.author.agentId === qaWorker.agentId && report.author.sessionId === qaWorker.sessionId
        && report.author.runId !== binding.runId && [context, implementation.author, qa.author, submission.producer, acceptance.receivedBy]
          .every(other => other.agentId !== report.author.agentId && other.sessionId !== report.author.sessionId && other.runId !== report.author.runId),
      "historical-qa-author-not-independent");
      requireEvidence(await submittedRun(platform, workspaceId, devWorker.sessionId, taskWorkerRequestId(devWorker)) === submission.producer.runId,
        "historical-qa-source-producer-request-mismatch");
      const producerRaw = await platform.agents.sessions.getRun(devWorker.sessionId, workspaceId, submission.producer.runId);
      requireEvidence(producerRaw && typeof producerRaw === "object", "historical-qa-source-producer-run-unavailable");
      const producer = exactToolRecord(producerRaw, ["runId", "status", "cancellationRequested", "termination", "errorCode", "error"],
        ["execution", "output", "timing"]);
      // Source acceptance observes provenance, not successful completion. A failed
      // or cancelled producer can still have submitted this exact accepted commit.
      requireEvidence(producer.runId === submission.producer.runId && typeof producer.status === "string"
        && ["running", "succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(producer.status)
        && typeof producer.cancellationRequested === "boolean"
        && ["not_applicable", "pending", "confirmed"].includes(producer.termination as string),
      "historical-qa-source-producer-run-mismatch");
      const producerObservation = { runId: producer.runId, status: producer.status,
        cancellationRequested: producer.cancellationRequested, termination: producer.termination };
      const originalQaRunId = await submittedRun(platform, workspaceId, qaWorker.sessionId, taskWorkerRequestId(qaWorker));
      await checkAuthor(platform, report, reference, originalQaRunId);

      const host = platform as SpsPlatformInvocationContext & { protectedTests?: {
        getRunV1?(workspaceId: string, runId: string, subjectKeySha256: string): Promise<unknown>;
      }; localFolders?: { matchWorkspaceSourceV1?(folderKey: string, sourceId: string): Promise<unknown>;
        readWorkspaceSourceGitTipV1?(sourceId: string, folderKey: string, branch: string): Promise<unknown> } };
      const api = host.protectedTests, folders = host.localFolders;
      requireEvidence(typeof api?.getRunV1 === "function" && typeof folders?.matchWorkspaceSourceV1 === "function"
        && typeof folders.readWorkspaceSourceGitTipV1 === "function", "historical-qa-host-readers-unavailable");
      const coreRun = technicalReceipt(await api.getRunV1(workspaceId, binding.runId, binding.subjectKeySha256), reference, report);
      const root = exactToolRecord(await folders.matchWorkspaceSourceV1(binding.folderKey, binding.sourceId), ["folderKey", "workspaceSourceId", "match"]);
      requireEvidence(root.folderKey === binding.folderKey && root.workspaceSourceId === binding.sourceId && root.match === "same_root",
        "historical-qa-source-root-mismatch");
      const tip = readWorkspaceSourceGitTipProof(await folders.readWorkspaceSourceGitTipV1(binding.sourceId, binding.folderKey, binding.branch));
      requireEvidence(tip.status === "current" && tip.sourceId === binding.sourceId && tip.folderKey === binding.folderKey
        && tip.branch === binding.branch && tip.commitSha === binding.commitSha && tip.treeSha === binding.treeSha,
      "historical-qa-current-authorized-tip-mismatch");
      await assertCurrentCto();
      const [currentAfter, reportAfter, referenceAfter, registryAfter] = await Promise.all([
        store.current(), reports.current(), references.current(), state.get(registryKey),
      ]);
      requireEvidence(hash(currentAfter) === hash(current) && hash(reportAfter) === hash(reportHead) && hash(referenceAfter) === hash(referenceHead)
        && hash(registryAfter) === hash(registryRaw), "historical-qa-heads-changed");
      await assertCurrentCto();
      return { current, reportHead, referenceHead, registryRaw, producerObservation, originalQaRunId, value: Object.freeze({
        taskBoardRevisionId, taskBoardSequence: historical.sequence, implementationDigest, qaDigest,
        implementationRecord: implementation, qaRecord: qa, report, reference, submission, acceptance, coreRun,
        evidenceKind: "historical-exact-task-qa" as const, currentGate: "not-established" as const,
      }) };
    };

    const first = await inspect(), expected = hash(first);
    return Object.freeze({ status: "available" as const, value: first.value, async check(): Promise<void> {
      try {
        requireEvidence(hash(await inspect()) === expected, "historical-qa-evidence-changed");
      } catch { throw new Error("Historical Task QA evidence or current observation authority changed."); }
    } });
  } catch (error) {
    return Object.freeze({ status: "unknown" as const,
      reason: error instanceof Unavailable ? error.message : "historical-qa-authority-or-evidence-unavailable" });
  }
}
