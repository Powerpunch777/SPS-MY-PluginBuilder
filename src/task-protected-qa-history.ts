import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { taskPacketRecordDigest, type TaskPacketRecord } from "./domain/task-packets.ts";
import { exactToolRecord } from "./lead-tool-authority.ts";
import { resolveCtoTaskAuthority } from "./task-packet-tools.ts";
import { createTaskQaRunReferenceStore, type TaskQaRunReference } from "./task-qa-run-references.ts";
import { createTaskQaReportStore } from "./task-qa-reports.ts";

const TOOL = "builder.read-protected-task-qa-history";
const hash = /^[a-f0-9]{64}$/u;
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
type HistoryPlatform = SpsPlatformInvocationContext & Readonly<{
  protectedTests?: { getRunV1?: (companyId: string, runId: string, subjectKeySha256: string) => Promise<unknown> };
  localFolders?: { readWorkspaceSourceGitTipV1?: (sourceId: string, folderKey: string, branch: string) => Promise<unknown> };
}>;

function boundedId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("A bounded Task QA history scope is required.");
  }
  return value;
}

function packetPinsCurrent(reference: TaskQaRunReference, packets: readonly TaskPacketRecord[]) {
  const { scope, binding } = reference;
  const qa = packets.find(row => row.packet.taskId === scope.qaTaskId);
  const implementation = packets.find(row => row.packet.taskId === binding.implementationTaskId);
  if (!qa || !implementation || qa.packet.kind !== "qa" || implementation.packet.kind !== "development"
    || qa.packet.revision !== binding.qaRevision || implementation.packet.revision !== binding.implementationRevision
    || taskPacketRecordDigest(qa, scope.projectId, scope.ctoId, scope.workstreamId) !== binding.qaDigest
    || taskPacketRecordDigest(implementation, scope.projectId, scope.ctoId, scope.workstreamId) !== binding.implementationDigest) return false;
  if (!qa.dependencyPins.some(pin => pin.taskId === implementation.packet.taskId && pin.revision === binding.implementationRevision
    && pin.recordSha256 === binding.implementationDigest)) return false;
  return [qa, implementation].every(record => record.dependencyPins.every(pin => {
    const current = packets.find(row => row.packet.taskId === pin.taskId);
    return current?.packet.revision === pin.revision
      && taskPacketRecordDigest(current, scope.projectId, scope.ctoId, scope.workstreamId) === pin.recordSha256;
  }));
}

function projectRun(value: unknown, reference: TaskQaRunReference) {
  const row = exactToolRecord(value, ["schemaVersion", "kind", "id", "status", "termination", "pins", "receipt", "timestamps", "qaVerdict"]);
  const pins = exactToolRecord(row.pins, ["approvalId", "sourceId", "planSha256", "profileSha256", "commitSha", "treeSha",
    "manifestSha256", "inputTreeSha256", "nodeSha256", "subjectKeySha256", "timeoutMs"]);
  const { binding } = reference;
  if (row.schemaVersion !== 1 || row.kind !== "protected-node-test-v1" || row.id !== binding.runId
    || row.qaVerdict !== "not-established" || !["queued", "claimed", "running", "cancelling", "succeeded", "failed", "cancelled"].includes(String(row.status))
    || !["not_applicable", "pending", "confirmed"].includes(String(row.termination))
    || pins.sourceId !== binding.sourceId || pins.commitSha !== binding.commitSha || pins.treeSha !== binding.treeSha
    || pins.approvalId !== binding.approvalId || pins.planSha256 !== binding.planSha256
    || pins.subjectKeySha256 !== binding.subjectKeySha256) throw new Error("Protected Core receipt does not match its historical Task reference.");
  let receiptDigest: string | null = null;
  let processExitCode: number | null = null;
  if (row.receipt !== null) {
    const receipt = exactToolRecord(row.receipt, ["digest", "status", "stdoutSha256", "stderrSha256", "stdoutBytes", "stderrBytes",
      "processExitCode", "timedOut", "cancelled", "outputLimit", "appContainerVerified", "capabilitiesCount",
      "childTerminationConfirmed", "jobEmpty", "profileCleanupSucceeded", "sandboxCleanupSucceeded", "fixtureMustBeRetained"]);
    if (typeof receipt.digest !== "string" || !hash.test(receipt.digest)
      || row.status === "succeeded" && (receipt.status !== "completed" || receipt.processExitCode !== 0
        || receipt.timedOut !== false || receipt.cancelled !== false || receipt.outputLimit !== false
        || receipt.appContainerVerified !== true || receipt.childTerminationConfirmed !== true || receipt.jobEmpty !== true
        || receipt.capabilitiesCount !== 0
        || receipt.profileCleanupSucceeded !== true || receipt.sandboxCleanupSucceeded !== true || receipt.fixtureMustBeRetained !== false
        || row.termination !== "confirmed")) throw new Error("Protected Core completion receipt is incomplete.");
    receiptDigest = receipt.digest;
    processExitCode = typeof receipt.processExitCode === "number" ? receipt.processExitCode : null;
  } else if (row.status === "succeeded") throw new Error("Succeeded Core run lacks a completion receipt.");
  return { status: "available" as const, technicalStatus: row.status as string, termination: row.termination as string,
    receiptDigest, processExitCode, qaVerdict: "not-established" as const };
}

/** Historical technical observations never authorize another run or establish independent QA. */
export async function readProtectedTaskQaHistory(params: unknown, runContext: unknown, platformInput: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "ctoId", "workstreamId", "qaTaskId"], ["cursor"]);
  const projectId = boundedId(input.projectId), ctoId = boundedId(input.ctoId), workstreamId = boundedId(input.workstreamId), qaTaskId = boundedId(input.qaTaskId);
  if (input.cursor !== undefined && input.cursor !== null && (typeof input.cursor !== "string" || !input.cursor || input.cursor.length > 8192)) {
    throw new TypeError("Invalid QA history cursor.");
  }
  const platform = platformInput as HistoryPlatform;
  const authority = await resolveCtoTaskAuthority(projectId, ctoId, workstreamId, runContext, platform, TOOL);
  const scope = { workspaceId: authority.context.companyId, projectId, ctoId, workstreamId, qaTaskId };
  const store = createTaskQaRunReferenceStore(scope, authority.state);
  const page = await store.publishedPage(input.cursor as string | null | undefined ?? null, 10);
  const reportHistory = await createTaskQaReportStore(scope, authority.state).recent(50);
  const board = await authority.store.current();
  const packets = board?.revision.packets ?? [];
  const entries = [];
  for (const { sequence, revision: reference } of page.revisions) {
    await authority.check();
    const binding = reference.binding;
    let core: ReturnType<typeof projectRun> | Readonly<{ status: "unavailable"; reason: string }>;
    const get = platform.protectedTests?.getRunV1;
    if (typeof get !== "function") core = { status: "unavailable", reason: "protected-run-reader-unsupported" };
    else {
      try {
        const raw = await get.call(platform.protectedTests, scope.workspaceId, binding.runId, binding.subjectKeySha256);
        core = raw === null ? { status: "unavailable", reason: "protected-run-not-found" } : projectRun(raw, reference);
      } catch { core = { status: "unavailable", reason: "protected-run-read-denied-or-invalid" }; }
    }
    let freshness: "current" | "stale" | "unknown" = packetPinsCurrent(reference, packets) ? "unknown" : "stale";
    if (freshness !== "stale" && typeof platform.localFolders?.readWorkspaceSourceGitTipV1 === "function") {
      try {
        const tip = exactToolRecord(await platform.localFolders.readWorkspaceSourceGitTipV1(binding.sourceId, binding.folderKey, binding.branch),
          ["status"], ["sourceId", "folderKey", "branch", "commitSha", "treeSha", "observedAt", "reason"]);
        if (tip.status === "current" && tip.sourceId === binding.sourceId && tip.folderKey === binding.folderKey && tip.branch === binding.branch
          && typeof tip.commitSha === "string" && oid.test(tip.commitSha) && typeof tip.treeSha === "string" && oid.test(tip.treeSha)
          && typeof tip.observedAt === "string" && Number.isFinite(Date.parse(tip.observedAt))) {
          freshness = tip.commitSha === binding.commitSha && tip.treeSha === binding.treeSha ? "current" : "stale";
        }
      } catch { /* Historical Core data remains readable when current Git authority is unavailable. */ }
    }
    await authority.check();
    const latest = await authority.store.current();
    if (!packetPinsCurrent(reference, latest?.revision.packets ?? [])) freshness = "stale";
    const qaReports = [];
    for (const { revision: report } of reportHistory.revisions.filter(item => item.revision.reference.revisionId === reference.revisionId)) {
      let authorRun: "succeeded" | "running" | "not-succeeded" | "unknown" = "unknown";
      try {
        const run = await platform.agents.sessions.getRun(report.author.sessionId, scope.workspaceId, report.author.runId);
        if (run.runId === report.author.runId && run.cancellationRequested === false) {
          authorRun = run.status === "succeeded" ? "succeeded" : run.status === "running" ? "running" : "not-succeeded";
        }
      } catch { /* A stored report remains history, not evidence of a successful author run. */ }
      await authority.check();
      qaReports.push(Object.freeze({ revisionId: report.revisionId, authoredVerdict: report.verdict,
        coreReceiptMatches: core.status === "available" ? core.receiptDigest === report.coreReceiptDigest : "unknown",
        authorRun, checkedCriteria: report.checks.length,
        failedCriteria: report.checks.filter(check => check.verdict === "failed").length,
        untestedCriteria: report.checks.filter(check => check.verdict === "not-tested").length }));
    }
    entries.push(Object.freeze({ sequence, reference, freshness, core, qaReports: Object.freeze(qaReports),
      qaVerdict: "not-established" as const }));
  }
  await authority.check();
  return Object.freeze({ status: "read" as const, scope: Object.freeze(scope), entries: Object.freeze(entries),
    nextCursor: page.nextCursor, qaReportHistoryTruncated: reportHistory.hasMore,
    freshnessScope: "task-packets-and-source-only" as const,
    executionStarted: false, qaVerdict: "not-established" as const });
}
