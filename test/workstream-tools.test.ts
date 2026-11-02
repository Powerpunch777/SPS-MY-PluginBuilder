import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createWorkstreamStore, publishWorkstream, readCtoWorkstream, readLeadWorkstreams, acknowledgeWorkstream } from "../src/workstream-tools.ts";
import { createDesignBaselineStore } from "../src/design-baseline-tools.ts";
import { createTechnologyDecisionStore } from "../src/technology-decision-tools.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const PROJECT = "project-alpha";
const OTHER_PROJECT = "project-beta";
const LEAD = "33333333-3333-4333-8333-333333333333";
const WORKER = "44444444-4444-4444-8444-444444444444";
const RUN = "88888888-8888-4888-8888-888888888888";
const RUN2 = "99999999-9999-4999-8999-999999999999";
const SESSIONS = {
  main: "55555555-5555-4555-8555-555555555555",
  "cto-inbox": "66666666-6666-4666-8666-666666666666",
  decisions: "77777777-7777-4777-8777-777777777777",
  cto1: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  cto2: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  otherMain: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
const NAMESPACE = "sonpark.my-builder";
type Expected = { exists: false } | { exists: true; value: JsonValue };
type CasHook = (key: SpsStateKey, expected: Expected, value: JsonValue) => void | Promise<void>;
const fullKey = (key: SpsStateKey) => JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const hashText = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function fixture(options: { cas?: boolean } = {}) {
  const values = new Map<string, JsonValue>();
  const casCalls: Array<{ key: SpsStateKey; expected: Expected; value: JsonValue }> = [];
  let writes = 0;
  let sets = 0;
  let beforeCas: CasHook = () => {};
  const key = (stateKey: string, workspaceId = WORKSPACE): SpsStateKey => ({
    scopeKind: "company", scopeId: workspaceId, namespace: NAMESPACE, stateKey,
  });
  const state = {
    async get(input: SpsStateKey): Promise<JsonValue | null> {
      const value = values.get(fullKey(input));
      return value === undefined ? null : structuredClone(value);
    },
    async set(input: SpsStateKey, value: JsonValue): Promise<void> {
      sets += 1;
      writes += 1;
      values.set(fullKey(input), structuredClone(value));
    },
    async compareAndSet(input: SpsStateKey, expected: Expected, value: JsonValue): Promise<{ swapped: boolean }> {
      casCalls.push({ key: structuredClone(input), expected: structuredClone(expected), value: structuredClone(value) });
      await beforeCas(input, expected, value);
      const id = fullKey(input), exists = values.has(id), current = values.get(id);
      const swapped = expected.exists ? exists && JSON.stringify(current) === JSON.stringify(expected.value) : !exists;
      if (swapped) { writes += 1; values.set(id, structuredClone(value)); }
      return { swapped };
    },
  };
  const seedLead = (workspaceId = WORKSPACE, agentId = LEAD, revision = 1) => {
    values.set(fullKey(key("lead-agent.v1", workspaceId)), { workspaceId, revision, selectedAgentId: agentId });
    values.set(fullKey(key(`lead-sessions.v1.${revision}`, workspaceId)), {
      workspaceId, selectionRevision: revision, agentId,
      sessions: { main: SESSIONS.main, "cto-inbox": SESSIONS["cto-inbox"], decisions: SESSIONS.decisions },
    });
  };
  seedLead();
  const platform = {
    state: options.cas === false ? { ...state, compareAndSet: undefined } : state,
    agents: new Proxy({}, { get() { throw new Error("Workstream tools must not call the Agent API"); } }),
  } as unknown as SpsPlatformInvocationContext;
  const context = (workspaceId = WORKSPACE, agentId = LEAD, sessionId = SESSIONS.main, runId = RUN) => ({
    companyId: workspaceId, agentId, sessionId, runId,
  });
  const scopedKey = (stateKey: string, workspaceId = WORKSPACE) => fullKey(key(stateKey, workspaceId));
  const seedCtos = () => {
    values.set(scopedKey(`project-ctos.v1.${hashText(PROJECT)}`), {
      schemaVersion: 1, workspaceId: WORKSPACE, projectId: PROJECT, revision: 1,
      ctos: [
        { ctoId: "cto-one", displayName: "CTO One", agentId: LEAD, sessionId: SESSIONS.cto1, status: "ACTIVE",
          createdAt: "2026-11-02T01:02:03.004Z", createdBy: { agentId: LEAD, sessionId: SESSIONS.main, runId: RUN, selectionRevision: 1 } },
        { ctoId: "cto-two", displayName: "CTO Two", agentId: WORKER, sessionId: SESSIONS.cto2, status: "ACTIVE",
          createdAt: "2026-11-02T01:02:03.004Z", createdBy: { agentId: LEAD, sessionId: SESSIONS.main, runId: RUN, selectionRevision: 1 } },
      ],
    });
  };
  const selectWorker = () => {
    values.set(scopedKey("lead-agent.v1"), { workspaceId: WORKSPACE, revision: 2, selectedAgentId: WORKER });
    values.set(scopedKey("lead-sessions.v1.2"), { workspaceId: WORKSPACE, revision: 2, agentId: WORKER,
      sessions: { main: SESSIONS.otherMain, "cto-inbox": null, decisions: null } });
  };
  return {
    values, state, platform, context, key, scopedKey, seedLead, seedCtos, selectWorker, casCalls,
    get writes() { return writes; }, get sets() { return sets; }, setBeforeCas(hook: CasHook) { beforeCas = hook; },
  };
}

function baseline(revisionId = "baseline-r01") {
  return {
    projectId: PROJECT, revisionId, sourceDraftRevisionId: `draft-${revisionId}`, draftDigest: "a".repeat(64),
    createdAt: "2026-11-02T01:02:03.004Z",
    author: { agentId: LEAD, sessionId: SESSIONS.main, runId: RUN, selectionRevision: 1 },
    userDecision: { sourceId: "lead-turn:dddddddd-dddd-4ddd-8ddd-dddddddddddd", sourceSha256: "b".repeat(64), interpretation: "A user decision." },
    specification: { projectId: PROJECT, revisionId: `spec-${revisionId}`, productTier: "M",
      requirements: [{ id: "REQ-1", description: "Keep the agreed workflow.", acceptanceCriteriaIds: ["AC-1"] }],
      targets: ["sps-plugin"], dataPolicyRef: "policy-r01", approvalEvidenceRef: "lead-turn:dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
    graph: { approvedSpecRevisionId: `spec-${revisionId}`, graphRevisionId: `graph-${revisionId}`,
      entities: [{ id: "feature-1", kind: "feature", specRef: "REQ-1", contractRefs: ["API-1"] }],
      relations: [], viewLayoutRef: "layout-r01" },
  };
}

function technology(revisionId = "technology-r01", baselineRevisionId = "baseline-r01", specRevisionId = `spec-${baselineRevisionId}`, graphRevisionId = `graph-${baselineRevisionId}`) {
  return {
    register: {
      projectId: PROJECT, revisionId, sourceBaselineRevisionId: baselineRevisionId,
      sourceSpecRevisionId: specRevisionId, sourceGraphRevisionId: graphRevisionId,
      entries: [{ id: "tech-allowed", technology: "Example allowed", disposition: "allowed",
        selectionReason: "Fits the stated interface.", nonSelectionReason: "", scopeNodeIds: ["feature-1"],
        interoperability: ["HTTP"], constraints: ["Keep credentials out of configuration."], cost: "Estimate: low.",
        versionCompatibility: "Range: v1.", changeApprovalOwner: "Lead",
        licenseReview: { status: "unreviewed", licenseExpression: null, evidenceRefs: [] },
        verification: { level: "not-verified", evidenceRefs: [], limitations: "Not independently checked.", nextReviewCondition: "Before adoption." } }],
    },
    author: { agentId: LEAD, sessionId: SESSIONS.main, runId: RUN, selectionRevision: 1 },
    createdAt: "2026-11-02T01:02:03.004Z", baselineDigest: "0".repeat(64),
  };
}

async function prepared(options: { cas?: boolean } = {}) {
  const f = fixture(options);
  f.seedCtos();
  const baselineStore = createDesignBaselineStore(WORKSPACE, PROJECT, f.state);
  const b = baseline();
  assert.equal((await baselineStore.publish({ expectedBaseRevisionId: null, revision: b })).status, "published");
  const baselinePublished = await baselineStore.current();
  assert.ok(baselinePublished);
  const tech = technology();
  tech.baselineDigest = hash(baselinePublished.revision);
  assert.equal((await createTechnologyDecisionStore(WORKSPACE, PROJECT, f.state).publish({
    expectedBaseRevisionId: null, revision: tech,
  })).status, "published");
  f.casCalls.length = 0;
  return f;
}

function spec(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT, id: "ws-one", revision: 1, sourceSpecRevisionId: "spec-baseline-r01",
    assignedCtoId: "cto-one", title: "Build one bounded part", goal: "Implement the agreed capability.",
    scopeNodeIds: ["feature-1"], included: ["The agreed feature"], excluded: ["Unrelated features"],
    dependencies: [], interfaceContracts: ["API-1"], technologyDecisionsRef: "technology-r01",
    reuseCandidates: [], acceptance: ["Acceptance check passes"], evidenceRequired: ["Focused test result"], openQuestions: [],
    ...overrides,
  };
}
function change(previousRevision: number | null = null) {
  return { previousRevision, reason: previousRevision === null ? "Initial assignment" : "Scope clarification",
    diff: previousRevision === null ? "Create the first instruction." : "Update the bounded goal.",
    impactNodeIds: ["feature-1"], impactInterfaceContracts: ["API-1"], impactTaskIds: [], effectiveFrom: "Immediately after acknowledgement." };
}
function publishParams(revisionId = "board-r01", expectedBaseRevisionId: string | null = null, overrides: Record<string, unknown> = {}) {
  return { projectId: PROJECT, expectedBaseRevisionId, revisionId, spec: spec(overrides), change: change() };
}
const leadCtx = (f: ReturnType<typeof fixture>) => f.context();
const ctoCtx = (f: ReturnType<typeof fixture>, cto = "cto-one") => f.context(WORKSPACE, cto === "cto-one" ? LEAD : WORKER,
  cto === "cto-one" ? SESSIONS.cto1 : SESSIONS.cto2);

test("Lead publishes an exact version with pinned source refs by CAS only, with no dispatch", async () => {
  const f = await prepared();
  const result = await publishWorkstream(publishParams(), leadCtx(f), f.platform);
  assert.equal((result.data as { status: string; executionStarted: boolean }).status, "published");
  assert.equal((result.data as { executionStarted: boolean }).executionStarted, false);
  assert.match(result.content, /no session message, provider run, Worker, code or completion was created/i);
  const board = await createWorkstreamStore(WORKSPACE, PROJECT, f.state).current();
  assert.equal(board?.revision.revisionId, "board-r01");
  const record = board?.revision.workstreams[0];
  assert.deepEqual(record?.spec, spec());
  assert.equal(record?.sourceBaselineRevisionId, "baseline-r01");
  assert.equal(record?.spec.technologyDecisionsRef, "technology-r01");
  assert.equal(record?.receipt, null);
  assert.equal(f.writes, 6, "baseline, technology and workstream each write immutable revision + head");
  assert.equal(f.sets, 0);
  assert.equal(f.casCalls.filter(call => call.key.stateKey.startsWith("workstreams-")).length, 2);
});

test("Lead view and assigned CTO read exact published context and report readiness, never execution", async () => {
  const f = await prepared();
  await publishWorkstream(publishParams(), leadCtx(f), f.platform);
  const leadRead = await readLeadWorkstreams({ projectId: PROJECT }, leadCtx(f), f.platform);
  assert.equal((leadRead.data as { current: { revision: { revisionId: string } } }).current.revision.revisionId, "board-r01");
  const ctoRead = await readCtoWorkstream({ projectId: PROJECT, ctoId: "cto-one", workstreamId: "ws-one" }, ctoCtx(f), f.platform);
  const data = ctoRead.data as { workstream: { spec: unknown }; sources: { baseline: { revisionId: string }; technology: { register: { revisionId: string } } } };
  assert.deepEqual(data.workstream.spec, spec());
  assert.equal(data.sources.baseline.revisionId, "baseline-r01");
  assert.equal(data.sources.technology.register.revisionId, "technology-r01");
  assert.match(ctoRead.content, /Historical revisions are not automatically current/);
  const ack = await acknowledgeWorkstream({ projectId: PROJECT, ctoId: "cto-one", workstreamId: "ws-one",
    expectedBaseRevisionId: "board-r01", revisionId: "board-r02", specRevision: 1,
    readiness: "ready", note: "I understand the scope and acceptance criteria." }, ctoCtx(f), f.platform);
  assert.equal((ack.data as { status: string; executionStarted: boolean }).status, "published");
  assert.equal((ack.data as { executionStarted: boolean }).executionStarted, false);
  assert.match(ack.content, /No provider execution.*verified completion/);
  const visible = await createWorkstreamStore(WORKSPACE, PROJECT, f.state).current();
  assert.deepEqual(visible?.revision.workstreams[0]?.receipt, {
    revision: 1, agentId: LEAD, sessionId: SESSIONS.cto1, runId: RUN, createdAt: visible?.revision.workstreams[0]?.receipt?.createdAt,
    readiness: "ready", note: "I understand the scope and acceptance criteria.",
  });
  assert.equal(f.sets, 0);
});

test("authority rejects Workers, Lead sessions, mismatched CTO sessions, other CTOs and cross-workspace contexts", async () => {
  const f = await prepared();
  await publishWorkstream(publishParams(), leadCtx(f), f.platform);
  const readParams = { projectId: PROJECT, ctoId: "cto-one", workstreamId: "ws-one" };
  await assert.rejects(publishWorkstream(publishParams(), f.context(WORKER, WORKER, SESSIONS.main), f.platform), /current Builder Lead/);
  await assert.rejects(readLeadWorkstreams({ projectId: PROJECT }, f.context(WORKSPACE, LEAD, SESSIONS.cto1), f.platform), /prepared current Lead session/);
  await assert.rejects(readCtoWorkstream(readParams, f.context(WORKSPACE, LEAD, SESSIONS.main), f.platform), /registered CTO and its independent session/);
  await assert.rejects(readCtoWorkstream({ ...readParams, ctoId: "cto-two" }, ctoCtx(f), f.platform), /registered CTO and its independent session/);
  await assert.rejects(readCtoWorkstream(readParams, f.context(OTHER_WORKSPACE, LEAD, SESSIONS.cto1), f.platform), /registered CTO and its independent session/);
  await assert.rejects(acknowledgeWorkstream({ projectId: PROJECT, ctoId: "cto-one", workstreamId: "ws-one",
    expectedBaseRevisionId: "board-r01", revisionId: "unauthorized-ack", specRevision: 1,
    readiness: "ready", note: "Must be denied." }, f.context(WORKSPACE, LEAD, SESSIONS.main), f.platform), /registered CTO and its independent session/);
  assert.equal(f.sets, 0);
});

test("stale board heads and wrong specification revisions conflict without overwriting", async () => {
  const f = await prepared();
  await publishWorkstream(publishParams(), leadCtx(f), f.platform);
  const writes = f.writes;
  const stale = await publishWorkstream(publishParams("board-stale", null), leadCtx(f), f.platform);
  assert.equal((stale.data as { status: string }).status, "conflict");
  const wrongSpec = await acknowledgeWorkstream({ projectId: PROJECT, ctoId: "cto-one", workstreamId: "ws-one",
    expectedBaseRevisionId: "board-r01", revisionId: "board-ack-wrong", specRevision: 2,
    readiness: "ready", note: "wrong version" }, ctoCtx(f), f.platform);
  assert.equal((wrongSpec.data as { status: string }).status, "conflict");
  assert.equal(f.writes, writes);
  assert.equal((await createWorkstreamStore(WORKSPACE, PROJECT, f.state).current())?.revision.revisionId, "board-r01");
});

test("new specification revision requires the exact previous version and resets its receipt", async () => {
  const f = await prepared();
  await publishWorkstream(publishParams(), leadCtx(f), f.platform);
  await acknowledgeWorkstream({ projectId: PROJECT, ctoId: "cto-one", workstreamId: "ws-one",
    expectedBaseRevisionId: "board-r01", revisionId: "board-ack", specRevision: 1,
    readiness: "ready", note: "Ready for the original scope." }, ctoCtx(f), f.platform);
  const current = (await createWorkstreamStore(WORKSPACE, PROJECT, f.state).current())!;
  const changedSpec = spec({ revision: 2, goal: "Implement the clarified bounded capability." });
  const result = await publishWorkstream({ projectId: PROJECT, expectedBaseRevisionId: current.revision.revisionId,
    revisionId: "board-r02", spec: changedSpec, change: change(1) }, leadCtx(f), f.platform);
  assert.equal((result.data as { status: string }).status, "published");
  const updated = (await createWorkstreamStore(WORKSPACE, PROJECT, f.state).current())!;
  assert.equal(updated.revision.workstreams[0]?.spec.revision, 2);
  assert.equal(updated.revision.workstreams[0]?.change.previousRevision, 1);
  assert.equal(updated.revision.workstreams[0]?.receipt, null);
  const writes = f.writes;
  await assert.rejects(publishWorkstream({ projectId: PROJECT, expectedBaseRevisionId: "board-r02", revisionId: "bad-next",
    spec: spec({ revision: 4 }), change: change(2) }, leadCtx(f), f.platform), /exact prior specification revision/);
  assert.equal(f.writes, writes);
});

test("baseline or technology head changes fail closed without substituting newer current values", async () => {
  const f = await prepared();
  const nextBaseline = baseline("baseline-r02");
  assert.equal((await createDesignBaselineStore(WORKSPACE, PROJECT, f.state).publish({
    expectedBaseRevisionId: "baseline-r01", revision: nextBaseline,
  })).status, "published");
  await assert.rejects(publishWorkstream(publishParams(), leadCtx(f), f.platform), /exact current design baseline/);
  assert.equal(f.writes, 6);
  assert.equal((await createWorkstreamStore(WORKSPACE, PROJECT, f.state).current()), null);

  const g = await prepared();
  const nextTech = technology("technology-r02");
  nextTech.baselineDigest = hash((await createDesignBaselineStore(WORKSPACE, PROJECT, g.state).current())!.revision);
  assert.equal((await createTechnologyDecisionStore(WORKSPACE, PROJECT, g.state).publish({
    expectedBaseRevisionId: "technology-r01", revision: nextTech,
  })).status, "published");
  await assert.rejects(publishWorkstream(publishParams(), leadCtx(g), g.platform), /exact current design baseline/);
  assert.equal((await createWorkstreamStore(WORKSPACE, PROJECT, g.state).current()), null);
});

test("invalid graph scope/interface and missing or retired CTO are denied without writes", async () => {
  const f = await prepared();
  const writes = f.writes;
  await assert.rejects(publishWorkstream(publishParams("bad-node", null, { scopeNodeIds: ["missing"] }), leadCtx(f), f.platform), /scope and interface references/);
  await assert.rejects(publishWorkstream(publishParams("bad-contract", null, { interfaceContracts: ["missing"] }), leadCtx(f), f.platform), /scope and interface references/);
  await assert.rejects(publishWorkstream(publishParams("missing-cto", null, { assignedCtoId: "absent" }), leadCtx(f), f.platform), /registered non-retired CTO/);
  const registryKey = f.scopedKey(`project-ctos.v1.${hashText(PROJECT)}`);
  const registry = structuredClone(f.values.get(registryKey)) as { ctos: Array<{ ctoId: string; status: string }> };
  registry.ctos[0]!.status = "RETIRED";
  f.values.set(registryKey, registry as JsonValue);
  await assert.rejects(publishWorkstream(publishParams("retired", null), leadCtx(f), f.platform), /registered non-retired CTO/);
  assert.equal(f.writes, writes);
});

test("one Graph node cannot be assigned to two CTOs and a rejected overlap leaves state unchanged", async () => {
  const f = await prepared();
  await publishWorkstream(publishParams(), leadCtx(f), f.platform);
  const writes = f.writes;
  const overlap = await publishWorkstream({ ...publishParams("board-overlap", "board-r01"),
    spec: spec({ id: "ws-two", assignedCtoId: "cto-two" }) }, leadCtx(f), f.platform);
  assert.equal((overlap.data as { status: string }).status, "scope-conflict");
  assert.match(overlap.content, /one responsible CTO/);
  assert.equal(f.writes, writes);
  assert.equal((await createWorkstreamStore(WORKSPACE, PROJECT, f.state).current())?.revision.revisionId, "board-r01");
});

test("one CTO can divide its own node into multiple workstreams without creating a second owner", async () => {
  const f = await prepared();
  await publishWorkstream(publishParams(), leadCtx(f), f.platform);
  const result = await publishWorkstream({ ...publishParams("board-r02", "board-r01"), spec: spec({ id: "ws-same-cto" }) }, leadCtx(f), f.platform);
  assert.equal((result.data as { status: string }).status, "published");
  const board = (await readWorkstreamsForTest(f))!;
  assert.equal(board.workstreams.length, 2);
  assert.deepEqual([...new Set(board.workstreams.map(item => item.spec.assignedCtoId))], ["cto-one"]);
});

async function readWorkstreamsForTest(f: Awaited<ReturnType<typeof prepared>>) {
  return (await createWorkstreamStore(WORKSPACE, PROJECT, f.state).current())?.revision;
}

test("two CTOs can share an interface contract while owning separate Graph nodes", async () => {
  const f = await prepared();
  const b2 = baseline("baseline-r02");
  b2.graph.entities.push({ id: "feature-2", kind: "feature", specRef: "REQ-1", contractRefs: ["API-1"] });
  await createDesignBaselineStore(WORKSPACE, PROJECT, f.state).publish({ expectedBaseRevisionId: "baseline-r01", revision: b2 });
  const tech2 = technology("technology-r02", "baseline-r02");
  tech2.baselineDigest = hash(b2);
  await createTechnologyDecisionStore(WORKSPACE, PROJECT, f.state).publish({ expectedBaseRevisionId: "technology-r01", revision: tech2 });
  const first = publishParams("board-r01", null, { sourceSpecRevisionId: "spec-baseline-r02", technologyDecisionsRef: "technology-r02" });
  await publishWorkstream(first, leadCtx(f), f.platform);
  const second = publishParams("board-r02", "board-r01", { id: "ws-two", assignedCtoId: "cto-two", scopeNodeIds: ["feature-2"],
    sourceSpecRevisionId: "spec-baseline-r02", technologyDecisionsRef: "technology-r02", dependencies: ["Use ws-one's API-1 contract without editing its owned node."] });
  const result = await publishWorkstream(second, leadCtx(f), f.platform);
  assert.equal((result.data as { status: string }).status, "published");
  assert.equal((await readWorkstreamsForTest(f))?.workstreams.length, 2);
});

test("concurrent cross-CTO claims on the same node still publish only one owner", async () => {
  const f = await prepared();
  const requests = [publishParams("board-a"), publishParams("board-b", null, { id: "ws-two", assignedCtoId: "cto-two" })];
  const results = await Promise.all(requests.map(params => publishWorkstream(params, leadCtx(f), f.platform)));
  assert.equal(results.filter(result => (result.data as { status: string }).status === "published").length, 1);
  assert.equal((await readWorkstreamsForTest(f))?.workstreams.length, 1);
});

test("missing CAS has no set fallback; lost head response remains readable without retry", async () => {
  const unsupported = await prepared({ cas: false });
  const before = unsupported.writes;
  await assert.rejects(publishWorkstream(publishParams(), leadCtx(unsupported), unsupported.platform), /compareAndSet is required/);
  assert.equal(unsupported.writes, before);
  assert.equal(unsupported.sets, 0);

  const f = await prepared();
  const original = f.state.compareAndSet.bind(f.state);
  let lost = false;
  f.state.compareAndSet = async (key, expected, value) => {
    const result = await original(key, expected, value);
    if (!lost && result.swapped && key.stateKey.startsWith("workstreams-head")) { lost = true; throw new Error("head response lost"); }
    return result;
  };
  await assert.rejects(publishWorkstream(publishParams(), leadCtx(f), f.platform), /head response lost/);
  assert.equal((await createWorkstreamStore(WORKSPACE, PROJECT, f.state).current())?.revision.revisionId, "board-r01");
  const writes = f.writes;
  const retry = await publishWorkstream(publishParams(), leadCtx(f), f.platform);
  assert.equal((retry.data as { status: string }).status, "conflict");
  assert.equal(f.writes, writes);
  assert.equal(f.sets, 0);
});

test("two independent writers publish one head and an unpublished staged entry stays invisible", async () => {
  const f = await prepared();
  const outcomes = await Promise.all(["board-a", "board-b"].map(revisionId =>
    publishWorkstream(publishParams(revisionId), leadCtx(f), f.platform)));
  assert.equal(outcomes.filter(item => (item.data as { status: string }).status === "published").length, 1);
  assert.equal(outcomes.filter(item => (item.data as { status: string }).status === "conflict").length, 1);
  const board = await createWorkstreamStore(WORKSPACE, PROJECT, f.state).current();
  assert.ok(board);
  assert.equal(board.revision.revisionId === "board-a" || board.revision.revisionId === "board-b", true);
  const original = f.state.compareAndSet.bind(f.state);
  f.state.compareAndSet = async (key, expected, value) => {
    if (key.stateKey.startsWith("workstreams-head")
      && (value as { revisionId?: string }).revisionId === "board-staged") return { swapped: false };
    return original(key, expected, value);
  };
  const staged = await publishWorkstream(publishParams("board-staged", board.revision.revisionId, { id: "ws-staged" }), leadCtx(f), f.platform);
  assert.equal((staged.data as { status: string }).status, "conflict");
  const leadRead = await readLeadWorkstreams({ projectId: PROJECT }, leadCtx(f), f.platform);
  assert.equal((leadRead.data as { current: { revision: { revisionId: string } } }).current.revision.revisionId, board.revision.revisionId);
  assert.equal(f.sets, 0);
});

test("Lead authority change before or during CAS does not claim atomicity or erase readable uncertain history", async () => {
  const before = await prepared();
  const originalGet = before.state.get.bind(before.state);
  let changed = false;
  before.state.get = async key => {
    const value = await originalGet(key);
    if (!changed && key.stateKey.startsWith("workstreams-head")) { changed = true; before.selectWorker(); }
    return value;
  };
  const writesBefore = before.writes;
  await assert.rejects(publishWorkstream(publishParams(), leadCtx(before), before.platform), /selection changed|current Builder Lead/);
  assert.equal(before.writes, writesBefore);

  const during = await prepared();
  during.setBeforeCas(key => { if (key.stateKey.startsWith("workstreams-head")) during.selectWorker(); });
  await assert.rejects(publishWorkstream(publishParams(), leadCtx(during), during.platform), /selection changed|current Builder Lead/);
  const visible = await createWorkstreamStore(WORKSPACE, PROJECT, during.state).current();
  assert.equal(visible?.revision.revisionId, "board-r01");
  assert.equal(visible?.revision.workstreams[0]?.author.selectionRevision, 1);
  const afterCommit = during.writes;
  await assert.rejects(publishWorkstream(publishParams(), leadCtx(during), during.platform), /current Builder Lead/);
  assert.equal(during.writes, afterCommit);
  assert.equal(during.sets, 0);
});

test("CTO pinned reads follow published source history after newer heads and ignore staged raw keys", async () => {
  const f = await prepared();
  await publishWorkstream(publishParams(), leadCtx(f), f.platform);
  const b2 = baseline("baseline-r02");
  await createDesignBaselineStore(WORKSPACE, PROJECT, f.state).publish({ expectedBaseRevisionId: "baseline-r01", revision: b2 });
  const tech2 = technology("technology-r02", "baseline-r02", "spec-baseline-r02", "graph-baseline-r02");
  tech2.baselineDigest = hash(b2);
  await createTechnologyDecisionStore(WORKSPACE, PROJECT, f.state).publish({ expectedBaseRevisionId: "technology-r01", revision: tech2 });
  const read = await readCtoWorkstream({ projectId: PROJECT, ctoId: "cto-one", workstreamId: "ws-one" }, ctoCtx(f), f.platform);
  const sources = (read.data as { sources: { baseline: { revisionId: string }; technology: { register: { revisionId: string } } } }).sources;
  assert.equal(sources.baseline.revisionId, "baseline-r01");
  assert.equal(sources.technology.register.revisionId, "technology-r01");
});
