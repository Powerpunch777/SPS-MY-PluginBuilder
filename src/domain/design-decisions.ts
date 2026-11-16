import type { DesignDraft } from "./design-drafts.ts";

export type DesignDecision = Readonly<{ questionId: string; questionDigest: string;
  answerSourceId: string; answerSourceSha256: string; answerText: string;
  fromDraftRevisionId: string; appliedDraftRevisionId: string }>;

export function parseDesignDecisions(value: unknown, draft: DesignDraft): readonly DesignDecision[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 50
    || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError("Invalid design decisions.");
  const seen = new Set<string>();
  const keys = ["questionId", "questionDigest", "answerSourceId", "answerSourceSha256", "answerText", "fromDraftRevisionId", "appliedDraftRevisionId"];
  const entries = Array.from({ length: value.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !("value" in field)) throw new TypeError("Invalid decision item.");
    const raw: unknown = field.value;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
      || Reflect.ownKeys(raw).length !== keys.length) throw new TypeError("Invalid decision fields.");
    const row: Record<string, string> = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string" || !descriptor.value.trim()) {
        throw new TypeError("Invalid decision value.");
      }
      row[key] = descriptor.value;
    }
    for (const key of ["questionId", "fromDraftRevisionId", "appliedDraftRevisionId"]) {
      if (row[key]!.length > 160 || /[\u0000-\u001f\u007f]/.test(row[key]!)) throw new TypeError("Invalid decision ID.");
    }
    if (!/^[a-f0-9]{64}$/.test(row.questionDigest!) || !/^[a-f0-9]{64}$/.test(row.answerSourceSha256!)
      || !/^lead-turn:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(row.answerSourceId!)
      || new TextEncoder().encode(row.answerText!).length > 8192 || seen.has(row.questionId!)
      || !draft.questions.some(question => question.id === row.questionId)) throw new TypeError("Invalid decision references.");
    seen.add(row.questionId!);
    return Object.freeze({ questionId: row.questionId!, questionDigest: row.questionDigest!, answerSourceId: row.answerSourceId!,
      answerSourceSha256: row.answerSourceSha256!, answerText: row.answerText!, fromDraftRevisionId: row.fromDraftRevisionId!,
      appliedDraftRevisionId: row.appliedDraftRevisionId! });
  });
  return Object.freeze(entries);
}
