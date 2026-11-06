import { parseCtoQuestionBoard } from "./domain/cto-questions.ts";
import { createRevisionJournal, type RevisionState } from "./solution-revision-store.ts";

export function createCtoQuestionStore(workspaceId: string, projectId: string, state: RevisionState) {
  return createRevisionJournal(workspaceId, projectId, state, { prefix: "cto-questions",
    parse: value => parseCtoQuestionBoard(value, projectId), revisionId: board => board.revisionId });
}
