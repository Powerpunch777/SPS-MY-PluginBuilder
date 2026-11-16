import assert from "node:assert/strict";
import test from "node:test";
import { parseCtoMemoryRevision, type CtoMemoryRevision } from "../src/domain/cto-memory.ts";

const projectId = "project-memory";
const ctoId = "cto-memory";
const requestId = "11111111-1111-4111-8111-111111111111";
const otherRequestId = "22222222-2222-4222-8222-222222222222";

function entry(overrides: Record<string, unknown> = {}) {
  return { id: "MEM-001", kind: "context", text: "Pinned project context.", sourceRequestIds: [requestId], ...overrides };
}

function memory(overrides: Record<string, unknown> = {}) {
  return { projectId, ctoId, revisionId: "memory-rev-1", entries: [entry()], ...overrides };
}

test("parses an exact scoped DTO into a detached deeply frozen snapshot", () => {
  const input = memory();
  const parsed = parseCtoMemoryRevision(input, projectId, ctoId);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.entries, input.entries);
  assert.notEqual(parsed.entries[0], input.entries[0]);
  assert.notEqual(parsed.entries[0]?.sourceRequestIds, input.entries[0]?.sourceRequestIds);
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.entries));
  assert(Object.isFrozen(parsed.entries[0]));
  assert(Object.isFrozen(parsed.entries[0]?.sourceRequestIds));
  (input.entries[0]?.sourceRequestIds as string[]).push(otherRequestId);
  assert.deepEqual(parsed.entries[0]?.sourceRequestIds, [requestId]);
  assert.deepEqual(parseCtoMemoryRevision(memory({ entries: [] }), projectId, ctoId).entries, []);
});

test("requires exact project and CTO scopes", () => {
  assert.throws(() => parseCtoMemoryRevision(memory({ projectId: "other-project" }), projectId, ctoId), /projectId does not match/);
  assert.throws(() => parseCtoMemoryRevision(memory({ ctoId: "other-cto" }), projectId, ctoId), /ctoId does not match/);
  assert.throws(() => parseCtoMemoryRevision(memory(), "other-project", ctoId), /expected project/);
  assert.throws(() => parseCtoMemoryRevision(memory(), projectId, "other-cto"), /expected CTO/);
});

test("rejects extra keys, accessors, symbols, prototypes, and non-data properties", () => {
  assert.throws(() => parseCtoMemoryRevision({ ...memory(), extra: true }, projectId, ctoId), /unknown or missing fields/);
  let calls = 0;
  const accessor = memory();
  Object.defineProperty(accessor, "revisionId", { enumerable: true, get() { calls += 1; return "memory-rev-1"; } });
  assert.throws(() => parseCtoMemoryRevision(accessor, projectId, ctoId), /enumerable data field/);
  assert.equal(calls, 0);
  const symbol = memory();
  Object.defineProperty(symbol, Symbol("extra"), { value: true });
  assert.throws(() => parseCtoMemoryRevision(symbol, projectId, ctoId), /unknown or missing fields/);
  assert.throws(() => parseCtoMemoryRevision(Object.assign(Object.create({ inherited: true }), memory()), projectId, ctoId), /plain record/);
  const nonEnumerable = memory();
  Object.defineProperty(nonEnumerable, "revisionId", { value: "memory-rev-1", enumerable: false });
  assert.throws(() => parseCtoMemoryRevision(nonEnumerable, projectId, ctoId), /enumerable data field/);
});

test("rejects sparse, accessor, symbol, and extended arrays at every array boundary", () => {
  assert.throws(() => parseCtoMemoryRevision(memory({ entries: new Array(1) }), projectId, ctoId), /dense/);
  assert.throws(() => parseCtoMemoryRevision(memory({ entries: Array.from({ length: 129 }, (_, index) => entry({ id: `MEM-${index}` })) }), projectId, ctoId), /0 through 128/);
  assert.throws(() => parseCtoMemoryRevision(memory({ entries: [entry({ sourceRequestIds: [] })] }), projectId, ctoId), /1 through 32/);
  assert.throws(() => parseCtoMemoryRevision(memory({ entries: [entry({ sourceRequestIds: Array(33).fill(requestId) })] }), projectId, ctoId), /1 through 32/);
  const sparseRefs = new Array(1);
  assert.throws(() => parseCtoMemoryRevision(memory({ entries: [entry({ sourceRequestIds: sparseRefs })] }), projectId, ctoId), /dense/);
  const symbolRefs = [requestId];
  Object.defineProperty(symbolRefs, Symbol("extra"), { value: true });
  assert.throws(() => parseCtoMemoryRevision(memory({ entries: [entry({ sourceRequestIds: symbolRefs })] }), projectId, ctoId), /extra properties/);
  const accessorRefs = [requestId];
  Object.defineProperty(accessorRefs, "0", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.throws(() => parseCtoMemoryRevision(memory({ entries: [entry({ sourceRequestIds: accessorRefs })] }), projectId, ctoId), /data fields/);
});

test("validates entry IDs, kinds, unique IDs, and canonical source UUIDs", () => {
  assert.throws(() => parseCtoMemoryRevision(memory({ entries: [entry(), entry({ id: "MEM-001" })] }), projectId, ctoId), /duplicated/);
  assert.throws(() => parseCtoMemoryRevision(memory({ entries: [entry({ id: "x".repeat(161) })] }), projectId, ctoId), /160 characters/);
  assert.throws(() => parseCtoMemoryRevision(memory({ entries: [entry({ id: "bad\u0000id" })] }), projectId, ctoId), /without controls/);
  assert.throws(() => parseCtoMemoryRevision(memory({ entries: [entry({ kind: "answer" })] }), projectId, ctoId), /kind is unsupported/);
  assert.throws(() => parseCtoMemoryRevision(memory({ entries: [entry({ sourceRequestIds: ["not-a-uuid"] })] }), projectId, ctoId), /canonical lowercase UUID/);
  assert.throws(() => parseCtoMemoryRevision(memory({ entries: [entry({ sourceRequestIds: [requestId, requestId] })] }), projectId, ctoId), /duplicate UUIDs/);
});

test("enforces UTF-8 bounds and permits only tab, CR, and LF controls in text", () => {
  assert.equal(parseCtoMemoryRevision(memory({ entries: [entry({ text: "e\r\n\tvidence" })] }), projectId, ctoId).entries[0]?.text, "e\r\n\tvidence");
  assert.equal(parseCtoMemoryRevision(memory({ entries: [entry({ text: "é".repeat(2_048) })] }), projectId, ctoId).entries[0]?.text.length, 2_048);
  assert.throws(() => parseCtoMemoryRevision(memory({ entries: [entry({ text: "é".repeat(2_049) })] }), projectId, ctoId), /4096 UTF-8 bytes/);
  for (const text of ["bad\u0000text", "bad\u000btext", "bad\u007ftext", "bad\ufffdtext", "bad\ud800text", "bad\udffftext"]) {
    assert.throws(() => parseCtoMemoryRevision(memory({ entries: [entry({ text })] }), projectId, ctoId));
  }
  assert.throws(() => parseCtoMemoryRevision(memory({ revisionId: "bad\nrevision" }), projectId, ctoId), /without controls/);
});

test("enforces the whole serialized revision limit after canonicalizing", () => {
  const entries = Array.from({ length: 32 }, (_, index) => entry({ id: `MEM-${index}`, text: "x".repeat(4_000) }));
  assert.throws(() => parseCtoMemoryRevision(memory({ entries }), projectId, ctoId), /131072-byte JSON limit/);
  const accepted = parseCtoMemoryRevision(memory({ entries: entries.slice(0, 31) }), projectId, ctoId);
  assert.equal(accepted.entries.length, 31);
  assert(Object.isFrozen(accepted as CtoMemoryRevision));
});
