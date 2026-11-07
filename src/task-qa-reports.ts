import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { exactToolRecord, parseLeadToolContext } from "./lead-tool-authority.ts";
import { createRevisionJournal, type RevisionState, type RevisionPublicationGuard } from "./solution-revision-store.ts";
import { createTaskQaRunReferenceStore, parseTaskQaReferenceScope, parseTaskQaRunReference, type TaskQaReferenceScope, type TaskQaRunReference } from "./task-qa-run-references.ts";
import { resolveProtectedTaskQaObservation } from "./task-protected-qa.ts";
import { taskQaCriteria } from "./task-qa-criteria.ts";
export { taskQaCriteria } from "./task-qa-criteria.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const sha = /^[a-f0-9]{64}$/u;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
type Check = Readonly<{ criterionId: string; text: string; verdict: "passed" | "failed" | "not-tested"; note: string }>;
export type TaskQaReport = Readonly<{ schemaVersion: 1; revisionId: string; reference: TaskQaRunReference;
  coreReceiptDigest: string; coreStatus: "succeeded" | "failed" | "cancelled";
  author: Readonly<{ agentId: string; sessionId: string; runId: string }>;
  checks: readonly Check[]; summary: string; verdict: "passed" | "failed" | "incomplete" }>;

function text(value: unknown, maximum = 4096): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new TypeError("Bounded QA report text is required.");
  }
  return value;
}

function verdict(checks: readonly Check[], coreStatus: TaskQaReport["coreStatus"]) {
  if (coreStatus !== "succeeded" || checks.some(check => check.verdict === "failed")) return "failed" as const;
  return checks.every(check => check.verdict === "passed") ? "passed" as const : "incomplete" as const;
}

export function parseTaskQaReport(value: unknown): TaskQaReport {
  const row = exactToolRecord(value, ["schemaVersion", "revisionId", "reference", "coreReceiptDigest", "coreStatus", "author", "checks", "summary", "verdict"]);
  const reference = parseTaskQaRunReference(row.reference);
  const author = exactToolRecord(row.author, ["agentId", "sessionId", "runId"]);
  if (row.schemaVersion !== 1 || typeof row.coreReceiptDigest !== "string" || !sha.test(row.coreReceiptDigest)
    || !["succeeded", "failed", "cancelled"].includes(String(row.coreStatus))
    || [author.agentId, author.sessionId, author.runId].some(item => typeof item !== "string" || !uuid.test(item))
    || author.agentId !== reference.binding.qaAgentId || author.sessionId !== reference.binding.qaSessionId
    || !Array.isArray(row.checks) || row.checks.length < 1 || row.checks.length > 128) throw new TypeError("Invalid Task QA report binding.");
  const checks = row.checks.map(raw => {
    const check = exactToolRecord(raw, ["criterionId", "text", "verdict", "note"]);
    if (!["passed", "failed", "not-tested"].includes(String(check.verdict))) throw new TypeError("Invalid QA criterion verdict.");
    return Object.freeze({ criterionId: text(check.criterionId, 100), text: text(check.text),
      verdict: check.verdict as Check["verdict"], note: text(check.note) });
  });
  if (new Set(checks.map(check => check.criterionId)).size !== checks.length) throw new TypeError("Duplicate QA criterion report.");
  const content = { schemaVersion: 1 as const, reference, coreReceiptDigest: row.coreReceiptDigest,
    coreStatus: row.coreStatus as TaskQaReport["coreStatus"], author: Object.freeze({ agentId: author.agentId as string,
      sessionId: author.sessionId as string, runId: author.runId as string }), checks: Object.freeze(checks),
    summary: text(row.summary, 8192), verdict: verdict(checks, row.coreStatus as TaskQaReport["coreStatus"]) };
  const revisionId = `task-qa-report-v1:${digest(content)}`;
  if (row.verdict !== content.verdict || row.revisionId !== revisionId) throw new TypeError("Task QA report digest/verdict mismatch.");
  return Object.freeze({ ...content, revisionId });
}

export function createTaskQaReportStore(scope: TaskQaReferenceScope, state: RevisionState) {
  const selected = parseTaskQaReferenceScope(scope);
  return createRevisionJournal(selected.workspaceId, digest(selected), state, { prefix: "task-qa-reports",
    revisionId: (value: TaskQaReport) => value.revisionId,
    parse(value: unknown) {
      const parsed = parseTaskQaReport(value);
      if (JSON.stringify(parsed.reference.scope) !== JSON.stringify(selected)) throw new Error("QA report belongs to another Task.");
      return parsed;
    } });
}

/** An authenticated independent QA author records a verdict, not CTO VERIFIED or integration. */
export async function publishTaskQaReport(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "ctoId", "workstreamId", "qaTaskId", "approvalId", "planSha256", "runId",
    "expectedBaseRevisionId", "checks", "summary"]);
  const context = parseLeadToolContext(runContext);
  const captured = new Map<string, RevisionPublicationGuard>();
  const state = platform.state as typeof platform.state & RevisionState;
  if (typeof state.guardedCompareAndSet !== "function") return { status: "unsupported" as const, reason: "guarded-qa-publication-unavailable" };
  const tracked: RevisionState = { ...state, async get(key: SpsStateKey) {
    const value = await state.get(key);
    if (key.scopeKind !== "company" || key.scopeId !== context.companyId) throw new Error("QA state read escaped its Workspace.");
    if (value !== null) {
      const identity = JSON.stringify([key.namespace ?? "default", key.stateKey]);
      const prior = captured.get(identity);
      if (prior && JSON.stringify(prior.expectedValue) !== JSON.stringify(value)) throw new Error("QA source state changed during review.");
      captured.set(identity, { stateKey: key.stateKey, ...(key.namespace === undefined ? {} : { namespace: key.namespace }), expectedValue: value });
    }
    return value;
  } };
  const observed = await resolveProtectedTaskQaObservation({ projectId: input.projectId, ctoId: input.ctoId,
    workstreamId: input.workstreamId, qaTaskId: input.qaTaskId, approvalId: input.approvalId,
    planSha256: input.planSha256, runId: input.runId }, runContext,
  { ...platform, state: tracked as typeof platform.state });
  if (observed.status !== "current" || !observed.target) return { status: "stale" as const, reason: observed.reason ?? "current-protected-qa-target-unavailable" };
  const target = observed.target;
  if (context.agentId !== target.qaWorker.agentId || context.sessionId !== target.qaWorker.sessionId || context.runId !== target.qaRunId) {
    throw new Error("Only the exact active independent QA Worker may publish this report.");
  }
  const scope = { workspaceId: target.workspaceId, projectId: target.projectId, ctoId: target.ctoId,
    workstreamId: target.workstreamId, qaTaskId: target.qa.packet.taskId };
  const referenced = await createTaskQaRunReferenceStore(scope, tracked).findRun(String(input.runId));
  if (referenced.status !== "found") return { status: "unknown" as const, reason: "exact-protected-run-reference-unavailable" };
  const referenceBinding = referenced.reference.binding;
  if (referenceBinding.qaDigest !== target.qaDigest || referenceBinding.implementationDigest !== target.implementationDigest
    || referenceBinding.qaAgentId !== target.qaWorker.agentId || referenceBinding.qaSessionId !== target.qaWorker.sessionId
    || referenceBinding.acceptanceId !== target.acceptanceId || referenceBinding.submissionId !== target.submissionId
    || referenceBinding.requestId !== target.requestId || referenceBinding.sourceId !== target.source.sourceId
    || referenceBinding.commitSha !== target.commitSha || referenceBinding.treeSha !== target.treeSha
    || referenceBinding.approvalId !== target.approvalId || referenceBinding.planSha256 !== target.planSha256) {
    throw new Error("The protected run reference is not the exact current independent QA target.");
  }
  const api = (platform as typeof platform & { protectedTests?: { getRunV1?: (companyId: string, runId: string, subjectHash: string) => Promise<unknown> } }).protectedTests;
  if (typeof api?.getRunV1 !== "function") return { status: "unsupported" as const, reason: "protected-run-reader-unavailable" };
  await target.assertCurrent();
  const raw = await api.getRunV1(target.workspaceId, String(input.runId), target.subjectKeySha256);
  const core = exactToolRecord(raw, ["schemaVersion", "kind", "id", "status", "termination", "pins", "receipt", "timestamps", "qaVerdict"]);
  const pins = exactToolRecord(core.pins, ["approvalId", "sourceId", "planSha256", "profileSha256", "commitSha", "treeSha",
    "manifestSha256", "inputTreeSha256", "nodeSha256", "subjectKeySha256", "timeoutMs"]);
  if (core.schemaVersion !== 1 || core.kind !== "protected-node-test-v1" || core.id !== input.runId
    || !["succeeded", "failed", "cancelled"].includes(String(core.status)) || core.termination !== "confirmed"
    || pins.sourceId !== target.source.sourceId || pins.commitSha !== target.commitSha || pins.treeSha !== target.treeSha
    || pins.approvalId !== target.approvalId || pins.planSha256 !== target.planSha256 || pins.subjectKeySha256 !== target.subjectKeySha256) {
    throw new Error("An exact completed protected Core run is required for a QA report.");
  }
  const receipt = exactToolRecord(core.receipt, ["digest", "status", "stdoutSha256", "stderrSha256", "stdoutBytes", "stderrBytes",
    "processExitCode", "timedOut", "cancelled", "outputLimit", "appContainerVerified", "capabilitiesCount",
    "childTerminationConfirmed", "jobEmpty", "profileCleanupSucceeded", "sandboxCleanupSucceeded", "fixtureMustBeRetained"]);
  if (typeof receipt.digest !== "string" || !sha.test(receipt.digest) || receipt.appContainerVerified !== true
    || receipt.capabilitiesCount !== 0 || receipt.childTerminationConfirmed !== true || receipt.jobEmpty !== true
    || receipt.profileCleanupSucceeded !== true || receipt.sandboxCleanupSucceeded !== true || receipt.fixtureMustBeRetained !== false
    || core.status === "succeeded" && (receipt.status !== "completed" || receipt.processExitCode !== 0
      || receipt.timedOut !== false || receipt.cancelled !== false || receipt.outputLimit !== false)) throw new Error("Protected Core completion proof is incomplete.");
  const criteria = taskQaCriteria(target.qa.packet.acceptance, target.qa.packet.testPlan?.passCriteria ?? [], target.implementation.packet.acceptance);
  if (!Array.isArray(input.checks) || input.checks.length !== criteria.length) throw new TypeError("Every current QA acceptance and test-plan criterion must be assessed.");
  const checks = criteria.map(criterion => {
    const matches = (input.checks as unknown[]).map(value => exactToolRecord(value, ["criterionId", "verdict", "note"]))
      .filter(value => value.criterionId === criterion.criterionId);
    if (matches.length !== 1 || !["passed", "failed", "not-tested"].includes(String(matches[0]!.verdict))) throw new TypeError("Missing, repeated or invalid QA criterion assessment.");
    return { ...criterion, verdict: matches[0]!.verdict as Check["verdict"], note: text(matches[0]!.note) };
  });
  const content = { schemaVersion: 1 as const, reference: referenced.reference, coreReceiptDigest: receipt.digest,
    coreStatus: core.status as TaskQaReport["coreStatus"], author: { agentId: context.agentId, sessionId: context.sessionId, runId: context.runId },
    checks, summary: text(input.summary, 8192), verdict: verdict(checks, core.status as TaskQaReport["coreStatus"]) };
  const next = parseTaskQaReport({ ...content, revisionId: `task-qa-report-v1:${digest(content)}` });
  await target.assertCurrent();
  // Immutable entries are already digest-checked by their journals. Guard the
  // current heads and mutable role/acceptance bindings, not duplicate bodies.
  const guards = [...captured.values()].filter(guard => !guard.stateKey.includes("-revision.v1."));
  if (guards.length < 1 || guards.length > 64 || Buffer.byteLength(JSON.stringify(guards), "utf8") > 200_000) {
    return { status: "unsupported" as const, reason: "qa-source-guard-inventory-out-of-bound" };
  }
  const store = createTaskQaReportStore(scope, state);
  const existing = await store.publishedRevision(next.revisionId);
  if (existing) return { status: "existing" as const, report: existing.revision };
  if (input.expectedBaseRevisionId !== null) text(input.expectedBaseRevisionId, 160);
  let result: Awaited<ReturnType<typeof store.publishGuarded>>;
  try { result = await store.publishGuarded({ expectedBaseRevisionId: input.expectedBaseRevisionId, revision: next }, guards); }
  catch {
    // A lost reply is not permission to publish a new verdict or repeat a test.
    return { status: "unknown" as const, reportRevisionId: next.revisionId,
      reason: "qa-report-publication-outcome-unknown", workstreamVerification: "not-established" as const };
  }
  try { await target.assertCurrent(); }
  catch { return { status: "stale" as const, reportRevisionId: next.revisionId,
    reason: "qa-authority-changed-after-publication", workstreamVerification: "not-established" as const }; }
  return { status: result.status, ...(result.status === "published" ? { report: result.revision } : {}),
    workstreamVerification: "not-established" as const };
}
