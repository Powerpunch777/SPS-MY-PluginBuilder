import assert from "node:assert/strict";
import test from "node:test";
import { parseQuestionContext } from "../src/domain/question-context.ts";

function context(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: "project-1",
    draftRevisionId: "draft-r01",
    questionId: "question-1",
    ...overrides,
  };
}

test("returns a cloned, frozen context with exactly its three IDs", () => {
  const input = context();
  const parsed = parseQuestionContext(input);

  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.deepEqual(Object.keys(parsed), ["projectId", "draftRevisionId", "questionId"]);
  assert(Object.isFrozen(parsed));

  input.projectId = "mutated";
  assert.equal(parsed.projectId, "project-1");
});

test("accepts null-prototype records and rejects non-plain or non-record values", () => {
  const nullPrototype = Object.assign(Object.create(null) as object, context());
  assert.equal(parseQuestionContext(nullPrototype).questionId, "question-1");

  for (const value of [null, "context", [], new Date(), Object.assign(Object.create({ inherited: true }) as object, context())]) {
    assert.throws(() => parseQuestionContext(value), /Invalid question context/);
  }
});

test("rejects extra, missing, symbol, non-enumerable, and accessor fields without invoking getters", () => {
  assert.throws(() => parseQuestionContext(context({ extra: true })), /fields/);
  assert.throws(() => parseQuestionContext(context({ questionId: undefined })), /ID/);

  const symbolField = context();
  Object.defineProperty(symbolField, Symbol("extra"), { value: true });
  assert.throws(() => parseQuestionContext(symbolField), /fields/);

  const hiddenField = context();
  Object.defineProperty(hiddenField, "hidden", { value: true });
  assert.throws(() => parseQuestionContext(hiddenField), /fields/);

  let calls = 0;
  const accessorField = context();
  Object.defineProperty(accessorField, "projectId", {
    enumerable: true,
    get() { calls += 1; return "project-1"; },
  });
  assert.throws(() => parseQuestionContext(accessorField), /ID/);
  assert.equal(calls, 0);
});

test("rejects blank, oversized, and control-character IDs", () => {
  for (const overrides of [
    { projectId: "  " },
    { draftRevisionId: "x".repeat(161) },
    { questionId: "question\n1" },
  ]) {
    assert.throws(() => parseQuestionContext(context(overrides)), /ID/);
  }
});
