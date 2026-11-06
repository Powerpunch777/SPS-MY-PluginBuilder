import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createEmptyBuilderSnapshot } from "../src/domain/snapshot.ts";
import { importConsultation, proposeLeadDesign, readLeadDesignSources } from "../src/platform.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const WORKER = "44444444-4444-4444-8444-444444444444";
const RUN = "55555555-5555-4555-8555-555555555555";
const OTHER_RUN = "99999999-9999-4999-8999-999999999999";
const SESSIONS = {
  main: "66666666-6666-4666-8666-666666666666",
  "cto-inbox": "77777777-7777-4777-8777-777777777777",
  decisions: "88888888-8888-4888-8888-888888888888",
};
const NAMESPACE = "sonpark.my-builder";
const CONSULTATION_IDS = [
  "consultation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "consultation-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
];
const TURN_IDS = {
  mainOld: "10101010-1010-4010-8010-101010101010",
  mainNew: "11111111-1111-4111-8111-111111111112",
  decisions: "20202020-2020-4020-8020-202020202020",
  cto: "30303030-3030-4030-8030-303030303030",
};
const fullKey = (key: SpsStateKey) => JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);

test("case-preserving imported UUIDs remain discoverable and citable without rewriting old IDs", async () => {
  const f = fixture({ includeSnapshot: false });
  const importPlatform = { ...f.platform, state: { ...f.platform.state,
    async set(key: SpsStateKey, value: JsonValue) { f.values.set(fullKey(key), structuredClone(value)); },
    async compareAndSet(key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
      const current = f.values.get(fullKey(key));
      const matches = expected.exists ? JSON.stringify(current) === JSON.stringify(expected.value) : !f.values.has(fullKey(key));
      if (matches) f.values.set(fullKey(key), structuredClone(value));
      return { swapped: matches };
    },
  } } as SpsPlatformInvocationContext;
  const requestId = "aAbBcCdD-1234-4AbC-8DeF-aBcDeF123456";
  await importConsultation(WORKSPACE, { requestId, text: "Original mixed-case import source." }, importPlatform);
  const page = await readLeadDesignSources({ channel: "consultation", cursor: null }, f.context, importPlatform);
  assert.deepEqual((page.data as { sources: unknown[] }).sources, [{ id: `consultation-${requestId}`, text: "Original mixed-case import source." }]);
  const result = await proposeLeadDesign({ projectId: WORKSPACE, expectedBaseRevisionId: null,
    draft: { projectId: WORKSPACE, revisionId: "case-draft-1", sourceIds: [`consultation-${requestId}`],
      specification: { revisionId: "spec-1", productTier: "M", requirements: [{ id: "REQ-1", description: "Preserve imported text", acceptanceCriteriaIds: [] }],
        targets: ["desktop"], dataPolicyRef: "unreviewed" }, graph: { graphRevisionId: "graph-1", entities: [], relations: [], viewLayoutRef: "layout-1" }, questions: [] } },
  f.context, importPlatform);
  assert.equal((result.data as { status: string }).status, "published");
});

type FixtureOptions = { workspaceId?: string; includeSnapshot?: boolean };
function fixture(options: FixtureOptions = {}) {
  const workspaceId = options.workspaceId ?? WORKSPACE;
  const values = new Map<string, JsonValue>();
  const reads: SpsStateKey[] = [];
  const writes: SpsStateKey[] = [];
  let onRead: ((key: SpsStateKey) => void) | undefined;
  const key = (stateKey: string, scopeId = workspaceId): SpsStateKey => ({
    scopeKind: "company", scopeId, namespace: NAMESPACE, stateKey,
  });
  const state = {
    async get(input: SpsStateKey) {
      reads.push(structuredClone(input));
      const value = structuredClone(values.get(fullKey(input)) ?? null);
      onRead?.(input);
      return value;
    },
    async set(input: SpsStateKey, _value: JsonValue) {
      writes.push(structuredClone(input));
      throw new Error("readLeadDesignSources must not write state");
    },
    async compareAndSet(input: SpsStateKey, _expected: unknown, _value: JsonValue) {
      writes.push(structuredClone(input));
      throw new Error("readLeadDesignSources must not compare-and-set state");
    },
  };
  values.set(fullKey(key("lead-agent.v1")), { workspaceId, revision: 1, selectedAgentId: LEAD });
  values.set(fullKey(key("lead-sessions.v1.1")), {
    workspaceId, selectionRevision: 1, agentId: LEAD, sessions: { ...SESSIONS },
  });
  if (options.includeSnapshot !== false) {
    const snapshot = createEmptyBuilderSnapshot(workspaceId);
    snapshot.messages.push(
      { id: CONSULTATION_IDS[0]!, channel: "main", actorId: null, role: "user", text: "Earlier user consultation.",
        createdAt: "2026-11-01T00:00:00.000Z", runId: null },
      { id: CONSULTATION_IDS[1]!, channel: "main", actorId: null, role: "user", text: "Latest user consultation.",
        createdAt: "2026-11-02T00:00:00.000Z", runId: null },
      { id: "consultation-cccccccc-cccc-4ccc-8ccc-cccccccccccc", channel: "main", actorId: null, role: "assistant",
        text: "Assistant consultation is not user input.", createdAt: "2026-11-03T00:00:00.000Z", runId: null },
      { id: "consultation-dddddddd-dddd-4ddd-8ddd-dddddddddddd", channel: "decisions", actorId: null, role: "user",
        text: "Other channel is excluded.", createdAt: "2026-11-04T00:00:00.000Z", runId: null },
    );
    values.set(fullKey(key("snapshot.v1")), snapshot as unknown as JsonValue);
  }
  const platform = {
    state,
    agents: new Proxy({}, { get() { throw new Error("Source reads must not call the Agent API"); } }),
  } as unknown as SpsPlatformInvocationContext;
  const context = { companyId: workspaceId, agentId: LEAD, runId: RUN, sessionId: SESSIONS.main };
  return {
    values, reads, writes, key, state, platform, context,
    setOnRead(callback: typeof onRead) { onRead = callback; },
  };
}

function putTurn(f: ReturnType<typeof fixture>, channel: "main" | "decisions" | "cto-inbox", requestId: string,
  sequence: number, previousRequestId: string | null, text: string) {
  const sessionId = SESSIONS[channel];
  const turn = {
    workspaceId: f.context.companyId,
    selectionRevision: 1,
    agentId: LEAD,
    sessionId,
    channel,
    schemaVersion: 1,
    requestId,
    previousRequestId,
    sequence,
    text,
    createdAt: `2026-11-0${sequence + 1}T00:00:00.000Z`,
    state: "succeeded",
    runId: RUN,
    answer: "Agent answer must never be exposed as a source.",
    outputState: "available",
    cancellationRequested: false,
    termination: "not_applicable",
  };
  f.values.set(fullKey(f.key(`lead-chat.turn.v1.${requestId}`)), turn as unknown as JsonValue);
  f.values.set(fullKey(f.key(`lead-chat.index.v1.1.${channel}.${sequence}`)), { requestId });
  return turn;
}

function putConversation(f: ReturnType<typeof fixture>, channel: "main" | "decisions", ids: readonly string[]) {
  let previousRequestId: string | null = null;
  ids.forEach((requestId, sequence) => {
    putTurn(f, channel, requestId, sequence, previousRequestId, `User ${channel} input ${sequence + 1}.`);
    previousRequestId = requestId;
  });
  f.values.set(fullKey(f.key(`lead-chat.head.v1.1.${channel}`)), {
    workspaceId: f.context.companyId, selectionRevision: 1, agentId: LEAD, sessionId: SESSIONS[channel], channel,
    schemaVersion: 1, totalTurns: ids.length, lastRequestId: previousRequestId, activeRequestId: null,
  });
}

async function sources(f: ReturnType<typeof fixture>, channel: "consultation" | "main" | "decisions", cursor: string | null = null) {
  return readLeadDesignSources({ channel, cursor }, f.context, f.platform);
}

test("consultation sources are newest-first, one per page, and stop at null", async () => {
  const f = fixture();
  const first = await sources(f, "consultation");
  assert.deepEqual(first.data, { workspaceId: WORKSPACE, projectId: WORKSPACE, channel: "consultation",
    sources: [{ id: CONSULTATION_IDS[1], text: "Latest user consultation." }], nextCursor: CONSULTATION_IDS[0] });
  const second = await sources(f, "consultation", CONSULTATION_IDS[0]!);
  assert.deepEqual(second.data, { workspaceId: WORKSPACE, projectId: WORKSPACE, channel: "consultation",
    sources: [{ id: CONSULTATION_IDS[0], text: "Earlier user consultation." }], nextCursor: null });
  const end = await sources(f, "consultation", CONSULTATION_IDS[0]!);
  assert.deepEqual(end.data, second.data);
  assert.equal(f.writes.length, 0);
});

test("main and decisions return linked user turns only, even when successful answers are available", async () => {
  const f = fixture({ includeSnapshot: false });
  putConversation(f, "main", [TURN_IDS.mainOld, TURN_IDS.mainNew]);
  putConversation(f, "decisions", [TURN_IDS.decisions]);

  const mainFirst = await sources(f, "main");
  assert.deepEqual(mainFirst.data, { workspaceId: WORKSPACE, projectId: WORKSPACE, channel: "main",
    sources: [{ id: `lead-turn:${TURN_IDS.mainNew}`, text: "User main input 2." }], nextCursor: TURN_IDS.mainOld });
  const mainSecond = await sources(f, "main", TURN_IDS.mainOld);
  assert.deepEqual(mainSecond.data, { workspaceId: WORKSPACE, projectId: WORKSPACE, channel: "main",
    sources: [{ id: `lead-turn:${TURN_IDS.mainOld}`, text: "User main input 1." }], nextCursor: null });
  const decisions = await sources(f, "decisions");
  assert.deepEqual(decisions.data, { workspaceId: WORKSPACE, projectId: WORKSPACE, channel: "decisions",
    sources: [{ id: `lead-turn:${TURN_IDS.decisions}`, text: "User decisions input 1." }], nextCursor: null });
  assert.doesNotMatch(JSON.stringify([mainFirst, mainSecond, decisions]), /Agent answer/);
  assert.equal(f.reads.some(read => read.stateKey.includes("cto-inbox")), false);
  assert.equal(f.writes.length, 0);
});

test("invalid fields, accessors, cursors, Worker, wrong Workspace, and mismatched sessions are rejected", async () => {
  const f = fixture();
  await assert.rejects(readLeadDesignSources({ channel: "main", cursor: null, projectId: "forged" }, f.context, f.platform));
  const accessor = Object.defineProperties({}, {
    channel: { enumerable: true, get() { throw new Error("must not invoke getter"); } },
    cursor: { enumerable: true, value: null },
  });
  await assert.rejects(readLeadDesignSources(accessor, f.context, f.platform));
  await assert.rejects(sources(f, "consultation", "not-a-source-id"));
  await assert.rejects(sources(f, "main", "not-a-uuid"));

  const workerContext = { ...f.context, agentId: WORKER };
  await assert.rejects(readLeadDesignSources({ channel: "consultation", cursor: null }, workerContext, f.platform));
  const malformedContext = { ...f.context, runId: "not-a-canonical-uuid" };
  await assert.rejects(readLeadDesignSources({ channel: "consultation", cursor: null }, malformedContext, f.platform));
  const otherWorkspaceContext = { ...f.context, companyId: OTHER_WORKSPACE };
  await assert.rejects(readLeadDesignSources({ channel: "consultation", cursor: null }, otherWorkspaceContext, f.platform));
  const unpreparedSessionContext = { ...f.context, sessionId: OTHER_RUN };
  await assert.rejects(readLeadDesignSources({ channel: "consultation", cursor: null }, unpreparedSessionContext, f.platform));
});

test("empty sources remain empty and internal CTO inbox is not a supported source channel", async () => {
  const f = fixture({ includeSnapshot: false });
  const emptyConsultation = await sources(f, "consultation");
  assert.deepEqual(emptyConsultation.data, { workspaceId: WORKSPACE, projectId: WORKSPACE, channel: "consultation",
    sources: [], nextCursor: null });
  const emptyMain = await sources(f, "main");
  assert.deepEqual(emptyMain.data, { workspaceId: WORKSPACE, projectId: WORKSPACE, channel: "main",
    sources: [], nextCursor: null });
  await assert.rejects(readLeadDesignSources({ channel: "cto-inbox", cursor: null }, f.context, f.platform));
  assert.equal(f.writes.length, 0);
});

test("a binding change during the read invalidates the result", async () => {
  const f = fixture();
  let changed = false;
  f.setOnRead(read => {
    if (!changed && read.stateKey === "snapshot.v1") {
      changed = true;
      f.values.set(fullKey(f.key("lead-agent.v1")), { workspaceId: WORKSPACE, revision: 2, selectedAgentId: LEAD });
    }
  });
  await assert.rejects(sources(f, "consultation"), /selection changed/);
  assert.equal(changed, true);
  assert.equal(f.writes.length, 0);
});

test("KV reads use exact Workspace keys and return cloned values", async () => {
  const f = fixture();
  await sources(f, "consultation");
  assert.ok(f.reads.length > 0);
  assert.ok(f.reads.every(read => read.scopeKind === "company" && read.scopeId === WORKSPACE
    && read.namespace === NAMESPACE));
  const returned = await f.state.get(f.key("lead-agent.v1")) as { selectedAgentId: string };
  returned.selectedAgentId = WORKER;
  assert.equal((f.values.get(fullKey(f.key("lead-agent.v1")) as string) as { selectedAgentId: string }).selectedAgentId, LEAD);
  assert.equal(f.writes.length, 0);
});
