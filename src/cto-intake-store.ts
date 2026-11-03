import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { parseCtoIntakeDelivery } from "./domain/cto-intake-deliveries.ts";
import type { CtoQuestionRecord } from "./domain/cto-questions.ts";
import { createCtoQuestionStore } from "./cto-question-store.ts";
import { createRevisionJournal, type RevisionState } from "./solution-revision-store.ts";
import { parseLeadToolContext, resolveLeadToolAuthority } from "./lead-tool-authority.ts";
import { readWorkstreams, readPinnedWorkstreamSources } from "./workstream-tools.ts";
import { workstreamInstructionDigest } from "./cto-delivery-store.ts";
import { readProjectCtos } from "./project-cto-tools.ts";

export function createCtoIntakeStore(workspaceId: string, projectId: string, questionId: string, state: RevisionState) {
  const key = createHash("sha256").update(JSON.stringify([projectId, questionId])).digest("hex");
  return createRevisionJournal(workspaceId, `intake:${key}`, state, { prefix: "cto-intake",
    parse: value => parseCtoIntakeDelivery(value, workspaceId, projectId, questionId), revisionId: value => value.revisionId });
}

export const unreviewedQuestion = (question: CtoQuestionRecord): CtoQuestionRecord => ({ ...question, review: null });

export async function checkCurrentCtoQuestion(workspaceId: string, projectId: string, question: CtoQuestionRecord,
  platform: SpsPlatformInvocationContext) {
  const stored = (await createCtoQuestionStore(workspaceId, projectId, platform.state).current())?.revision.questions
    .find(row => row.proposal.id === question.proposal.id);
  if (!stored || JSON.stringify(unreviewedQuestion(stored)) !== JSON.stringify(unreviewedQuestion(question))) {
    throw new Error("The immutable CTO question no longer matches this intake.");
  }
  const board = await readWorkstreams(workspaceId, projectId, platform);
  const instruction = board?.revision.workstreams.find(row => row.spec.id === question.reporter.workstreamId);
  const cto = (await readProjectCtos(workspaceId, projectId, platform)).ctos.find(row => row.ctoId === question.reporter.ctoId);
  if (!instruction || !cto || cto.status === "RETIRED" || cto.agentId !== question.reporter.agentId
    || cto.sessionId !== question.reporter.sessionId || instruction.spec.assignedCtoId !== cto.ctoId
    || instruction.ctoAgentId !== cto.agentId || instruction.ctoSessionId !== cto.sessionId
    || instruction.spec.revision !== question.reporter.specRevision
    || workstreamInstructionDigest(instruction) !== question.reporter.instructionSha256) {
    throw new Error("The CTO question's assignment or specification changed during intake.");
  }
  const sources = await readPinnedWorkstreamSources(workspaceId, projectId, instruction, platform);
  return { question: stored, instruction, sources };
}

/** Resolve the exact Core-admitted question turn; a prepared Lead session alone is insufficient. */
export async function resolveBoundCtoIntake(projectId: string, questionId: string, runContext: unknown,
  platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext), lead = await resolveLeadToolAuthority(context, platform);
  if (lead.logicalContext !== null ? lead.logicalContext !== "question_intake"
    : lead.sessions?.sessions["cto-inbox"] !== context.sessionId) throw new Error("Only the prepared CTO-intake Lead session or Question Intake context may handle this question.");
  const store = createCtoIntakeStore(context.companyId, projectId, questionId, platform.state);
  const delivery = (await store.current())?.revision;
  if (!delivery || ["prepared", "superseded"].includes(delivery.phase)
    || delivery.target.agentId !== context.agentId || delivery.target.sessionId !== context.sessionId
    || delivery.target.selectionRevision !== lead.selectionRevision
    || delivery.runId !== null && delivery.runId !== context.runId) {
    throw new Error("This Lead run is not the recorded question intake.");
  }
  const check = async () => {
    await lead.check();
    const currentTargetSession = lead.logicalContext !== null
      ? lead.contexts?.contexts.question_intake
      : lead.sessions?.sessions["cto-inbox"];
    if (currentTargetSession !== context.sessionId || delivery.target.sessionId !== currentTargetSession
      || delivery.target.agentId !== lead.context.agentId || delivery.target.selectionRevision !== lead.selectionRevision) {
      throw new Error("The current Lead intake target changed. The recorded request was not reassigned.");
    }
    const current = (await store.current())?.revision;
    if (!current || current.requestId !== delivery.requestId || JSON.stringify(current.target) !== JSON.stringify(delivery.target)
      || ["prepared", "superseded"].includes(current.phase)
      || current.runId !== null && current.runId !== context.runId) throw new Error("The recorded question intake changed.");
    const receipt = await platform.agents.sessions.getRequest(context.sessionId, context.companyId, delivery.requestId);
    if (!receipt || receipt.requestId !== delivery.requestId || receipt.state !== "submitted" || receipt.runId !== context.runId) {
      throw new Error("The actual Core receipt does not match this question intake run.");
    }
    const run = await platform.agents.sessions.getRun(context.sessionId, context.companyId, context.runId);
    if (run.runId !== context.runId || run.status !== "running" || run.cancellationRequested || run.termination !== "not_applicable") {
      throw new Error("Question review requires the active uncancelled intake Lead run.");
    }
    await checkCurrentCtoQuestion(context.companyId, projectId, delivery.question, platform);
    await lead.check();
  };
  await check();
  const pinned = await checkCurrentCtoQuestion(context.companyId, projectId, delivery.question, platform);
  const state: RevisionState = {
    get: async key => { await check(); const result = await platform.state.get(key); await check(); return result; },
    compareAndSet: platform.state.compareAndSet ? async (...args) => {
      await check(); const result = await platform.state.compareAndSet!(...args); await check(); return result;
    } : undefined,
  };
  return { context, lead, delivery, check, state, ...pinned };
}
