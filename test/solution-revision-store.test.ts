import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import type { SolutionRevision } from "../src/domain/graph-revisions.ts";
import { createSolutionRevisionStore } from "../src/solution-revision-store.ts";

const WORKSPACE_A = "a1234567-b89c-4123-8123-123456789abc";
const WORKSPACE_B = "b1234567-b89c-4123-8123-123456789abc";
const PROJECT_A = "builder-project-a";
const PROJECT_B = "builder-project-b";
const NAMESPACE = "sonpark.my-builder";

type Key = SpsStateKey & { scopeKind: "company"; scopeId: string; namespace: string; stateKey: string };
type Expected = { exists: false } | { exists: true; value: JsonValue };
type CasCall = { key: Key; expected: Expected; value: JsonValue; swapped: boolean };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function fullKey(key: SpsStateKey): string {
  return JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);
}

class FakeState {
  readonly values = new Map<string, JsonValue>();
  readonly casCalls: CasCall[] = [];
  getCalls = 0;
  beforeCas?: (call: CasCall) => Promise<void>;
  beforeGet?: (key: SpsStateKey) => Promise<void>;
  swapOverride?: (call: CasCall) => boolean | undefined;
  receipt?: (call: CasCall) => unknown;
  failureBeforeCommit?: (call: CasCall) => Error | undefined;
  failure?: (call: CasCall) => Error | undefined;

  async get(key: SpsStateKey): Promise<JsonValue | null> {
    this.getCalls += 1;
    await this.beforeGet?.(clone(key));
    const value = this.values.get(fullKey(key));
    return value === undefined ? null : clone(value);
  }

  async compareAndSet(key: SpsStateKey, expected: Expected, value: JsonValue): Promise<{ swapped: boolean }> {
    const call: CasCall = {
      key: clone(key) as Key,
      expected: clone(expected),
      value: clone(value),
      swapped: false,
    };
    this.casCalls.push(call);
    await this.beforeCas?.(call);
    const storedKey = fullKey(key);
    const current = this.values.get(storedKey);
    const exists = this.values.has(storedKey);
    const matches = expected.exists
      ? exists && JSON.stringify(current) === JSON.stringify(expected.value)
      : !exists;
    call.swapped = this.swapOverride?.(call) ?? matches;
    const failureBeforeCommit = this.failureBeforeCommit?.(call);
    if (failureBeforeCommit) throw failureBeforeCommit;
    if (call.swapped) this.values.set(storedKey, clone(value));
    const failure = this.failure?.(call);
    if (failure) throw failure;
    return clone(this.receipt ? this.receipt(call) : { swapped: call.swapped }) as { swapped: boolean };
  }
}

function revision(id: string, overrides: Partial<SolutionRevision> = {}): SolutionRevision {
  return {
    approvedSpecRevisionId: `spec-${id}`,
    graphRevisionId: id,
    entities: [
      { id: "feature-a", kind: "feature", specRef: "REQ-1", contractRefs: ["API-1"] },
      { id: "feature-b", kind: "feature" },
    ],
    relations: [{ id: "a-depends-b", sourceId: "feature-a", targetId: "feature-b", kind: "depends_on", contractRef: "API-1" }],
    viewLayoutRef: `layout-${id}`,
    ...overrides,
  };
}

function patch(expectedBaseRevisionId: string | null, next: SolutionRevision) {
  return { expectedBaseRevisionId, revision: next };
}

function projectHash(projectId: string): string {
  return createHash("sha256").update(projectId, "utf8").digest("hex");
}

function headKey(workspaceId = WORKSPACE_A, projectId = PROJECT_A): Key {
  return { scopeKind: "company", scopeId: workspaceId, namespace: NAMESPACE, stateKey: `solution-head.v1.${projectHash(projectId)}` };
}

function revisionKey(id: string, workspaceId = WORKSPACE_A, projectId = PROJECT_A): Key {
  return {
    scopeKind: "company",
    scopeId: workspaceId,
    namespace: NAMESPACE,
    stateKey: `solution-revision.v1.${projectHash(projectId)}.${revisionIdHash(id)}`,
  };
}

function makeStore(state: FakeState, workspaceId = WORKSPACE_A, projectId = PROJECT_A) {
  return createSolutionRevisionStore(workspaceId, projectId, state);
}

function revisionIdHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return async () => {
    arrived += 1;
    if (arrived === parties) release();
    await ready;
  };
}

test("empty state, publish, restart, and immutable newest-first history", async () => {
  const state = new FakeState();
  const store = makeStore(state);

  assert.equal(await store.current(), null);
  assert.deepEqual(await store.recent(), { revisions: [], hasMore: false });
  assert.deepEqual(await store.publish(patch(null, revision("graph-r01"))), {
    status: "published", sequence: 1, revision: revision("graph-r01"),
  });
  assert.deepEqual(await store.publish(patch("graph-r01", revision("graph-r02"))), {
    status: "published", sequence: 2, revision: revision("graph-r02"),
  });

  const restarted = makeStore(state);
  const current = await restarted.current();
  assert.deepEqual(current, { sequence: 2, revision: revision("graph-r02") });
  assert(Object.isFrozen(current));
  assert(Object.isFrozen(current?.revision));
  assert(Object.isFrozen(current?.revision.entities));
  assert.throws(() => { (current!.revision.entities as unknown[]).push({}); }, TypeError);
  assert.deepEqual(await restarted.recent(), {
    revisions: [
      { sequence: 2, revision: revision("graph-r02") },
      { sequence: 1, revision: revision("graph-r01") },
    ],
    hasMore: false,
  });
  assert.deepEqual(await restarted.recent(1), {
    revisions: [{ sequence: 2, revision: revision("graph-r02") }],
    hasMore: true,
  });
  assert.deepEqual(await restarted.recent(2), {
    revisions: [
      { sequence: 2, revision: revision("graph-r02") },
      { sequence: 1, revision: revision("graph-r01") },
    ],
    hasMore: false,
  });
  await assert.rejects(restarted.recent(0), /1 through 50/);
  await assert.rejects(restarted.recent(51), /1 through 50/);
});

test("stale expected base returns conflict without staging a record", async () => {
  const state = new FakeState();
  const store = makeStore(state);
  await store.publish(patch(null, revision("graph-r01")));
  const writesBefore = state.casCalls.length;

  assert.deepEqual(await store.publish(patch("stale-r00", revision("graph-r02"))), {
    status: "conflict", actualBaseRevisionId: "graph-r01",
  });
  assert.equal(state.casCalls.length, writesBefore);
});

test("independent concurrent creators publish one head and exclude the orphan from history", async () => {
  const state = new FakeState();
  const waitForHeadRace = barrier(2);
  state.beforeCas = async call => {
    if (call.key.stateKey.startsWith("solution-head.v1.")) await waitForHeadRace();
  };
  const left = makeStore(state);
  const right = makeStore(state);

  const outcomes = await Promise.all([
    left.publish(patch(null, revision("graph-left"))),
    right.publish(patch(null, revision("graph-right"))),
  ]);
  assert.equal(outcomes.filter(result => result.status === "published").length, 1);
  assert.equal(outcomes.filter(result => result.status === "conflict").length, 1);
  const current = await left.current();
  const history = await right.recent();
  assert.equal(current?.sequence, 1);
  assert.deepEqual(history.revisions.map(item => item.revision.graphRevisionId), [current?.revision.graphRevisionId]);
  assert.equal(history.hasMore, false);
  assert.equal(state.casCalls.filter(call => call.key.stateKey.startsWith("solution-head.v1.")).length, 2);
});

test("independent concurrent updates publish one child and keep the losing staged entry out of history", async () => {
  const state = new FakeState();
  const seed = makeStore(state);
  await seed.publish(patch(null, revision("graph-r01")));
  const waitForHeadRace = barrier(2);
  state.beforeCas = async call => {
    if (call.key.stateKey.startsWith("solution-head.v1.")) await waitForHeadRace();
  };
  const left = makeStore(state);
  const right = makeStore(state);

  const outcomes = await Promise.all([
    left.publish(patch("graph-r01", revision("graph-left"))),
    right.publish(patch("graph-r01", revision("graph-right"))),
  ]);
  assert.equal(outcomes.filter(result => result.status === "published").length, 1);
  assert.equal(outcomes.filter(result => result.status === "conflict").length, 1);
  const history = await seed.recent();
  assert.equal(history.revisions.length, 2);
  assert.equal(history.revisions[0]?.sequence, 2);
  assert.equal(history.revisions[1]?.revision.graphRevisionId, "graph-r01");
  assert.equal(history.hasMore, false);
});

test("a revision ID with different content cannot replace the immutable staged entry", async () => {
  const state = new FakeState();
  const first = makeStore(state);
  const second = makeStore(state);
  const waitForEntryRace = barrier(2);
  state.beforeCas = async call => {
    if (call.key.stateKey.startsWith("solution-revision.v1.")) await waitForEntryRace();
  };

  const attempts = await Promise.allSettled([
    first.publish(patch(null, revision("graph-same-id", { viewLayoutRef: "layout-first" }))),
    second.publish(patch(null, revision("graph-same-id", { viewLayoutRef: "layout-second" }))),
  ]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(attempts.filter(result => result.status === "rejected").length, 1);
  const current = await first.current();
  assert.equal(current?.revision.graphRevisionId, "graph-same-id");
  assert(["layout-first", "layout-second"].includes(current!.revision.viewLayoutRef));
  assert.equal(state.casCalls.filter(call => call.key.stateKey.startsWith("solution-revision.v1.")).length, 2);
});

test("corrupt digest and missing published entry throw without repairing state", async t => {
  await t.test("corrupt digest", async () => {
    const state = new FakeState();
    const store = makeStore(state);
    await store.publish(patch(null, revision("graph-r01")));
    const entryStorageKey = fullKey(revisionKey("graph-r01"));
    const corrupt = state.values.get(entryStorageKey) as Record<string, unknown>;
    state.values.set(entryStorageKey, { ...corrupt, digest: "f".repeat(64) });
    const writesBefore = state.casCalls.length;
    await assert.rejects(store.current(), /identity mismatch|digest mismatch/);
    await assert.rejects(store.recent(), /identity mismatch|digest mismatch/);
    assert.equal(state.casCalls.length, writesBefore);
  });

  await t.test("missing published entry", async () => {
    const state = new FakeState();
    const store = makeStore(state);
    await store.publish(patch(null, revision("graph-r01")));
    state.values.delete(fullKey(revisionKey("graph-r01")));
    const writesBefore = state.casCalls.length;
    await assert.rejects(store.current(), /Published solution revision is missing/);
    await assert.rejects(store.recent(), /Published solution revision is missing/);
    assert.equal(state.casCalls.length, writesBefore);
  });
});

test("separate Workspaces and namespaces remain isolated in the full Host key", async () => {
  const state = new FakeState();
  const storeA = makeStore(state, WORKSPACE_A, PROJECT_A);
  const storeB = makeStore(state, WORKSPACE_B, PROJECT_A);
  await storeA.publish(patch(null, revision("graph-a")));
  assert.equal(await storeB.current(), null);
  await storeB.publish(patch(null, revision("graph-b")));

  assert.equal((await storeA.current())?.revision.graphRevisionId, "graph-a");
  assert.equal((await storeB.current())?.revision.graphRevisionId, "graph-b");
  assert(state.casCalls.every(call => call.key.scopeKind === "company"));
  assert(state.casCalls.every(call => call.key.namespace === NAMESPACE));
  assert(state.casCalls.some(call => call.key.scopeId === WORKSPACE_A));
  assert(state.casCalls.some(call => call.key.scopeId === WORKSPACE_B));
  assert(state.casCalls.every(call => call.key.stateKey.startsWith("solution-head.v1.")
    || call.key.stateKey.startsWith("solution-revision.v1.")));
  assert.notEqual(fullKey(headKey(WORKSPACE_A, PROJECT_A)), fullKey(headKey(WORKSPACE_B, PROJECT_A)));
});

test("separate projects in one Workspace have independent heads and immutable revision namespaces", async () => {
  const state = new FakeState();
  const projectA = makeStore(state, WORKSPACE_A, PROJECT_A);
  const projectB = makeStore(state, WORKSPACE_A, PROJECT_B);
  await projectA.publish(patch(null, revision("graph-shared-id", { viewLayoutRef: "layout-project-a" })));
  assert.equal(await projectB.current(), null);
  await projectB.publish(patch(null, revision("graph-shared-id", { viewLayoutRef: "layout-project-b" })));

  assert.equal((await projectA.current())?.revision.viewLayoutRef, "layout-project-a");
  assert.equal((await projectB.current())?.revision.viewLayoutRef, "layout-project-b");
  assert.notEqual(fullKey(headKey(WORKSPACE_A, PROJECT_A)), fullKey(headKey(WORKSPACE_A, PROJECT_B)));
  assert.notEqual(fullKey(revisionKey("graph-shared-id", WORKSPACE_A, PROJECT_A)),
    fullKey(revisionKey("graph-shared-id", WORKSPACE_A, PROJECT_B)));
  assert(state.casCalls.some(call => call.key.stateKey === headKey(WORKSPACE_A, PROJECT_A).stateKey));
  assert(state.casCalls.some(call => call.key.stateKey === headKey(WORKSPACE_A, PROJECT_B).stateKey));
});

test("requires a lowercase canonical Workspace UUID", () => {
  assert.throws(() => createSolutionRevisionStore(WORKSPACE_A.toUpperCase(), PROJECT_A, new FakeState()), /canonical Workspace ID/);
  assert.throws(() => createSolutionRevisionStore("not-a-uuid", PROJECT_A, new FakeState()), /canonical Workspace ID/);

  let coerced = false;
  const uuidObject = { toString() { coerced = true; return WORKSPACE_A; } };
  assert.throws(() => createSolutionRevisionStore(uuidObject as unknown as string, PROJECT_A, new FakeState()), /canonical Workspace ID/);
  assert.equal(coerced, false);
});

test("rejects a control-character revision ID before any CAS write", async () => {
  const state = new FakeState();
  const store = makeStore(state);
  await assert.rejects(store.publish(patch(null, revision("graph\ncontrol"))), /Invalid solution revision ID/);
  assert.equal(state.casCalls.length, 0);
});

test("rejects malformed/accessor patches, dangling relations, and dependency cycles without writes", async () => {
  const state = new FakeState();
  const store = makeStore(state);
  const before = state.casCalls.length;

  await assert.rejects(store.publish(null), /Invalid solution patch/);
  const accessorPatch = patch(null, revision("graph-accessor"));
  Object.defineProperty(accessorPatch, "revision", { enumerable: true, get() { throw new Error("getter invoked"); } });
  await assert.rejects(store.publish(accessorPatch), /Invalid solution patch/);
  await assert.rejects(store.publish(patch(null, revision("graph-dangling", {
    relations: [{ id: "dangling", sourceId: "feature-a", targetId: "absent", kind: "implements" }],
  }))), /outside the revision/);
  await assert.rejects(store.publish(patch(null, revision("graph-cycle", {
    relations: [
      { id: "depends-ab", sourceId: "feature-a", targetId: "feature-b", kind: "depends_on" },
      { id: "depends-ba", sourceId: "feature-b", targetId: "feature-a", kind: "depends_on" },
    ],
  }))), /depends_on relations must form a DAG/);
  assert.equal(state.casCalls.length, before);
});

test("rejects entries larger than 192 KiB before any state write", async () => {
  const state = new FakeState();
  const store = makeStore(state);
  const entities = Array.from({ length: 1_400 }, (_, index) => ({
    id: `feature-${index}`,
    kind: "feature" as const,
    specRef: `REQ-${index}-${"x".repeat(130)}`,
    contractRefs: [`API-${index}-${"y".repeat(100)}`],
  }));
  await assert.rejects(store.publish(patch(null, revision("graph-huge", { entities, relations: [] }))), /exceeds 192 KiB/);
  assert.equal(state.casCalls.length, 0);
  assert.equal(state.values.size, 0);
});

test("requires compareAndSet and never falls back to ordinary set", async () => {
  let gets = 0;
  let sets = 0;
  const unsupported = {
    async get() { gets += 1; return null; },
    async set() { sets += 1; },
  };
  const store = createSolutionRevisionStore(WORKSPACE_A, PROJECT_A, unsupported);
  await assert.rejects(store.publish(patch(null, revision("graph-r01"))), /compareAndSet is required/);
  assert.equal(gets, 0);
  assert.equal(sets, 0);
});

test("malformed receipt, false head receipt, CAS error, and lost response never retry", async t => {
  await t.test("malformed receipt", async () => {
    const state = new FakeState();
    state.receipt = () => ({ swapped: true, extra: "not allowed" });
    const store = makeStore(state);
    await assert.rejects(store.publish(patch(null, revision("graph-r01"))), /Invalid conditional state receipt fields/);
    assert.equal(state.casCalls.length, 1);
  });

  await t.test("false head receipt", async () => {
    const state = new FakeState();
    state.swapOverride = call => call.key.stateKey.startsWith("solution-head.v1.") ? false : undefined;
    const store = makeStore(state);
    assert.deepEqual(await store.publish(patch(null, revision("graph-r01"))), {
      status: "conflict", actualBaseRevisionId: null,
    });
    assert.equal(state.casCalls.filter(call => call.key.stateKey.startsWith("solution-head.v1.")).length, 1);
    assert.equal(await store.current(), null);
  });

  await t.test("CAS error before commit", async () => {
    const state = new FakeState();
    state.failureBeforeCommit = () => new Error("Host unavailable");
    const store = makeStore(state);
    await assert.rejects(store.publish(patch(null, revision("graph-r01"))), /Host unavailable/);
    assert.equal(state.casCalls.length, 1);
    assert.equal(state.values.size, 0);
  });

  await t.test("lost head response after commit", async () => {
    const state = new FakeState();
    state.failure = call => call.key.stateKey.startsWith("solution-head.v1.") ? new Error("response lost") : undefined;
    const store = makeStore(state);
    await assert.rejects(store.publish(patch(null, revision("graph-r01"))), /response lost/);
    assert.equal(state.casCalls.filter(call => call.key.stateKey.startsWith("solution-head.v1.")).length, 1);
    assert.equal((await store.current())?.revision.graphRevisionId, "graph-r01");
  });
});

test("entry-stage and head-stage failures leave no published graph", async t => {
  await t.test("entry stage failure", async () => {
    const state = new FakeState();
    state.failureBeforeCommit = call => call.key.stateKey.startsWith("solution-revision.v1.") ? new Error("entry failed") : undefined;
    const store = makeStore(state);
    await assert.rejects(store.publish(patch(null, revision("graph-r01"))), /entry failed/);
    assert.equal(state.casCalls.length, 1);
    assert.equal(await store.current(), null);
  });

  await t.test("head stage failure leaves only an unpublished entry", async () => {
    const state = new FakeState();
    state.failureBeforeCommit = call => call.key.stateKey.startsWith("solution-head.v1.") ? new Error("head failed") : undefined;
    const store = makeStore(state);
    await assert.rejects(store.publish(patch(null, revision("graph-r01"))), /head failed/);
    assert.equal(state.casCalls.length, 2);
    assert.equal(state.values.size, 1);
    assert.equal(await store.current(), null);
    assert.deepEqual(await store.recent(), { revisions: [], hasMore: false });
  });
});

test("snapshots caller input before the first awaited Host read", async () => {
  const state = new FakeState();
  let unblock!: () => void;
  let signalEntered!: () => void;
  const entered = new Promise<void>(resolve => { signalEntered = resolve; });
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  state.beforeGet = async () => {
    state.beforeGet = undefined;
    signalEntered();
    await blocked;
  };
  const store = makeStore(state);
  const proposed = revision("graph-r01");
  const publishing = store.publish(patch(null, proposed));
  await entered;
  (proposed.entities[0] as { specRef: string }).specRef = "mutated-during-await";
  (proposed.relations as unknown[]).push({ id: "late", sourceId: "feature-a", targetId: "feature-b", kind: "triggers" });
  unblock();

  assert.equal((await publishing).status, "published");
  assert.equal((await store.current())?.revision.entities[0]?.specRef, "REQ-1");
  assert.equal((await store.current())?.revision.relations.length, 1);
});
