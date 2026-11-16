import assert from "node:assert/strict";
import test from "node:test";
import { parseLeadMemoryRevision } from "../src/domain/lead-memory.ts";

const PROJECT = "project-1";
const CONSULTATION = "consultation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TURN = "lead-turn:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function entry(overrides: Record<string, unknown> = {}) {
  return { id: "goal-1", kind: "goal", text: "Ship a useful tool.", sourceIds: [CONSULTATION], ...overrides };
}

function revision(entries: unknown[] = [entry()], overrides: Record<string, unknown> = {}) {
  return { projectId: PROJECT, revisionId: "rev-1", entries, ...overrides };
}

function rejects(value: unknown, expectedProjectId = PROJECT) {
  assert.throws(() => parseLeadMemoryRevision(value, expectedProjectId), TypeError);
}

test("returns a deep-frozen clone and accepts both source ID forms", () => {
  const original = entry({ sourceIds: [CONSULTATION, TURN] });
  const input = revision([original]);
  const parsed = parseLeadMemoryRevision(input, PROJECT);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.entries, input.entries);
  assert.notEqual(parsed.entries[0], input.entries[0]);
  assert.notEqual(parsed.entries[0].sourceIds, original.sourceIds);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.entries) && Object.isFrozen(parsed.entries[0]) && Object.isFrozen(parsed.entries[0].sourceIds));
  assert.ok(!Object.isFrozen(input) && !Object.isFrozen(input.entries) && !Object.isFrozen(input.entries[0]));
  original.text = "changed after parsing";
  assert.equal(parsed.entries[0].text, "Ship a useful tool.");
});

test("allows an empty entries list as a deliberate clear revision", () => {
  assert.deepEqual(parseLeadMemoryRevision(revision([]), PROJECT).entries, []);
});

test("enforces project, ID, entry-count, kind, and duplicate-ID boundaries", () => {
  rejects(revision(), "another-project");
  rejects(revision([], { projectId: "x\u007fy" }));
  rejects(revision([], { revisionId: "r".repeat(161) }));
  assert.equal(parseLeadMemoryRevision(revision([], { revisionId: "r".repeat(160) }), PROJECT).revisionId.length, 160);
  rejects(revision([entry({ id: "a\n" })]));
  rejects(revision([entry(), entry()]));
  rejects(revision([entry({ kind: "approval" })]));
  rejects(revision(Array.from({ length: 129 }, (_, index) => entry({ id: `id-${index}` }))));
  assert.equal(parseLeadMemoryRevision(revision(Array.from({ length: 128 }, (_, index) => entry({ id: `id-${index}` }))), PROJECT).entries.length, 128);
});

test("enforces text UTF-8 and source reference bounds and uniqueness", () => {
  assert.equal(parseLeadMemoryRevision(revision([entry({ text: "é".repeat(2048) })]), PROJECT).entries[0].text.length, 2048);
  rejects(revision([entry({ text: "é".repeat(2049) })]));
  rejects(revision([entry({ text: " \n " })]));
  rejects(revision([entry({ sourceIds: [] })]));
  rejects(revision([entry({ sourceIds: [CONSULTATION, CONSULTATION] })]));
  rejects(revision([entry({ sourceIds: ["lead-turn:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"] })]));
  const maximumSources = Array.from({ length: 32 }, (_, index) => `consultation-${String(index).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
  assert.equal(parseLeadMemoryRevision(revision([entry({ sourceIds: maximumSources })]), PROJECT).entries[0].sourceIds.length, 32);
  rejects(revision([entry({ sourceIds: Array.from({ length: 33 }, (_, index) => `consultation-${String(index).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`) })]));
});

test("rejects unknown fields, including approval or secret claims", () => {
  rejects(revision([], { approved: true }));
  rejects(revision([entry({ approvalEvidenceRef: "approved" })]));
  rejects(revision([entry({ secret: "credential" })]));
});

test("rejects accessors, symbols, custom prototypes, and non-enumerable fields", () => {
  const accessor = revision([]);
  Object.defineProperty(accessor, "revisionId", { enumerable: true, get() { throw new Error("must not run"); } });
  rejects(accessor);
  const symbolic = revision([]);
  Object.defineProperty(symbolic, Symbol("extra"), { value: true });
  rejects(symbolic);
  rejects(Object.assign(Object.create({ inherited: true }), revision([])));
  const hidden = revision([]);
  Object.defineProperty(hidden, "hidden", { value: true });
  rejects(hidden);
});

test("rejects sparse arrays, array accessors, and extra array properties", () => {
  const sparse: unknown[] = [];
  sparse.length = 1;
  rejects(revision(sparse));
  const accessor: unknown[] = [];
  Object.defineProperty(accessor, "0", { enumerable: true, get() { throw new Error("must not run"); } });
  rejects(revision(accessor));
  const extra = [entry()];
  Object.assign(extra, { extra: true });
  rejects(revision(extra));
});

test("rejects revisions above the validated JSON byte limit", () => {
  const tooLarge = revision(Array.from({ length: 32 }, (_, index) => entry({ id: `id-${index}`, text: "x".repeat(4096) })));
  rejects(tooLarge);
});

test("accepts exactly the validated JSON byte limit", () => {
  const entries = Array.from({ length: 31 }, (_, index) => entry({ id: `id-${index}`, text: "x".repeat(4096) }));
  const last = entry({ id: "id-31", text: "x" });
  entries.push(last);
  const baseBytes = new TextEncoder().encode(JSON.stringify(revision(entries))).byteLength;
  last.text = "x".repeat(last.text.length + (128 * 1024 - baseBytes));
  assert.equal(new TextEncoder().encode(JSON.stringify(revision(entries))).byteLength, 128 * 1024);
  assert.equal(parseLeadMemoryRevision(revision(entries), PROJECT).entries.length, 32);
});
