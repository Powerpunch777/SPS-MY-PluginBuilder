import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import type { SolutionRevision } from "../src/domain/graph-revisions.ts";
import { createSolutionRevisionStore, type RevisionState } from "../src/solution-revision-store.ts";

const workspaceId = "a1234567-b89c-4123-8123-123456789abc";
const projectId = "guarded-publication-independent-qa";
type Expected = { exists: false } | { exists: true; value: JsonValue };

function key(input: SpsStateKey) {
  return JSON.stringify([input.scopeKind, input.scopeId, input.namespace, input.stateKey]);
}

function revision(id: string): SolutionRevision {
  return { approvedSpecRevisionId: `spec-${id}`, graphRevisionId: id,
    entities: [{ id: "feature-a", kind: "feature" }], relations: [], viewLayoutRef: `layout-${id}` };
}

class State implements RevisionState {
  values = new Map<string, JsonValue>();
  calls = 0;
  successfulWrites = 0;
  getCalls = 0;
  guardedCalls = 0;
  loseResponse = false;

  async get(input: SpsStateKey): Promise<JsonValue | null> {
    this.getCalls += 1;
    return this.values.get(key(input)) ?? null;
  }

  async compareAndSet(input: SpsStateKey, expected: Expected, value: JsonValue) {
    this.calls += 1;
    const id = key(input), old = this.values.get(id);
    const match = expected.exists ? old !== undefined && JSON.stringify(old) === JSON.stringify(expected.value) : old === undefined;
    if (match) {
      this.values.set(id, structuredClone(value));
      this.successfulWrites += 1;
    }
    return { swapped: match };
  }

  async guardedCompareAndSet(input: SpsStateKey & { scopeKind: "company"; scopeId: string;
    guards: readonly { stateKey: string; namespace?: string; expectedValue: JsonValue }[] },
  expected: Expected, value: JsonValue) {
    this.guardedCalls += 1;
    for (const guard of input.guards) {
      const actual = this.values.get(key({ scopeKind: "company", scopeId: input.scopeId,
        namespace: guard.namespace, stateKey: guard.stateKey }));
      if (actual === undefined) return { status: "unsupported" as const, reason: "missing-guard" as const };
      if (JSON.stringify(actual) !== JSON.stringify(guard.expectedValue)) return { status: "conflict" as const };
    }
    const id = key(input), old = this.values.get(id);
    const match = expected.exists ? old !== undefined && JSON.stringify(old) === JSON.stringify(expected.value) : old === undefined;
    if (!match) return { status: "conflict" as const };
    this.values.set(id, structuredClone(value));
    this.successfulWrites += 1;
    if (this.loseResponse) throw new Error("QA response lost after commit");
    return { status: "committed" as const };
  }
}

test("unsupported legacy SDK is rejected before even a state read", async () => {
  const actual = new State();
  const legacy: RevisionState = {
    get: input => actual.get(input),
    compareAndSet: (input, expected, value) => actual.compareAndSet(input, expected, value),
  };
  const result = await createSolutionRevisionStore(workspaceId, projectId, legacy)
    .publishGuarded({ expectedBaseRevisionId: null, revision: revision("legacy") }, [{ stateKey: "source", expectedValue: null }]);
  assert.deepEqual(result, { status: "unsupported", reason: "guarded-cas-unavailable" });
  assert.equal(actual.getCalls, 0);
  assert.equal(actual.calls, 0);
  assert.equal(actual.guardedCalls, 0);
  assert.equal(actual.values.size, 0);
});

test("same-input retry after a lost guarded receipt never writes again and leaves the committed head recognizable", async () => {
  const state = new State();
  const source: SpsStateKey = { scopeKind: "company", scopeId: workspaceId,
    namespace: "source", stateKey: "approved-source" };
  state.values.set(key(source), { revisionId: "source-r1" });
  state.loseResponse = true;
  const store = createSolutionRevisionStore(workspaceId, projectId, state);
  const patch = { expectedBaseRevisionId: null, revision: revision("solution-r1") };
  const guards = [{ stateKey: source.stateKey, namespace: source.namespace, expectedValue: { revisionId: "source-r1" } }];

  await assert.rejects(store.publishGuarded(patch, guards), /response lost after commit/u);
  state.loseResponse = false;
  const retry = await store.publishGuarded(patch, guards);
  assert.deepEqual(retry, { status: "conflict", actualBaseRevisionId: "solution-r1" });
  assert.equal((await store.current())?.revision.graphRevisionId, "solution-r1");
  assert.equal(state.guardedCalls, 1);
  assert.equal(state.calls, 1); // retry conflicts from the current head before staging
  assert.equal(state.successfulWrites, 2); // initial stage plus the guarded head commit
  assert.equal(state.values.size, 3); // source pointer, immutable entry, and the published head
});
