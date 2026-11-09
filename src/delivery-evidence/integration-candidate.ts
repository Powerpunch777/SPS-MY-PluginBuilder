import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { checkIntegrationPrerequisites, readCurrentIntegrationPlan, type IntegrationValidationPhase } from "../builder-gates/integration-plan.ts";
import { createIntegrationAttemptStore, type IntegrationAttempt, type IntegrationValidationReference } from "../builder-gates/integration-progress.ts";
import { integrationValidationReservation, readIntegrationValidationRuns } from "../builder-gates/integration-validation.ts";
import { createWorkstreamVerificationPublication } from "../builder-gates/workstream-verification-publication.ts";
import type { VerifiedWorkstreamSnapshot } from "../builder-gates/workstream-verification-consumer.ts";
import { readDesignBaseline } from "../design-baseline-tools.ts";
import { exactToolRecord } from "../lead-tool-authority.ts";
import { taskPacketRecordDigest } from "../domain/task-packets.ts";
import { createTaskPacketStore } from "../task-packet-tools.ts";
import { createTaskQaReportStore } from "../task-qa-reports.ts";
import { readWorkstreams } from "../workstream-tools.ts";
import { verifyTaskQaReportForSnapshot } from "../builder-gates/verified-task-qa-report.ts";

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const TASK_PREFIX = "builder-v1:task-packet:";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
type TechnicalRun = Awaited<ReturnType<typeof readIntegrationValidationRuns>>[number];
type TaskTrace = Readonly<{ workstreamId: string; verificationEventId: string; taskId: string; taskRevision: number;
  taskSha256: string; scopeNodeIds: readonly string[]; qaReportRevisionId: string; qaReportSha256: string;
  integrationAttemptRevisionId: string; commitSha: string; treeSha: string }>;

type PhaseReference = Readonly<{ attempt: IntegrationAttempt; reference: IntegrationValidationReference }>;

export function integrationCandidateEvidenceDigest(value: Extract<Awaited<ReturnType<typeof readIntegrationCandidate>>, { status: "observed" }>) {
  return hash([value.candidate, value.plan.revisionId, value.boardRevisionId, value.snapshots.map(item => item.eventId),
    value.attempts.map(item => item.revisionId), value.scopeTrace, value.ci, value.e2e, value.regression ?? null]);
}

/** Multiple local observations of a single Core request are not multiple tests.
 * Never select between contradictory receipts or distinct requests. */
export function selectLogicalValidationRun(references: readonly PhaseReference[]) {
  let selected: PhaseReference | null = null;
  for (const entry of references) {
    if (!selected) { selected = entry; continue; }
    const a = selected.reference, b = entry.reference;
    if (a.requestId !== b.requestId || a.subjectKey !== b.subjectKey || a.subjectKeySha256 !== b.subjectKeySha256
      || a.approvalTemplateId !== b.approvalTemplateId || a.planSha256 !== b.planSha256 || a.commitSha !== b.commitSha || a.treeSha !== b.treeSha
      || a.runId !== null && b.runId !== null && (a.runId !== b.runId || a.approvalId !== b.approvalId)) {
      return { status: "ambiguous" as const };
    }
    if (a.runId === null && b.runId !== null) selected = entry;
  }
  return selected ? { status: "selected" as const, ...selected } : { status: "absent" as const };
}

function chainMatches(attempts: readonly IntegrationAttempt[], base: string, commit: string, tree: string) {
  const next = new Map<string, { commitSha: string; treeSha: string }>();
  const unchanged: string[] = [];
  for (const { effect, git } of attempts) {
    if (!git || git.status === "conflict") return false;
    if (git.status === "unchanged") {
      if (git.headSha !== effect.expectedHead) return false;
      unchanged.push(git.headSha);
    } else {
      if (git.commitSha === effect.expectedHead || next.has(effect.expectedHead)) return false;
      next.set(effect.expectedHead, git);
    }
  }
  const seen = new Set<string>([base]);
  let head = base, headTree: string | null = null;
  while (next.has(head)) {
    const after = next.get(head)!;
    if (seen.has(after.commitSha)) return false;
    head = after.commitSha;
    headTree = after.treeSha;
    seen.add(head);
  }
  return seen.size === next.size + 1 && head === commit && (headTree === null || headTree === tree)
    && unchanged.every(value => seen.has(value));
}

/** Read existing records only. A matching technical candidate does not establish
 * G6/G7 or delivery authority. Scope trace records links, not functional coverage. */
export async function readIntegrationCandidate(workspaceId: string, platform: SpsPlatformInvocationContext) {
  const unavailable = <Status extends "pending" | "stale" | "failed" | "unknown">(status: Status, reason: string) => ({ status, reason });
  try {
    const plan = (await readCurrentIntegrationPlan(workspaceId, platform))?.revision;
    const board = (await readWorkstreams(workspaceId, workspaceId, platform))?.revision;
    if (!plan || !board?.workstreams.length) return unavailable("pending", "integration-plan-or-workstream-board-unavailable");
    const baseline = (await readDesignBaseline(workspaceId, workspaceId, platform))?.revision;
    if (!baseline || baseline.revisionId !== plan.baselineRevisionId || hash(baseline) !== plan.baselineDigest) {
      return unavailable("stale", "integration-approved-scope-changed");
    }
    const byRequirement = new Map(baseline.specification.requirements.map(requirement => [requirement.id, {
      requirementId: requirement.id, acceptanceCriteriaIds: [...requirement.acceptanceCriteriaIds], tasks: [] as TaskTrace[],
    }]));
    const folders = (platform as SpsPlatformInvocationContext & { localFolders?: {
      readWorkspaceSourceGitTipV1?: (sourceId: string, folderKey: string, branch: string) => Promise<unknown>;
    } }).localFolders;
    if (typeof folders?.readWorkspaceSourceGitTipV1 !== "function") return unavailable("unknown", "integration-source-observation-unavailable");
    const tip = async (branch: string) => {
      const row = exactToolRecord(await folders.readWorkspaceSourceGitTipV1!(plan.sourceId, plan.folderKey, branch),
        ["status"], ["reason", "sourceId", "folderKey", "branch", "commitSha", "treeSha", "observedAt"]);
      if (row.status === "denied" && row.reason === "branch_unavailable") return null;
      if (row.status !== "current" || row.sourceId !== plan.sourceId || row.folderKey !== plan.folderKey || row.branch !== branch
        || typeof row.commitSha !== "string" || typeof row.treeSha !== "string" || !OID.test(row.commitSha)
        || !OID.test(row.treeSha) || row.commitSha.length !== row.treeSha.length
        || typeof row.observedAt !== "string" || !Number.isFinite(Date.parse(row.observedAt))) throw new Error("Unconfirmed Git tip.");
      return { sourceId: plan.sourceId, folderKey: plan.folderKey, branch, commitSha: row.commitSha, treeSha: row.treeSha };
    };
    const base = await tip(plan.baseBranch);
    if (!base || base.commitSha !== plan.baseCommit || base.treeSha !== plan.baseTree) return unavailable("stale", "integration-plan-base-changed");
    const currentCandidate = await tip(plan.candidateBranch);
    if (!currentCandidate) return unavailable("pending", "integration-candidate-not-created");
    const candidate = currentCandidate;
    const publication = createWorkstreamVerificationPublication(platform.state);
    const snapshots: VerifiedWorkstreamSnapshot[] = [];
    const attempts: IntegrationAttempt[] = [];
    for (const { spec } of board.workstreams) {
      const prerequisite = await checkIntegrationPrerequisites(workspaceId, spec.id, platform);
      if (prerequisite.status !== "ready") return unavailable(prerequisite.status === "waiting-dependencies" ? "pending" : "unknown", prerequisite.reason);
      const scope = { workspaceId, projectId: workspaceId, workstreamId: spec.id };
      const current = await publication.readLatestCurrent(scope);
      if (current.status === "stale") return unavailable("stale", "workstream-verification-changed");
      if (current.status !== "current") return unavailable(current.reason === "verified-head-unavailable" ? "pending" : "unknown", current.reason);
      const snapshot = current.snapshot;
      snapshots.push(snapshot);
      const ctoId = spec.assignedCtoId;
      const taskBoard = (await createTaskPacketStore(workspaceId, workspaceId, ctoId, spec.id, platform.state).current())?.revision;
      const tasks = taskBoard?.packets.filter(row => row.packet.kind === "development") ?? [];
      if (!tasks.length || tasks.length !== snapshot.qaEvidence.length) return unavailable("unknown", "workstream-task-report-inventory-incomplete");
      for (const task of tasks) {
        const taskId = task.packet.taskId;
        const digest = taskPacketRecordDigest(task, workspaceId, ctoId, spec.id);
        const qaTasks = taskBoard!.packets.filter(row => row.packet.kind === "qa" && row.dependencyPins.some(pin =>
          pin.taskId === taskId && pin.revision === task.packet.revision && pin.recordSha256 === digest));
        if (!snapshot.sourcePins.some(pin => pin.sourceId === `${TASK_PREFIX}${taskId}` && pin.sha256 === digest)
          || qaTasks.length !== 1) return unavailable("stale", "workstream-task-verification-pins-changed");
        const qaTaskId = qaTasks[0]!.packet.taskId;
        const report = (await createTaskQaReportStore({ ...scope, ctoId, qaTaskId }, platform.state).current())?.revision;
        const reportSha256 = hash(report ?? null);
        const qaEvidence = snapshot.qaEvidence.find(qa => qa.report.sourceId === `builder-v1:task-qa-report:${qaTaskId}`);
        const qaDigest = taskPacketRecordDigest(qaTasks[0]!, workspaceId, ctoId, spec.id);
        if (report?.verdict !== "passed" || !qaEvidence || !verifyTaskQaReportForSnapshot({ snapshot, task, taskDigest: digest,
          qaTask: qaTasks[0]!, qaDigest, taskBoardRevisionId: taskBoard!.revisionId,
          workstream: board.workstreams.find(item => item.spec.id === spec.id)!, report, reportPin: qaEvidence.report })) {
          return unavailable("stale", "workstream-independent-qa-pins-changed");
        }
        const attempt = (await createIntegrationAttemptStore({ workspaceId, workstreamId: spec.id,
          eventId: snapshot.eventId, taskId }, platform.state).current())?.revision;
        if (!attempt || attempt.stage !== "git-observed") return unavailable("pending", "workstream-task-integration-not-observed");
        if (attempt.planRevisionId !== plan.revisionId || attempt.effect.sourceId !== candidate.sourceId
          || attempt.effect.folderKey !== candidate.folderKey || attempt.effect.branch !== candidate.branch
          || attempt.reportRevisionId !== report.revisionId || attempt.effect.incomingCommit !== report.reference.binding.commitSha
          || attempt.effect.incomingTree !== report.reference.binding.treeSha) {
          return unavailable("stale", "workstream-task-integration-pins-changed");
        }
        if (attempt.git?.status === "conflict") return unavailable("failed", "workstream-task-integration-conflict");
        const trace: TaskTrace = { workstreamId: spec.id, verificationEventId: snapshot.eventId, taskId,
          taskRevision: task.packet.revision, taskSha256: digest, scopeNodeIds: [...task.packet.scopeNodeIds],
          qaReportRevisionId: report.revisionId, qaReportSha256: reportSha256, integrationAttemptRevisionId: attempt.revisionId,
          commitSha: attempt.effect.incomingCommit, treeSha: attempt.effect.incomingTree };
        for (const requirementId of task.packet.requirementIds) {
          const requirement = byRequirement.get(requirementId);
          if (!requirement) return unavailable("stale", "integration-task-outside-approved-scope");
          requirement.tasks.push(trace);
        }
        attempts.push(attempt);
      }
    }
    if (!chainMatches(attempts, base.commitSha, candidate.commitSha, candidate.treeSha)) return unavailable("stale", "integration-candidate-does-not-match-observed-effects");
    if (!plan.validationPlans) return unavailable("pending", "integration-validation-plans-unavailable");
    const plans = plan.validationPlans;
    const required = {} as Record<"ci" | "e2e", TechnicalRun> & { regression?: TechnicalRun };
    const phases: readonly IntegrationValidationPhase[] = plans.regression ? ["ci", "e2e", "regression"] : ["ci", "e2e"];
    for (const phase of phases) {
      const references: PhaseReference[] = [];
      const expected = plans[phase]!;
      for (const attempt of attempts) {
        const reference = attempt.validationRuns?.[phase];
        if (!reference || reference.commitSha !== candidate.commitSha || reference.treeSha !== candidate.treeSha
          || reference.approvalTemplateId !== expected.approvalTemplateId || reference.planSha256 !== expected.planSha256) continue;
        if (plan.validationRequestScope === "candidate-v2") {
          const key = integrationValidationReservation(plan, attempt.scope, phase, candidate.commitSha, candidate.treeSha);
          if (reference.requestId !== key.requestId || reference.subjectKey !== key.subjectKey || reference.subjectKeySha256 !== key.subjectKeySha256) {
            return unavailable("unknown", `integration-${phase}-request-identity-mismatch`);
          }
        }
        references.push({ attempt, reference });
      }
      const selected = selectLogicalValidationRun(references);
      if (selected.status !== "selected") return unavailable(selected.status === "ambiguous" ? "unknown" : "pending",
        `integration-${phase}-run-not-unique-or-unavailable`);
      const [result] = await readIntegrationValidationRuns([{ ...selected.attempt,
        validationRuns: { ci: null, e2e: null, [phase]: selected.reference } }], platform);
      if (!result) return unavailable("unknown", `integration-${phase}-run-read-unavailable`);
      if (result.status !== "passed") return unavailable(result.status, `integration-${phase}-not-passed`);
      required[phase] = result;
    }
    for (const snapshot of snapshots) {
      const current = await publication.readLatestCurrent(snapshot);
      if (current.status !== "current" || current.snapshot.eventId !== snapshot.eventId) return unavailable("stale", "workstream-verification-changed-during-read");
    }
    for (const attempt of attempts) {
      const latest = await createIntegrationAttemptStore(attempt.scope, platform.state).current();
      if (latest?.revision.revisionId !== attempt.revisionId) return unavailable("stale", "integration-attempt-changed-during-read");
    }
    if ((await readCurrentIntegrationPlan(workspaceId, platform))?.revision.revisionId !== plan.revisionId
      || (await readWorkstreams(workspaceId, workspaceId, platform))?.revision.revisionId !== board.revisionId
      || (await checkIntegrationPrerequisites(workspaceId, board.workstreams[0]!.spec.id, platform)).status !== "ready"
      || JSON.stringify(await tip(plan.baseBranch)) !== JSON.stringify(base)
      || JSON.stringify(await tip(plan.candidateBranch)) !== JSON.stringify(candidate)) return unavailable("stale", "integration-candidate-changed-during-read");
    const requirements = [...byRequirement.values()];
    const scopeTrace = { baselineRevisionId: baseline.revisionId, specificationRevisionId: baseline.specification.revisionId,
      requirements, unmappedRequirementIds: requirements.filter(requirement => !requirement.tasks.length).map(requirement => requirement.requirementId) };
    return { status: "observed" as const, candidate, plan, boardRevisionId: board.revisionId, snapshots, attempts, scopeTrace,
      ci: required.ci, e2e: required.e2e, ...(required.regression ? { regression: required.regression } : {}),
      deliveryAuthority: "not-established" as const };
  } catch {
    return unavailable("unknown", "integration-candidate-read-unconfirmed");
  }
}
