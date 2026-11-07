import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import type { SolutionRevision } from "../src/domain/graph-revisions.ts";
import { createRevisionJournal, createSolutionRevisionStore, type RevisionState } from "../src/solution-revision-store.ts";

// Independent journal regression; exact tested sources: Builder 38bd70a, SDK 59f7193, Core 20c7aa8. JSONB order is simulated; no V1 repair.
const WORKSPACE = "a1234567-b89c-4123-8123-123456789abc";
const PROJECT = "jsonb-revision-roundtrip-independent";
const NAMESPACE = "sonpark.my-builder";
type Expected = { exists: false } | { exists: true; value: JsonValue };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function reorderLikeJsonb(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(reorderLikeJsonb);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, reorderLikeJsonb(value[key]!)]));
  }
  return value;
}

function keyOf(key: SpsStateKey): string {
  return JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);
}

class JsonbState implements RevisionState {
  readonly rows = new Map<string, JsonValue>();
  reorderWrites = true;

  async get(key: SpsStateKey): Promise<JsonValue | null> {
    const value = this.rows.get(keyOf(key));
    return value === undefined ? null : clone(value);
  }

  async compareAndSet(key: SpsStateKey, expected: Expected, value: JsonValue): Promise<{ swapped: boolean }> {
    const address = keyOf(key), current = this.rows.get(address);
    const matches = expected.exists
      ? current !== undefined && JSON.stringify(current) === JSON.stringify(expected.value)
      : current === undefined;
    if (matches) this.rows.set(address, clone(this.reorderWrites ? reorderLikeJsonb(value) : value));
    return { swapped: matches };
  }

  seed(key: SpsStateKey, value: JsonValue) {
    this.rows.set(keyOf(key), clone(this.reorderWrites ? reorderLikeJsonb(value) : value));
  }
}

function revision(id: string): SolutionRevision {
  return {
    approvedSpecRevisionId: `spec-${id}`,
    graphRevisionId: id,
    entities: [
      { id: "feature-a", kind: "feature", specRef: "REQ-1", contractRefs: ["API-1"] },
      { id: "feature-b", kind: "feature" },
    ],
    relations: [{ id: "a-depends-b", sourceId: "feature-a", targetId: "feature-b", kind: "depends_on", contractRef: "API-1" }],
    viewLayoutRef: `layout-${id}`,
  };
}

function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function projectHash(): string { return hash(PROJECT); }

function stateKey(stateKey: string): SpsStateKey {
  return { scopeKind: "company", scopeId: WORKSPACE, namespace: NAMESPACE, stateKey };
}

function entryKey(id: string): SpsStateKey {
  return stateKey(`solution-revision.v1.${projectHash()}.${hash(id)}`);
}

function headKey(): SpsStateKey {
  return stateKey(`solution-head.v1.${projectHash()}`);
}

type HistoricalRevision = { id: string; nested: { z: string; a: number }; fields: string[] };
function historicalJournal(state: JsonbState) {
  return createRevisionJournal<HistoricalRevision>(WORKSPACE, PROJECT, state, {
    prefix: "independent-history", parse: value => value as HistoricalRevision, revisionId: value => value.id,
  });
}
function historicalEntry(value: HistoricalRevision) {
  const body = { schemaVersion: 1 as const, workspaceId: WORKSPACE, projectId: PROJECT,
    sequence: 1, parent: null, revision: value };
  const digest = hash(JSON.stringify(body));
  const project = projectHash();
  return {
    entryKey: stateKey(`independent-history-revision.v1.${project}.${hash(value.id)}`),
    headKey: stateKey(`independent-history-head.v1.${project}`),
    entry: { ...body, digest }, head: { revisionId: value.id, sequence: 1, digest },
  };
}

test("new journal entries preserve revision JSON across JSONB key reordering without changing revision IDs", async () => {
  const state = new JsonbState();
  const store = createSolutionRevisionStore(WORKSPACE, PROJECT, state);
  const proposed = revision("source-id-remains-exact");

  assert.deepEqual(await store.publish({ expectedBaseRevisionId: null, revision: proposed }), {
    status: "published", sequence: 1, revision: proposed,
  });
  const pointer = await state.get(headKey()) as any;
  const entry = await state.get(entryKey(proposed.graphRevisionId)) as any;
  assert.deepEqual(pointer, { revisionId: proposed.graphRevisionId, sequence: 1, digest: entry.digest });
  assert.equal(entry.schemaVersion, 2);
  assert.ok(Array.isArray(entry.revisionOrder));
  assert.deepEqual(entry.revision, proposed);

  const restarted = createSolutionRevisionStore(WORKSPACE, PROJECT, state);
  assert.deepEqual(await restarted.current(), { sequence: 1, revision: proposed });
  assert.equal((await restarted.current())?.revision.graphRevisionId, "source-id-remains-exact");
});

test("legacy V1 reads remain unchanged, while JSONB-reordered V1 history fails closed without repair", async () => {
  const proposed: HistoricalRevision = { id: "historical-v1-id", nested: { z: "last", a: 1 }, fields: ["one", "two"] };
  const legacy = historicalEntry(proposed);

  const unchangedState = new JsonbState();
  unchangedState.reorderWrites = false;
  unchangedState.seed(legacy.entryKey, legacy.entry as unknown as JsonValue);
  unchangedState.seed(legacy.headKey, legacy.head as unknown as JsonValue);
  assert.deepEqual(await historicalJournal(unchangedState).current(), { sequence: 1, revision: proposed });

  const reorderedState = new JsonbState();
  reorderedState.seed(legacy.entryKey, legacy.entry as unknown as JsonValue);
  reorderedState.seed(legacy.headKey, legacy.head as unknown as JsonValue);
  const beforeEntry = await reorderedState.get(legacy.entryKey);
  const beforeHead = await reorderedState.get(legacy.headKey);
  await assert.rejects(historicalJournal(reorderedState).current(),
    /Solution revision digest mismatch/u);
  assert.deepEqual(await reorderedState.get(legacy.entryKey), beforeEntry);
  assert.deepEqual(await reorderedState.get(legacy.headKey), beforeHead);
});
