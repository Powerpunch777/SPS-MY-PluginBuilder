import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createEmptyBuilderSnapshot } from "../src/domain/snapshot.ts";
import { publishDesignBaseline, readDesignBaseline, readLeadDesignBaseline } from "../src/design-baseline-tools.ts";
import { proposeLeadDesign, readLeadSolution } from "../src/platform.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const LEAD = "44444444-4444-4444-8444-444444444444";
const WORKER = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";
const OTHER_RUN = "77777777-7777-4777-8777-777777777777";
const SESSIONS = {
  main: "88888888-8888-4888-8888-888888888888",
  "cto-inbox": "99999999-9999-4999-8999-999999999999",
  decisions: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const CONSULTATION_ID = "consultation-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ASSISTANT_ID = "consultation-cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TURN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NAMESPACE = "sonpark.my-builder";
type Expected = { exists: false } | { exists: true; value: JsonValue };
type CasCall = { key: SpsStateKey; expected: Expected; value: JsonValue };
type BeforeCas = (key: SpsStateKey, expected: Expected, value: JsonValue) => void | Promise<void>;

const fullKey = (key: SpsStateKey) => JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function draft(revisionId: string) {
  return {
    projectId: PROJECT,
    revisionId,
    sourceIds: [CONSULTATION_ID],
    specification: {
      revisionId: `spec-${revisionId}`,
      productTier: "M",
      requirements: [{ id: "REQ-1", description: "Keep the requested workflow intact.", acceptanceCriteriaIds: ["AC-1"] }],
      targets: ["sps-plugin"],
      dataPolicyRef: "policy-unreviewed",
    },
    graph: {
      graphRevisionId: `graph-${revisionId}`,
      entities: [{ id: "feature-1", kind: "feature", specRef: "REQ-1", contractRefs: ["API-1"] }],
      relations: [],
      viewLayoutRef: "layout-unreviewed",
    },
    questions: [],
  };
}

function fixture(options: { agentId?: string; sessionId?: string } = {}) {
  const values = new Map<string, JsonValue>();
  const casCalls: CasCall[] = [];
  let successfulWrites = 0;
  let setCalls = 0;
  let beforeCas: BeforeCas = () => {};
  const key = (stateKey: string): SpsStateKey => ({
    scopeKind: "company", scopeId: WORKSPACE, namespace: NAMESPACE, stateKey,
  });
  const state = {
    async get(input: SpsStateKey): Promise<JsonValue | null> {
      const stored = values.get(fullKey(input));
      return stored === undefined ? null : structuredClone(stored);
    },
    async set(input: SpsStateKey, value: JsonValue): Promise<void> {
      setCalls += 1;
      successfulWrites += 1;
      values.set(fullKey(input), structuredClone(value));
    },
    async compareAndSet(input: SpsStateKey, expected: Expected, value: JsonValue): Promise<{ swapped: boolean }> {
      const call = { key: structuredClone(input), expected: structuredClone(expected), value: structuredClone(value) };
      casCalls.push(call);
      await beforeCas(call.key, call.expected, call.value);
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
  const scopedKey = (stateKey: string) => fullKey(key(stateKey));
  values.set(scopedKey("lead-agent.v1"), { workspaceId: WORKSPACE, revision: 1, selectedAgentId: LEAD });
  values.set(scopedKey("lead-sessions.v1.1"), {
    workspaceId: WORKSPACE, selectionRevision: 1, agentId: LEAD, sessions: { ...SESSIONS },
  });
  const snapshot = createEmptyBuilderSnapshot(WORKSPACE);
  snapshot.messages.push({ id: CONSULTATION_ID, channel: "main", actorId: null, role: "user",
    text: "Please make the onboarding flow calm and clear.", createdAt: "2026-11-02T00:00:00.000Z", runId: null });
  snapshot.messages.push({ id: ASSISTANT_ID, channel: "main", actorId: null, role: "assistant",
    text: "Assistant output is not user decision evidence.", createdAt: "2026-11-02T00:00:01.000Z", runId: null });
  values.set(scopedKey("snapshot.v1"), snapshot as unknown as JsonValue);
  const platform = {
    state,
    agents: new Proxy({}, { get() { throw new Error("Design baseline tools must not call the Agent API"); } }),
  } as unknown as SpsPlatformInvocationContext;
  const context = {
    companyId: WORKSPACE,
    agentId: options.agentId ?? LEAD,
    runId: RUN,
    sessionId: options.sessionId ?? SESSIONS.main,
  };
  return {
    values, key, scopedKey, state, platform, context, casCalls,
    get successfulWrites() { return successfulWrites; },
    get setCalls() { return setCalls; },
    setBeforeCas(callback: BeforeCas) { beforeCas = callback; },
    selectWorker() {
      values.set(scopedKey("lead-agent.v1"), { workspaceId: WORKSPACE, revision: 2, selectedAgentId: WORKER });
      values.set(scopedKey("lead-sessions.v1.2"), {
        workspaceId: WORKSPACE, selectionRevision: 2, agentId: WORKER,
        sessions: { main: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "cto-inbox": null, decisions: null },
      });
    },
  };
}

function persistMainUserTurn(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const turn = {
    workspaceId: WORKSPACE,
    selectionRevision: 1,
    agentId: LEAD,
    sessionId: SESSIONS.main,
    channel: "main",
    schemaVersion: 1,
    requestId: TURN_ID,
    previousRequestId: null,
    sequence: 0,
    text: "Use a quiet layout, and keep the onboarding steps obvious.",
    createdAt: "2026-11-02T00:00:02.000Z",
    state: "submitted",
    runId: RUN,
    answer: null,
    outputState: "not_ready",
    cancellationRequested: false,
    termination: "not_applicable",
    ...overrides,
  };
  f.values.set(f.scopedKey(`lead-chat.turn.v1.${TURN_ID}`), turn as unknown as JsonValue);
  return turn;
}

async function prepared() {
  const f = fixture();
  const consultationText = "Please make the onboarding flow calm and clear.";
  const sourceDraft = draft("draft-r01");
  const result = await proposeLeadDesign({ projectId: PROJECT, expectedBaseRevisionId: null, draft: sourceDraft }, f.context, f.platform);
  assert.equal((result.data as { status: string }).status, "published");
  const turn = persistMainUserTurn(f);
  return { ...f, f, sourceDraft, turn, consultationText };
}

function publishParams(sourceDraftRevisionId = "draft-r01", expectedBaseRevisionId: string | null = null) {
  return {
    projectId: PROJECT,
    expectedBaseRevisionId,
    sourceDraftRevisionId,
    revisionId: "baseline-r01",
    userSourceId: `lead-turn:${TURN_ID}`,
    interpretation: "The user chose a quiet layout with obvious onboarding steps.",
  };
}

test("publishes one detached baseline from the current Lead draft and actual submitted user turn; reads survive restart", async () => {
  const { f, sourceDraft, turn, consultationText } = await prepared();
  const draftStorePrefix = [...f.values.keys()].find(value => value.includes("design-draft-lead-1-revision.v1."));
  assert.ok(draftStorePrefix);
  const rawDraftEntry = f.values.get(draftStorePrefix);
  assert.ok(rawDraftEntry);
  const persistedDraft = structuredClone((rawDraftEntry as { revision: { draft: unknown } }).revision.draft);
  const writesBefore = f.successfulWrites;

  const result = await publishDesignBaseline(publishParams(), f.context, f.platform);
  assert.equal((result.data as { status: string }).status, "published");
  assert.match(result.content, /not independently verified legal approval/);
  assert.equal(f.successfulWrites - writesBefore, 2, "one immutable revision and one head CAS are written");
  assert.equal(f.casCalls.length, 4, "draft and baseline each use a revision CAS plus a head CAS");
  assert.equal(f.setCalls, 0);

  const stored = await readDesignBaseline(WORKSPACE, PROJECT, f.platform);
  assert.ok(stored);
  assert.equal(stored.sequence, 1);
  assert.equal(stored.revision.revisionId, "baseline-r01");
  assert.equal(stored.revision.sourceDraftRevisionId, "draft-r01");
  assert.equal(stored.revision.draftDigest, sha256(JSON.stringify((rawDraftEntry as { revision: unknown }).revision)));
  assert.deepEqual(stored.revision.author, { agentId: LEAD, sessionId: SESSIONS.main, runId: RUN, selectionRevision: 1 });
  assert.deepEqual(stored.revision.userDecision, {
    sourceId: `lead-turn:${TURN_ID}`,
    sourceSha256: sha256(turn.text),
    interpretation: "The user chose a quiet layout with obvious onboarding steps.",
  });
  assert.equal(stored.revision.userDecision.sourceSha256, sha256("Use a quiet layout, and keep the onboarding steps obvious."));
  assert.notEqual(stored.revision.userDecision.sourceSha256, sha256(consultationText));
  assert.deepEqual(stored.revision.specification, {
    ...sourceDraft.specification,
    projectId: PROJECT,
    revisionId: `baseline-spec-${sha256(`${PROJECT}\0baseline-r01`)}`,
    approvalEvidenceRef: `lead-turn:${TURN_ID}`,
  });
  assert.deepEqual(stored.revision.graph, {
    ...sourceDraft.graph,
    graphRevisionId: `baseline-graph-${sha256(`${PROJECT}\0baseline-r01`)}`,
    approvedSpecRevisionId: `baseline-spec-${sha256(`${PROJECT}\0baseline-r01`)}`,
  });
  assert.notStrictEqual(stored.revision.specification, sourceDraft.specification);
  assert.notStrictEqual(stored.revision.specification.requirements, sourceDraft.specification.requirements);
  assert.notStrictEqual(stored.revision.graph, sourceDraft.graph);
  assert.notStrictEqual(stored.revision.graph.entities, sourceDraft.graph.entities);
  assert.deepEqual((rawDraftEntry as { revision: { draft: unknown } }).revision.draft, persistedDraft,
    "publishing a baseline leaves the source draft unchanged");
  assert.notStrictEqual(stored.revision.specification, (rawDraftEntry as { revision: { draft: { specification: unknown } } }).revision.draft.specification);

  const restartedPlatform = { ...f.platform } as SpsPlatformInvocationContext;
  assert.deepEqual(await readDesignBaseline(WORKSPACE, PROJECT, restartedPlatform), stored);
  const leadRead = await readLeadDesignBaseline({ projectId: PROJECT }, f.context, restartedPlatform);
  assert.deepEqual((leadRead.data as { current: unknown }).current, stored);
  assert.equal(f.setCalls, 0);
});

test("baseline revision history uses compare-and-set and stale expected revisions conflict without writes", async () => {
  const { f } = await prepared();
  assert.equal(((await publishDesignBaseline(publishParams(), f.context, f.platform)).data as { status: string }).status, "published");
  const second = { ...publishParams("draft-r01", "baseline-r01"), revisionId: "baseline-r02" };
  assert.equal(((await publishDesignBaseline(second, f.context, f.platform)).data as { status: string }).status, "published");
  const beforeStale = f.successfulWrites;
  const stale = { ...second, revisionId: "baseline-r03", expectedBaseRevisionId: "baseline-r01" };
  assert.equal(((await publishDesignBaseline(stale, f.context, f.platform)).data as { status: string }).status, "conflict");
  assert.equal(f.successfulWrites, beforeStale);
  const current = await readDesignBaseline(WORKSPACE, PROJECT, f.platform);
  assert.equal(current?.sequence, 2);
  assert.equal(current?.revision.revisionId, "baseline-r02");
  assert.equal(f.setCalls, 0);
});

test("publication rejects a Worker, mismatched decisions session, CTO intake and wrong source run/session", async () => {
  const variations = ["worker", "decisions", "cto", "source-run", "source-session"] as const;
  for (const variation of variations) {
    const { f, turn } = await prepared();
    let context = { ...f.context };
    if (variation === "worker") context = { ...context, agentId: WORKER };
    if (variation === "decisions") context = { ...context, sessionId: SESSIONS.decisions };
    if (variation === "cto") context = { ...context, sessionId: SESSIONS["cto-inbox"] };
    if (variation === "source-run") f.values.set(f.scopedKey(`lead-chat.turn.v1.${TURN_ID}`),
      { ...turn, runId: OTHER_RUN } as unknown as JsonValue);
    if (variation === "source-session") f.values.set(f.scopedKey(`lead-chat.turn.v1.${TURN_ID}`),
      { ...turn, sessionId: SESSIONS.decisions } as unknown as JsonValue);
    const writes = f.successfulWrites;
    await assert.rejects(publishDesignBaseline(publishParams(), context, f.platform));
    assert.equal(f.successfulWrites, writes, variation);
  }
});

test("consultation and assistant snapshot messages are not accepted as Lead user-decision sources", async () => {
  for (const [label, sourceId] of [["consultation", CONSULTATION_ID], ["assistant", ASSISTANT_ID]] as const) {
    const { f } = await prepared();
    const writes = f.successfulWrites;
    await assert.rejects(publishDesignBaseline({ ...publishParams(), userSourceId: sourceId }, f.context, f.platform));
    assert.equal(f.successfulWrites, writes, label);
  }
});

test("wrong source draft and caller mutation cannot redirect publication after input validation", async () => {
  const wrongDraft = await prepared();
  const beforeWrong = wrongDraft.f.successfulWrites;
  const wrong = await publishDesignBaseline(publishParams("not-current"), wrongDraft.f.context, wrongDraft.f.platform);
  assert.equal((wrong.data as { status: string }).status, "conflict");
  assert.equal(wrongDraft.f.successfulWrites, beforeWrong);

  const { f } = await prepared();
  const params = publishParams();
  let mutated = false;
  const originalGet = f.state.get.bind(f.state);
  f.state.get = async (key: SpsStateKey) => {
    if (!mutated) {
      mutated = true;
      params.projectId = "mutated-project";
      params.revisionId = "mutated-revision";
      params.userSourceId = `lead-turn:${OTHER_RUN}`;
    }
    return originalGet(key);
  };
  const result = await publishDesignBaseline(params, f.context, f.platform);
  assert.equal((result.data as { status: string }).status, "published");
  const stored = await readDesignBaseline(WORKSPACE, PROJECT, f.platform);
  assert.equal(stored?.revision.revisionId, "baseline-r01");
  assert.equal(stored?.revision.projectId, PROJECT);
  assert.equal(stored?.revision.userDecision.sourceId, `lead-turn:${TURN_ID}`);
});

test("a lost successful head-CAS response is recovered by reading, without automatic retry", async () => {
  const { f } = await prepared();
  const originalCas = f.state.compareAndSet.bind(f.state);
  let responseLost = false;
  f.state.compareAndSet = async (key: SpsStateKey, expected: Expected, value: JsonValue) => {
    const receipt = await originalCas(key, expected, value);
    if (!responseLost && receipt.swapped && key.stateKey.startsWith("design-baseline-head.v1.")) {
      responseLost = true;
      throw new Error("baseline head CAS response was lost");
    }
    return receipt;
  };
  await assert.rejects(publishDesignBaseline(publishParams(), f.context, f.platform), /response was lost/);
  assert.equal(responseLost, true);
  const visible = await readDesignBaseline(WORKSPACE, PROJECT, f.platform);
  assert.equal(visible?.revision.revisionId, "baseline-r01");
  const writes = f.successfulWrites;
  const retry = await publishDesignBaseline(publishParams(), f.context, f.platform);
  assert.equal((retry.data as { status: string }).status, "conflict");
  assert.equal(f.successfulWrites, writes);
  assert.equal(f.setCalls, 0);
});

test("unknown and approval-shaped fields are denied before any baseline write", async () => {
  const { f } = await prepared();
  const writes = f.successfulWrites;
  for (const extra of [{ approved: true }, { approvalEvidenceRef: `lead-turn:${TURN_ID}` }, { signed: true },
    { specificationRevisionId: "borrowed-revision" }, { graphRevisionId: "borrowed-graph" }]) {
    await assert.rejects(publishDesignBaseline({ ...publishParams(), ...extra }, f.context, f.platform));
  }
  assert.equal(f.successfulWrites, writes);
  assert.equal(f.setCalls, 0);
});

test("v2 UI Design remains unable to publish while a Main source turn can publish the baseline", async () => {
  const { f } = await prepared();
  const v2Ids = [
    "12121212-1212-4121-8121-121212121212",
    "13131313-1313-4131-8131-131313131313",
    "14141414-1414-4141-8141-141414141414",
    "15151515-1515-4151-8151-151515151515",
    "16161616-1616-4161-8161-161616161616",
  ];
  f.values.set(f.scopedKey("lead-contexts.v2.1"), {
    schemaVersion: 2, workspaceId: WORKSPACE, selectionRevision: 1, agentId: LEAD,
    requestId: "17171717-1717-4171-8171-171717171717", status: "ready", pendingContext: null,
    contexts: { user_conversation: v2Ids[4], ui_design: v2Ids[0], background_planning: v2Ids[1],
      question_intake: v2Ids[2], question_discussion: v2Ids[3] },
  });
  const writes = f.successfulWrites;
  await assert.rejects(publishDesignBaseline(publishParams(), { ...f.context, sessionId: v2Ids[0] }, f.platform), /Only the Main/);
  assert.equal(f.successfulWrites, writes);
  assert.equal(f.setCalls, 0);
  f.values.set(f.scopedKey(`lead-chat.turn.v1.${TURN_ID}`), {
    workspaceId: WORKSPACE, selectionRevision: 1, agentId: LEAD, sessionId: v2Ids[4], channel: "user_conversation",
    schemaVersion: 1, requestId: TURN_ID, previousRequestId: null, sequence: 0,
    text: "The user explicitly approved the current baseline decision.", createdAt: "2026-11-03T00:00:00.000Z",
    state: "submitted", runId: RUN, answer: null, outputState: "not_ready", cancellationRequested: false,
    termination: "not_applicable",
  });
  const result = await publishDesignBaseline(publishParams(), { ...f.context, sessionId: v2Ids[4] }, f.platform);
  assert.equal((result.data as { status: string }).status, "published");
  assert.equal(f.successfulWrites, writes + 2);
});

test("canonical solution reads the paired graph and baseline history survives Lead selection changes", async () => {
  const { f } = await prepared();
  await publishDesignBaseline(publishParams(), f.context, f.platform);
  const stored = await readDesignBaseline(WORKSPACE, PROJECT, f.platform);
  const solution = await readLeadSolution({ projectId: PROJECT }, f.context, f.platform);
  assert.deepEqual((solution.data as { solution: unknown }).solution, { sequence: 1, revision: stored!.revision.graph });
  f.selectWorker();
  await assert.rejects(publishDesignBaseline(publishParams(), f.context, f.platform), /current Builder Lead/);
  assert.deepEqual(await readDesignBaseline(WORKSPACE, PROJECT, f.platform), stored);
});

test("independent baseline writers publish one head; exact new baseline IDs derive different paired revision IDs", async () => {
  const { f } = await prepared();
  const results = await Promise.all(["concurrent-a", "concurrent-b"].map(revisionId =>
    publishDesignBaseline({ ...publishParams(), revisionId }, f.context, f.platform)));
  assert.equal(results.filter(result => (result.data as { status: string }).status === "published").length, 1);
  assert.equal(results.filter(result => (result.data as { status: string }).status === "conflict").length, 1);
  const first = (await readDesignBaseline(WORKSPACE, PROJECT, f.platform))!;
  await publishDesignBaseline({ ...publishParams(), expectedBaseRevisionId: first.revision.revisionId, revisionId: "next-baseline" }, f.context, f.platform);
  const next = (await readDesignBaseline(WORKSPACE, PROJECT, f.platform))!;
  assert.notEqual(first.revision.specification.revisionId, next.revision.specification.revisionId);
  assert.notEqual(first.revision.graph.graphRevisionId, next.revision.graph.graphRevisionId);
  assert.equal(next.sequence, 2);
  assert.equal(f.setCalls, 0);
});

test("an observed retired Lead before a baseline CAS rejects without automatic retry", async () => {
  const { f } = await prepared();
  const original = f.state.get;
  let changed = false;
  f.state.get = async key => {
    const result = await original(key);
    if (!changed && key.stateKey.startsWith("design-baseline-head")) { changed = true; f.selectWorker(); }
    return result;
  };
  const writes = f.successfulWrites;
  await assert.rejects(publishDesignBaseline(publishParams(), f.context, f.platform), /selection changed|current Builder Lead/);
  assert.equal(f.successfulWrites, writes);
});

test("selection change inside head CAS leaves readable uncertain history rather than successful authorization", async () => {
  const { f } = await prepared();
  f.setBeforeCas(key => {
    if (key.stateKey.startsWith("design-baseline-head")) f.selectWorker();
  });
  await assert.rejects(publishDesignBaseline(publishParams(), f.context, f.platform), /selection changed|current Builder Lead/);
  const stored = await readDesignBaseline(WORKSPACE, PROJECT, f.platform);
  assert.equal(stored?.revision.revisionId, "baseline-r01");
  assert.equal(stored?.revision.author.selectionRevision, 1);
  const writes = f.successfulWrites;
  await assert.rejects(publishDesignBaseline(publishParams(), f.context, f.platform), /current Builder Lead/);
  assert.equal(f.successfulWrites, writes);
  assert.equal(f.setCalls, 0);
});
