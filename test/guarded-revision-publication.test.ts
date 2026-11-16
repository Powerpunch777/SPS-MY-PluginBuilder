import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import type { SolutionRevision } from "../src/domain/graph-revisions.ts";
import { createSolutionRevisionStore, type RevisionState } from "../src/solution-revision-store.ts";

const WORKSPACE = "a1234567-b89c-4123-8123-123456789abc";
const PROJECT = "guarded-publication-project";
const NAMESPACE = "sonpark.my-builder";
type Expected = { exists: false } | { exists: true; value: JsonValue };

function fullKey(key: SpsStateKey): string {
  return JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class GuardedState implements RevisionState {
  readonly values = new Map<string, JsonValue>();
  readonly calls: Array<{ key: SpsStateKey; expected: Expected; value: JsonValue }> = [];
  guardedCalls = 0;
  guardedResult?: "missing-guard" | "conflict";
  loseGuardedResponseAfterCommit = false;

  async get(key: SpsStateKey): Promise<JsonValue | null> {
    const value = this.values.get(fullKey(key));
    return value === undefined ? null : clone(value);
  }

  async compareAndSet(key: SpsStateKey, expected: Expected, value: JsonValue): Promise<{ swapped: boolean }> {
    const stored = fullKey(key);
    const current = this.values.get(stored);
    const matches = expected.exists ? current !== undefined && JSON.stringify(current) === JSON.stringify(expected.value)
      : current === undefined;
    this.calls.push({ key: clone(key), expected: clone(expected), value: clone(value) });
    if (matches) this.values.set(stored, clone(value));
    return { swapped: matches };
  }

  async guardedCompareAndSet(key: SpsStateKey & { scopeKind: "company"; scopeId: string;
    guards: readonly { stateKey: string; namespace?: string; expectedValue: JsonValue }[] },
  expected: Expected, value: JsonValue): Promise<{ status: "committed" | "conflict" } | { status: "unsupported"; reason: "missing-guard" }> {
    this.guardedCalls += 1;
    if (this.guardedResult === "missing-guard") return { status: "unsupported", reason: "missing-guard" };
    if (this.guardedResult === "conflict") return { status: "conflict" };
    for (const guard of key.guards) {
      const guardValue = this.values.get(fullKey({ scopeKind: "company", scopeId: key.scopeId,
        namespace: guard.namespace, stateKey: guard.stateKey }));
      if (guardValue === undefined) return { status: "unsupported", reason: "missing-guard" };
      if (JSON.stringify(guardValue) !== JSON.stringify(guard.expectedValue)) return { status: "conflict" };
    }
    const stored = fullKey(key);
    const current = this.values.get(stored);
    const matches = expected.exists ? current !== undefined && JSON.stringify(current) === JSON.stringify(expected.value)
      : current === undefined;
    if (!matches) return { status: "conflict" };
    this.values.set(stored, clone(value));
    if (this.loseGuardedResponseAfterCommit) throw new Error("synthetic response lost after commit");
    return { status: "committed" };
  }
}

function revision(id: string, viewLayoutRef = `layout-${id}`): SolutionRevision {
  return { approvedSpecRevisionId: `spec-${id}`, graphRevisionId: id,
    entities: [{ id: "feature-a", kind: "feature" }], relations: [], viewLayoutRef };
}

function patch(expectedBaseRevisionId: string | null, value: SolutionRevision) {
  return { expectedBaseRevisionId, revision: value };
}

function pointerKey(key: string, namespace = "source") {
  return { scopeKind: "company" as const, scopeId: WORKSPACE, namespace, stateKey: key };
}

function makeGuard(key: string, expectedValue: JsonValue, namespace = "source") {
  return { stateKey: key, namespace, expectedValue };
}

function entryStorageKey(revisionId: string): string {
  const projectHash = createHash("sha256").update(PROJECT, "utf8").digest("hex");
  const idHash = createHash("sha256").update(revisionId, "utf8").digest("hex");
  return fullKey({ scopeKind: "company", scopeId: WORKSPACE, namespace: NAMESPACE,
    stateKey: `solution-revision.v1.${projectHash}.${idHash}` });
}

test("guarded publication stages immutably and refuses a changed source pointer, then safely retries the same entry", async () => {
  const state = new GuardedState();
  const source = pointerKey("approved-source");
  state.values.set(fullKey(source), { revisionId: "source-r1" });
  const store = createSolutionRevisionStore(WORKSPACE, PROJECT, state);
  const proposed = revision("solution-r1");
  state.values.set(fullKey(source), { revisionId: "source-r2" });
  const stale = await store.publishGuarded(patch(null, proposed), [makeGuard(source.stateKey, { revisionId: "source-r1" })]);
  assert.deepEqual(stale, { status: "conflict", actualBaseRevisionId: null, stagedRevisionId: "solution-r1" });
  assert.equal(await store.current(), null);
  assert.equal(state.values.has(entryStorageKey("solution-r1")), true);
  assert.deepEqual(await store.stagedRevision("solution-r1", null), {
    status: "staged", sequence: 1, expectedBaseRevisionId: null, revision: proposed,
  });
  await assert.rejects(store.publishGuarded(patch(null, revision("solution-r1", "different-body")),
    [makeGuard(source.stateKey, { revisionId: "source-r1" })]), /identity mismatch|digest mismatch|already contains different/u);

  state.values.set(fullKey(source), { revisionId: "source-r1" });
  assert.deepEqual(await store.publishGuarded(patch(null, proposed), [makeGuard(source.stateKey, { revisionId: "source-r1" })]), {
    status: "published", sequence: 1, revision: proposed,
  });
});

test("guarded publication refuses unsupported Hosts before staging and preserves missing-guard outcomes", async () => {
  const legacy = new GuardedState();
  const stateWithoutMethod: RevisionState = { get: key => legacy.get(key), compareAndSet: (key, expected, value) => legacy.compareAndSet(key, expected, value) };
  const legacyStore = createSolutionRevisionStore(WORKSPACE, PROJECT, stateWithoutMethod);
  assert.deepEqual(await legacyStore.publishGuarded(patch(null, revision("unsupported-r1")), [makeGuard("source", { r: 1 })]), {
    status: "unsupported", reason: "guarded-cas-unavailable",
  });
  assert.equal(legacy.calls.length, 0);
  assert.equal(legacy.values.size, 0);

  const state = new GuardedState();
  state.guardedResult = "missing-guard";
  const store = createSolutionRevisionStore(WORKSPACE, PROJECT, state);
  assert.deepEqual(await store.publishGuarded(patch(null, revision("missing-guard-r1")), [makeGuard("absent", { r: 1 })]), {
    status: "unsupported", reason: "missing-guard", stagedRevisionId: "missing-guard-r1", expectedBaseRevisionId: null,
  });
  assert.equal(await store.current(), null);
  assert.equal(state.values.has(entryStorageKey("missing-guard-r1")), true);
});

test("guarded receipt response loss propagates without retry or ordinary head CAS fallback", async () => {
  const state = new GuardedState();
  const source = pointerKey("approved-source");
  state.values.set(fullKey(source), { revisionId: "source-r1" });
  state.loseGuardedResponseAfterCommit = true;
  const store = createSolutionRevisionStore(WORKSPACE, PROJECT, state);
  await assert.rejects(store.publishGuarded(patch(null, revision("response-lost-r1")),
    [makeGuard(source.stateKey, { revisionId: "source-r1" })]), /response lost/u);
  assert.deepEqual((await store.current())?.revision, revision("response-lost-r1"));
  assert.equal(state.guardedCalls, 1);
  assert.equal(state.calls.filter(call => call.key.stateKey.includes("solution-head")).length, 0);
  assert.equal(state.values.has(entryStorageKey("response-lost-r1")), true);
});

test("guard list rejects bounds, duplicate keys, and head overlap before any staged entry", async () => {
  const state = new GuardedState();
  const store = createSolutionRevisionStore(WORKSPACE, PROJECT, state);
  const headStateKey = `solution-head.v1.${createHash("sha256").update(PROJECT, "utf8").digest("hex")}`;
  await assert.rejects(store.publishGuarded(patch(null, revision("bad-guards-r1")), []), /between 1 and 64/u);
  await assert.rejects(store.publishGuarded(patch(null, revision("bad-guards-many")),
    Array.from({ length: 65 }, (_, index) => makeGuard(`source-${index}`, index))), /between 1 and 64/u);
  await assert.rejects(store.publishGuarded(patch(null, revision("bad-guards-r2")), [makeGuard("same", 1), makeGuard("same", 2)]), /unique/u);
  await assert.rejects(store.publishGuarded(patch(null, revision("bad-guards-r3")), [makeGuard(headStateKey, null, NAMESPACE)]), /cannot also/u);
  assert.equal(state.calls.length, 0);
});
