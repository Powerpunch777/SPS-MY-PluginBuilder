import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createDesignBaselineStore } from "../src/design-baseline-tools.ts";
import { createTechnologyDecisionStore } from "../src/technology-decision-tools.ts";
import { createWorkstreamStore, publishWorkstream } from "../src/workstream-tools.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "planning-preflight-project";
const LEAD = "33333333-3333-4333-8333-333333333333";
const CTO_ONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CTO_TWO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LEAD_SESSION = "55555555-5555-4555-8555-555555555555";
const CTO_ONE_SESSION = "66666666-6666-4666-8666-666666666666";
const CTO_TWO_SESSION = "77777777-7777-4777-8777-777777777777";
const RUN = "88888888-8888-4888-8888-888888888888";
const NAMESPACE = "sonpark.my-builder";
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const digest = (value: unknown) => sha(JSON.stringify(value));
const key = (stateKey: string): SpsStateKey => ({ scopeKind: "company", scopeId: WORKSPACE, namespace: NAMESPACE, stateKey });
const mapKey = (value: SpsStateKey) => JSON.stringify(value);

async function fixture(relations: unknown[] = []) {
  const values = new Map<string, JsonValue>();
  const state = {
    async get(address: SpsStateKey) { return structuredClone(values.get(mapKey(address)) ?? null); },
    async compareAndSet(address: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
      const addressKey = mapKey(address), current = values.get(addressKey);
      const matches = expected.exists ? JSON.stringify(current) === JSON.stringify(expected.value) : current === undefined;
      if (matches) values.set(addressKey, structuredClone(value));
      return { swapped: matches };
    },
  };
  const ctx = { companyId: WORKSPACE, agentId: LEAD, sessionId: LEAD_SESSION, runId: RUN };
  values.set(mapKey(key("lead-agent.v1")), { workspaceId: WORKSPACE, revision: 1, selectedAgentId: LEAD });
  values.set(mapKey(key("lead-sessions.v1.1")), { workspaceId: WORKSPACE, selectionRevision: 1, agentId: LEAD,
    sessions: { main: LEAD_SESSION, "ui-design": null, background: null, decisions: null, "cto-inbox": null, "integration-review": null } });
  values.set(mapKey(key(`project-ctos.v1.${sha(PROJECT)}`)), { schemaVersion: 1, workspaceId: WORKSPACE, projectId: PROJECT, revision: 1,
    ctos: [
      { ctoId: "cto-one", displayName: "CTO One", agentId: CTO_ONE, sessionId: CTO_ONE_SESSION, status: "ACTIVE",
        createdAt: "2026-11-02T01:02:03.004Z", createdBy: { agentId: LEAD, sessionId: LEAD_SESSION, runId: RUN, selectionRevision: 1 } },
      { ctoId: "cto-two", displayName: "CTO Two", agentId: CTO_TWO, sessionId: CTO_TWO_SESSION, status: "ACTIVE",
        createdAt: "2026-11-02T01:02:03.004Z", createdBy: { agentId: LEAD, sessionId: LEAD_SESSION, runId: RUN, selectionRevision: 1 } },
    ] });
  const baseline = { projectId: PROJECT, revisionId: "baseline-r1", sourceDraftRevisionId: "draft-r1", draftDigest: "a".repeat(64),
    createdAt: "2026-11-02T01:02:03.004Z", author: { agentId: LEAD, sessionId: LEAD_SESSION, runId: RUN, selectionRevision: 1 },
    userDecision: { sourceId: `lead-turn:${RUN}`, sourceSha256: "b".repeat(64), interpretation: "Approved interface ownership fixture." },
    specification: { projectId: PROJECT, revisionId: "spec-r1", productTier: "M",
      requirements: [{ id: "REQ-1", description: "Use the declared interface.", acceptanceCriteriaIds: ["AC-1"] }],
      targets: ["sps-plugin"], dataPolicyRef: "policy-r1", approvalEvidenceRef: `lead-turn:${RUN}` },
    graph: { approvedSpecRevisionId: "spec-r1", graphRevisionId: "graph-r1",
      entities: [
        { id: "feature-one", kind: "feature", specRef: "REQ-1", contractRefs: ["API-1"] },
        { id: "feature-two", kind: "feature", specRef: "REQ-1", contractRefs: ["API-1"] },
      ], relations, viewLayoutRef: "layout-r1" } };
  const baselineStore = createDesignBaselineStore(WORKSPACE, PROJECT, state as never);
  await baselineStore.publish({ expectedBaseRevisionId: null, revision: baseline as never });
  const baselineHead = (await baselineStore.current())!.revision;
  const technology = { register: { projectId: PROJECT, revisionId: "technology-r1", sourceBaselineRevisionId: baselineHead.revisionId,
    sourceSpecRevisionId: baselineHead.specification.revisionId, sourceGraphRevisionId: baselineHead.graph.graphRevisionId, entries: [] },
    author: baselineHead.author, createdAt: baselineHead.createdAt, baselineDigest: digest(baselineHead) };
  await createTechnologyDecisionStore(WORKSPACE, PROJECT, state as never).publish({ expectedBaseRevisionId: null, revision: technology as never });
  const platform = { state, agents: new Proxy({}, { get() { throw new Error("Planning preflight must not call the Agent API."); } }) } as unknown as SpsPlatformInvocationContext;
  const spec = (overrides: Record<string, unknown> = {}) => ({ projectId: PROJECT, id: "ws-one", revision: 1,
    sourceSpecRevisionId: "spec-r1", assignedCtoId: "cto-one", title: "Build the owned feature", goal: "Implement its approved behavior.",
    scopeNodeIds: ["feature-one"], included: ["Approved feature"], excluded: [], dependencies: [], interfaceContracts: ["API-1"],
    technologyDecisionsRef: "technology-r1", reuseCandidates: [], acceptance: ["The behavior passes"],
    evidenceRequired: ["Independent QA"], openQuestions: [], ...overrides });
  const params = (revisionId: string, expectedBaseRevisionId: string | null, specValue = spec()) => ({ projectId: PROJECT,
    expectedBaseRevisionId, revisionId, spec: specValue,
    change: { previousRevision: null, reason: "Initial assignment", diff: "Assign the bounded feature.",
      impactNodeIds: [...specValue.scopeNodeIds as string[]], impactInterfaceContracts: [...specValue.interfaceContracts as string[]],
      impactTaskIds: [], effectiveFrom: "After publication" } });
  return { values, state, platform, ctx, spec, params };
}

test("publication permits shared declared interfaces and reports unresolved whole-entry dependencies", async () => {
  const f = await fixture();
  const firstSpec = f.spec({ dependencies: ["ws-two"] });
  const first = await publishWorkstream(f.params("board-r1", null, firstSpec), f.ctx, f.platform);
  assert.equal((first.data as { status: string }).status, "published");
  assert.deepEqual((first.data as { unresolvedDependencies: string[] }).unresolvedDependencies, ["ws-two"]);
  assert.match(first.content, /Integration Manager waits until an exact Workstream ID is published/u);
  const secondSpec = f.spec({ id: "ws-two", assignedCtoId: "cto-two", scopeNodeIds: ["feature-two"],
    dependencies: [], interfaceContracts: ["API-1"] });
  const second = await publishWorkstream(f.params("board-r2", "board-r1", secondSpec), f.ctx, f.platform);
  assert.equal((second.data as { status: string }).status, "published");
  assert.match(second.content, /shared interface references are allowed/u);
  assert.match(second.content, /no prose or interface semantics are inferred/u);
  const board = await createWorkstreamStore(WORKSPACE, PROJECT, f.state as never).current();
  assert.deepEqual(board?.revision.workstreams.map(item => item.spec.id), ["ws-one", "ws-two"]);
  assert.deepEqual(board?.revision.workstreams.map(item => item.spec.interfaceContracts), [["API-1"], ["API-1"]]);
});

test("publication rejects a reachable cycle between exact Workstream IDs without writing", async () => {
  const f = await fixture();
  const a = await publishWorkstream(f.params("board-r1", null, f.spec({ dependencies: ["ws-two"] })), f.ctx, f.platform);
  assert.equal((a.data as { status: string }).status, "published");
  const before = f.values.size;
  const bSpec = f.spec({ id: "ws-two", assignedCtoId: "cto-two", scopeNodeIds: ["feature-two"], dependencies: ["ws-one"] });
  const b = await publishWorkstream(f.params("board-r2", "board-r1", bSpec), f.ctx, f.platform);
  assert.equal((b.data as { status: string }).status, "dependency-conflict");
  assert.deepEqual((b.data as { cycle: string[] }).cycle, ["ws-two", "ws-one", "ws-two"]);
  assert.equal(f.values.size, before, "cycle preflight must not stage or publish a board revision");
  assert.deepEqual((await createWorkstreamStore(WORKSPACE, PROJECT, f.state as never).current())?.revision.workstreams.map(item => item.spec.id), ["ws-one"]);
});

test("a whole-entry self dependency is rejected as a cycle", async () => {
  const f = await fixture();
  const result = await publishWorkstream(f.params("board-self", null, f.spec({ dependencies: ["ws-one"] })), f.ctx, f.platform);
  assert.equal((result.data as { status: string }).status, "dependency-conflict");
  assert.deepEqual((result.data as { cycle: string[] }).cycle, ["ws-one", "ws-one"]);
  assert.equal(await createWorkstreamStore(WORKSPACE, PROJECT, f.state as never).current(), null);
});

test("actual directed depends_on cycles are rejected by the pinned Graph contract before Workstream publication", async () => {
  const cycle = [
    { id: "edge-one", sourceId: "feature-one", targetId: "feature-two", kind: "depends_on" },
    { id: "edge-two", sourceId: "feature-two", targetId: "feature-one", kind: "depends_on" },
  ];
  await assert.rejects(() => fixture(cycle), /depends_on relations must form a DAG/u);
});

test("scope preflight rejects another CTO claiming the same Graph node and explains the boundary", async () => {
  const f = await fixture();
  await publishWorkstream(f.params("board-r1", null), f.ctx, f.platform);
  const secondSpec = f.spec({ id: "ws-two", assignedCtoId: "cto-two", scopeNodeIds: ["feature-one"] });
  const result = await publishWorkstream(f.params("board-r2", "board-r1", secondSpec), f.ctx, f.platform);
  assert.equal((result.data as { status: string }).status, "scope-conflict");
  assert.match(result.content, /shared declared interfaces remain allowed/u);
  assert.match(result.content, /Unresolved dependency text is not interpreted as an ID/u);
  assert.equal((await createWorkstreamStore(WORKSPACE, PROJECT, f.state as never).current())?.revision.workstreams.length, 1);
});
