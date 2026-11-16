export type QuestionContext = Readonly<{ projectId: string; draftRevisionId: string; questionId: string }>;

/** Association only. It is never proof of approval or permission. */
export function parseQuestionContext(value: unknown): QuestionContext {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Invalid question context.");
  const keys = ["projectId", "draftRevisionId", "questionId"];
  if (Reflect.ownKeys(value).length !== keys.length) throw new TypeError("Invalid question context fields.");
  const result: Record<string, string> = Object.create(null);
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !("value" in field) || typeof field.value !== "string" || !field.value.trim()
      || field.value.length > 160 || /[\u0000-\u001f\u007f]/.test(field.value)) throw new TypeError("Invalid question context ID.");
    result[key] = field.value;
  }
  return Object.freeze({ projectId: result.projectId!, draftRevisionId: result.draftRevisionId!, questionId: result.questionId! });
}
