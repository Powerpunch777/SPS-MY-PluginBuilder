import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createCtoMemoryStore, type AuthoredCtoMemory } from "../src/cto-memory-store.ts";
import type { RevisionState } from "../src/solution-revision-store.ts";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherWorkspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const projectId = "project-memory";
const otherProjectId = "other-project";
const ctoId = "cto-memory";
const otherCtoId = "cto-other";
const agentId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const otherRequestId = "55555555-5555-4555-8555-555555555555";
const timestamp = "2026-11-02T01:02:03.004Z";
const digest = "a".repeat(64);

const stateKey = (key: SpsStateKey) => JSON.stringify(key);

function fixture() {
  const values = new Map<string, JsonValue>();
  let writes = 0;
  const state: RevisionState = {
    async get(key) { return structuredClone(values.get(stateKey(key)) ?? null); },
    async compareAndSet(key, expected, value) {
      const mapKey = stateKey(key), current = values.get(mapKey);
      const matches = expected.exists
        ? current !== undefined && JSON.stringify(current) === JSON.stringify(expected.value)
        : current === undefined;
      if (matches) { values.set(mapKey, structuredClone(value)); writes += 1; }
      return { swapped: matches };
    },
  };
  return { state, values, get writes() { return writes; } };
}

function memory(revisionId = "memory-rev-1", overrides: Record<string, unknown> = {}) {
  return {
    projectId, ctoId, revisionId,
    entries: [
      { id: "MEM-001", kind: "context", text: "Keep the approved data boundary.", sourceRequestIds: [requestId, otherRequestId] },
      { id: "MEM-002", kind: "decision", text: "Use the existing authentication contract.", sourceRequestIds: [requestId] },
    ],
    ...overrides,
  };
}

function authored(revisionId = "memory-rev-1", overrides: Record<string, unknown> = {}): AuthoredCtoMemory {
  return {
    memory: memory(revisionId),
    author: { agentId, sessionId, runId },
    createdAt: timestamp,
    sourceDigests: [
      { requestId, workstreamId: "WS-001", specRevision: 1, sha256: digest },
      { requestId: otherRequestId, workstreamId: "WS-002", specRevision: 3, sha256: "b".repeat(64) },
    ],
    ...overrides,
  } as AuthoredCtoMemory;
}

test("does not initialize a private memory lane until an explicit publish", async () => {
  const f = fixture();
  const store = createCtoMemoryStore(workspaceId, projectId, ctoId, f.state);
  assert.equal(await store.current(), null);
  assert.equal(f.writes, 0);
  assert.equal(f.values.size, 0);
});

test("publishes, reads and retains immutable authored revisions and exact source citations", async () => {
  const f = fixture();
  const store = createCtoMemoryStore(workspaceId, projectId, ctoId, f.state);
  const first = authored();
  const published = await store.publish({ expectedBaseRevisionId: null, revision: first });
  assert.equal(published.status, "published");
  assert.deepEqual(published.revision, first);
  assert.notEqual(published.revision, first);
  assert(Object.isFrozen(published.revision));
  assert(Object.isFrozen(published.revision.author));
  assert(Object.isFrozen(published.revision.memory.entries));
  assert(Object.isFrozen(published.revision.memory.entries[0]?.sourceRequestIds));
  assert(Object.isFrozen(published.revision.sourceDigests));
  const current = (await store.current())!;
  assert.equal(current.sequence, 1);
  assert.deepEqual(current.revision, first);
  const second = authored("memory-rev-2", { memory: memory("memory-rev-2", { entries: [] }), sourceDigests: [] });
  assert.equal((await store.publish({ expectedBaseRevisionId: "memory-rev-1", revision: second })).status, "published");
  assert.equal((await store.publishedRevision("memory-rev-1"))?.revision.memory.revisionId, "memory-rev-1");
  const recent = await store.recent();
  assert.deepEqual(recent.revisions.map(item => item.revision.memory.revisionId), ["memory-rev-2", "memory-rev-1"]);
  assert.equal(recent.hasMore, false);
});

test("isolates the journal by Workspace, project, and CTO", async () => {
  const f = fixture();
  await createCtoMemoryStore(workspaceId, projectId, ctoId, f.state).publish({ expectedBaseRevisionId: null, revision: authored() });
  for (const [workspace, project, cto] of [
    [otherWorkspaceId, projectId, ctoId], [workspaceId, otherProjectId, ctoId], [workspaceId, projectId, otherCtoId],
  ]) {
    assert.equal(await createCtoMemoryStore(workspace!, project!, cto!, f.state).current(), null);
  }
  const source = createCtoMemoryStore(workspaceId, projectId, ctoId, f.state);
  const storedKeys = [...f.values.keys()].filter(key => key.includes(workspaceId));
  assert.equal(storedKeys.length, 2);
  assert(storedKeys.every(key => key.includes("cto-memory")));
  assert.equal((await source.current())?.revision.memory.revisionId, "memory-rev-1");
});

test("uses journal CAS for concurrent writes and preserves the winning historical head", async () => {
  const f = fixture();
  const store = createCtoMemoryStore(workspaceId, projectId, ctoId, f.state);
  const results = await Promise.all([
    store.publish({ expectedBaseRevisionId: null, revision: authored("memory-a") }),
    store.publish({ expectedBaseRevisionId: null, revision: authored("memory-b", {
      memory: memory("memory-b", { entries: [{ id: "MEM-B", kind: "assumption", text: "Wait for evidence.", sourceRequestIds: [requestId] }] }),
      sourceDigests: [{ requestId, workstreamId: "WS-001", specRevision: 1, sha256: digest }],
    }) }),
  ]);
  assert.equal(results.filter(result => result.status === "published").length, 1);
  assert.equal(results.filter(result => result.status === "conflict").length, 1);
  assert.equal((await store.current())?.sequence, 1);
  assert.equal((await store.recent()).revisions.length, 1);
});

test("rejects malformed author, timestamp, citation records, and non-exact source sets before writes", async () => {
  const invalid: unknown[] = [
    authored("bad-author", { author: { agentId, sessionId, runId, extra: true } }),
    authored("bad-uuid", { author: { agentId: "not-a-uuid", sessionId, runId } }),
    authored("bad-date", { createdAt: "2026-11-02T01:02:03Z" }),
    authored("bad-source", { sourceDigests: [{ requestId, workstreamId: "WS-001", specRevision: 0, sha256: digest }] }),
    authored("missing-source", { sourceDigests: [{ requestId, workstreamId: "WS-001", specRevision: 1, sha256: digest }] }),
    authored("extra-source", { sourceDigests: [
      { requestId, workstreamId: "WS-001", specRevision: 1, sha256: digest },
      { requestId: otherRequestId, workstreamId: "WS-002", specRevision: 3, sha256: "b".repeat(64) },
      { requestId: "66666666-6666-4666-8666-666666666666", workstreamId: "WS-003", specRevision: 1, sha256: digest },
    ] }),
    authored("wrong-scope", { memory: memory("wrong-scope", { ctoId: otherCtoId }) }),
  ];
  for (const revision of invalid) {
    const f = fixture(), store = createCtoMemoryStore(workspaceId, projectId, ctoId, f.state);
    await assert.rejects(store.publish({ expectedBaseRevisionId: null, revision }));
    assert.equal(f.writes, 0);
    assert.equal(f.values.size, 0);
  }
});

test("rejects more than 128 unique source requests across entries before any journal write", async () => {
  const refs = Array.from({ length: 129 }, (_, index) => `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`);
  const entries = Array.from({ length: 5 }, (_, index) => ({ id: `MEM-${index}`, kind: "context", text: "Context", sourceRequestIds: refs.slice(index * 32, Math.min((index + 1) * 32, refs.length)) }));
  const sourceDigests = refs.map((requestId, index) => ({ requestId, workstreamId: "WS-001", specRevision: 1, sha256: digest }));
  const f = fixture(), store = createCtoMemoryStore(workspaceId, projectId, ctoId, f.state);
  await assert.rejects(store.publish({ expectedBaseRevisionId: null, revision: authored("too-many-sources", {
    memory: memory("too-many-sources", { entries }), sourceDigests,
  }) }), /at most 128 unique source requests/);
  assert.equal(f.writes, 0);
  assert.equal(f.values.size, 0);
});

test("rejects malformed store inputs and a missing CAS capability without creating state", async () => {
  const f = fixture(), store = createCtoMemoryStore(workspaceId, projectId, ctoId, f.state);
  await assert.rejects(store.publish({ expectedBaseRevisionId: null, revision: { ...authored(), unexpected: true } }), /unknown or missing fields/);
  const noCas: RevisionState = { get: f.state.get };
  const unsupported = createCtoMemoryStore(workspaceId, projectId, ctoId, noCas);
  await assert.rejects(unsupported.publish({ expectedBaseRevisionId: null, revision: authored() }), /compareAndSet is required/);
  assert.equal(f.writes, 0);
});
