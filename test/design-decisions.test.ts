import assert from "node:assert/strict";
import test from "node:test";
import type { DesignDraft } from "../src/domain/design-drafts.ts";
import { parseDesignDecisions } from "../src/domain/design-decisions.ts";

const SHA = "a".repeat(64);
const ANSWER_SOURCE_ID = "lead-turn:123e4567-e89b-42d3-a456-426614174000";

function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    questionId: "question-1",
    questionDigest: SHA,
    answerSourceId: ANSWER_SOURCE_ID,
    answerSourceSha256: "b".repeat(64),
    answerText: "Use CSV for exports.",
    fromDraftRevisionId: "draft-r01",
    appliedDraftRevisionId: "draft-r02",
    ...overrides,
  };
}

function draft(questionIds = ["question-1"]): DesignDraft {
  return { projectId: "project-1", revisionId: "draft-r02", sourceIds: [ANSWER_SOURCE_ID],
    specification: { revisionId: "spec-2", productTier: "M", requirements: [], targets: ["desktop"], dataPolicyRef: "unreviewed" },
    graph: { graphRevisionId: "graph-2", entities: [], relations: [], viewLayoutRef: "layout-2" },
    questions: questionIds.map(id => ({ id, title: "Choose", text: "Which format?", options: [], recommendation: null })) };
}

test("accepts legacy undefined as a frozen empty list", () => {
  const parsed = parseDesignDecisions(undefined, draft());
  assert.deepEqual(parsed, []);
  assert(Object.isFrozen(parsed));
});

test("returns frozen cloned decisions and a frozen list", () => {
  const input = [decision()];
  const parsed = parseDesignDecisions(input, draft());

  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed[0], input[0]);
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed[0]));

  (input[0] as Record<string, unknown>).answerText = "mutated";
  assert.equal(parsed[0]!.answerText, "Use CSV for exports.");
});

test("rejects unavailable or duplicate question references", () => {
  assert.throws(() => parseDesignDecisions([decision({ questionId: "question-absent" })], draft()), /references/);
  assert.throws(() => parseDesignDecisions([decision(), decision()], draft()), /references/);
});

test("validates digest and answer-source citation formats", () => {
  for (const overrides of [
    { questionDigest: "A".repeat(64) },
    { questionDigest: "a".repeat(63) },
    { answerSourceSha256: "not-a-digest" },
    { answerSourceId: "lead-turn:not-a-uuid" },
    { answerSourceId: "lead-turn:123e4567-e89b-42d3-a456-42661417400A" },
  ]) {
    assert.throws(() => parseDesignDecisions([decision(overrides)], draft()), /references/);
  }
});

test("requires exact plain decision records and never invokes accessors", () => {
  assert.throws(() => parseDesignDecisions([decision({ extra: true })], draft()), /fields/);

  const symbolField = decision();
  Object.defineProperty(symbolField, Symbol("extra"), { value: true });
  assert.throws(() => parseDesignDecisions([symbolField], draft()), /fields/);

  const customPrototype = Object.assign(Object.create({ inherited: true }) as object, decision());
  assert.throws(() => parseDesignDecisions([customPrototype], draft()), /fields/);

  let calls = 0;
  const accessorField = decision();
  Object.defineProperty(accessorField, "answerText", {
    enumerable: true,
    get() { calls += 1; return "Use CSV for exports."; },
  });
  assert.throws(() => parseDesignDecisions([accessorField], draft()), /value/);
  assert.equal(calls, 0);
});

test("rejects sparse, accessor-backed, or augmented decision arrays", () => {
  const sparse = new Array(1);
  assert.throws(() => parseDesignDecisions(sparse, draft()), /Invalid design decisions/);

  const accessorArray = [decision()];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get() { throw new Error("array getter must not run"); },
  });
  assert.throws(() => parseDesignDecisions(accessorArray, draft()), /Invalid decision item/);

  const augmented = [decision()] as Record<string, unknown>[] & { extra?: boolean };
  augmented.extra = true;
  assert.throws(() => parseDesignDecisions(augmented, draft()), /Invalid design decisions/);

  const symbolArray = [decision()];
  Object.defineProperty(symbolArray, Symbol("extra"), { value: true });
  assert.throws(() => parseDesignDecisions(symbolArray, draft()), /Invalid design decisions/);
});
