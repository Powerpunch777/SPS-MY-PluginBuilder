import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createProjectDeliverablesStore } from "../src/project-deliverables-store.ts";
import type { ProjectDeliverableSource } from "../src/domain/project-deliverable-source.ts";

const WORKSPACE_A = "a1234567-b89c-4123-8123-123456789abc";
const WORKSPACE_B = "b1234567-b89c-4123-8123-123456789abc";
const PROJECT_A = "customer-project-a";
const PROJECT_B = "customer-project-b";

function clone<T>(value: T): T { return structuredClone(value); }
function fullKey(key: SpsStateKey): string { return JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]); }

class FakeState {
  readonly values = new Map<string, JsonValue>();
  async get(key: SpsStateKey): Promise<JsonValue | null> {
    const value = this.values.get(fullKey(key));
    return value === undefined ? null : clone(value);
  }
  async compareAndSet(key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
    const storageKey = fullKey(key);
    const exists = this.values.has(storageKey);
    const current = this.values.get(storageKey);
    const matches = expected.exists ? exists && JSON.stringify(current) === JSON.stringify(expected.value) : !exists;
    if (matches) this.values.set(storageKey, clone(value));
    return { swapped: matches };
  }
}

function source(revisionId: string, overrides: Partial<ProjectDeliverableSource> = {}): ProjectDeliverableSource {
  return {
    workspaceId: WORKSPACE_A,
    projectId: PROJECT_A,
    revisionId,
    sourceRevision: { kind: "source-manifest", value: "source-manifest-actual-ref" },
    authoringReference: { sourceId: "lead-turn:actual-user-input", revisionId: "turn-revision-3" },
    requirements: [{ id: "PROJECT-DELIVERABLE-1", description: "Project specific executable package.",
      sourceReferences: [{ sourceId: "approved-project-scope", revisionId: "scope-rev-7" }] }],
    catalogReferences: [{ sourceId: "existing-catalog-record", revisionId: "catalog-rev-2" }],
    documentation: {
      installation: "Install using the project's approved package instructions.",
      usage: "Use only with the configured project workspace.",
      knownLimits: ["The source revision relation has not been independently verified."],
      sourceReferences: [{ sourceId: "project-document", revisionId: "doc-rev-4" }],
    },
    ...overrides,
  };
}

test("persists and reads project-scoped G7 source drafts without upgrading authority", async () => {
  const state = new FakeState();
  const store = createProjectDeliverablesStore(WORKSPACE_A, PROJECT_A, state);
  assert.equal((await store.readCurrentForSource(source("unused").sourceRevision)).status, "missing");
  assert.deepEqual(await store.appendDraft(null, source("deliverables-r01")), {
    status: "published", sequence: 1, revision: source("deliverables-r01"),
  });

  const restarted = createProjectDeliverablesStore(WORKSPACE_A, PROJECT_A, state);
  const read = await restarted.readCurrentForSource(source("unused").sourceRevision);
  assert.equal(read.status, "found");
  if (read.status !== "found") return;
  assert.equal(read.authority, "unknown");
  assert.equal(read.sourceRevisionVerification, "unknown");
  assert.equal(read.value.authoringReference.sourceId, "lead-turn:actual-user-input");
  assert.equal(read.value.requirements[0]?.id, "PROJECT-DELIVERABLE-1");
  assert.equal(read.value.catalogReferences[0]?.revisionId, "catalog-rev-2");
  assert.equal(read.value.documentation.installation, source("x").documentation.installation);
  assert.equal(read.value.documentation.usage, source("x").documentation.usage);
  assert.deepEqual(read.value.documentation.knownLimits, ["The source revision relation has not been independently verified."]);
  assert(Object.isFrozen(read.value));
  assert(Object.isFrozen(read.value.documentation));
  assert.deepEqual(await restarted.appendDraft("stale-revision", source("deliverables-r02")), {
    status: "conflict", actualBaseRevisionId: "deliverables-r01",
  });
});

test("missing documentation stays missing and a different source revision is not current", async () => {
  const state = new FakeState();
  const store = createProjectDeliverablesStore(WORKSPACE_A, PROJECT_A, state);
  const incomplete = source("deliverables-r01", { documentation: {
    installation: null, usage: null, knownLimits: null, sourceReferences: [],
  } });
  await store.appendDraft(null, incomplete);

  const sameSource = await store.readCurrentForSource(incomplete.sourceRevision);
  assert.equal(sameSource.status, "found");
  if (sameSource.status === "found") {
    assert.equal(sameSource.value.documentation.installation, null);
    assert.equal(sameSource.value.documentation.usage, null);
    assert.equal(sameSource.value.documentation.knownLimits, null);
    assert.equal(sameSource.authority, "unknown");
  }
  assert.deepEqual(await store.readCurrentForSource({ kind: "source-manifest", value: "another-manifest" }), {
    status: "mismatched", reason: "project-record-source-revision-differs",
  });
});

test("workspace and project journals do not share current records", async () => {
  const state = new FakeState();
  const owner = createProjectDeliverablesStore(WORKSPACE_A, PROJECT_A, state);
  await owner.appendDraft(null, source("deliverables-r01"));
  assert.equal((await createProjectDeliverablesStore(WORKSPACE_B, PROJECT_A, state).current()), null);
  assert.equal((await createProjectDeliverablesStore(WORKSPACE_A, PROJECT_B, state).current()), null);
});

test("invalid scope and malformed source records are rejected", async () => {
  const state = new FakeState();
  assert.throws(() => createProjectDeliverablesStore("not-a-workspace", PROJECT_A, state), /canonical Workspace ID/);
  const store = createProjectDeliverablesStore(WORKSPACE_A, PROJECT_A, state);
  await assert.rejects(store.appendDraft(null, source("bad-revision", { projectId: PROJECT_B })), /outside the expected Workspace\/project/);
  await assert.rejects(store.appendDraft(null, source("duplicate", {
    requirements: [source("a").requirements[0]!, source("b").requirements[0]!],
  })), /duplicate IDs/);
  assert.equal(await store.current(), null);
});

test("read failures and corrupt current entries stay unknown, then recover on a later read", async () => {
  const state = new FakeState();
  const store = createProjectDeliverablesStore(WORKSPACE_A, PROJECT_A, state);
  await store.appendDraft(null, source("deliverables-r01"));

  const failOnce = { ...state, get: state.get.bind(state) } as FakeState;
  let fail = true;
  failOnce.get = async key => {
    if (fail) {
      fail = false;
      throw new Error("private host detail must not escape");
    }
    return state.get(key);
  };
  const recovering = createProjectDeliverablesStore(WORKSPACE_A, PROJECT_A, failOnce);
  assert.deepEqual(await recovering.readCurrentForSource(source("unused").sourceRevision), {
    status: "unknown", reason: "project-record-read-failed",
  });
  assert.equal((await recovering.readCurrentForSource(source("unused").sourceRevision)).status, "found");

  const head = [...state.values.keys()].find(key => key.includes("project-deliverables-head.v1."));
  assert(head);
  const savedHead = state.values.get(head);
  state.values.set(head, { revisionId: "deliverables-r01", sequence: 1, digest: "0".repeat(64) });
  assert.deepEqual(await store.readCurrentForSource(source("unused").sourceRevision), {
    status: "unknown", reason: "project-record-read-failed",
  });
  state.values.set(head, savedHead!);
  assert.equal((await store.readCurrentForSource(source("unused").sourceRevision)).status, "found");
});

test("unsupported CAS cannot publish a draft", async () => {
  const base = new FakeState();
  const state = { get: base.get.bind(base) };
  const store = createProjectDeliverablesStore(WORKSPACE_A, PROJECT_A, state);
  await assert.rejects(store.appendDraft(null, source("deliverables-r01")), /compareAndSet is required/);
  assert.equal(await store.current(), null);
});

test("concurrent writers from one base publish only one revision and report the loser", async () => {
  const state = new FakeState();
  const store = createProjectDeliverablesStore(WORKSPACE_A, PROJECT_A, state);
  const results = await Promise.all([
    store.appendDraft(null, source("deliverables-r01")),
    store.appendDraft(null, source("deliverables-r02")),
  ]);
  assert.equal(results.filter(result => result.status === "published").length, 1);
  assert.equal(results.filter(result => result.status === "conflict").length, 1);

  const current = await store.current();
  assert(current);
  assert.equal(current.sequence, 1);
  assert.equal((await store.appendDraft(current.revision.revisionId, source("deliverables-r03"))).status, "published");
  assert.equal((await store.current())?.sequence, 2);
});

test("an unpublished staged entry can recover after a head CAS conflict", async () => {
  const base = new FakeState();
  const headWriteFailures = new Set<string>();
  const state = {
    get: base.get.bind(base),
    compareAndSet: async (key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) => {
      if (key.stateKey.startsWith("project-deliverables-head.v1.") && !headWriteFailures.has(key.stateKey)) {
        headWriteFailures.add(key.stateKey);
        return { swapped: false };
      }
      return base.compareAndSet(key, expected, value);
    },
  };
  const store = createProjectDeliverablesStore(WORKSPACE_A, PROJECT_A, state);
  assert.deepEqual(await store.appendDraft(null, source("deliverables-r01")), {
    status: "conflict", actualBaseRevisionId: null,
  });
  assert.equal(await store.current(), null);
  assert.equal((await store.appendDraft(null, source("deliverables-r01"))).status, "published");
  assert.equal((await store.current())?.revision.revisionId, "deliverables-r01");
});
