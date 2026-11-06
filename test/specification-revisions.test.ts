import assert from "node:assert/strict";
import test from "node:test";
import {
  DELIVERY_TARGETS,
  PRODUCT_TIERS,
  parseApprovedSpecRevision,
  type ApprovedSpecRevision,
} from "../src/domain/specification-revisions.ts";

function revision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: "project-1",
    revisionId: "spec-r01",
    productTier: "M",
    requirements: [{ id: "REQ-1", description: "Export a project report", acceptanceCriteriaIds: ["AC-1"] }],
    targets: ["desktop"],
    dataPolicyRef: "policy-r01",
    approvalEvidenceRef: "evidence-r01",
    ...overrides,
  };
}

function parse(value: unknown): ApprovedSpecRevision {
  return parseApprovedSpecRevision(value, "project-1");
}

test("returns a deeply frozen clone of the exact conceptual revision fields", () => {
  const input = revision();
  const parsed = parse(input);

  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.requirements, input.requirements);
  assert.notEqual(parsed.requirements[0], (input.requirements as object[])[0]);
  assert.notEqual(parsed.requirements[0]!.acceptanceCriteriaIds, ((input.requirements as { acceptanceCriteriaIds: string[] }[])[0]!).acceptanceCriteriaIds);
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.requirements));
  assert(Object.isFrozen(parsed.requirements[0]));
  assert(Object.isFrozen(parsed.requirements[0]!.acceptanceCriteriaIds));
  assert(Object.isFrozen(parsed.targets));

  ((input.requirements as { description: string; acceptanceCriteriaIds: string[] }[])[0]!).description = "Changed by caller";
  ((input.requirements as { description: string; acceptanceCriteriaIds: string[] }[])[0]!).acceptanceCriteriaIds.push("AC-2");
  (input.targets as string[]).push("hybrid");
  assert.equal(parsed.requirements[0]!.description, "Export a project report");
  assert.deepEqual(parsed.requirements[0]!.acceptanceCriteriaIds, ["AC-1"]);
  assert.deepEqual(parsed.targets, ["desktop"]);
});

test("accepts each supported product tier and target and permits shared acceptance criteria IDs", () => {
  for (const productTier of PRODUCT_TIERS) assert.equal(parse(revision({ productTier })).productTier, productTier);
  for (const target of DELIVERY_TARGETS) assert.deepEqual(parse(revision({ targets: [target] })).targets, [target]);

  const parsed = parse(revision({ requirements: [
    { id: "REQ-1", description: "First description", acceptanceCriteriaIds: ["AC-SHARED"] },
    { id: "REQ-2", description: "Second description", acceptanceCriteriaIds: ["AC-SHARED"] },
  ] }));
  assert.equal(parsed.requirements.length, 2);
});

test("rejects non-record top-level values and mismatched project boundaries", () => {
  for (const value of [null, undefined, true, 42, "revision", [], () => undefined]) {
    assert.throws(() => parse(value), TypeError);
  }
  assert.throws(() => parseApprovedSpecRevision(revision({ projectId: "project-2" }), "project-1"), /does not match/);
  assert.throws(() => parseApprovedSpecRevision(revision(), " \t "), /expectedProjectId/);
});

test("rejects missing and extra fields, symbols, custom prototypes, and accessors without invoking them", () => {
  const missing = revision();
  delete missing.dataPolicyRef;
  assert.throws(() => parse(missing), /unknown or missing fields/);
  assert.throws(() => parse(revision({ extra: true })), /unknown or missing fields/);

  const symbolField = revision();
  Object.defineProperty(symbolField, Symbol("hidden"), { value: true });
  assert.throws(() => parse(symbolField), /unknown or missing fields/);

  const customRecord = Object.assign(Object.create({ inherited: true }) as object, revision());
  assert.throws(() => parse(customRecord), /plain record/);

  let getterCalls = 0;
  const accessorRecord = revision();
  Object.defineProperty(accessorRecord, "projectId", { enumerable: true, get() { getterCalls += 1; return "project-1"; } });
  assert.throws(() => parse(accessorRecord), /data field/);
  const toJsonAccessor = revision();
  Object.defineProperty(toJsonAccessor, "toJSON", { enumerable: true, get() { getterCalls += 1; return () => ({}); } });
  assert.throws(() => parse(toJsonAccessor), /unknown or missing fields/);
  assert.equal(getterCalls, 0);
});

test("rejects unsupported prototypes, sparse arrays, accessors, and array side properties", () => {
  const sparse = new Array(1);
  assert.throws(() => parse(revision({ targets: sparse })), /dense/);
  const arrayWithExtra = ["desktop"] as string[] & { extra?: boolean };
  arrayWithExtra.extra = true;
  assert.throws(() => parse(revision({ targets: arrayWithExtra })), /dense/);

  const accessorArray = ["desktop"];
  Object.defineProperty(accessorArray, "0", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.throws(() => parse(revision({ targets: accessorArray })), /dense data/);
  assert.throws(() => parse(revision({ targets: Object.setPrototypeOf(["desktop"], {}) })), /standard array/);
});

test("validates IDs, controls, descriptions, and Unicode byte bounds", () => {
  for (const invalid of [null, undefined, true, 7, {}, []]) {
    assert.throws(() => parse(revision({ revisionId: invalid })), /identifier/);
    assert.throws(() => parse(revision({ requirements: [{ id: "REQ-1", description: invalid, acceptanceCriteriaIds: [] }] })), TypeError);
  }
  for (const field of ["revisionId", "dataPolicyRef", "approvalEvidenceRef"] as const) {
    assert.throws(() => parse(revision({ [field]: "\u0000bad" })), /identifier/);
    assert.throws(() => parse(revision({ [field]: "x".repeat(161) })), /identifier/);
  }
  assert.throws(() => parse(revision({ projectId: "\u007f" })), /identifier/);
  assert.throws(() => parse(revision({ requirements: [{ id: "\n", description: "Valid description", acceptanceCriteriaIds: [] }] })), /identifier/);
  assert.throws(() => parse(revision({ requirements: [{ id: "REQ-1", description: " \t ", acceptanceCriteriaIds: [] }] })), /description/);
  assert.throws(() => parse(revision({ requirements: [{ id: "REQ-1", description: "😀".repeat(2_049), acceptanceCriteriaIds: [] }] })), /UTF-8 bytes/);
  assert.throws(() => parse(revision({ requirements: [{ id: "REQ-1", description: "Valid description", acceptanceCriteriaIds: [null] }] })), /identifier/);
  assert.equal(parse(revision({ requirements: [{ id: "요구-1", description: "😀".repeat(2_048), acceptanceCriteriaIds: [] }] })).requirements[0]!.description.length, 4_096);
});

test("rejects unknown enums, duplicate IDs or references, and empty approved-spec collections", () => {
  assert.throws(() => parse(revision({ productTier: "XXL" })), /unsupported/);
  assert.throws(() => parse(revision({ targets: ["browser"] })), /unsupported/);
  assert.throws(() => parse(revision({ targets: ["desktop", "desktop"] })), /duplicates/);
  assert.throws(() => parse(revision({ requirements: [] })), /must not be empty/);
  assert.throws(() => parse(revision({ targets: [] })), /must not be empty/);

  const duplicateRequirement = { id: "REQ-1", description: "Another requirement", acceptanceCriteriaIds: [] };
  assert.throws(() => parse(revision({ requirements: [
    { id: "REQ-1", description: "First requirement", acceptanceCriteriaIds: [] },
    duplicateRequirement,
  ] })), /duplicate IDs/);
  assert.throws(() => parse(revision({ requirements: [
    { id: "REQ-1", description: "First requirement", acceptanceCriteriaIds: ["AC-1", "AC-1"] },
  ] })), /duplicate IDs/);
});

test("enforces bounded collection sizes and the 192 KiB validated JSON limit", () => {
  assert.throws(() => parse(revision({ requirements: Array.from({ length: 1_001 }, (_, index) => ({
    id: `REQ-${index}`,
    description: "A valid requirement",
    acceptanceCriteriaIds: [],
  })) })), /at most 1000/);
  assert.throws(() => parse(revision({ requirements: [{
    id: "REQ-1",
    description: "A valid requirement",
    acceptanceCriteriaIds: Array.from({ length: 101 }, (_, index) => `AC-${index}`),
  }] })), /at most 100/);
  assert.throws(() => parse(revision({ targets: [...DELIVERY_TARGETS, "desktop"] })), /at most 6/);
  assert.throws(() => parse(revision({ requirements: [{
    id: "REQ-1",
    description: "A valid requirement",
    acceptanceCriteriaIds: [],
  }, ...Array.from({ length: 24 }, (_, index) => ({
    id: `REQ-${index + 2}`,
    description: "d".repeat(8 * 1024),
    acceptanceCriteriaIds: [],
  }))] })), /196608-byte Builder storage limit/);
});

test("does not claim approval, license, Core capacity, or execution based on reference presence", () => {
  const parsed = parse(revision({ approvalEvidenceRef: "not-verified" }));
  assert.equal(parsed.approvalEvidenceRef, "not-verified");
});
