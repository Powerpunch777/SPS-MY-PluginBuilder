import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import type { BuilderSnapshot } from "./domain/model.ts";
import { parseDesignDraft } from "./domain/design-drafts.ts";
import { parseDesignDecisions } from "./domain/design-decisions.ts";
import { exactToolRecord, parseLeadToolContext, resolveLeadToolAuthority } from "./lead-tool-authority.ts";
import { readLeadUserSource } from "./lead-conversations.ts";
import { createDesignDraftStore, type AuthoredDesignDraft } from "./design-draft-store.ts";
import type { RevisionState } from "./solution-revision-store.ts";

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export async function resolveDesignQuestion(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext,
  loadSnapshot: (companyId: string, platform: SpsPlatformInvocationContext) => Promise<BuilderSnapshot>) {
  const input = exactToolRecord(params, ["projectId", "expectedBaseRevisionId", "questionId", "answerSourceId", "answerText", "draft"]);
  const context = parseLeadToolContext(runContext);
  if (typeof input.projectId !== "string" || typeof input.expectedBaseRevisionId !== "string"
    || typeof input.questionId !== "string" || typeof input.answerText !== "string"
    || typeof input.answerSourceId !== "string" || !/^lead-turn:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.answerSourceId)) {
    throw new TypeError("A scoped question and persisted user answer are required.");
  }
  const next = parseDesignDraft(input.draft, input.projectId);
  const { expectedBaseRevisionId, questionId, answerSourceId, answerText } = input as {
    expectedBaseRevisionId: string; questionId: string; answerSourceId: string; answerText: string;
  };
  const authority = await resolveLeadToolAuthority(context, platform);
  if (authority.sessions.sessions.decisions !== context.sessionId) throw new Error("Question answers require the prepared decisions Lead session.");
  const state = platform.state as typeof platform.state & RevisionState;
  const guarded = {
    get: async (key: Parameters<typeof state.get>[0]) => {
      await authority.check(); const result = await state.get(key); await authority.check(); return result;
    },
    compareAndSet: state.compareAndSet ? async (...args: Parameters<NonNullable<typeof state.compareAndSet>>) => {
      await authority.check(); const result = await state.compareAndSet!(...args); await authority.check(); return result;
    } : undefined,
  };
  const store = createDesignDraftStore(context.companyId, next.projectId,
    { selectionRevision: authority.selectionRevision, agentId: context.agentId }, guarded);
  const current = await store.current();
  if (!current || current.revision.draft.revisionId !== expectedBaseRevisionId) {
    return { content: "The design revision changed. Read the current question and revision; do not automatically retry.",
      data: { status: "conflict", actualBaseRevisionId: current?.revision.draft.revisionId ?? null } as JsonValue };
  }
  const question = current.revision.draft.questions.find(question => question.id === questionId);
  if (!question || current.revision.decisions?.some(decision => decision.questionId === questionId)) throw new Error("This question is unavailable or already answered.");
  const retainedQuestion = next.questions.find(question => question.id === questionId);
  if (JSON.stringify(question) !== JSON.stringify(retainedQuestion) || next.revisionId === current.revision.draft.revisionId
    || next.specification.revisionId === current.revision.draft.specification.revisionId
    || next.graph.graphRevisionId === current.revision.draft.graph.graphRevisionId || !next.sourceIds.includes(answerSourceId)) {
    throw new Error("Keep the answered question unchanged and create new cited design, specification and Graph revisions.");
  }
  const source = await readLeadUserSource(answerSourceId.slice("lead-turn:".length), authority.sessions, platform);
  if (source.questionContext?.projectId !== next.projectId || source.questionContext.draftRevisionId !== expectedBaseRevisionId
    || source.questionContext.questionId !== questionId) throw new Error("The user answer is not bound to this question and design revision.");
  const decisions = parseDesignDecisions([...(current.revision.decisions ?? []), { questionId,
    questionDigest: hash(JSON.stringify(question)), answerSourceId, answerSourceSha256: hash(source.text), answerText,
    fromDraftRevisionId: expectedBaseRevisionId, appliedDraftRevisionId: next.revisionId }], next);
  const snapshot = await loadSnapshot(context.companyId, platform);
  const sourceDigests = [];
  for (const id of next.sourceIds) {
    const cited = id.startsWith("lead-turn:")
      ? await readLeadUserSource(id.slice("lead-turn:".length), authority.sessions, platform)
      : snapshot.messages.find(message => message.id === id && message.role === "user" && message.channel === "main");
    if (!cited || !cited.text.trim()) throw new Error("The revised design cites unavailable user input.");
    sourceDigests.push({ id, sha256: hash(cited.text) });
  }
  await authority.check();
  const authored: AuthoredDesignDraft = { status: "draft", selectionRevision: authority.selectionRevision,
    author: { agentId: context.agentId, sessionId: context.sessionId, runId: context.runId }, createdAt: new Date().toISOString(),
    sourceDigests, draft: next, decisions };
  const result = await store.publish({ expectedBaseRevisionId, revision: authored });
  await authority.check();
  return { content: result.status === "published"
    ? "User answer interpretation and revised draft specification/Graph stored together. This is not customer contract approval, execution, deployment or delivery. Shared memory and downstream work require their own recorded updates."
    : "The design changed. Reconcile with a read; do not automatically retry.", data: result as unknown as JsonValue };
}
