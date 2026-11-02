import assert from "node:assert/strict";
import test from "node:test";
import { parseDesignDraft, type DesignDraft } from "../src/domain/design-drafts.ts";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: "project-1",
    revisionId: "draft-r01",
    sourceIds: [`consultation-${UUID}`, `lead-turn:${UUID}`],
    specification: {
      revisionId: "spec-r01",
      productTier: "M",
      requirements: [{ id: "REQ-1", description: "Export the report", acceptanceCriteriaIds: ["AC-1"] }],
      targets: ["desktop"],
      dataPolicyRef: "policy-r01",
    },
    graph: {
      graphRevisionId: "graph-r01",
      entities: [{ id: "feature-a", kind: "feature", specRef: "REQ-1", contractRefs: ["API-1"] }],
      relations: [],
      viewLayoutRef: "layout-r01",
    },
    questions: [{
      id: "question-1",
      title: "Export format",
      text: "Which format should the report use?",
      options: [
        { id: "csv", label: "CSV", tradeoff: "Easy to process" },
        { id: "json", label: "JSON", tradeoff: "Preserves structure" },
      ],
      recommendation: "csv",
    }],
    ...overrides,
  };
}

function parse(value: unknown): DesignDraft {
  return parseDesignDraft(value, "project-1");
}

test("returns an exact, deeply frozen clone without approval metadata", () => {
  const input = draft();
  const parsed = parse(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.specification, input.specification);
  assert.notEqual(parsed.graph, input.graph);
  assert.notEqual(parsed.questions, input.questions);
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.sourceIds));
  assert(Object.isFrozen(parsed.specification));
  assert(Object.isFrozen(parsed.specification.requirements[0]));
  assert(Object.isFrozen(parsed.specification.requirements[0]!.acceptanceCriteriaIds));
  assert(Object.isFrozen(parsed.specification.targets));
  assert(Object.isFrozen(parsed.graph));
  assert(Object.isFrozen(parsed.graph.entities[0]));
  assert(Object.isFrozen(parsed.graph.entities[0]!.contractRefs));
  assert(Object.isFrozen(parsed.questions[0]));
  assert(Object.isFrozen(parsed.questions[0]!.options));
  assert(Object.isFrozen(parsed.questions[0]!.options[0]));
  assert.equal("approvalEvidenceRef" in parsed.specification, false);
  assert.equal("approvedSpecRevisionId" in parsed.graph, false);

  (input.sourceIds as string[]).push(`consultation-${UUID}`);
  ((input.specification as { requirements: { description: string }[] }).requirements[0]!).description = "mutated";
  ((input.graph as { entities: { id: string }[] }).entities[0]!).id = "mutated";
  ((input.questions as { options: { label: string }[] }[])[0]!).options[0]!.label = "mutated";
  assert.equal(parsed.sourceIds.length, 2);
  assert.equal(parsed.specification.requirements[0]!.description, "Export the report");
  assert.equal(parsed.graph.entities[0]!.id, "feature-a");
  assert.equal(parsed.questions[0]!.options[0]!.label, "CSV");
});

test("accepts no questions and validates source IDs and unique references", () => {
  assert.deepEqual(parse(draft({ questions: [] })).questions, []);
  const historical = "consultation-AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
  assert.deepEqual(parse(draft({ sourceIds: [historical] })).sourceIds, [historical]);
  for (const sourceId of ["lead-turn:AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", "consultation-not-a-uuid", `other-${UUID}`]) {
    assert.throws(() => parse(draft({ sourceIds: [sourceId] })), /source ID format/);
  }
  assert.throws(() => parse(draft({ sourceIds: [] })), /at least one/);
  assert.throws(() => parse(draft({ sourceIds: [`consultation-${UUID}`, `consultation-${UUID}`] })), /duplicate IDs/);
});

test("rejects approval, answer, and execution metadata at every exact contract boundary", () => {
  assert.throws(() => parse(draft({ approvalEvidenceRef: "evidence" })), /unknown or missing fields/);
  assert.throws(() => parse(draft({ specification: { ...draft().specification as object, approvalEvidenceRef: "evidence" } })), /unknown or missing fields/);
  assert.throws(() => parse(draft({ specification: { ...draft().specification as object, status: "approved" } })), /unknown or missing fields/);
  assert.throws(() => parse(draft({ graph: { ...draft().graph as object, approvedSpecRevisionId: "spec-r01" } })), /unknown or missing fields/);
  assert.throws(() => parse(draft({ questions: [{ ...((draft().questions as object[])[0]!), status: "open" }] })), /unknown or missing fields/);
  assert.throws(() => parse(draft({ questions: [{ ...((draft().questions as object[])[0]!), answer: "csv" }] })), /unknown or missing fields/);
});

test("rejects project mismatches, unknown fields, symbols, custom prototypes, and getters without invoking them", () => {
  assert.throws(() => parseDesignDraft(draft({ projectId: "project-2" }), "project-1"), /does not match/);
  assert.throws(() => parse(draft({ extra: true })), /unknown or missing fields/);
  const symbolField = draft();
  Object.defineProperty(symbolField, Symbol("extra"), { value: true });
  assert.throws(() => parse(symbolField), /unknown or missing fields/);
  const customPrototype = Object.assign(Object.create({ inherited: true }) as object, draft());
  assert.throws(() => parse(customPrototype), /plain record/);

  let calls = 0;
  const getter = draft();
  Object.defineProperty(getter, "projectId", { enumerable: true, get() { calls += 1; return "project-1"; } });
  assert.throws(() => parse(getter), /data field/);
  assert.equal(calls, 0);
});

test("rejects sparse arrays and arrays carrying extra properties", () => {
  const sparse = new Array(1);
  assert.throws(() => parse(draft({ sourceIds: sparse })), /dense/);
  const withExtra = [`consultation-${UUID}`] as string[] & { extra?: boolean };
  withExtra.extra = true;
  assert.throws(() => parse(draft({ sourceIds: withExtra })), /dense/);
  const accessorArray = [`consultation-${UUID}`];
  Object.defineProperty(accessorArray, "0", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.throws(() => parse(draft({ sourceIds: accessorArray })), /dense data/);
});

test("enforces bounded identifiers, UTF-8 text sizes, and option recommendations", () => {
  assert.throws(() => parse(draft({ revisionId: `x\n` })), /identifier/);
  assert.throws(() => parse(draft({ revisionId: "x".repeat(161) })), /identifier/);
  assert.throws(() => parse(draft({ questions: [{ ...((draft().questions as object[])[0]!), title: "😀".repeat(65) }] })), /256 UTF-8 bytes/);
  assert.throws(() => parse(draft({ questions: [{ ...((draft().questions as object[])[0]!), text: "😀".repeat(2_049) }] })), /8192 UTF-8 bytes/);
  assert.throws(() => parse(draft({ questions: [{ ...((draft().questions as object[])[0]!), recommendation: "missing" }] })), /identify one of its options/);
  assert.throws(() => parse(draft({ questions: [{ ...((draft().questions as object[])[0]!), options: [
    { id: "dup", label: "A", tradeoff: "A" }, { id: "dup", label: "B", tradeoff: "B" },
  ] }] })), /duplicate IDs/);
  assert.throws(() => parse(draft({ questions: [{ ...((draft().questions as object[])[0]!), options: [
    { id: "a", label: "A", tradeoff: "😀".repeat(513) },
  ], recommendation: null }] })), /2048 UTF-8 bytes/);
});

test("reuses specification and graph invariants and rejects dangling requirement references", () => {
  assert.throws(() => parse(draft({ specification: { ...draft().specification as object, requirements: [] } })), /must not be empty/);
  assert.throws(() => parse(draft({ specification: { ...draft().specification as object, targets: [] } })), /must not be empty/);
  assert.throws(() => parse(draft({ graph: { ...draft().graph as object, entities: [
    { id: "a", kind: "feature", specRef: "REQ-absent" },
  ] } })), /undeclared requirement/);
  assert.throws(() => parse(draft({ graph: { ...draft().graph as object, entities: [
    { id: "a", kind: "feature" }, { id: "b", kind: "feature" },
  ], relations: [
    { id: "ab", sourceId: "a", targetId: "b", kind: "depends_on" },
    { id: "ba", sourceId: "b", targetId: "a", kind: "depends_on" },
  ] } })), /must form a DAG/);
  assert.throws(() => parse(draft({ graph: { ...draft().graph as object, entities: [
    { id: "a", kind: "feature" }, { id: "a", kind: "component" },
  ] } })), /duplicate IDs/);
  assert.throws(() => parse(draft({ graph: { ...draft().graph as object, entities: [
    { id: "bad\nentity", kind: "feature" },
  ] } })), /identifier/);
});

test("rejects oversized total validated JSON", () => {
  assert.throws(() => parse(draft({ questions: [{
    id: "q", title: "Title", text: "x".repeat(8 * 1024), options: [], recommendation: null,
  }, {
    id: "q2", title: "Title", text: "y".repeat(8 * 1024), options: [], recommendation: null,
  }, {
    id: "q3", title: "Title", text: "z".repeat(8 * 1024), options: [], recommendation: null,
  }, {
    id: "q4", title: "Title", text: "v".repeat(8 * 1024), options: [], recommendation: null,
  }, {
    id: "q5", title: "Title", text: "w".repeat(8 * 1024), options: [], recommendation: null,
  }, {
    id: "q6", title: "Title", text: "r".repeat(8 * 1024), options: [], recommendation: null,
  }, {
    id: "q7", title: "Title", text: "s".repeat(8 * 1024), options: [], recommendation: null,
  }, {
    id: "q8", title: "Title", text: "t".repeat(8 * 1024), options: [], recommendation: null,
  }, {
    id: "q9", title: "Title", text: "u".repeat(8 * 1024), options: [], recommendation: null,
  }, {
    id: "q10", title: "Title", text: "n".repeat(8 * 1024), options: [], recommendation: null,
  }, {
    id: "q11", title: "Title", text: "m".repeat(8 * 1024), options: [], recommendation: null,
  }, {
    id: "q12", title: "Title", text: "p".repeat(8 * 1024), options: [], recommendation: null,
  }, {
    id: "q13", title: "Title", text: "k".repeat(8 * 1024), options: [], recommendation: null,
  }, {
    id: "q14", title: "Title", text: "j".repeat(8 * 1024), options: [], recommendation: null,
  }, {
    id: "q15", title: "Title", text: "h".repeat(8 * 1024), options: [], recommendation: null,
  }, {
    id: "q16", title: "Title", text: "g".repeat(8 * 1024), options: [], recommendation: null,
  }] })), /131072-byte validated JSON limit/);
});
