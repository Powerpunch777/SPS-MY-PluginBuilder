import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import type { SolutionRevision } from "../src/domain/graph-revisions.ts";
import { createSolutionRevisionStore, type RevisionState } from "../src/solution-revision-store.ts";

const WORKSPACE = "a1234567-b89c-4123-8123-123456789abc";
const PROJECT = "guarded-revision-job-wake";
const NAMESPACE = "sonpark.my-builder";
type Expected = { exists: false } | { exists: true; value: JsonValue };
type Wake = Readonly<{ name: string; eventId: string; jobKey: string; payload: JsonValue }>;
type GuardedKey = SpsStateKey & { scopeKind: "company"; scopeId: string;
  guards: readonly { stateKey: string; namespace?: string; expectedValue: JsonValue }[] };

function fullKey(key: SpsStateKey): string {
  return JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function revision(id: string): SolutionRevision {
  return { approvedSpecRevisionId: `spec-${id}`, graphRevisionId: id,
    entities: [{ id: "feature-a", kind: "feature" }], relations: [], viewLayoutRef: `layout-${id}` };
}

function patch(expectedBaseRevisionId: string | null, value: SolutionRevision) {
  return { expectedBaseRevisionId, revision: value };
}

function pointerKey(stateKey: string, namespace = "source"): SpsStateKey {
  return { scopeKind: "company", scopeId: WORKSPACE, namespace, stateKey };
}

function projectHeadKey(): SpsStateKey & { scopeKind: "company"; scopeId: string } {
  const projectHash = createHash("sha256").update(PROJECT, "utf8").digest("hex");
  return { scopeKind: "company", scopeId: WORKSPACE, namespace: NAMESPACE, stateKey: `solution-head.v1.${projectHash}` };
}

class WakeState implements RevisionState {
  readonly values = new Map<string, JsonValue>();
  readonly stageCalls: Array<{ key: SpsStateKey; expected: Expected; value: JsonValue }> = [];
  readonly wakeCalls: Array<{ key: GuardedKey; expected: Expected; value: JsonValue; wake: Wake }> = [];
  getCalls = 0;
  legacyGuardedCalls = 0;
  result: "missing-guard" | "conflict" | "committed" = "committed";
  loseWakeResponseAfterCommit = false;

  async get(key: SpsStateKey): Promise<JsonValue | null> {
    this.getCalls += 1;
    const value = this.values.get(fullKey(key));
    return value === undefined ? null : clone(value);
  }

  async compareAndSet(key: SpsStateKey, expected: Expected, value: JsonValue): Promise<{ swapped: boolean }> {
    this.stageCalls.push({ key: clone(key), expected: clone(expected), value: clone(value) });
    const stored = fullKey(key);
    const current = this.values.get(stored);
    const matches = expected.exists ? current !== undefined && JSON.stringify(current) === JSON.stringify(expected.value)
      : current === undefined;
    if (matches) this.values.set(stored, clone(value));
    return { swapped: matches };
  }

  async guardedCompareAndSet(key: GuardedKey, expected: Expected, value: JsonValue) {
    this.legacyGuardedCalls += 1;
    return { status: "committed" as const };
  }

  async guardedCompareAndSetWithJobWakeV1(key: GuardedKey, expected: Expected, value: JsonValue, wake: Wake) {
    this.wakeCalls.push({ key: clone(key), expected: clone(expected), value: clone(value), wake: clone(wake) });
    if (this.result === "missing-guard") return { status: "unsupported" as const, reason: "missing-guard" as const };
    if (this.result === "conflict") return { status: "conflict" as const };
    const stored = fullKey(key);
    const current = this.values.get(stored);
    const matches = expected.exists ? current !== undefined && JSON.stringify(current) === JSON.stringify(expected.value)
      : current === undefined;
    if (!matches) return { status: "conflict" as const };
    this.values.set(stored, clone(value));
    if (this.loseWakeResponseAfterCommit) throw new Error("job-wake response lost after commit");
    return { status: "committed" as const };
  }
}

function wake(): Wake {
  return { name: "builder.revision.published", eventId: "builder-wake-01", jobKey: "revision-followup",
    payload: { source: "test", nested: [1, true, null] } };
}

function guard() {
  return [{ stateKey: "source-pointer", namespace: "source", expectedValue: { revisionId: "source-r1" } }];
}

test("missing atomic job-wake capability returns before any state I/O and never calls legacy guarded CAS", async () => {
  const actual = new WakeState();
  const legacyOnly: RevisionState = {
    get: key => actual.get(key),
    compareAndSet: (key, expected, value) => actual.compareAndSet(key, expected, value),
    guardedCompareAndSet: (key, expected, value) => actual.guardedCompareAndSet(key, expected, value),
  };
  const store = createSolutionRevisionStore(WORKSPACE, PROJECT, legacyOnly);

  assert.deepEqual(await store.publishGuardedWithJobWakeV1(patch(null, revision("wake-unsupported")), guard(), wake()), {
    status: "unsupported", reason: "guarded-cas-job-wake-unavailable",
  });
  assert.equal(actual.getCalls, 0);
  assert.equal(actual.stageCalls.length, 0);
  assert.equal(actual.legacyGuardedCalls, 0);
  assert.equal(actual.wakeCalls.length, 0);
  assert.equal(actual.values.size, 0);
});

test("forwards the exact head CAS and wake only through the explicit atomic operation", async () => {
  const state = new WakeState();
  const store = createSolutionRevisionStore(WORKSPACE, PROJECT, state);
  const requestedWake = wake();
  const proposed = revision("wake-published");

  assert.deepEqual(await store.publishGuardedWithJobWakeV1(patch(null, proposed), guard(), requestedWake), {
    status: "published", sequence: 1, revision: proposed,
  });
  assert.equal(state.wakeCalls.length, 1);
  assert.equal(state.legacyGuardedCalls, 0);
  assert.deepEqual(state.wakeCalls[0]?.key, { ...projectHeadKey(), guards: guard() });
  assert.deepEqual(state.wakeCalls[0]?.expected, { exists: false });
  assert.deepEqual(state.wakeCalls[0]?.wake, requestedWake);
  assert.equal(state.stageCalls.length, 1);
  assert.deepEqual(state.stageCalls[0]?.expected, { exists: false });
  assert.equal(state.values.has(fullKey(projectHeadKey())), true);
});

test("stale base and missing guard preserve conflict and staged-entry reconciliation results", async () => {
  const state = new WakeState();
  const store = createSolutionRevisionStore(WORKSPACE, PROJECT, state);

  assert.deepEqual(await store.publishGuardedWithJobWakeV1(patch("stale-base", revision("wake-stale")), guard(), wake()), {
    status: "conflict", actualBaseRevisionId: null,
  });
  assert.equal(state.stageCalls.length, 0);
  assert.equal(state.wakeCalls.length, 0);

  state.result = "missing-guard";
  assert.deepEqual(await store.publishGuardedWithJobWakeV1(patch(null, revision("wake-missing-guard")), guard(), wake()), {
    status: "unsupported", reason: "missing-guard", stagedRevisionId: "wake-missing-guard", expectedBaseRevisionId: null,
  });
  assert.equal(await store.current(), null);
  assert.deepEqual(await store.stagedRevision("wake-missing-guard", null), {
    status: "staged", sequence: 1, expectedBaseRevisionId: null, revision: revision("wake-missing-guard"),
  });
  assert.equal(state.wakeCalls.length, 1);
  assert.equal(state.legacyGuardedCalls, 0);
});

test("lost atomic response propagates without retry and leaves committed head recognizable", async () => {
  const state = new WakeState();
  state.loseWakeResponseAfterCommit = true;
  const store = createSolutionRevisionStore(WORKSPACE, PROJECT, state);
  const proposed = revision("wake-response-lost");

  await assert.rejects(store.publishGuardedWithJobWakeV1(patch(null, proposed), guard(), wake()), /response lost after commit/u);
  assert.deepEqual((await store.current())?.revision, proposed);
  assert.deepEqual(await store.stagedRevision(proposed.graphRevisionId, null), {
    status: "conflict", actualBaseRevisionId: proposed.graphRevisionId,
  });
  assert.equal(state.wakeCalls.length, 1);
  assert.equal(state.legacyGuardedCalls, 0);
  assert.equal(state.stageCalls.filter(call => call.key.stateKey.startsWith("solution-head.v1.")).length, 0);
});
