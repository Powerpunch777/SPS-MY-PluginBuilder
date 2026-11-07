import { createHash } from "node:crypto";
import { assertProtectedOutputMetadata, PROTECTED_OUTPUT_RECEIPT_FIELDS } from "../protected-test-output-metadata.ts";
import { readProtectedOutputArtifacts, type ProtectedOutputRead } from "../protected-test-output-artifacts.ts";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { exactToolRecord, parseLeadToolContext } from "../lead-tool-authority.ts";
import { parseProtectedRun } from "../task-protected-qa.ts";
import { checkIntegrationPrerequisites, INTEGRATION_VALIDATION_PHASES, readCurrentIntegrationPlan,
  type IntegrationPlan, type IntegrationValidationPhase } from "./integration-plan.ts";
import { readVerifiedWorkstreamForManager } from "./integration-manager-job.ts";
import { createIntegrationAttemptStore, withIntegrationValidationReferences,
  type IntegrationAttempt, type IntegrationAttemptScope, type IntegrationValidationReference } from "./integration-progress.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const textHash = (value: string) => createHash("sha256").update(value).digest("hex");
type Host = SpsPlatformInvocationContext & { protectedTests?: {
  delegatedBranchInputVersion?: 1;
  enqueueApprovedV1?: (input: unknown) => Promise<unknown>;
  getRunV1?: (workspaceId: string, runId: string, subjectKeySha256: string) => Promise<unknown>;
}; localFolders?: { readWorkspaceSourceGitTipV1?: (sourceId: string, folderKey: string, branch: string) => Promise<unknown> } };

function bounded(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError("An exact integration validation scope is required.");
  return value;
}

export function integrationValidationReservation(plan: IntegrationPlan, scope: IntegrationAttemptScope, phase: IntegrationValidationPhase,
  commitSha: string, treeSha: string): IntegrationValidationReference {
  const selected = plan.validationPlans?.[phase];
  if (!selected || scope.workspaceId !== plan.workspaceId) throw new Error("The exact planned validation phase is required.");
  // Keep the Host-approved subject prefix; only the identity domain changes.
  const key = hash(plan.validationRequestScope === "candidate-v2"
    ? ["builder-integration-validation-candidate-v2", plan.workspaceId, plan.revisionId, phase, plan.sourceId,
      plan.folderKey, plan.candidateBranch, commitSha, treeSha, selected]
    : ["builder-integration-validation-v1", scope, plan.revisionId, phase, plan.sourceId,
      plan.candidateBranch, commitSha, treeSha, selected]);
  const subjectKey = `builder-integration-${phase}-v1:${key}`;
  return Object.freeze({ requestId: subjectKey, subjectKey, subjectKeySha256: textHash(subjectKey),
    approvalTemplateId: selected.approvalTemplateId, planSha256: selected.planSha256, commitSha, treeSha, runId: null, approvalId: null });
}

function matchesRun(raw: unknown, attempt: IntegrationAttempt, reference: IntegrationValidationReference) {
  const run = parseProtectedRun(raw);
  if (run.pins.approvalId === reference.approvalTemplateId
    || reference.runId !== null && run.id !== reference.runId || reference.approvalId !== null && run.pins.approvalId !== reference.approvalId
    || run.pins.sourceId !== attempt.effect.sourceId || run.pins.commitSha !== reference.commitSha
    || run.pins.treeSha !== reference.treeSha || run.pins.planSha256 !== reference.planSha256
    || run.pins.subjectKeySha256 !== reference.subjectKeySha256) throw new Error("Core validation run does not match the exact candidate reference.");
  return run;
}

function technicalOutcome(run: ReturnType<typeof parseProtectedRun>): "pending" | "passed" | "failed" | "unknown" {
  if (["queued", "claimed", "running", "cancelling"].includes(run.status)) return "pending";
  if (run.termination !== "confirmed" || run.receipt === null) return "unknown";
  const receipt = exactToolRecord(run.receipt, ["digest", "status", "stdoutSha256", "stderrSha256", "stdoutBytes", "stderrBytes",
    "processExitCode", "timedOut", "cancelled", "outputLimit", "appContainerVerified", "capabilitiesCount",
    "childTerminationConfirmed", "jobEmpty", "profileCleanupSucceeded", "sandboxCleanupSucceeded", "fixtureMustBeRetained"], PROTECTED_OUTPUT_RECEIPT_FIELDS);
  assertProtectedOutputMetadata(receipt);
  if (typeof receipt.digest !== "string" || !/^[a-f0-9]{64}$/u.test(receipt.digest)
    || receipt.appContainerVerified !== true || receipt.capabilitiesCount !== 0 || receipt.childTerminationConfirmed !== true
    || receipt.jobEmpty !== true || receipt.profileCleanupSucceeded !== true || receipt.sandboxCleanupSucceeded !== true
    || receipt.fixtureMustBeRetained !== false) return "unknown";
  return run.status === "succeeded" && receipt.status === "completed" && receipt.processExitCode === 0
    && receipt.timedOut === false && receipt.cancelled === false && receipt.outputLimit === false ? "passed" : "failed";
}

function completionIdentity(run: ReturnType<typeof parseProtectedRun>) {
  const digest = run.receipt && typeof run.receipt === "object" ? Object.getOwnPropertyDescriptor(run.receipt, "digest")?.value : null;
  return JSON.stringify([run.id, run.status, run.termination, run.pins, digest]);
}

/** Observation never enqueues. A passed finite technical recipe is not authored
 * QA, complete G6/G7 coverage, a Final Packet, or user delivery approval. */
export async function readIntegrationValidationRuns(attempts: readonly IntegrationAttempt[], platform: SpsPlatformInvocationContext) {
  const api = (platform as Host).protectedTests, folders = (platform as Host).localFolders;
  const results = [];
  for (const attempt of attempts) {
    for (const phase of INTEGRATION_VALIDATION_PHASES) {
      const reference = attempt.validationRuns?.[phase];
      if (!reference) continue;
      let status: "pending" | "passed" | "failed" | "unknown" | "stale" = "unknown";
      let outputs: ProtectedOutputRead | null = null;
      let receiptSha256: string | null = null;
      if (reference.runId && typeof api?.getRunV1 === "function") {
        try {
          const raw = await api.getRunV1(attempt.scope.workspaceId, reference.runId, reference.subjectKeySha256);
          if (raw !== null) {
            const run = matchesRun(raw, attempt, reference);
            status = technicalOutcome(run);
            const observedCompletion = completionIdentity(run);
            const tipCurrent = async () => {
              const tip = exactToolRecord(await folders!.readWorkspaceSourceGitTipV1!(attempt.effect.sourceId, attempt.effect.folderKey, attempt.effect.branch),
                ["status", "sourceId", "folderKey", "branch", "commitSha", "treeSha", "observedAt"]);
              return tip.status === "current" && tip.sourceId === attempt.effect.sourceId && tip.folderKey === attempt.effect.folderKey
                && tip.branch === attempt.effect.branch && tip.commitSha === reference.commitSha && tip.treeSha === reference.treeSha;
            };
            if (typeof folders?.readWorkspaceSourceGitTipV1 !== "function") status = "unknown";
            else if (!await tipCurrent()) status = "stale";
            if (status === "passed" && reference.approvalId) outputs = await readProtectedOutputArtifacts({
              workspaceId: attempt.scope.workspaceId, runId: reference.runId, subjectKey: reference.subjectKey,
              approvalId: reference.approvalId, sourceId: attempt.effect.sourceId, commitSha: reference.commitSha,
              treeSha: reference.treeSha, planSha256: reference.planSha256 }, platform);
            if (status === "passed") {
              const latest = matchesRun(await api.getRunV1(attempt.scope.workspaceId, reference.runId, reference.subjectKeySha256), attempt, reference);
              if (technicalOutcome(latest) !== "passed" || completionIdentity(latest) !== observedCompletion) { status = "unknown"; outputs = null; }
              else if (!await tipCurrent()) { status = "stale"; outputs = null; }
              else receiptSha256 = (latest.receipt as { digest: string }).digest;
            }
          }
        } catch {
          status = "unknown";
          outputs = null;
        }
      }
      results.push({ taskId: attempt.scope.taskId, phase, runId: reference.runId, commitSha: reference.commitSha,
        treeSha: reference.treeSha, status, receiptSha256, outputs, qaVerdict: "not-established" as const });
    }
  }
  return results;
}

export async function requestIntegrationValidation(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["workstreamId", "eventId", "taskId", "phase"]);
  const context = parseLeadToolContext(runContext), workstreamId = bounded(input.workstreamId), eventId = bounded(input.eventId), taskId = bounded(input.taskId);
  const phase = INTEGRATION_VALIDATION_PHASES.find(value => value === input.phase);
  if (!phase) throw new TypeError("Integration validation phase must be ci, e2e or regression.");
  const scope = { workspaceId: context.companyId, workstreamId, eventId, taskId };
  const api = (platform as Host).protectedTests, folders = (platform as Host).localFolders;
  const check = async () => {
    await readVerifiedWorkstreamForManager({ workstreamId, eventId }, runContext, platform);
    const ready = await checkIntegrationPrerequisites(context.companyId, workstreamId, platform);
    if (ready.status !== "ready") throw new Error("Integration validation authority or dependencies are not current.");
  };
  await check();
  const plan = await readCurrentIntegrationPlan(context.companyId, platform), selected = plan?.revision.validationPlans?.[phase];
  if (!plan || !selected) return { status: "unsupported", reason: "main-validation-plan-reference-unavailable", executionStarted: false };
  if (api?.delegatedBranchInputVersion !== 1 || typeof api.enqueueApprovedV1 !== "function" || typeof api.getRunV1 !== "function"
    || typeof folders?.readWorkspaceSourceGitTipV1 !== "function") return { status: "unsupported", reason: "protected-validation-api-unavailable", executionStarted: false };
  const store = createIntegrationAttemptStore(scope, platform.state), current = await store.current();
  if (!current || current.revision.stage !== "git-observed" || !current.revision.git || current.revision.git.status === "conflict"
    || current.revision.planRevisionId !== plan.revision.revisionId || current.revision.effect.sourceId !== plan.revision.sourceId
    || current.revision.effect.folderKey !== plan.revision.folderKey || current.revision.effect.branch !== plan.revision.candidateBranch) {
    throw new Error("The exact observed integration candidate and current plan are required.");
  }
  let attempt = current.revision;
  const git = current.revision.git!;
  const readTip = async () => exactToolRecord(await folders.readWorkspaceSourceGitTipV1!(plan.revision.sourceId, plan.revision.folderKey, plan.revision.candidateBranch),
    ["status"], ["sourceId", "folderKey", "branch", "commitSha", "treeSha", "observedAt", "reason"]);
  const tip = await readTip();
  const expectedCommit = git.status === "unchanged" ? git.headSha : (git as { commitSha: string }).commitSha;
  const expectedTree = git.status === "integrated" || git.status === "replayed" ? git.treeSha : tip.treeSha;
  if (tip.status !== "current" || tip.sourceId !== attempt.effect.sourceId || tip.folderKey !== attempt.effect.folderKey
    || tip.branch !== attempt.effect.branch || tip.branch !== plan.revision.candidateBranch || tip.commitSha !== expectedCommit
    || tip.treeSha !== expectedTree || typeof tip.commitSha !== "string" || typeof tip.treeSha !== "string"
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tip.treeSha)) return { status: "stale", reason: "integration-candidate-tip-changed", executionStarted: false };
  const reservation = integrationValidationReservation(plan.revision, scope, phase, tip.commitSha, tip.treeSha);
  const prior = attempt.validationRuns?.[phase];
  if (prior && hash({ ...prior, runId: null, approvalId: null }) !== hash(reservation)) return { status: "stale", reason: "validation-reservation-pins-changed", executionStarted: false };
  if (prior?.runId) return { status: "existing", reference: prior, technicalValidation: await readIntegrationValidationRuns([attempt], platform), executionStarted: false };
  if (!prior) {
    const reserved = withIntegrationValidationReferences(attempt, { ci: null, e2e: null, ...attempt.validationRuns, [phase]: reservation });
    const saved = await store.publish({ expectedBaseRevisionId: attempt.revisionId, revision: reserved });
    if (saved.status !== "published") return { status: "conflict", reason: "validation-reservation-cas-conflict", executionStarted: false };
    attempt = reserved;
  }
  await check();
  if ((await readCurrentIntegrationPlan(context.companyId, platform))?.revision.revisionId !== plan.revision.revisionId
    || (await store.current())?.revision.revisionId !== attempt.revisionId) return { status: "stale", reason: "validation-authority-changed-before-enqueue", executionStarted: false };
  const latestTip = await readTip();
  if (latestTip.status !== "current" || latestTip.sourceId !== tip.sourceId || latestTip.folderKey !== tip.folderKey
    || latestTip.branch !== tip.branch || latestTip.commitSha !== tip.commitSha || latestTip.treeSha !== tip.treeSha) {
    return { status: "stale", reason: "integration-candidate-tip-changed", executionStarted: false };
  }
  let run;
  try {
    run = matchesRun(await api.enqueueApprovedV1({ companyId: context.companyId, sourceId: attempt.effect.sourceId,
      approvalId: selected.approvalTemplateId, requestId: reservation.requestId, subjectKey: reservation.subjectKey,
      branch: attempt.effect.branch, commitSha: reservation.commitSha, treeSha: reservation.treeSha, planSha256: reservation.planSha256 }), attempt, reservation);
  } catch { return { status: "unknown", reason: "validation-enqueue-outcome-unknown-reconcile-same-request", requestId: reservation.requestId, executionStarted: null }; }
  const reference = Object.freeze({ ...reservation, runId: run.id, approvalId: run.pins.approvalId });
  await check();
  const observed = withIntegrationValidationReferences(attempt, { ...attempt.validationRuns!, [phase]: reference });
  const saved = await store.publish({ expectedBaseRevisionId: attempt.revisionId, revision: observed });
  return { status: saved.status, reference, admission: "confirmed", technicalValidation: technicalOutcome(run),
    qaVerdict: "not-established", executionStarted: null };
}
