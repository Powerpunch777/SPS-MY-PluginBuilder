import assert from "node:assert/strict";
import test from "node:test";
import { parseTechnologyDecisionRegister } from "../src/domain/technology-decisions.ts";

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tech-1",
    technology: "Example Runtime",
    disposition: "allowed",
    selectionReason: "Fits the stated interface.",
    nonSelectionReason: "",
    scopeNodeIds: [],
    interoperability: ["HTTP"],
    constraints: ["No secrets in configuration."],
    cost: "Model-reported estimate: low.",
    versionCompatibility: "Version range reported by model: v1.",
    changeApprovalOwner: "Platform owner",
    licenseReview: { status: "unreviewed", licenseExpression: null, evidenceRefs: [] },
    verification: { level: "not-verified", evidenceRefs: [], limitations: "No test performed.", nextReviewCondition: "Before adoption." },
    ...overrides,
  };
}

function register(entries: unknown[] = [entry()], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: "project-1",
    revisionId: "decision-r1",
    sourceBaselineRevisionId: "baseline-r1",
    sourceSpecRevisionId: "spec-r1",
    sourceGraphRevisionId: "graph-r1",
    entries,
    ...overrides,
  };
}

test("accepts an empty register as no recorded choice and freezes a detached snapshot", () => {
  const empty = parseTechnologyDecisionRegister(register([]), "project-1");
  assert.deepEqual(empty.entries, []);
  const input = register();
  const inputEntries = input.entries as Record<string, unknown>[];
  const parsed = parseTechnologyDecisionRegister(input, "project-1");
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.entries, inputEntries);
  assert.notEqual(parsed.entries[0], inputEntries[0]);
  assert(Object.isFrozen(parsed) && Object.isFrozen(parsed.entries));
  assert(Object.isFrozen(parsed.entries[0]) && Object.isFrozen(parsed.entries[0]!.licenseReview));
  assert(Object.isFrozen(parsed.entries[0]!.verification));
  inputEntries[0]!.technology = "Changed";
  assert.equal(parsed.entries[0]!.technology, "Example Runtime");
});

test("enforces reason pair, exact enums, licenses, and evidence level semantics", () => {
  assert.throws(() => parseTechnologyDecisionRegister(register([entry({ selectionReason: "", nonSelectionReason: "  " })]), "project-1"), /reason/);
  assert.throws(() => parseTechnologyDecisionRegister(register([entry({ disposition: "default" })]), "project-1"), /disposition/);
  assert.throws(() => parseTechnologyDecisionRegister(register([entry({ licenseReview: { status: "reviewed", licenseExpression: "MIT", evidenceRefs: ["license-1"] } })]), "project-1"), /status/);
  assert.throws(() => parseTechnologyDecisionRegister(register([entry({ licenseReview: { status: "unreviewed", licenseExpression: "MIT", evidenceRefs: [] } })]), "project-1"), /expression/);
  assert.throws(() => parseTechnologyDecisionRegister(register([entry({ licenseReview: { status: "reported-reviewed", licenseExpression: "MIT", evidenceRefs: [] } })]), "project-1"), /evidence/);
  assert.throws(() => parseTechnologyDecisionRegister(register([entry({ verification: { level: "documentation-only", evidenceRefs: [], limitations: "None", nextReviewCondition: "Later" } })]), "project-1"), /evidence/);
  assert.throws(() => parseTechnologyDecisionRegister(register([entry({ verification: { level: "not-verified", evidenceRefs: ["test-1"], limitations: "None", nextReviewCondition: "Later" } })]), "project-1"), /evidence/);

  const modelReport = entry({
    licenseReview: { status: "reported-reviewed", licenseExpression: "MIT", evidenceRefs: ["license-page"] },
    verification: { level: "reported-integration-test", evidenceRefs: ["test-report"], limitations: "Model-reported only.", nextReviewCondition: "Repeat in target host." },
  });
  const parsed = parseTechnologyDecisionRegister(register([modelReport]), "project-1");
  assert.equal(parsed.entries[0]!.licenseReview.status, "reported-reviewed");
  assert.equal(parsed.entries[0]!.verification.level, "reported-integration-test");
  assert.deepEqual(Object.keys(parsed.entries[0]!.licenseReview), ["status", "licenseExpression", "evidenceRefs"]);
  assert.deepEqual(Object.keys(parsed.entries[0]!.verification), ["level", "evidenceRefs", "limitations", "nextReviewCondition"]);
});

test("rejects project mismatch, duplicate exact labels, malformed objects, and malformed arrays", () => {
  assert.throws(() => parseTechnologyDecisionRegister(register(), "other-project"), /does not match/);
  assert.throws(() => parseTechnologyDecisionRegister(register([entry(), entry({ id: "tech-2" })]), "project-1"), /duplicate/);
  assert.throws(() => parseTechnologyDecisionRegister(register([entry(), entry({ id: "tech-2", technology: "Example Runtime" })]), "project-1"), /duplicate/);
  assert.throws(() => parseTechnologyDecisionRegister(register([entry({ extra: true })]), "project-1"), /unknown or missing/);

  const symbolRecord = entry();
  Object.defineProperty(symbolRecord, Symbol("extra"), { value: true });
  assert.throws(() => parseTechnologyDecisionRegister(register([symbolRecord]), "project-1"), /unknown or missing/);

  let calls = 0;
  const getterRecord = entry();
  Object.defineProperty(getterRecord, "technology", { enumerable: true, get() { calls += 1; return "bad"; } });
  assert.throws(() => parseTechnologyDecisionRegister(register([getterRecord]), "project-1"), /data field/);
  assert.equal(calls, 0);

  const sparse = new Array(1);
  assert.throws(() => parseTechnologyDecisionRegister(register(sparse), "project-1"), /dense array/);
  const augmented = [entry()] as unknown[] & { extra?: boolean };
  augmented.extra = true;
  assert.throws(() => parseTechnologyDecisionRegister(register(augmented), "project-1"), /dense array/);
});

test("enforces UTF-8 byte limits and the complete serialized register bound", () => {
  assert.throws(() => parseTechnologyDecisionRegister(register([entry({ technology: "가".repeat(171) })]), "project-1"), /UTF-8 bytes/);
  assert.throws(() => parseTechnologyDecisionRegister(register([entry({ id: "x\u0000y" })]), "project-1"), /control/);
  assert.throws(() => parseTechnologyDecisionRegister(register([entry({ constraints: ["é".repeat(2049)] })]), "project-1"), /UTF-8 bytes/);
  const largeEntries = Array.from({ length: 33 }, (_, index) => entry({
    id: `tech-${index}`,
    technology: `Runtime ${index}`,
    constraints: ["x".repeat(4096)],
  }));
  assert.throws(() => parseTechnologyDecisionRegister(register(largeEntries), "project-1"), /131072-byte limit/);
});

test("preserves exact technology labels without case-folding", () => {
  const parsed = parseTechnologyDecisionRegister(register([entry(), entry({ id: "tech-2", technology: "example runtime" })]), "project-1");
  assert.equal(parsed.entries.length, 2);
});

test("rejects exact duplicates in uniqueItems arrays", () => {
  const duplicateCases = [
    entry({ scopeNodeIds: ["node-1", "node-1"] }),
    entry({ interoperability: ["HTTP", "HTTP"] }),
    entry({ constraints: ["No secrets in configuration.", "No secrets in configuration."] }),
    entry({ licenseReview: { status: "unreviewed", licenseExpression: null, evidenceRefs: ["license-1", "license-1"] } }),
    entry({ verification: { level: "documentation-only", evidenceRefs: ["doc-1", "doc-1"], limitations: "None", nextReviewCondition: "Later" } }),
  ];
  for (const duplicate of duplicateCases) {
    assert.throws(() => parseTechnologyDecisionRegister(register([duplicate]), "project-1"), /must not contain duplicates/);
  }
});
