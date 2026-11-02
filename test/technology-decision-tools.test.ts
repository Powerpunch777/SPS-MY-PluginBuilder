import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { parseAuthoredTechnologyDecisions } from "../src/domain/authored-technology-decisions.ts";
import { createDesignBaselineStore } from "../src/design-baseline-tools.ts";
import {
  createTechnologyDecisionStore,
  publishTechnologyDecisions,
  readLeadTechnologyDecisions,
  readTechnologyDecisions,
} from "../src/technology-decision-tools.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const LEAD = "44444444-4444-4444-8444-444444444444";
const WORKER = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";
const SESSIONS = {
  main: "88888888-8888-4888-8888-888888888888",
  "cto-inbox": "99999999-9999-4999-8999-999999999999",
  decisions: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const NAMESPACE = "sonpark.my-builder";
type Expected = { exists: false } | { exists: true; value: JsonValue };
type CasHook = (key: SpsStateKey) => void | Promise<void>;

const fullKey = (key: SpsStateKey) => JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

function baseline(revisionId = "baseline-r01") {
  return {
    projectId: PROJECT,
    revisionId,
    sourceDraftRevisionId: `draft-${revisionId}`,
    draftDigest: "a".repeat(64),
    createdAt: "2026-11-02T01:02:03.004Z",
    author: { agentId: LEAD, sessionId: SESSIONS.main, runId: RUN, selectionRevision: 1 },
    userDecision: { sourceId: "lead-turn:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", sourceSha256: "b".repeat(64), interpretation: "A user decision." },
    specification: {
      projectId: PROJECT,
      revisionId: `spec-${revisionId}`,
      productTier: "M",
      requirements: [{ id: "REQ-1", description: "Keep the agreed workflow.", acceptanceCriteriaIds: ["AC-1"] }],
      targets: ["sps-plugin"],
      dataPolicyRef: "policy-r01",
      approvalEvidenceRef: "lead-turn:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    },
    graph: {
      approvedSpecRevisionId: `spec-${revisionId}`,
      graphRevisionId: `graph-${revisionId}`,
      entities: [{ id: "feature-1", kind: "feature", specRef: "REQ-1", contractRefs: ["API-1"] }],
      relations: [],
      viewLayoutRef: "layout-r01",
    },
  };
}

function entry(disposition: "required" | "allowed" | "prohibited" | "undecided" = "allowed") {
  return {
    id: `tech-${disposition}`,
    technology: `Example ${disposition}`,
    disposition,
    selectionReason: "Fits the stated interface.",
    nonSelectionReason: "",
    scopeNodeIds: ["feature-1"],
    interoperability: ["HTTP"],
    constraints: ["Keep credentials out of configuration."],
    cost: "Model-reported estimate: low.",
    versionCompatibility: "Model-reported range: v1.",
    changeApprovalOwner: "Lead",
    licenseReview: { status: "unreviewed", licenseExpression: null, evidenceRefs: [] },
    verification: { level: "not-verified", evidenceRefs: [], limitations: "Not independently checked.", nextReviewCondition: "Before adoption." },
  };
}

function register(entries = [entry() as ReturnType<typeof entry>], overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT,
    revisionId: "technology-r01",
    sourceBaselineRevisionId: "baseline-r01",
    sourceSpecRevisionId: "spec-baseline-r01",
    sourceGraphRevisionId: "graph-baseline-r01",
    entries,
    ...overrides,
  };
}

function fixture(options: { agentId?: string; sessionId?: string; cas?: boolean } = {}) {
  const values = new Map<string, JsonValue>();
  const casCalls: SpsStateKey[] = [];
  let writes = 0;
  let sets = 0;
  let beforeCas: CasHook = () => {};
  const key = (stateKey: string): SpsStateKey => ({ scopeKind: "company", scopeId: WORKSPACE, namespace: NAMESPACE, stateKey });
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
      casCalls.push(structuredClone(input));
      await beforeCas(input);
      const id = fullKey(input);
      const exists = values.has(id);
      const current = values.get(id);
      const matches = expected.exists
        ? exists && JSON.stringify(current) === JSON.stringify(expected.value)
        : !exists;
      if (matches) {
        writes += 1;
        values.set(id, structuredClone(value));
      }
      return { swapped: matches };
    },
  };
  values.set(fullKey(key("lead-agent.v1")), { workspaceId: WORKSPACE, revision: 1, selectedAgentId: LEAD });
  values.set(fullKey(key("lead-sessions.v1.1")), {
    workspaceId: WORKSPACE, selectionRevision: 1, agentId: LEAD, sessions: { ...SESSIONS },
  });
  const platform = {
    state: options.cas === false ? { ...state, compareAndSet: undefined } : state,
    agents: new Proxy({}, { get() { throw new Error("Technology decision tools must not call the Agent API"); } }),
  } as unknown as SpsPlatformInvocationContext;
  const context = {
    companyId: WORKSPACE,
    agentId: options.agentId ?? LEAD,
    runId: RUN,
    sessionId: options.sessionId ?? SESSIONS.main,
  };
  const scopedKey = (stateKey: string) => fullKey(key(stateKey));
  return {
    values, key, scopedKey, state, platform, context, casCalls,
    get writes() { return writes; },
    get sets() { return sets; },
    setBeforeCas(hook: CasHook) { beforeCas = hook; },
    selectWorker() {
      values.set(scopedKey("lead-agent.v1"), { workspaceId: WORKSPACE, revision: 2, selectedAgentId: WORKER });
      values.set(scopedKey("lead-sessions.v1.2"), {
        workspaceId: WORKSPACE, selectionRevision: 2, agentId: WORKER,
        sessions: { main: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "cto-inbox": null, decisions: null },
      });
    },
  };
}

async function prepared(options: { agentId?: string; sessionId?: string; cas?: boolean } = {}) {
  const f = fixture(options);
  const baselines = createDesignBaselineStore(WORKSPACE, PROJECT, f.state);
  const seeded = await baselines.publish({ expectedBaseRevisionId: null, revision: baseline() });
  assert.equal(seeded.status, "published");
  f.casCalls.length = 0;
  return f;
}

function params(value = register(), expectedBaseRevisionId: string | null = null) {
  return { projectId: PROJECT, expectedBaseRevisionId, register: value };
}

test("current Lead publishes detached authored metadata with a baseline digest and no ordinary set or Agent calls", async () => {
  const f = await prepared();
  const input = register();
  const writes = f.writes;
  const result = await publishTechnologyDecisions(params(input), f.context, f.platform);
  assert.equal((result.data as { status: string }).status, "published");
  assert.match(result.content, /Omitted technologies are unspecified, not prohibited/);
  assert.equal(f.writes - writes, 2, "one immutable revision and one head CAS are written");
  assert.equal(f.sets, 0);
  const current = await readTechnologyDecisions(WORKSPACE, PROJECT, f.platform);
  assert.equal(current?.sequence, 1);
  assert.deepEqual(current?.revision.register, input);
  assert.deepEqual(current?.revision.author, {
    agentId: LEAD, sessionId: SESSIONS.main, runId: RUN, selectionRevision: 1,
  });
  assert.match(current?.revision.createdAt ?? "", /^\d{4}-\d\d-\d\dT/);
  const storedBaseline = (await createDesignBaselineStore(WORKSPACE, PROJECT, f.state).current())!;
  assert.equal(current?.revision.baselineDigest, sha256(storedBaseline.revision));
  assert.notStrictEqual(current?.revision.register, input);
  assert.notStrictEqual(current?.revision.register.entries[0], input.entries[0]);

  const restarted = { ...f.platform } as SpsPlatformInvocationContext;
  assert.deepEqual(await readTechnologyDecisions(WORKSPACE, PROJECT, restarted), current);
  const leadRead = await readLeadTechnologyDecisions({ projectId: PROJECT }, f.context, restarted);
  assert.deepEqual((leadRead.data as { current: unknown }).current, current);
  assert.equal(f.sets, 0);
});

test("all four dispositions are valid and an omitted technology is not implicitly prohibited", async () => {
  const f = await prepared();
  const all = ["required", "allowed", "prohibited", "undecided"] as const;
  const values = all.map((disposition, index) => entry(disposition) as ReturnType<typeof entry> & { id: string; technology: string });
  values.forEach((value, index) => { value.id = `tech-${index}`; value.technology = `Example ${index}`; });
  const result = await publishTechnologyDecisions(params(register(values)), f.context, f.platform);
  assert.equal((result.data as { status: string }).status, "published");
  const current = await readTechnologyDecisions(WORKSPACE, PROJECT, f.platform);
  assert.deepEqual(current?.revision.register.entries.map(item => item.disposition), all);
  assert.equal(current?.revision.register.entries.some(item => item.technology === "Unmentioned Tool"), false);
  assert.match(result.content, /Omitted technologies are unspecified, not prohibited/);
});

test("rejects a Worker and mismatched or unprepared Lead sessions before publication", async () => {
  for (const options of [
    { agentId: WORKER },
    { sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  ]) {
    const f = await prepared(options);
    const writes = f.writes;
    await assert.rejects(publishTechnologyDecisions(params(), f.context, f.platform));
    assert.equal(f.writes, writes);
  }
  const f = await prepared();
  f.values.set(f.scopedKey("lead-sessions.v1.1"), {
    workspaceId: WORKSPACE, selectionRevision: 1, agentId: LEAD,
    sessions: { ...SESSIONS, main: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  });
  const writes = f.writes;
  await assert.rejects(publishTechnologyDecisions(params(), f.context, f.platform), /prepared current Lead session/);
  assert.equal(f.writes, writes);
});

test("rejects absent or mismatched baseline source IDs and foreign graph nodes before writes", async () => {
  const f = await prepared();
  const writes = f.writes;
  await assert.rejects(publishTechnologyDecisions(params(register([], { sourceBaselineRevisionId: "other" })), f.context, f.platform));
  await assert.rejects(publishTechnologyDecisions(params(register([], { sourceSpecRevisionId: "other" })), f.context, f.platform));
  await assert.rejects(publishTechnologyDecisions(params(register([], { sourceGraphRevisionId: "other" })), f.context, f.platform));
  const foreignNode = { ...entry("allowed"), scopeNodeIds: ["foreign-node"] };
  await assert.rejects(publishTechnologyDecisions(params(register([foreignNode])), f.context, f.platform));
  assert.equal(f.writes, writes);

  const absent = fixture();
  await assert.rejects(publishTechnologyDecisions(params(register()), absent.context, absent.platform));
  assert.equal(absent.writes, 0);
});

test("stale expected head conflicts without overwrite and successful publication advances history", async () => {
  const f = await prepared();
  const first = await publishTechnologyDecisions(params(register()), f.context, f.platform);
  assert.equal((first.data as { status: string }).status, "published");
  const secondRegister = register([], { revisionId: "technology-r02" });
  const second = await publishTechnologyDecisions(params(secondRegister, "technology-r01"), f.context, f.platform);
  assert.equal((second.data as { status: string }).status, "published");
  const writes = f.writes;
  const stale = await publishTechnologyDecisions(params(register([], { revisionId: "technology-r03" }), "technology-r01"), f.context, f.platform);
  assert.equal((stale.data as { status: string }).status, "conflict");
  assert.equal(f.writes, writes);
  const history = await createTechnologyDecisionStore(WORKSPACE, PROJECT, f.state).recent();
  assert.deepEqual(history.revisions.map(item => item.revision.register.revisionId), ["technology-r02", "technology-r01"]);
  assert.equal(history.revisions[1]?.sequence, 1);
});

test("snapshots caller input before its first asynchronous state read", async () => {
  const f = await prepared();
  const input = params(register());
  const originalGet = f.state.get.bind(f.state);
  let mutated = false;
  f.state.get = async key => {
    if (!mutated) {
      mutated = true;
      (input.register.entries[0] as { technology: string }).technology = "Mutated during await";
      input.projectId = "other-project";
    }
    return originalGet(key);
  };
  const result = await publishTechnologyDecisions(input, f.context, f.platform);
  assert.equal((result.data as { status: string }).status, "published");
  const current = await readTechnologyDecisions(WORKSPACE, PROJECT, f.platform);
  assert.equal(current?.revision.register.projectId, PROJECT);
  assert.equal(current?.revision.register.entries[0]?.technology, "Example allowed");
});

test("lost successful head-CAS response remains readable and publication is not retried", async () => {
  const f = await prepared();
  const original = f.state.compareAndSet.bind(f.state);
  let lost = false;
  f.state.compareAndSet = async (key, expected, value) => {
    const result = await original(key, expected, value);
    if (!lost && result.swapped && key.stateKey.startsWith("technology-decisions-head")) {
      lost = true;
      throw new Error("technology head CAS response was lost");
    }
    return result;
  };
  await assert.rejects(publishTechnologyDecisions(params(), f.context, f.platform), /response was lost/);
  const visible = await readTechnologyDecisions(WORKSPACE, PROJECT, f.platform);
  assert.equal(visible?.revision.register.revisionId, "technology-r01");
  const writes = f.writes;
  const retry = await publishTechnologyDecisions(params(), f.context, f.platform);
  assert.equal((retry.data as { status: string }).status, "conflict");
  assert.equal(f.writes, writes);
});

test("retired Lead before and during head CAS is denied; uncertain committed history grants no execution", async () => {
  const before = await prepared();
  let changed = false;
  const originalGet = before.state.get.bind(before.state);
  before.state.get = async key => {
    const value = await originalGet(key);
    if (!changed && key.stateKey.startsWith("technology-decisions-head")) {
      changed = true;
      before.selectWorker();
    }
    return value;
  };
  const writesBefore = before.writes;
  await assert.rejects(publishTechnologyDecisions(params(), before.context, before.platform), /selection changed|current Builder Lead/);
  assert.equal(before.writes, writesBefore);

  const during = await prepared();
  during.setBeforeCas(key => {
    if (key.stateKey.startsWith("technology-decisions-head")) during.selectWorker();
  });
  await assert.rejects(publishTechnologyDecisions(params(), during.context, during.platform), /selection changed|current Builder Lead/);
  const history = await readTechnologyDecisions(WORKSPACE, PROJECT, during.platform);
  assert.equal(history?.revision.author.selectionRevision, 1);
  assert.equal(history?.revision.register.revisionId, "technology-r01");
  const committedWrites = during.writes;
  await assert.rejects(publishTechnologyDecisions(params(), during.context, during.platform), /current Builder Lead/);
  assert.equal(during.writes, committedWrites);
});

test("baseline change during guarded write is rejected without assuming cross-key atomicity", async () => {
  const f = await prepared();
  let changed = false;
  const originalGet = f.state.get.bind(f.state);
  f.state.get = async key => {
    const value = await originalGet(key);
    if (!changed && key.stateKey.startsWith("technology-decisions-head")) {
      changed = true;
      const store = createDesignBaselineStore(WORKSPACE, PROJECT, f.state);
      await store.publish({ expectedBaseRevisionId: "baseline-r01", revision: baseline("baseline-r02") });
    }
    return value;
  };
  const writes = f.writes;
  await assert.rejects(publishTechnologyDecisions(params(), f.context, f.platform), /baseline changed|Read the exact current design baseline/);
  assert.ok(f.writes >= writes, "the fake state does not claim cross-key atomicity");
  assert.equal(await readTechnologyDecisions(WORKSPACE, PROJECT, f.platform), null);
});

test("CAS unsupported host fails closed without ordinary-set fallback", async () => {
  const f = await prepared({ cas: false });
  const writes = f.writes;
  await assert.rejects(publishTechnologyDecisions(params(), f.context, f.platform), /compareAndSet is required/);
  assert.equal(f.writes, writes);
  assert.equal(f.sets, 0);
});

test("authored schema rejects malformed timestamps, UUIDs, digests, and unknown fields", () => {
  const valid = {
    register: register(),
    author: { agentId: LEAD, sessionId: SESSIONS.main, runId: RUN, selectionRevision: 1 },
    createdAt: "2026-11-02T01:02:03.004Z",
    baselineDigest: "c".repeat(64),
  };
  assert.deepEqual(parseAuthoredTechnologyDecisions(valid, PROJECT), valid);
  for (const authored of [
    { ...valid, createdAt: "2026-11-02T01:02:03Z" },
    { ...valid, createdAt: "not-a-time" },
    { ...valid, author: { ...valid.author, sessionId: "bad-uuid" } },
    { ...valid, author: { ...valid.author, runId: "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa" } },
    { ...valid, baselineDigest: "C".repeat(64) },
    { ...valid, extra: true },
    { ...valid, author: { ...valid.author, extra: true } },
  ]) assert.throws(() => parseAuthoredTechnologyDecisions(authored, PROJECT));
});
