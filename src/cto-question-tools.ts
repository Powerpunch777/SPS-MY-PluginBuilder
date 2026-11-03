import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { parseCtoQuestionBoard, parseCtoQuestionProposal, type CtoQuestionRecord } from "./domain/cto-questions.ts";
import type { RevisionState } from "./solution-revision-store.ts";
import { createCtoQuestionStore } from "./cto-question-store.ts";
export { createCtoQuestionStore } from "./cto-question-store.ts";
import { resolveCtoPlanningAuthority } from "./cto-planning-authority.ts";
import { exactToolRecord, parseLeadToolContext, resolveLeadToolAuthority } from "./lead-tool-authority.ts";
import { readPinnedWorkstreamSources, readWorkstreams } from "./workstream-tools.ts";
import { workstreamInstructionDigest } from "./cto-delivery-store.ts";
import { resolveBoundCtoIntake } from "./cto-intake-store.ts";

const json = (value: unknown) => value as JsonValue;
function id(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError("A bounded question scope ID is required.");
  return value;
}
function conflict(current: string | null) {
  return { content: "The CTO intake board changed. Read the existing receipt; never automatically repeat a write.",
    data: json({ status: "conflict", actualBaseRevisionId: current, aiDispatched: false, userQuestionCreated: false }) };
}
async function intakeAuthority(projectId: string, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext), lead = await resolveLeadToolAuthority(context, platform);
  if (lead.logicalContext !== null ? lead.logicalContext !== "question_intake"
    : lead.sessions?.sessions["cto-inbox"] !== context.sessionId) throw new Error("Only the prepared CTO-intake Lead session or Question Intake context may read or review CTO proposals.");
  const check = async () => {
    await lead.check();
    const run = await platform.agents.sessions.getRun(context.sessionId, context.companyId, context.runId);
    if (run.runId !== context.runId || run.status !== "running" || run.cancellationRequested || run.termination !== "not_applicable") {
      throw new Error("Question intake requires the active uncancelled Lead run.");
    }
    await lead.check();
  };
  const state: RevisionState = {
    get: async key => { await check(); const value = await platform.state.get(key); await check(); return value; },
    compareAndSet: platform.state.compareAndSet ? async (...args) => {
      await check(); const value = await platform.state.compareAndSet!(...args); await check(); return value;
    } : undefined,
  };
  await check();
  return { context, lead, check, store: createCtoQuestionStore(context.companyId, projectId, state) };
}

/** Stores a CTO-authored proposal, not a user message, answer or design amendment. */
export async function submitCtoQuestion(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "ctoId", "workstreamId", "expectedBaseRevisionId", "revisionId", "proposal"]);
  const projectId = id(input.projectId), ctoId = id(input.ctoId), workstreamId = id(input.workstreamId), revisionId = id(input.revisionId);
  const expected = input.expectedBaseRevisionId === null ? null : id(input.expectedBaseRevisionId);
  const proposal = parseCtoQuestionProposal(input.proposal);
  const authority = await resolveCtoPlanningAuthority(projectId, ctoId, workstreamId, runContext, platform, "builder.submit-cto-question");
  if (proposal.scopeNodeIds.some(node => !authority.delivery.instruction.spec.scopeNodeIds.includes(node))) {
    throw new Error("A CTO question may only cite nodes assigned by its exact delivered Workstream.");
  }
  const check = async () => {
    await authority.check();
    const latest = (await readWorkstreams(authority.context.companyId, projectId, platform))?.revision.workstreams
      .find(row => row.spec.id === workstreamId);
    if (!latest || workstreamInstructionDigest(latest) !== authority.source.sha256) throw new Error("The question's delivered instruction is no longer current.");
    await authority.check();
  };
  const state: RevisionState = {
    get: async key => { await check(); const result = await platform.state.get(key); await check(); return result; },
    compareAndSet: platform.state.compareAndSet ? async (...args) => {
      await check(); const result = await platform.state.compareAndSet!(...args); await check(); return result;
    } : undefined,
  };
  const store = createCtoQuestionStore(authority.context.companyId, projectId, state);
  const current = await store.current();
  const prior = current?.revision.questions.find(row => row.proposal.id === proposal.id);
  const reporter = { ctoId, agentId: authority.context.agentId, sessionId: authority.context.sessionId, runId: authority.context.runId,
    requestId: authority.source.requestId, workstreamId, specRevision: authority.source.specRevision, instructionSha256: authority.source.sha256 };
  if (prior) {
    if (JSON.stringify(prior.proposal) !== JSON.stringify(proposal) || JSON.stringify(prior.reporter) !== JSON.stringify(reporter)) {
      throw new Error("This question ID belongs to a different immutable proposal. Existing records are unchanged.");
    }
    await authority.check();
    return { content: "This exact CTO proposal was already recorded; no new write or provider send.",
      data: json({ status: "existing", questionId: proposal.id, boardRevisionId: current!.revision.revisionId,
        reviewed: prior.review !== null, aiDispatched: false, userQuestionCreated: false }) };
  }
  if ((current?.revision.revisionId ?? null) !== expected) return conflict(current?.revision.revisionId ?? null);
  const record: CtoQuestionRecord = { proposal, reporter, createdAtISO: new Date().toISOString(), review: null };
  const result = await store.publish({ expectedBaseRevisionId: expected, revision: {
    projectId, revisionId, questions: [...(current?.revision.questions ?? []), record],
  } });
  await authority.check();
  // The reporting CTO never receives the project's other CTO proposals.
  return { content: "CTO proposal recorded for internal Lead review. No user question, answer, approval, code or provider execution was created.",
    data: json({ status: result.status, questionId: proposal.id,
      boardRevisionId: result.status === "published" ? result.revision.revisionId : result.actualBaseRevisionId,
      aiDispatched: false, userQuestionCreated: false }) };
}

export async function readCtoQuestions(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId"]), projectId = id(input.projectId);
  const authority = await intakeAuthority(projectId, runContext, platform);
  const current = await authority.store.current();
  await authority.check();
  return { content: "Explicit CTO question proposals for the internal Lead, not private CTO memory, user decisions or verified facts. Compare exact pinned specifications and current project decisions before reviewing.",
    data: json({ projectId, current }) };
}

export async function readOwnCtoQuestion(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "ctoId", "workstreamId", "questionId"]);
  const projectId = id(input.projectId), ctoId = id(input.ctoId), workstreamId = id(input.workstreamId), questionId = id(input.questionId);
  const authority = await resolveCtoPlanningAuthority(projectId, ctoId, workstreamId, runContext, platform, "builder.read-own-cto-question");
  const current = await createCtoQuestionStore(authority.context.companyId, projectId, authority.state).current();
  const candidate = current?.revision.questions.find(row => row.proposal.id === questionId);
  const question = candidate?.reporter.ctoId === ctoId && candidate.reporter.agentId === authority.context.agentId
    && candidate.reporter.sessionId === authority.context.sessionId && candidate.reporter.workstreamId === workstreamId ? candidate : null;
  await authority.check();
  return { content: "Only this CTO's explicitly submitted question/review and the current board revision. No other CTO proposals or private memory. An unknown write is observed, never resent by this read.",
    data: json({ projectId, ctoId, questionId, boardRevisionId: current?.revision.revisionId ?? null, question }) };
}

/** Host-authorized UI projection: no unreviewed or Lead-resolved internal proposals. */
export async function readUserCtoQuestions(workspaceId: string, projectId: string, platform: SpsPlatformInvocationContext) {
  const current = await createCtoQuestionStore(workspaceId, id(projectId), platform.state).current();
  if (!current) return null;
  const board = await readWorkstreams(workspaceId, projectId, platform);
  const questions = current.revision.questions.filter(row => row.review?.disposition === "user-decision-needed"
    && board?.revision.workstreams.some(instruction => instruction.spec.id === row.reporter.workstreamId
      && instruction.spec.assignedCtoId === row.reporter.ctoId
      && workstreamInstructionDigest(instruction) === row.reporter.instructionSha256));
  return { workspaceId, projectId, sequence: current.sequence,
    board: parseCtoQuestionBoard({ ...current.revision, questions }, projectId) };
}

export async function reviewCtoQuestion(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "questionId", "expectedBaseRevisionId", "revisionId", "reviewId", "disposition", "rationale", "evidenceRefs"]);
  const projectId = id(input.projectId), questionId = id(input.questionId), expected = id(input.expectedBaseRevisionId), revisionId = id(input.revisionId);
  const authority = await resolveBoundCtoIntake(projectId, questionId, runContext, platform);
  const current = await createCtoQuestionStore(authority.context.companyId, projectId, authority.state).current();
  if (!current || current.revision.revisionId !== expected) return conflict(current?.revision.revisionId ?? null);
  const question = current.revision.questions.find(row => row.proposal.id === questionId);
  if (!question) throw new Error("The exact CTO proposal is unavailable.");
  const board = await readWorkstreams(authority.context.companyId, projectId, platform);
  const instruction = board?.revision.workstreams.find(row => row.spec.id === question.reporter.workstreamId);
  if (!instruction || instruction.spec.revision !== question.reporter.specRevision
    || instruction.spec.assignedCtoId !== question.reporter.ctoId
    || workstreamInstructionDigest(instruction) !== question.reporter.instructionSha256) throw new Error("This proposal's assignment changed. Do not decide against a substituted specification.");
  const sources = await readPinnedWorkstreamSources(authority.context.companyId, projectId, instruction, platform);
  const review = { reviewId: input.reviewId, reviewer: { agentId: authority.context.agentId, sessionId: authority.context.sessionId,
    runId: authority.context.runId, selectionRevision: authority.lead.selectionRevision }, disposition: input.disposition,
    rationale: input.rationale, evidenceRefs: input.evidenceRefs, createdAtISO: new Date().toISOString() };
  const updated = parseCtoQuestionBoard({ projectId, revisionId,
    questions: current.revision.questions.map(row => row.proposal.id === questionId ? { ...row, review } : row) }, projectId);
  const reviewed = updated.questions.find(row => row.proposal.id === questionId)!.review!;
  const refs = new Set([`baseline:${sources.baseline.revisionId}`, `spec:${sources.baseline.specification.revisionId}`,
    `graph:${sources.baseline.graph.graphRevisionId}`, `technology:${sources.technology.register.revisionId}`,
    `workstream:${instruction.spec.id}:${instruction.spec.revision}`]);
  if (reviewed.evidenceRefs.some(ref => !refs.has(ref)) || reviewed.evidenceRefs.length === 0) {
    throw new Error("Lead review must cite the available pinned design/technology/Workstream records, not invented evidence.");
  }
  if (question.review) throw new Error("This immutable proposal already has a review. Read it instead of overwriting history.");
  const check = async () => {
    await authority.check();
    const latest = (await readWorkstreams(authority.context.companyId, projectId, platform))?.revision.workstreams
      .find(row => row.spec.id === question.reporter.workstreamId);
    if (!latest || workstreamInstructionDigest(latest) !== question.reporter.instructionSha256) throw new Error("The reviewed instruction changed during intake.");
    await authority.check();
  };
  const state: RevisionState = {
    get: async key => { await check(); const result = await platform.state.get(key); await check(); return result; },
    compareAndSet: platform.state.compareAndSet ? async (...args) => {
      await check(); const result = await platform.state.compareAndSet!(...args); await check(); return result;
    } : undefined,
  };
  const result = await createCtoQuestionStore(authority.context.companyId, projectId, state).publish({ expectedBaseRevisionId: expected, revision: updated });
  await check();
  return { content: "Lead interpretation recorded, not independently verified. Only user-decision-needed becomes eligible for the user decisions list. No user answer, automatic approval, design amendment, CTO response or provider dispatch was created.",
    data: json({ ...result, aiDispatched: false, userDecisionPublished: result.status === "published" && reviewed.disposition === "user-decision-needed" }) };
}
