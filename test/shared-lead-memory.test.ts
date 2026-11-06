import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { readSharedLeadMemory, updateSharedLeadMemory } from "../src/platform.ts";
import { createEmptyBuilderSnapshot } from "../src/domain/snapshot.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const NEXT_LEAD = "44444444-4444-4444-8444-444444444444";
const WORKER = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";
const NEXT_RUN = "77777777-7777-4777-8777-777777777777";
const SESSIONS = {
  main: "88888888-8888-4888-8888-888888888888",
  "cto-inbox": "99999999-9999-4999-8999-999999999999",
  decisions: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const NEXT_SESSIONS = {
  main: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "cto-inbox": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  decisions: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
};
const PROJECT = "project-alpha";
const OTHER_PROJECT = "project-beta";
const CONSULTATION = "consultation-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ASSISTANT = "consultation-ffffffff-ffff-4fff-8fff-ffffffffffff";
const FOREIGN = "consultation-12121212-1212-4121-8121-121212121212";
const PRIVATE_TURN = "13131313-1313-4131-8131-131313131313";
const OTHER_TURN = "14141414-1414-4141-8141-141414141414";
const NAMESPACE = "sonpark.my-builder";
type Expected = { exists: false } | { exists: true; value: JsonValue };
const stateId = (key: SpsStateKey) => JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function fixture() {
  const values = new Map<string, JsonValue>();
  const casCalls: Array<{ key: SpsStateKey; expected: Expected; value: JsonValue }> = [];
  let successfulWrites = 0;
  let setCalls = 0;
  let onGet: ((key: SpsStateKey) => void) | undefined;
  const key = (workspaceId: string, stateKey: string): SpsStateKey => ({
    scopeKind: "company", scopeId: workspaceId, namespace: NAMESPACE, stateKey,
  });
  const state = {
    async get(input: SpsStateKey) {
      onGet?.(input);
      const value = values.get(stateId(input));
      return value === undefined ? null : structuredClone(value);
    },
    async set(input: SpsStateKey, value: JsonValue) {
      setCalls += 1;
      successfulWrites += 1;
      values.set(stateId(input), structuredClone(value));
    },
    async compareAndSet(input: SpsStateKey, expected: Expected, value: JsonValue) {
      casCalls.push({ key: structuredClone(input), expected: structuredClone(expected), value: structuredClone(value) });
      const id = stateId(input);
      const exists = values.has(id);
      const current = values.get(id);
      const matches = expected.exists
        ? exists && JSON.stringify(current) === JSON.stringify(expected.value)
        : !exists;
      if (matches) {
        successfulWrites += 1;
        values.set(id, structuredClone(value));
      }
      return { swapped: matches };
    },
  };
  function select(workspaceId = WORKSPACE, agentId = LEAD, revision = 1, sessions = SESSIONS) {
    values.set(stateId(key(workspaceId, "lead-agent.v1")), { workspaceId, revision, selectedAgentId: agentId });
    values.set(stateId(key(workspaceId, `lead-sessions.v1.${revision}`)), {
      workspaceId, selectionRevision: revision, agentId, sessions: { ...sessions },
    });
  }
  function addSnapshot(workspaceId = WORKSPACE, messages = true) {
    const snapshot = createEmptyBuilderSnapshot(workspaceId);
    if (messages) {
      snapshot.messages.push({ id: CONSULTATION, channel: "main", actorId: null, role: "user",
        text: "The user wants a reliable shared planning memory.", createdAt: "2026-11-02T00:00:00.000Z", runId: null });
      snapshot.messages.push({ id: ASSISTANT, channel: "main", actorId: null, role: "assistant",
        text: "Assistant output is not user evidence.", createdAt: "2026-11-02T00:00:01.000Z", runId: null });
    }
    values.set(stateId(key(workspaceId, "snapshot.v1")), snapshot as unknown as JsonValue);
  }
  select();
  addSnapshot();
  const platform = {
    state,
    agents: new Proxy({}, { get() { throw new Error("Shared memory tests must not call the Agent API"); } }),
  } as unknown as SpsPlatformInvocationContext;
  const context = (channel: keyof typeof SESSIONS = "main", agentId = LEAD, sessionId = SESSIONS[channel], runId = RUN) => ({
    companyId: WORKSPACE, agentId, runId, sessionId,
  });
  return {
    values, key, state, platform, context, casCalls,
    get successfulWrites() { return successfulWrites; },
    get setCalls() { return setCalls; },
    onGet(callback: typeof onGet) { onGet = callback; },
    select,
    addSnapshot,
  };
}

function memory(revisionId: string, sourceIds: string[] = [CONSULTATION], text = "Keep the planning memory useful.") {
  return { projectId: PROJECT, revisionId, entries: [{ id: "goal-1", kind: "goal", text, sourceIds }] };
}

function params(revisionId: string, expectedBaseRevisionId: string | null = null, sourceIds?: string[], text?: string) {
  return { projectId: PROJECT, expectedBaseRevisionId, memory: memory(revisionId, sourceIds, text) };
}

function persistPrivateTurn(f: ReturnType<typeof fixture>, requestId: string, overrides: Record<string, unknown> = {}) {
  const turn = {
    workspaceId: WORKSPACE, selectionRevision: 1, agentId: LEAD, sessionId: SESSIONS.main,
    channel: "main", schemaVersion: 1, requestId, previousRequestId: null, sequence: 0,
    text: "Private Lead-session user input; retain its digest only.", createdAt: "2026-11-02T00:00:00.000Z",
    state: "prepared", runId: null, answer: null, outputState: "not_ready", cancellationRequested: false,
    termination: "not_applicable", ...overrides,
  };
  f.values.set(stateId(f.key(WORKSPACE, `lead-chat.turn.v1.${requestId}`)), turn as unknown as JsonValue);
  return turn;
}

test("three prepared Lead channels share one project journal, while project and Workspace remain isolated", async () => {
  const f = fixture();
  let previous: string | null = null;
  for (const channel of ["main", "cto-inbox", "decisions"] as const) {
    const revisionId = `from-${channel}`;
    const result = await updateSharedLeadMemory(params(revisionId, previous), f.context(channel), f.platform);
    assert.equal((result.data as { status: string }).status, "published");
    const read = await readSharedLeadMemory({ projectId: PROJECT }, f.context(channel), f.platform);
    const current = (read.data as { current: { revision: { memory: { revisionId: string } } } }).current;
    assert.equal(current.revision.memory.revisionId, revisionId);
    previous = revisionId;
  }
  assert.equal(f.successfulWrites, 6);
  assert.equal(f.setCalls, 0);
  assert.equal((await readSharedLeadMemory({ projectId: OTHER_PROJECT }, f.context(), f.platform).then(r => (r.data as { current: unknown }).current)), null);

  f.select(OTHER_WORKSPACE);
  f.addSnapshot(OTHER_WORKSPACE);
  const otherContext = { ...f.context(), companyId: OTHER_WORKSPACE };
  assert.equal((await readSharedLeadMemory({ projectId: PROJECT }, otherContext, f.platform).then(r => (r.data as { current: unknown }).current)), null);
});

test("only the selected Lead in one of its prepared sessions can read or write", async () => {
  const f = fixture();
  const cases = [
    f.context("main", WORKER),
    f.context("main", LEAD, "15151515-1515-4151-8151-151515151515"),
  ];
  for (const ctx of cases) {
    await assert.rejects(readSharedLeadMemory({ projectId: PROJECT }, ctx, f.platform));
    await assert.rejects(updateSharedLeadMemory(params("denied"), ctx, f.platform));
  }
  f.select(WORKSPACE, NEXT_LEAD, 2, NEXT_SESSIONS);
  await assert.rejects(readSharedLeadMemory({ projectId: PROJECT }, f.context(), f.platform), /current Builder Lead/i);
  await assert.rejects(updateSharedLeadMemory(params("stale"), f.context(), f.platform), /current Builder Lead/i);
  const staleSession = f.context("main", NEXT_LEAD, SESSIONS.main, NEXT_RUN);
  await assert.rejects(readSharedLeadMemory({ projectId: PROJECT }, staleSession, f.platform), /prepared current Lead session/i);
  await assert.rejects(updateSharedLeadMemory(params("stale-session"), staleSession, f.platform), /prepared current Lead session/i);
  assert.equal(f.successfulWrites, 0);
  assert.equal(f.setCalls, 0);
  assert.equal(f.casCalls.length, 0);
});

test("citation digests come from actual user text; assistant, foreign, and private CTO sources are denied", async () => {
  const f = fixture();
  const cited = await updateSharedLeadMemory(params("cited", null, [CONSULTATION]), f.context(), f.platform);
  assert.equal((cited.data as { status: string }).status, "published");
  const stored = await readSharedLeadMemory({ projectId: PROJECT }, f.context(), f.platform);
  assert.deepEqual((stored.data as { current: { revision: { sourceDigests: unknown } } }).current.revision.sourceDigests,
    [{ id: CONSULTATION, sha256: sha256("The user wants a reliable shared planning memory.") }]);

  const other = fixture();
  other.addSnapshot(OTHER_WORKSPACE);
  const otherSnapshot = other.values.get(stateId(other.key(OTHER_WORKSPACE, "snapshot.v1"))) as unknown as ReturnType<typeof createEmptyBuilderSnapshot>;
  otherSnapshot.messages.push({ id: FOREIGN, channel: "main", actorId: null, role: "user", text: "A different Workspace.",
    createdAt: "2026-11-02T00:00:00.000Z", runId: null });
  other.values.set(stateId(other.key(OTHER_WORKSPACE, "snapshot.v1")), otherSnapshot as unknown as JsonValue);
  for (const source of [ASSISTANT, FOREIGN, "consultation-16161616-1616-4161-8161-161616161616"]) {
    await assert.rejects(updateSharedLeadMemory(params(`reject-${source}`, "cited", [source]), f.context(), f.platform));
  }
  const privateTurn = persistPrivateTurn(f, PRIVATE_TURN, { channel: "cto-inbox", sessionId: SESSIONS["cto-inbox"] });
  assert.ok(privateTurn);
  await assert.rejects(updateSharedLeadMemory(params("private-cto", "cited", [`lead-turn:${PRIVATE_TURN}`]), f.context(), f.platform));
  assert.equal(f.setCalls, 0);
  assert.equal(f.casCalls.length, 2);
});

test("stale revisions conflict without retry; response loss is reconciled by an explicit read", async () => {
  const f = fixture();
  await updateSharedLeadMemory(params("rev-1"), f.context(), f.platform);
  const before = f.casCalls.length;
  const stale = await updateSharedLeadMemory(params("stale", null), f.context(), f.platform);
  assert.equal((stale.data as { status: string }).status, "conflict");
  assert.equal(f.casCalls.length, before);

  const originalCas = f.state.compareAndSet.bind(f.state);
  let dropHeadReceipt = true;
  const platform = { ...f.platform, state: { ...f.state, compareAndSet: async (key: SpsStateKey, expected: Expected, value: JsonValue) => {
    const receipt = await originalCas(key, expected, value);
    if (dropHeadReceipt && key.stateKey.startsWith("lead-memory-head.v1.") && receipt.swapped) {
      dropHeadReceipt = false;
      throw new Error("Head CAS response was lost");
    }
    return receipt;
  } } } as unknown as SpsPlatformInvocationContext;
  const beforeLoss = f.casCalls.length;
  const writesBeforeLoss = f.successfulWrites;
  await assert.rejects(updateSharedLeadMemory(params("rev-2", "rev-1"), f.context(), platform), /response was lost/);
  assert.equal(f.casCalls.length - beforeLoss, 2);
  assert.equal(f.successfulWrites - writesBeforeLoss, 2);
  assert.equal(f.setCalls, 0);
  const reconciled = await readSharedLeadMemory({ projectId: PROJECT }, f.context(), f.platform);
  assert.equal((reconciled.data as { current: { revision: { memory: { revisionId: string } } } }).current.revision.memory.revisionId, "rev-2");
});

test("observed Lead selection change before publication blocks CAS", async () => {
  const f = fixture();
  let switched = false;
  f.onGet(key => {
    if (!switched && key.stateKey === "snapshot.v1") {
      switched = true;
      f.select(WORKSPACE, NEXT_LEAD, 2, NEXT_SESSIONS);
    }
  });
  await assert.rejects(updateSharedLeadMemory(params("raced"), f.context(), f.platform), /selection changed/i);
  assert.equal(switched, true);
  assert.equal(f.casCalls.length, 0);
  assert.equal(f.successfulWrites, 0);
  assert.equal(f.setCalls, 0);
});

test("restart and newly selected Lead retain exact entries and provenance; old Lead loses write authority", async () => {
  const f = fixture();
  const turn = persistPrivateTurn(f, OTHER_TURN);
  const sourceId = `lead-turn:${OTHER_TURN}`;
  await updateSharedLeadMemory(params("old-lead-rev", null, [sourceId]), f.context(), f.platform);
  const restartedPlatform = { ...f.platform, state: f.state } as unknown as SpsPlatformInvocationContext;
  const afterRestart = await readSharedLeadMemory({ projectId: PROJECT }, f.context(), restartedPlatform);
  const original = (afterRestart.data as { current: unknown }).current;

  f.select(WORKSPACE, NEXT_LEAD, 2, NEXT_SESSIONS);
  const nextContext = f.context("main", NEXT_LEAD, NEXT_SESSIONS.main, NEXT_RUN);
  const inherited = await updateSharedLeadMemory({ projectId: PROJECT, expectedBaseRevisionId: "old-lead-rev",
    memory: memory("new-lead-rev", [sourceId]) }, nextContext, f.platform);
  assert.equal((inherited.data as { status: string }).status, "published");
  const current = (await readSharedLeadMemory({ projectId: PROJECT }, nextContext, f.platform).then(r => (r.data as { current: any }).current));
  assert.deepEqual(current.revision.memory.entries, (original as any).revision.memory.entries);
  assert.deepEqual(current.revision.sourceDigests, (original as any).revision.sourceDigests);
  assert.deepEqual(current.revision.author, {
    agentId: NEXT_LEAD, sessionId: NEXT_SESSIONS.main, runId: NEXT_RUN, selectionRevision: 2, channel: "main",
  });
  assert.equal(turn.text, "Private Lead-session user input; retain its digest only.");
  await assert.rejects(updateSharedLeadMemory(params("old-lead-write", "new-lead-rev", [sourceId]), f.context(), f.platform), /current Builder Lead/i);
});

test("changed inherited interpretation cannot borrow an old selection's private turn source", async () => {
  const f = fixture();
  persistPrivateTurn(f, OTHER_TURN);
  const sourceId = `lead-turn:${OTHER_TURN}`;
  await updateSharedLeadMemory(params("old-rev", null, [sourceId]), f.context(), f.platform);
  f.select(WORKSPACE, NEXT_LEAD, 2, NEXT_SESSIONS);
  const nextContext = f.context("main", NEXT_LEAD, NEXT_SESSIONS.main, NEXT_RUN);
  await assert.rejects(updateSharedLeadMemory(params("changed", "old-rev", [sourceId], "Changed interpretation."), nextContext, f.platform), /conversation is unavailable or changed/i);
  assert.equal(f.setCalls, 0);
});
