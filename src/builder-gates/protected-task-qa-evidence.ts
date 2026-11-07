import { createHash } from "node:crypto";
import { assertProtectedOutputMetadata, PROTECTED_OUTPUT_RECEIPT_FIELDS } from "../protected-test-output-metadata.ts";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { exactToolRecord, parseLeadToolContext } from "../lead-tool-authority.ts";
import { taskPacketRecordDigest } from "../domain/task-packets.ts";
import { resolveCtoTaskAuthority } from "../task-packet-tools.ts";
import { createTaskQaReportStore, parseTaskQaReport, taskQaCriteria, type TaskQaReport } from "../task-qa-reports.ts";
import { createTaskQaRunReferenceStore } from "../task-qa-run-references.ts";
import { resolveProtectedTaskQaObservation, type ProtectedTaskQaTarget } from "../task-protected-qa.ts";
import type { RevisionState } from "../solution-revision-store.ts";

const SHA256 = /^[a-f0-9]{64}$/u;

export type CurrentProtectedTaskQaEvidenceInput = Readonly<{
  scope: Readonly<{ workspaceId: string; projectId: string; workstreamId: string; taskId: string }>;
  ctoId: string;
  runContext: unknown;
  platform: SpsPlatformInvocationContext;
}>;

export type ProtectedTaskQaCoreRun = Readonly<Record<string, unknown> & {
  schemaVersion: 1;
  kind: "protected-node-test-v1";
  id: string;
  status: string;
  termination: string;
  pins: Readonly<Record<string, unknown>>;
  receipt: Readonly<Record<string, unknown>>;
}>;

export type CurrentProtectedTaskQaEvidence = Readonly<{
  implementationRecord: ProtectedTaskQaTarget["implementation"];
  qaRecord: ProtectedTaskQaTarget["qa"];
  report: TaskQaReport;
  coreRun: ProtectedTaskQaCoreRun;
}>;

type Result = Readonly<{ status: "available"; value: CurrentProtectedTaskQaEvidence; check(): Promise<void> }>
  | Readonly<{ status: "unknown"; reason: string }>;

function unknown(reason: string): Result { return Object.freeze({ status: "unknown", reason }); }

function parseScope(value: unknown) {
  const row = exactToolRecord(value, ["workspaceId", "projectId", "workstreamId", "taskId"]);
  for (const field of ["workspaceId", "projectId", "workstreamId", "taskId"] as const) {
    if (typeof row[field] !== "string" || !row[field].trim() || row[field].length > 160 || /[\u0000-\u001f\u007f]/u.test(row[field] as string)) {
      throw new TypeError("Invalid protected Task QA evidence scope.");
    }
  }
  return row as unknown as CurrentProtectedTaskQaEvidenceInput["scope"];
}

function parseCoreRun(value: unknown): ProtectedTaskQaCoreRun {
  const row = exactToolRecord(value, ["schemaVersion", "kind", "id", "status", "termination", "pins", "receipt", "timestamps", "qaVerdict"]);
  const pins = exactToolRecord(row.pins, ["approvalId", "sourceId", "planSha256", "profileSha256", "commitSha", "treeSha",
    "manifestSha256", "inputTreeSha256", "nodeSha256", "subjectKeySha256", "timeoutMs"]);
  const receipt = exactToolRecord(row.receipt, ["digest", "status", "stdoutSha256", "stderrSha256", "stdoutBytes", "stderrBytes",
    "processExitCode", "timedOut", "cancelled", "outputLimit", "appContainerVerified", "capabilitiesCount",
    "childTerminationConfirmed", "jobEmpty", "profileCleanupSucceeded", "sandboxCleanupSucceeded", "fixtureMustBeRetained"], PROTECTED_OUTPUT_RECEIPT_FIELDS);
  assertProtectedOutputMetadata(receipt);
  if (row.schemaVersion !== 1 || row.kind !== "protected-node-test-v1" || typeof row.id !== "string"
    || !["queued", "claimed", "running", "cancelling", "succeeded", "failed", "cancelled"].includes(String(row.status))
    || !["not_applicable", "pending", "confirmed"].includes(String(row.termination))
    || row.qaVerdict !== "not-established"
    || [pins.approvalId, pins.sourceId].some(item => typeof item !== "string")
    || [pins.planSha256, pins.profileSha256, pins.manifestSha256, pins.nodeSha256, pins.subjectKeySha256]
      .some(item => typeof item !== "string" || !SHA256.test(item))
    || [pins.commitSha, pins.treeSha, pins.inputTreeSha256].some(item => typeof item !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(item))
    || !Number.isSafeInteger(pins.timeoutMs) || (pins.timeoutMs as number) < 1
    || typeof receipt.digest !== "string" || !SHA256.test(receipt.digest)) throw new TypeError("Malformed protected Core run receipt.");
  return Object.freeze({ ...row, pins: Object.freeze(pins), receipt: Object.freeze(receipt) }) as ProtectedTaskQaCoreRun;
}

function reportMatchesCriteria(report: TaskQaReport, target: ProtectedTaskQaTarget) {
  const criteria = taskQaCriteria(target.qa.packet.acceptance, target.qa.packet.testPlan?.passCriteria ?? [],
    target.implementation.packet.acceptance);
  return report.checks.length === criteria.length && criteria.every((criterion, index) => {
    const check = report.checks[index];
    return check?.criterionId === criterion.criterionId && check.text === criterion.text && check.verdict === "passed";
  }) && report.coreStatus === "succeeded" && report.verdict === "passed";
}

function reportMatchesTarget(report: TaskQaReport, target: ProtectedTaskQaTarget) {
  const binding = report.reference.binding;
  return report.reference.scope.workspaceId === target.workspaceId && report.reference.scope.projectId === target.projectId
    && report.reference.scope.ctoId === target.ctoId && report.reference.scope.workstreamId === target.workstreamId
    && report.reference.scope.qaTaskId === target.qa.packet.taskId
    && binding.implementationTaskId === target.implementation.packet.taskId
    && binding.implementationRevision === target.implementation.packet.revision
    && binding.implementationDigest === target.implementationDigest
    && binding.qaRevision === target.qa.packet.revision && binding.qaDigest === target.qaDigest
    && binding.qaAgentId === target.qaWorker.agentId && binding.qaSessionId === target.qaWorker.sessionId
    && binding.sourceId === target.source.sourceId && binding.folderKey === target.source.folderKey && binding.branch === target.source.branch
    && binding.commitSha === target.commitSha && binding.treeSha === target.treeSha
    && binding.acceptanceId === target.acceptanceId && binding.submissionId === target.submissionId
    && binding.approvalId === target.approvalId && binding.planSha256 === target.planSha256
    && binding.requestId === target.requestId && binding.subjectKey === target.subjectKey
    && binding.subjectKeySha256 === target.subjectKeySha256 && binding.runId === report.reference.binding.runId
    && report.author.agentId === target.qaWorker.agentId && report.author.sessionId === target.qaWorker.sessionId
    && report.author.runId === target.qaRunId && binding.runId !== report.author.runId;
}

async function checkGitTip(platform: SpsPlatformInvocationContext, target: ProtectedTaskQaTarget) {
  const api = (platform as SpsPlatformInvocationContext & { localFolders?: {
    matchWorkspaceSourceV1?: (folderKey: string, sourceId: string) => Promise<unknown>;
    readWorkspaceSourceGitTipV1?: (sourceId: string, folderKey: string, branch: string) => Promise<unknown>;
  } }).localFolders;
  if (typeof api?.matchWorkspaceSourceV1 !== "function" || typeof api.readWorkspaceSourceGitTipV1 !== "function") {
    throw new Error("host-source-proof-unavailable");
  }
  const root = exactToolRecord(await api.matchWorkspaceSourceV1(target.source.folderKey, target.source.sourceId),
    ["folderKey", "workspaceSourceId", "match"]);
  if (root.folderKey !== target.source.folderKey || root.workspaceSourceId !== target.source.sourceId || root.match !== "same_root") {
    throw new Error("host-source-root-changed");
  }
  const tip = exactToolRecord(await api.readWorkspaceSourceGitTipV1(target.source.sourceId, target.source.folderKey, target.source.branch),
    ["status", "sourceId", "folderKey", "branch", "commitSha", "treeSha", "observedAt"]);
  if (tip.status !== "current" || tip.sourceId !== target.source.sourceId || tip.folderKey !== target.source.folderKey
    || tip.branch !== target.source.branch || tip.commitSha !== target.commitSha || tip.treeSha !== target.treeSha) {
    throw new Error("accepted-source-branch-tip-drifted");
  }
}

/** Reads current authored QA evidence and its technical Core receipt; it performs no execution or publication. */
export async function readCurrentProtectedTaskQaEvidence(input: CurrentProtectedTaskQaEvidenceInput): Promise<Result> {
  try {
    const scope = parseScope(input.scope);
    const context = parseLeadToolContext(input.runContext);
    if (context.companyId !== scope.workspaceId || (context.projectId !== undefined && context.projectId !== scope.projectId)) {
      return unknown("authenticated-cto-scope-mismatch");
    }
    const authority = await resolveCtoTaskAuthority(scope.projectId, input.ctoId, scope.workstreamId,
      input.runContext, input.platform, "builder.read-protected-task-qa");
    if (authority.context.companyId !== scope.workspaceId) return unknown("authenticated-cto-workspace-mismatch");
    await authority.check();

    const board = await authority.store.current();
    if (!board) return unknown("current-task-packet-board-unavailable");
    const implementations = board.revision.packets.filter(row => row.packet.taskId === scope.taskId && row.packet.kind === "development");
    if (implementations.length !== 1) return unknown("current-development-task-not-unique");
    const implementation = implementations[0]!;
    const qaCandidates = board.revision.packets.filter(row => row.packet.kind === "qa"
      && row.packet.dependencies.includes(scope.taskId)
      && row.dependencyPins.some(pin => pin.taskId === scope.taskId
        && pin.revision === implementation.packet.revision
        && pin.recordSha256 === taskPacketRecordDigest(implementation, scope.projectId, input.ctoId, scope.workstreamId)));
    if (qaCandidates.length !== 1) return unknown("current-dependent-qa-task-not-unique");
    const qa = qaCandidates[0]!;
    if (qa.packet.testPlan === null) return unknown("current-qa-test-plan-unavailable");

    const reportScope = { workspaceId: scope.workspaceId, projectId: scope.projectId, ctoId: input.ctoId,
      workstreamId: scope.workstreamId, qaTaskId: qa.packet.taskId };
    const revisionState = input.platform.state as typeof input.platform.state & RevisionState;
    const reports = createTaskQaReportStore(reportScope, revisionState);
    const latest = await reports.current();
    if (!latest) return unknown("current-qa-report-unavailable");
    const report = parseTaskQaReport(latest.revision);
    const binding = report.reference.binding;
    const references = createTaskQaRunReferenceStore(reportScope, revisionState);
    const reference = await references.findRun(binding.runId);
    if (reference.status !== "found" || reference.reference.revisionId !== report.reference.revisionId) {
      return unknown("immutable-qa-run-reference-unavailable-or-conflicting");
    }
    const currentReference = await references.current();
    if (!currentReference || currentReference.revision.revisionId !== report.reference.revisionId) {
      return unknown("report-does-not-reference-current-protected-qa-run");
    }

    const observed = await resolveProtectedTaskQaObservation({ projectId: scope.projectId, ctoId: input.ctoId,
      workstreamId: scope.workstreamId, qaTaskId: qa.packet.taskId, approvalId: binding.approvalId,
      planSha256: binding.planSha256, runId: binding.runId }, input.runContext, input.platform);
    if (observed.status !== "current" || !observed.target) return unknown(observed.reason ?? "protected-qa-target-not-current");
    const target = observed.target;
    if (target.implementation.packet.taskId !== implementation.packet.taskId
      || target.implementationDigest !== taskPacketRecordDigest(implementation, scope.projectId, input.ctoId, scope.workstreamId)
      || target.qa.packet.taskId !== qa.packet.taskId || target.qaDigest !== taskPacketRecordDigest(qa, scope.projectId, input.ctoId, scope.workstreamId)
      || !reportMatchesTarget(report, target)) return unknown("qa-report-does-not-match-exact-current-task-target");
    if (!reportMatchesCriteria(report, target)) return unknown("latest-qa-report-is-not-a-complete-passing-assessment");

    const coreApi = (input.platform as SpsPlatformInvocationContext & { protectedTests?: {
      getRunV1?: (workspaceId: string, runId: string, subjectKeySha256: string) => Promise<unknown>;
    } }).protectedTests;
    if (typeof coreApi?.getRunV1 !== "function") return unknown("protected-core-run-reader-unavailable");
    await target.assertCurrent();
    await checkGitTip(input.platform, target);
    const coreRun = parseCoreRun(await coreApi.getRunV1(scope.workspaceId, binding.runId, binding.subjectKeySha256));
    const pins = coreRun.pins, receipt = coreRun.receipt;
    if (coreRun.id !== binding.runId || coreRun.status !== "succeeded" || coreRun.termination !== "confirmed"
      || pins.approvalId !== target.approvalId || pins.sourceId !== target.source.sourceId
      || pins.planSha256 !== target.planSha256 || pins.commitSha !== target.commitSha || pins.treeSha !== target.treeSha
      || pins.subjectKeySha256 !== target.subjectKeySha256 || receipt.digest !== report.coreReceiptDigest
      || receipt.status !== "completed" || receipt.processExitCode !== 0 || receipt.timedOut !== false
      || receipt.cancelled !== false || receipt.outputLimit !== false || receipt.appContainerVerified !== true
      || receipt.capabilitiesCount !== 0 || receipt.childTerminationConfirmed !== true || receipt.jobEmpty !== true
      || receipt.profileCleanupSucceeded !== true || receipt.sandboxCleanupSucceeded !== true || receipt.fixtureMustBeRetained !== false) {
      return unknown("protected-core-run-or-receipt-pins-do-not-match-passing-report");
    }
    const sessions = input.platform.agents.sessions as typeof input.platform.agents.sessions & {
      getRun?: (sessionId: string, workspaceId: string, runId: string) => Promise<unknown>;
    };
    if (typeof sessions.getRun !== "function") return unknown("qa-author-session-run-reader-unavailable");
    const authorRun = await sessions.getRun(target.qaWorker.sessionId, scope.workspaceId, report.author.runId);
    if (!authorRun || authorRun.runId !== target.qaRunId || authorRun.status !== "succeeded" || authorRun.cancellationRequested !== false) {
      return unknown("exact-qa-author-run-not-successfully-closed");
    }

    const assertCurrent = async () => {
      await authority.check();
      await target.assertCurrent();
      const head = await reports.current();
      if (!head || head.revision.revisionId !== report.revisionId) throw new Error("latest-qa-report-head-changed");
      const referenceHead = await references.current();
      if (!referenceHead || referenceHead.revision.revisionId !== report.reference.revisionId) {
        throw new Error("current-protected-qa-run-reference-changed");
      }
      const currentBoard = await authority.store.current();
      const currentImpl = currentBoard?.revision.packets.find(row => row.packet.taskId === scope.taskId);
      const currentQa = currentBoard?.revision.packets.find(row => row.packet.taskId === qa.packet.taskId);
      if (!currentImpl || !currentQa || taskPacketRecordDigest(currentImpl, scope.projectId, input.ctoId, scope.workstreamId)
        !== target.implementationDigest || taskPacketRecordDigest(currentQa, scope.projectId, input.ctoId, scope.workstreamId) !== target.qaDigest) {
        throw new Error("current-task-or-dependency-digest-changed");
      }
      const authorNow = await sessions.getRun!(target.qaWorker.sessionId, scope.workspaceId, report.author.runId);
      if (!authorNow || authorNow.runId !== target.qaRunId || authorNow.status !== "succeeded" || authorNow.cancellationRequested !== false) {
        throw new Error("exact-qa-author-run-is-no-longer-successfully-closed");
      }
      const coreNow = parseCoreRun(await coreApi.getRunV1!(scope.workspaceId, binding.runId, binding.subjectKeySha256));
      if (coreNow.id !== coreRun.id || coreNow.status !== "succeeded" || coreNow.termination !== "confirmed"
        || coreNow.receipt.digest !== report.coreReceiptDigest) throw new Error("protected-core-receipt-changed");
      await checkGitTip(input.platform, target);
      await target.assertCurrent();
      await authority.check();
    };
    await assertCurrent();
    return Object.freeze({ status: "available", value: Object.freeze({ implementationRecord: target.implementation,
      qaRecord: target.qa, report, coreRun }), check: assertCurrent });
  } catch (error) {
    const message = error instanceof Error ? error.message : "protected-task-qa-evidence-unavailable";
    return unknown(message.slice(0, 240));
  }
}
