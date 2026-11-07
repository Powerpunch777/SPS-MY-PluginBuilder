import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { exactToolRecord, parseLeadToolContext } from "../lead-tool-authority.ts";
import { createRevisionJournal, type RevisionState, type RevisionPublicationGuard } from "../solution-revision-store.ts";
import { createTaskPacketStore } from "../task-packet-tools.ts";
import { taskPacketRecordDigest } from "../domain/task-packets.ts";
import { createTaskQaReportStore } from "../task-qa-reports.ts";
import { readWorkstreams } from "../workstream-tools.ts";
import { readCurrentIntegrationPlan, checkIntegrationPrerequisites } from "./integration-plan.ts";
import { readVerifiedWorkstreamForManager } from "./integration-manager-job.ts";
import type { VerifiedWorkstreamSnapshot } from "./workstream-verification-consumer.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const textHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const bounded = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError("A bounded integration scope is required.");
  return value;
};
export type IntegrationAttemptScope = Readonly<{ workspaceId: string; workstreamId: string; eventId: string; taskId: string }>;
type Scope = IntegrationAttemptScope;
export type IntegrationValidationReference = Readonly<{ requestId: string; subjectKey: string; subjectKeySha256: string;
  approvalTemplateId: string; planSha256: string; commitSha: string; treeSha: string; runId: string | null; approvalId: string | null }>;
export type IntegrationValidationReferences = Readonly<{ ci: IntegrationValidationReference | null; e2e: IntegrationValidationReference | null;
  regression?: IntegrationValidationReference | null }>;

function validationReference(value: unknown): IntegrationValidationReference | null {
  if (value === null) return null;
  const row = exactToolRecord(value, ["requestId", "subjectKey", "subjectKeySha256", "approvalTemplateId", "planSha256", "commitSha", "treeSha", "runId", "approvalId"]);
  if ([row.requestId, row.subjectKey].some(item => typeof item !== "string" || !/^[A-Za-z0-9._:-]{8,160}$/u.test(item))
    || [row.subjectKeySha256, row.planSha256].some(item => typeof item !== "string" || !/^[a-f0-9]{64}$/u.test(item))
    || typeof row.approvalTemplateId !== "string" || !UUID.test(row.approvalTemplateId)
    || [row.commitSha, row.treeSha].some(item => typeof item !== "string" || !OID.test(item))
    || (row.runId === null) !== (row.approvalId === null)
    || [row.runId, row.approvalId].some(item => item !== null && (typeof item !== "string" || !UUID.test(item)))
    || row.subjectKeySha256 !== textHash(row.subjectKey as string)) throw new TypeError("Invalid integration validation reference.");
  return Object.freeze(row as unknown as IntegrationValidationReference);
}
type EffectInput = Readonly<{ sourceId: string; folderKey: string; branch: string; expectedHead: string;
  incomingCommit: string; incomingTree: string; initializeIfMissing?: true }>;
type GitResult = Readonly<{ status: "integrated" | "replayed"; commitSha: string; treeSha: string; changedPaths: readonly string[] }>
  | Readonly<{ status: "unchanged"; headSha: string }>
  | Readonly<{ status: "conflict"; reason: "branch_changed" | "head_changed" | "merge_conflict"; actualHead: string | null }>;
export type IntegrationAttempt = Readonly<{ schemaVersion: 1; revisionId: string; scope: Scope; planRevisionId: string;
  reportRevisionId: string; stage: "reserved" | "git-observed"; effect: EffectInput; git: GitResult | null;
  validation: "not-executed"; validationRuns?: IntegrationValidationReferences;
  author: Readonly<{ agentId: string; sessionId: string; runId: string }> }>;

function parseAttempt(value: unknown): IntegrationAttempt {
  const row = exactToolRecord(value, ["schemaVersion", "revisionId", "scope", "planRevisionId", "reportRevisionId", "stage", "effect", "git", "validation", "author"], ["validationRuns"]);
  const scope = exactToolRecord(row.scope, ["workspaceId", "workstreamId", "eventId", "taskId"]);
  const effect = exactToolRecord(row.effect, ["sourceId", "folderKey", "branch", "expectedHead", "incomingCommit", "incomingTree"], ["initializeIfMissing"]);
  const author = exactToolRecord(row.author, ["agentId", "sessionId", "runId"]);
  if (row.schemaVersion !== 1 || row.validation !== "not-executed" || !["reserved", "git-observed"].includes(String(row.stage))
    || [scope.workspaceId, effect.sourceId, author.agentId, author.sessionId, author.runId].some(item => typeof item !== "string" || !UUID.test(item))
    || Object.values(scope).some(item => bounded(item) !== item)
    || [effect.expectedHead, effect.incomingCommit, effect.incomingTree].some(item => typeof item !== "string" || !OID.test(item))
    || Object.hasOwn(effect, "initializeIfMissing") && effect.initializeIfMissing !== true
    || (row.stage === "reserved") !== (row.git === null)) throw new TypeError("Invalid integration attempt.");
  let git: GitResult | null = null;
  if (row.git !== null) {
    const raw = row.git as Record<string, unknown>;
    if (raw.status === "integrated" || raw.status === "replayed") {
      const observed = exactToolRecord(raw, ["status", "commitSha", "treeSha", "changedPaths"]);
      if ([observed.commitSha, observed.treeSha].some(item => typeof item !== "string" || !OID.test(item))
        || !Array.isArray(observed.changedPaths) || observed.changedPaths.length > 64 || new Set(observed.changedPaths).size !== observed.changedPaths.length
        || observed.changedPaths.some(item => typeof item !== "string" || !item || item.startsWith("/") || item.includes("\\") || item.split("/").includes(".."))) throw new TypeError("Invalid Git effect receipt.");
      git = observed as unknown as GitResult;
    } else if (raw.status === "unchanged") {
      const observed = exactToolRecord(raw, ["status", "headSha"]);
      if (typeof observed.headSha !== "string" || !OID.test(observed.headSha)) throw new TypeError("Invalid unchanged Git receipt.");
      git = observed as unknown as GitResult;
    } else {
      const observed = exactToolRecord(raw, ["status", "reason", "actualHead"]);
      if (observed.status !== "conflict" || !["branch_changed", "head_changed", "merge_conflict"].includes(String(observed.reason))
        || observed.actualHead !== null && (typeof observed.actualHead !== "string" || !OID.test(observed.actualHead))) throw new TypeError("Invalid Git conflict receipt.");
      git = observed as unknown as GitResult;
    }
  }
  const refs = Object.hasOwn(row, "validationRuns") ? exactToolRecord(row.validationRuns, ["ci", "e2e"], ["regression"]) : null;
  if (refs && (row.stage !== "git-observed" || git?.status === "conflict")) throw new TypeError("Only observed non-conflicting Git effects can have validation references.");
  const content = { schemaVersion: 1 as const, scope: scope as unknown as Scope, planRevisionId: bounded(row.planRevisionId),
    reportRevisionId: bounded(row.reportRevisionId), stage: row.stage as IntegrationAttempt["stage"], effect: effect as unknown as EffectInput,
    git, validation: "not-executed" as const,
    ...(refs ? { validationRuns: Object.freeze({ ci: validationReference(refs.ci), e2e: validationReference(refs.e2e),
      ...(Object.hasOwn(refs, "regression") ? { regression: validationReference(refs.regression) } : {}) }) } : {}),
    author: author as unknown as IntegrationAttempt["author"] };
  const revisionId = `integration-attempt-v1:${hash(content)}`;
  if (row.revisionId !== revisionId) throw new TypeError("Integration attempt digest mismatch.");
  return Object.freeze({ ...content, revisionId });
}

function attemptScope(scope: Scope) {
  return { workspaceId: scope.workspaceId, workstreamId: scope.workstreamId, eventId: scope.eventId, taskId: scope.taskId };
}
export function createIntegrationAttemptStore(scope: Scope, state: RevisionState) {
  const selected = attemptScope(scope);
  return createRevisionJournal(scope.workspaceId, hash(selected), state, { prefix: "integration-attempts",
    parse(value: unknown) { const parsed = parseAttempt(value); if (JSON.stringify(parsed.scope) !== JSON.stringify(selected)) throw new Error("Foreign integration attempt."); return parsed; },
    revisionId: value => value.revisionId });
}
const stored = (content: Omit<IntegrationAttempt, "revisionId">) => parseAttempt({ ...content, revisionId: `integration-attempt-v1:${hash(content)}` });

function retryableHead(attempt: IntegrationAttempt, sequence: number): string | null {
  const git = attempt.git;
  // Initial reservation/result are revisions 1/2. A new target gets at most one
  // reservation/result pair; uncertain outcomes still reconcile their own pins.
  return sequence === 2 && git?.status === "conflict" && git.reason === "head_changed"
    && git.actualHead !== attempt.effect.expectedHead ? git.actualHead : null;
}

export function withIntegrationValidationReferences(attempt: IntegrationAttempt, validationRuns: IntegrationValidationReferences) {
  return stored({ schemaVersion: attempt.schemaVersion, scope: attempt.scope, planRevisionId: attempt.planRevisionId,
    reportRevisionId: attempt.reportRevisionId, stage: attempt.stage, effect: attempt.effect, git: attempt.git,
    validation: attempt.validation, validationRuns: { ci: validationRuns.ci, e2e: validationRuns.e2e,
      ...(Object.hasOwn(validationRuns, "regression") ? { regression: validationRuns.regression } : {}) }, author: attempt.author });
}

async function managerEvent(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const result = await readVerifiedWorkstreamForManager(params, runContext, platform);
  return (result.data as unknown as { evidence: VerifiedWorkstreamSnapshot }).evidence;
}

/** A model supplies IDs only. All Git object pins and effects originate in the
 * current verification and existing journals; no unrestricted command runs. */
export async function integrateVerifiedTask(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const row = exactToolRecord(params, ["workstreamId", "eventId", "taskId"]);
  const context = parseLeadToolContext(runContext), workstreamId = bounded(row.workstreamId), eventId = bounded(row.eventId), taskId = bounded(row.taskId);
  const state = platform.state as typeof platform.state & RevisionState;
  if (typeof state.guardedCompareAndSet !== "function") return { status: "unsupported", reason: "integration-atomic-reservation-unavailable" };
  const captured = new Map<string, RevisionPublicationGuard>();
  const tracked: RevisionState = { ...state, async get(key: SpsStateKey) {
    if (key.scopeKind !== "company" || key.scopeId !== context.companyId) throw new Error("Integration read escaped its Workspace.");
    const value = await state.get(key);
    if (value !== null) {
      const identity = JSON.stringify([key.namespace ?? "default", key.stateKey]), prior = captured.get(identity);
      if (prior && JSON.stringify(prior.expectedValue) !== JSON.stringify(value)) throw new Error("Integration authority changed during read.");
      captured.set(identity, { stateKey: key.stateKey, ...(key.namespace === undefined ? {} : { namespace: key.namespace }), expectedValue: value });
    }
    return value;
  } };
  const currentPlatform = { ...platform, state: tracked as typeof platform.state };
  const snapshot = await managerEvent({ workstreamId, eventId }, runContext, currentPlatform);
  const prerequisite = await checkIntegrationPrerequisites(context.companyId, workstreamId, currentPlatform);
  if (prerequisite.status !== "ready") return prerequisite;
  const plan = await readCurrentIntegrationPlan(context.companyId, currentPlatform);
  if (!plan) return { status: "unknown", reason: "integration-plan-unavailable" };
  const workstream = (await readWorkstreams(context.companyId, context.companyId, currentPlatform))?.revision.workstreams.find(item => item.spec.id === workstreamId);
  if (!workstream) throw new Error("Current integration Workstream is unavailable.");
  const board = await createTaskPacketStore(context.companyId, context.companyId, workstream.spec.assignedCtoId, workstreamId, tracked).current();
  const task = board?.revision.packets.find(item => item.packet.taskId === taskId && item.packet.kind === "development");
  if (!task || !task.packet.sourceAccess || task.packet.sourceAccess.sourceId !== plan.revision.sourceId
    || task.packet.sourceAccess.folderKey !== plan.revision.folderKey || task.packet.sourceAccess.branch === plan.revision.candidateBranch) {
    throw new Error("The current development Task source must match the approved isolated candidate.");
  }
  const digest = taskPacketRecordDigest(task, context.companyId, workstream.spec.assignedCtoId, workstreamId);
  if (!snapshot.sourcePins.some(pin => pin.sourceId === `builder-v1:task-packet:${taskId}` && pin.sha256 === digest)) throw new Error("Task is not in the exact admitted verification event.");
  const qaTasks = board!.revision.packets.filter(item => item.packet.kind === "qa" && item.dependencyPins.some(pin => pin.taskId === taskId
    && pin.revision === task.packet.revision && pin.recordSha256 === digest));
  if (qaTasks.length !== 1) throw new Error("The verified Task must have one exact independent QA record.");
  const reports = createTaskQaReportStore({ workspaceId: context.companyId, projectId: context.companyId,
    ctoId: workstream.spec.assignedCtoId, workstreamId, qaTaskId: qaTasks[0]!.packet.taskId }, tracked);
  const report = await reports.current();
  if (!report || report.revision.verdict !== "passed" || !snapshot.sourcePins.some(pin =>
    pin.sourceId === `builder-v1:task-qa-report:${qaTasks[0]!.packet.taskId}` && pin.revisionId === report.revision.revisionId
    && pin.sha256 === hash(report.revision))) throw new Error("The exact current independent QA report is unavailable.");
  const binding = report.revision.reference.binding;
  if (binding.implementationTaskId !== taskId || binding.implementationDigest !== digest || binding.sourceId !== plan.revision.sourceId
    || binding.folderKey !== plan.revision.folderKey) throw new Error("Incoming object pins do not match the verified Task and plan.");
  const scope = { workspaceId: context.companyId, workstreamId, eventId, taskId };
  const store = createIntegrationAttemptStore(scope, state), prior = await store.current();
  let attempt = prior?.revision;
  if (attempt && (attempt.planRevisionId !== plan.revision.revisionId || attempt.reportRevisionId !== report.revision.revisionId)) {
    return { status: "stale", reason: "integration-reservation-source-or-plan-changed" };
  }
  const retryHead = prior ? retryableHead(prior.revision, prior.sequence) : null;
  if (prior?.revision.stage === "git-observed" && retryHead === null) return { status: "existing", attempt: prior.revision,
    integrationStatus: prior.revision.git?.status === "conflict" ? "INTEGRATION_HOLD" : "INTEGRATING",
    reason: "git-result-preserved-required-ci-and-e2e-not-executed" };
  const api = (platform as typeof platform & { localFolders?: {
    readWorkspaceSourceGitTipV1?: (source: string, folder: string, branch: string) => Promise<unknown>;
    integrateWorkspaceSourceCommitV1?: (input: unknown) => Promise<unknown>;
  } }).localFolders;
  if (typeof api?.readWorkspaceSourceGitTipV1 !== "function" || typeof api.integrateWorkspaceSourceCommitV1 !== "function") {
    return { status: "unsupported", reason: "guarded-git-integration-api-unavailable" };
  }
  const base = exactToolRecord(await api.readWorkspaceSourceGitTipV1(plan.revision.sourceId, plan.revision.folderKey, plan.revision.baseBranch),
    ["status"], ["sourceId", "folderKey", "branch", "commitSha", "treeSha", "observedAt", "reason"]);
  if (base.status !== "current" || base.sourceId !== plan.revision.sourceId || base.folderKey !== plan.revision.folderKey
    || base.branch !== plan.revision.baseBranch || base.commitSha !== plan.revision.baseCommit || base.treeSha !== plan.revision.baseTree) {
    return { status: "stale", reason: "approved-integration-base-branch-changed" };
  }
  if (!attempt || retryHead !== null) {
    const tip = exactToolRecord(await api.readWorkspaceSourceGitTipV1(plan.revision.sourceId, plan.revision.folderKey, plan.revision.candidateBranch),
      ["status"], ["sourceId", "folderKey", "branch", "commitSha", "treeSha", "observedAt", "reason"]);
    // Only an authoritative missing-ref result permits create-only CAS.
    const missing = tip.status === "denied" && tip.reason === "branch_unavailable";
    if (!missing && (tip.status !== "current" || tip.sourceId !== plan.revision.sourceId || tip.folderKey !== plan.revision.folderKey
      || tip.branch !== plan.revision.candidateBranch || typeof tip.commitSha !== "string" || !OID.test(tip.commitSha))) {
      return { status: "unknown", reason: "integration-candidate-tip-not-authoritative" };
    }
    if (retryHead !== null && (missing || tip.commitSha !== retryHead)) {
      return { status: "stale", reason: "integration-candidate-changed-after-confirmed-head-race" };
    }
    attempt = stored({ schemaVersion: 1, scope, planRevisionId: plan.revision.revisionId, reportRevisionId: report.revision.revisionId,
      stage: "reserved", effect: { sourceId: plan.revision.sourceId, folderKey: plan.revision.folderKey,
        branch: plan.revision.candidateBranch, expectedHead: missing ? plan.revision.baseCommit : tip.commitSha as string,
        incomingCommit: binding.commitSha, incomingTree: binding.treeSha, ...(missing ? { initializeIfMissing: true as const } : {}) },
      git: null, validation: "not-executed", author: { agentId: context.agentId, sessionId: context.sessionId, runId: context.runId } });
    const guards = [...captured.values()].filter(guard => !guard.stateKey.includes("-revision.v1."));
    if (guards.length > 64) return { status: "unsupported", reason: "integration-authority-guard-bound" };
    const reserved = await store.publishGuarded({ expectedBaseRevisionId: prior?.revision.revisionId ?? null, revision: attempt }, guards);
    if (reserved.status !== "published") return { status: "conflict", reason: "integration-reservation-cas-conflict" };
  }
  await managerEvent({ workstreamId, eventId }, runContext, currentPlatform);
  const selected = attempt;
  const journalKey = textHash(hash(attemptScope(scope)));
  const reservationKey = { scopeKind: "company" as const, scopeId: context.companyId, namespace: "sonpark.my-builder",
    stateKey: `integration-attempts-head.v1.${journalKey}` };
  const head = await state.get(reservationKey);
  if (!head || (head as { revisionId?: unknown }).revisionId !== selected.revisionId) return { status: "conflict", reason: "integration-reservation-not-current" };
  const reportEntries = [...captured.values()].filter(guard => guard.stateKey.includes("task-qa-reports-revision.v1.")
    && (guard.expectedValue as { revision?: { revisionId?: unknown } })?.revision?.revisionId === report.revision.revisionId);
  if (reportEntries.length !== 1) return { status: "unknown", reason: "integration-persisted-source-proof-unavailable" };
  const guards = [...captured.values()].filter(guard => !guard.stateKey.includes("-revision.v1."));
  guards.push(reportEntries[0]!);
  if (guards.length > 64 || Buffer.byteLength(JSON.stringify(guards), "utf8") > 200_000) return { status: "unsupported", reason: "integration-effect-guard-bound" };
  let raw: unknown;
  try { raw = await api.integrateWorkspaceSourceCommitV1({ ...selected.effect,
    reservation: { namespace: reservationKey.namespace, stateKey: reservationKey.stateKey, expectedValue: head }, guards,
    incomingProof: { guardIndex: guards.length - 1, sourceIdPath: ["revision", "reference", "binding", "sourceId"],
      commitShaPath: ["revision", "reference", "binding", "commitSha"], treeShaPath: ["revision", "reference", "binding", "treeSha"] } }); }
  catch { return { status: "uncertain", reason: "git-effect-outcome-unknown-reconcile-same-reservation", attemptRevisionId: selected.revisionId }; }
  const result = exactToolRecord(raw, ["status"], ["git", "reason"]);
  if (result.status !== "observed") return { status: result.status, reason: result.reason };
  const completed = stored({ schemaVersion: 1, scope: selected.scope, planRevisionId: selected.planRevisionId,
    reportRevisionId: selected.reportRevisionId, stage: "git-observed", effect: selected.effect, git: result.git as GitResult,
    validation: "not-executed", author: selected.author });
  const saved = await store.publish({ expectedBaseRevisionId: selected.revisionId, revision: completed });
  if (saved.status === "published" && retryableHead(completed, saved.sequence) !== null) {
    return integrateVerifiedTask(params, runContext, platform);
  }
  return { status: saved.status, attempt: completed, integrationStatus: completed.git?.status === "conflict" ? "INTEGRATION_HOLD" : "INTEGRATING",
    reason: "git-observed-required-ci-and-e2e-not-executed" };
}

export async function readIntegrationProgress(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const row = exactToolRecord(params, ["workstreamId", "eventId"], ["projection"]), context = parseLeadToolContext(runContext);
  const workstreamId = bounded(row.workstreamId), eventId = bounded(row.eventId);
  if (row.projection !== undefined && row.projection !== "candidate") throw new TypeError("Unsupported integration progress projection.");
  const snapshot = await managerEvent({ workstreamId, eventId }, runContext, platform);
  if (row.projection === "candidate") {
    const result = await (await import("../delivery-evidence/integration-candidate.ts")).readIntegrationCandidate(context.companyId, platform);
    await managerEvent({ workstreamId, eventId }, runContext, platform);
    if (result.status !== "observed") return result;
    const unmapped = result.scopeTrace.unmappedRequirementIds;
    return { status: result.status, candidate: result.candidate, planRevisionId: result.plan.revisionId,
      boardRevisionId: result.boardRevisionId, workstreamCount: result.snapshots.length, taskCount: result.attempts.length,
      approvedScope: { specificationRevisionId: result.scopeTrace.specificationRevisionId,
        requirementCount: result.scopeTrace.requirements.length, unmappedRequirementCount: unmapped.length,
        unmappedRequirementIds: unmapped.slice(0, 32) },
      ciRunId: result.ci.runId, e2eRunId: result.e2e.runId,
      ...(result.regression ? { regressionRunId: result.regression.runId } : {}), deliveryAuthority: result.deliveryAuthority };
  }
  const taskPins = snapshot.sourcePins.filter(pin => pin.sourceId.startsWith("builder-v1:task-packet:"));
  const attempts = [];
  for (const pin of taskPins) {
    const taskId = pin.sourceId.slice("builder-v1:task-packet:".length);
    const current = await createIntegrationAttemptStore({ workspaceId: context.companyId, workstreamId, eventId, taskId }, platform.state).current();
    if (current) attempts.push(current.revision);
  }
  await managerEvent({ workstreamId, eventId }, runContext, platform);
  const technicalValidation = await (await import("./integration-validation.ts")).readIntegrationValidationRuns(attempts, platform);
  return { status: "read", attempts, technicalValidation,
    integrationStatus: attempts.some(attempt => attempt.git?.status === "conflict") ? "INTEGRATION_HOLD"
      : attempts.length ? "INTEGRATING" : "READY",
    validation: "not-executed", executionStarted: false };
}
