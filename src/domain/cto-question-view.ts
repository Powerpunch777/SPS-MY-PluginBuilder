import type { BuilderQuestion, BuilderSnapshot } from "./model.ts";
import { parseCtoQuestionBoard } from "./cto-questions.ts";

export type CtoUserQuestionsView = Readonly<{
  workspaceId: string;
  projectId: string;
  sequence: number;
  board: ReturnType<typeof parseCtoQuestionBoard>;
}>;

function exactRecord(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a plain record.`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) {
    throw new TypeError(`${label} has unknown or missing fields.`);
  }
  const row: Record<string, unknown> = Object.create(null);
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new TypeError(`${label}.${key} must be an enumerable data field.`);
    row[key] = descriptor.value;
  }
  return row;
}

export function parseCtoUserQuestionsView(value: unknown, workspaceId: string, projectId: string): CtoUserQuestionsView {
  const row = exactRecord(value, ["workspaceId", "projectId", "sequence", "board"], "ctoUserQuestionsView");
  if (row.workspaceId !== workspaceId || row.projectId !== projectId
    || typeof row.sequence !== "number" || !Number.isSafeInteger(row.sequence) || row.sequence < 1) {
    throw new TypeError("Stale or cross-scope CTO user questions view.");
  }
  const board = parseCtoQuestionBoard(row.board, projectId);
  return Object.freeze({ workspaceId, projectId, sequence: row.sequence, board });
}

export function projectCtoUserQuestions(snapshot: BuilderSnapshot, view: CtoUserQuestionsView): BuilderSnapshot {
  if (snapshot.workspaceId !== view.workspaceId) throw new TypeError("CTO question projection belongs to a different Workspace.");
  const questions: BuilderQuestion[] = view.board.questions
    .filter(question => question.review?.disposition === "user-decision-needed")
    .map(question => Object.freeze({
      id: `cto-intake:${view.projectId}:${question.proposal.id}`,
      title: question.proposal.title,
      text: `${question.proposal.context}\n\n필요한 이유: ${question.proposal.reasonNeeded}\n\n미룰 때 영향: ${question.proposal.delayImpact}\n\nLead 검토: ${question.review!.rationale}`,
      status: "open",
      options: question.proposal.options.map(option => ({ id: option.id, label: option.label, tradeoff: option.tradeoff })),
      recommendation: null,
      ctoRecommendation: question.proposal.recommendation,
      answer: null,
      revisionId: view.board.revisionId,
      decisionOrigin: "cto-intake",
      answerUnavailableReason: "이 CTO 질문의 답변 연결은 아직 준비되지 않았습니다.",
      originQuestionId: question.proposal.id,
      originWorkstreamId: question.reporter.workstreamId,
    }));
  return { ...snapshot, questions };
}
