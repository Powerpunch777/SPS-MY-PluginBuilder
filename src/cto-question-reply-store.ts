import { createHash } from "node:crypto";
import { parseCtoQuestionReply } from "./domain/cto-question-replies.ts";
import { createRevisionJournal, type RevisionState } from "./solution-revision-store.ts";

export function createCtoQuestionReplyStore(workspaceId: string, projectId: string, questionId: string, state: RevisionState) {
  const key = createHash("sha256").update(JSON.stringify([projectId, questionId])).digest("hex");
  return createRevisionJournal(workspaceId, `reply:${key}`, state, { prefix: "cto-question-reply",
    parse: value => parseCtoQuestionReply(value, workspaceId, projectId, questionId), revisionId: value => value.revisionId });
}
