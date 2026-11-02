import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createEmptyBuilderSnapshot } from "../src/domain/snapshot.ts";
import { proposeLeadDesign, readCurrentDesignDraft, readLeadDesignDraft } from "../src/platform.ts";

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
const NEXT_SESSIONS = {
  main: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "cto-inbox": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  decisions: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
const CONSULTATION_ID = "consultation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASSISTANT_ID = "consultation-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_WORKSPACE_SOURCE_ID = "consultation-dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TURN_IDS = {
  main: "10101010-1010-4010-8010-101010101010",
  decisions: "20202020-2020-4020-8020-202020202020",
  cto: "30303030-3030-4030-8030-303030303030",
  otherScope: "40404040-4040-4040-8040-404040404040",
  otherSelection: "50505050-5050-4050-8050-505050505050",
};
const PROJECT = WORKSPACE;
const NAMESPACE = "sonpark.my-builder";
const fullKey = (key: SpsStateKey) => JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);
type Expected = { exists: false } | { exists: true; value: JsonValue };

function draft(revisionId: string, sourceIds: string[] = [CONSULTATION_ID]) {
  return {
    projectId: PROJECT,
    revisionId,
    sourceIds,
    specification: {
      revisionId: `spec-${revisionId}`,
      productTier: "M",
      requirements: [{ id: "req-1", description: "Keep the user-provided intent.", acceptanceCriteriaIds: [] }],
      targets: ["desktop"],
      dataPolicyRef: "policy-unreviewed",
    },
    graph: { graphRevisionId: `graph-${revisionId}`, entities: [], relations: [], viewLayoutRef: "layout-unreviewed" },
    questions: [],
  };
}

function fixture(options: { workspaceId?: string; agentId?: string; sessionId?: string; revision?: number; includeSources?: boolean } = {}) {
  const workspaceId = options.workspaceId ?? WORKSPACE;
  const revision = options.revision ?? 1;
  const values = new Map<string, JsonValue>();
  const casCalls: Array<{ key: SpsStateKey; expected: Expected; value: JsonValue }> = [];
  let successfulWrites = 0;
  let setCalls = 0;
  let beforeCas: ((key: SpsStateKey, expected: Expected, value: JsonValue) => Promise<void>) | undefined;
  const key = (stateKey: string): SpsStateKey => ({ scopeKind: "company", scopeId: workspaceId, namespace: NAMESPACE, stateKey });
  const state = {
    async get(input: SpsStateKey) {
      return structuredClone(values.get(fullKey(input)) ?? null);
    },
    async set(input: SpsStateKey, value: JsonValue) {
      setCalls += 1;
      successfulWrites += 1;
      values.set(fullKey(input), structuredClone(value));
    },
    async compareAndSet(input: SpsStateKey, expected: Expected, value: JsonValue) {
      const call = { key: structuredClone(input), expected: structuredClone(expected), value: structuredClone(value) };
      casCalls.push(call);
      await beforeCas?.(call.key, call.expected, call.value);
      const id = fullKey(input);
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
  values.set(fullKey(key("lead-agent.v1")), { workspaceId, revision, selectedAgentId: LEAD });
  values.set(fullKey(key(`lead-sessions.v1.${revision}`)), {
    workspaceId, selectionRevision: revision, agentId: LEAD, sessions: { ...SESSIONS },
  });
  if (options.includeSources !== false) {
    const snapshot = createEmptyBuilderSnapshot(workspaceId);
    snapshot.messages.push({ id: CONSULTATION_ID, channel: "main", actorId: null, role: "user",
      text: "The user consultation is source material, not approval.", createdAt: "2026-11-02T00:00:00.000Z", runId: null });
    snapshot.messages.push({ id: ASSISTANT_ID, channel: "main", actorId: null, role: "assistant",
      text: "Assistant output is not user approval.", createdAt: "2026-11-02T00:00:01.000Z", runId: null });
    values.set(fullKey(key("snapshot.v1")), snapshot as unknown as JsonValue);
  }
  const platform = {
    state,
    agents: new Proxy({}, { get() { throw new Error("Design draft tools must not call the Agent API"); } }),
  } as unknown as SpsPlatformInvocationContext;
  const context = {
    companyId: workspaceId,
    agentId: options.agentId ?? LEAD,
    runId: RUN,
    sessionId: options.sessionId ?? SESSIONS.main,
  };
  return {
    values, key, state, platform, context, casCalls,
    get successfulWrites() { return successfulWrites; },
    get setCalls() { return setCalls; },
    setBeforeCas(callback: typeof beforeCas) { beforeCas = callback; },
    selectNextLead(nextAgentId = WORKER) {
      const nextRevision = revision + 1;
      values.set(fullKey(key("lead-agent.v1")), { workspaceId, revision: nextRevision, selectedAgentId: nextAgentId });
      values.set(fullKey(key(`lead-sessions.v1.${nextRevision}`)), {
        workspaceId, selectionRevision: nextRevision, agentId: nextAgentId, sessions: { ...NEXT_SESSIONS },
      });
    },
  };
}

function params(revisionId: string, expectedBaseRevisionId: string | null = null, sourceIds?: string[]) {
  return { projectId: PROJECT, expectedBaseRevisionId, draft: draft(revisionId, sourceIds) };
}

function persistLeadTurn(f: ReturnType<typeof fixture>, requestId: string, channel: "main" | "decisions" | "cto-inbox",
  overrides: Record<string, unknown> = {}) {
  const turn = {
    workspaceId: f.context.companyId,
    selectionRevision: 1,
    agentId: LEAD,
    sessionId: channel === "main" ? SESSIONS.main : channel === "decisions" ? SESSIONS.decisions : SESSIONS["cto-inbox"],
    channel,
    schemaVersion: 1,
    requestId,
    previousRequestId: null,
    sequence: 0,
    text: `Persisted ${channel} Lead user input ${requestId}.`,
    createdAt: "2026-11-02T00:00:00.000Z",
    state: "prepared",
    runId: null,
    answer: null,
    outputState: "not_ready",
    cancellationRequested: false,
    termination: "not_applicable",
    ...overrides,
  };
  f.values.set(fullKey(f.key(`lead-chat.turn.v1.${requestId}`)), turn as unknown as JsonValue);
  return turn;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

test("current Lead stores a draft without claiming approval or execution; current reads survive restart", async () => {
  const f = fixture();
  const result = await proposeLeadDesign(params("draft-1"), f.context, f.platform);
  assert.equal((result.data as { status: string }).status, "published");
  assert.match(result.content, /not customer approval, execution authorization/);
  assert.doesNotMatch(JSON.stringify(result), /approved|approval granted|executed|delivered/i);
  const stored = await readCurrentDesignDraft(WORKSPACE, PROJECT, f.platform);
  assert.equal(stored?.sequence, 1);
  assert.equal(stored?.revision.status, "draft");
  assert.equal(stored?.revision.draft.revisionId, "draft-1");
  assert.deepEqual(stored?.revision.sourceDigests.map(source => source.id), [CONSULTATION_ID]);
  const restarted = await readCurrentDesignDraft(WORKSPACE, PROJECT, f.platform);
  assert.deepEqual(restarted, stored);
  assert.equal(f.casCalls.length, 2);
  assert.equal(f.successfulWrites, 2);
});

test("two successful proposals retain linked revision history", async () => {
  const f = fixture();
  assert.equal(((await proposeLeadDesign(params("draft-1"), f.context, f.platform)).data as { status: string }).status, "published");
  assert.equal(((await proposeLeadDesign(params("draft-2", "draft-1"), f.context, f.platform)).data as { status: string }).status, "published");
  const head = await readCurrentDesignDraft(WORKSPACE, PROJECT, f.platform);
  assert.equal(head?.sequence, 2);
  assert.equal(head?.revision.draft.revisionId, "draft-2");
  const prefix = "design-draft-lead-1-revision.v1.";
  const entries = [...f.values.entries()].filter(([id]) => id.includes(prefix));
  assert.equal(entries.length, 2);
  assert.ok(entries.some(([, raw]) => (raw as { parent: unknown }).parent === null));
  assert.ok(entries.some(([, raw]) => (raw as { parent: { revisionId: string } }).parent?.revisionId === "draft-1"));
});

test("current Lead can read the current draft for its next expected base; Worker reads are rejected without writes", async () => {
  const f = fixture();
  await proposeLeadDesign(params("draft-for-read"), f.context, f.platform);
  const writes = f.successfulWrites;
  const result = await readLeadDesignDraft({ projectId: PROJECT }, f.context, f.platform);
  const data = result.data as { projectId: string; current: { sequence: number; revision: { status: string; draft: { revisionId: string } } } | null };
  assert.equal(data.projectId, PROJECT);
  assert.equal(data.current?.sequence, 1);
  assert.equal(data.current?.revision.status, "draft");
  assert.equal(data.current?.revision.draft.revisionId, "draft-for-read");
  assert.match(result.content, /unapproved/);
  await assert.rejects(readLeadDesignDraft({ projectId: PROJECT }, { ...f.context, agentId: WORKER }, f.platform), /current Builder Lead/i);
  assert.equal(f.successfulWrites, writes);
  assert.equal(f.casCalls.length, 2);
});

test("valid persisted main and decisions Lead turns are cited with digests of their actual text", async () => {
  for (const channel of ["main", "decisions"] as const) {
    const f = fixture();
    const requestId = TURN_IDS[channel];
    const turn = persistLeadTurn(f, requestId, channel);
    const result = await proposeLeadDesign(params(`from-${channel}`, null, [`lead-turn:${requestId}`]), f.context, f.platform);
    assert.equal((result.data as { status: string }).status, "published");
    const stored = await readCurrentDesignDraft(WORKSPACE, PROJECT, f.platform);
    assert.deepEqual(stored?.revision.sourceDigests, [{ id: `lead-turn:${requestId}`, sha256: sha256(turn.text) }]);
    assert.equal(f.setCalls, 0);
  }
});

test("Lead-turn citations reject another scope, cto-inbox, and another selection before CAS", async () => {
  const invalid = [
    { requestId: TURN_IDS.otherScope, channel: "main" as const, overrides: { workspaceId: OTHER_WORKSPACE } },
    { requestId: TURN_IDS.cto, channel: "cto-inbox" as const, overrides: {} },
    { requestId: TURN_IDS.otherSelection, channel: "main" as const,
      overrides: { selectionRevision: 2, agentId: WORKER, sessionId: NEXT_SESSIONS.main } },
  ];
  for (const entry of invalid) {
    const f = fixture();
    persistLeadTurn(f, entry.requestId, entry.channel, entry.overrides);
    await assert.rejects(proposeLeadDesign(params(`reject-${entry.requestId}`, null, [`lead-turn:${entry.requestId}`]), f.context, f.platform));
    assert.equal(f.casCalls.length, 0);
    assert.equal(f.setCalls, 0);
    assert.equal(f.successfulWrites, 0);
  }
});

test("rejects stale base, forged Worker/session, other Workspace, and unavailable or non-user source without writes", async () => {
  const f = fixture();
  await proposeLeadDesign(params("draft-1"), f.context, f.platform);
  const writes = f.successfulWrites;
  const stale = await proposeLeadDesign(params("stale", null), f.context, f.platform);
  assert.equal((stale.data as { status: string }).status, "conflict");
  await assert.rejects(proposeLeadDesign(params("worker"), { ...f.context, agentId: WORKER }, f.platform));
  await assert.rejects(proposeLeadDesign(params("wrong-session"), { ...f.context, sessionId: OTHER_RUN }, f.platform));
  const otherWorkspace = fixture({ workspaceId: OTHER_WORKSPACE });
  const foreignSnapshot = structuredClone(otherWorkspace.values.get(fullKey(otherWorkspace.key("snapshot.v1")))! as object) as ReturnType<typeof createEmptyBuilderSnapshot>;
  foreignSnapshot.messages.push({ id: OTHER_WORKSPACE_SOURCE_ID, channel: "main", actorId: null, role: "user",
    text: "This consultation belongs to another Workspace.", createdAt: "2026-11-02T00:00:00.000Z", runId: null });
  otherWorkspace.values.set(fullKey(otherWorkspace.key("snapshot.v1")), foreignSnapshot as unknown as JsonValue);
  await assert.rejects(proposeLeadDesign(params("other-workspace", null, [OTHER_WORKSPACE_SOURCE_ID]), f.context, f.platform));
  await assert.rejects(proposeLeadDesign(params("missing-source", null, ["consultation-cccccccc-cccc-4ccc-8ccc-cccccccccccc"]), f.context, f.platform));
  await assert.rejects(proposeLeadDesign(params("assistant-source", null, [ASSISTANT_ID]), f.context, f.platform));
  assert.equal(f.successfulWrites, writes);
  assert.equal(f.casCalls.length, 2);
});

test("malformed proposals, unknown approval fields, and invalid sources stop before CAS", async () => {
  const f = fixture();
  const malformed = [
    { ...params("malformed"), draft: { ...draft("malformed"), unexpected: true } },
    { ...params("approval"), draft: { ...draft("approval"), approvalEvidenceRef: "claimed" } },
    params("invalid-source", null, ["consultation-not-a-uuid"]),
  ];
  for (const input of malformed) await assert.rejects(proposeLeadDesign(input, f.context, f.platform));
  assert.equal(f.casCalls.length, 0);
  assert.equal(f.successfulWrites, 0);
});

test("old branch remains stored after Lead reselection but is not current; old run is rejected", async () => {
  const f = fixture();
  await proposeLeadDesign(params("old-branch"), f.context, f.platform);
  f.selectNextLead();
  assert.equal(await readCurrentDesignDraft(WORKSPACE, PROJECT, f.platform), null);
  const writes = f.successfulWrites;
  await assert.rejects(proposeLeadDesign(params("rejected-old-run"), f.context, f.platform), /current Builder Lead|selection changed/i);
  assert.equal(f.successfulWrites, writes);
  assert.ok([...f.values.keys()].some(id => id.includes("design-draft-lead-1-head.v1.")));
  assert.equal(await readCurrentDesignDraft(WORKSPACE, PROJECT, f.platform), null);
});

test("authority change during head CAS rejects without retry and keeps old branch invisible", async () => {
  const f = fixture();
  let changed = false;
  f.setBeforeCas(async key => {
    if (changed || !key.stateKey.includes("design-draft-lead-1-head.v1.")) return;
    changed = true;
    f.selectNextLead();
  });
  await assert.rejects(proposeLeadDesign(params("raced"), f.context, f.platform), /selection changed|authority|Lead/i);
  assert.equal(changed, true);
  assert.equal(f.casCalls.filter(call => call.key.stateKey.includes("design-draft-lead-") && call.key.stateKey.includes("head.v1.")).length, 1);
  assert.ok([...f.values.keys()].some(id => id.includes("design-draft-lead-1-head.v1.")));
  assert.equal(await readCurrentDesignDraft(WORKSPACE, PROJECT, f.platform), null);
});

test("CAS unavailable, throwing, malformed receipt, and lost head response never trigger retry or set fallback", async () => {
  const unavailable = fixture();
  const noCas = { ...unavailable.platform, state: { ...unavailable.state, compareAndSet: undefined } } as unknown as SpsPlatformInvocationContext;
  await assert.rejects(proposeLeadDesign(params("no-cas"), unavailable.context, noCas), /compareAndSet/);
  assert.equal(unavailable.successfulWrites, 0);
  assert.equal(unavailable.setCalls, 0);

  const failing = fixture();
  const throws = { ...failing.platform, state: { ...failing.state, compareAndSet: async () => { throw new Error("CAS unavailable"); } } } as unknown as SpsPlatformInvocationContext;
  await assert.rejects(proposeLeadDesign(params("throws"), failing.context, throws), /CAS unavailable/);
  assert.equal(failing.successfulWrites, 0);
  assert.equal(failing.setCalls, 0);

  const malformed = fixture();
  const badReceipt = { ...malformed.platform, state: { ...malformed.state,
    compareAndSet: async () => ({ swapped: "yes" }) } } as unknown as SpsPlatformInvocationContext;
  await assert.rejects(proposeLeadDesign(params("bad-receipt"), malformed.context, badReceipt), /conditional state receipt|Invalid conditional/);
  assert.equal(malformed.successfulWrites, 0);
  assert.equal(malformed.setCalls, 0);

  const lost = fixture();
  const originalCas = lost.state.compareAndSet.bind(lost.state);
  let lostHead = false;
  const loseResponse = { ...lost.platform, state: { ...lost.state, compareAndSet: async (key: SpsStateKey, expected: Expected, value: JsonValue) => {
    const receipt = await originalCas(key, expected, value);
    if (!lostHead && key.stateKey.includes("design-draft-lead-1-head.v1.") && receipt.swapped) {
      lostHead = true;
      throw new Error("Head CAS response was lost");
    }
    return receipt;
  } } } as unknown as SpsPlatformInvocationContext;
  await assert.rejects(proposeLeadDesign(params("committed-despite-lost-response"), lost.context, loseResponse), /response was lost/);
  assert.equal(lostHead, true);
  assert.equal(lost.casCalls.length, 2);
  assert.equal(lost.successfulWrites, 2);
  assert.equal(lost.setCalls, 0);
  const visible = await readCurrentDesignDraft(WORKSPACE, PROJECT, lost.platform);
  assert.equal(visible?.revision.draft.revisionId, "committed-despite-lost-response");
});
