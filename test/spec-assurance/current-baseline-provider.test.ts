import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createDesignBaselineStore } from "../../src/design-baseline-tools.ts";
import type { BuilderLeadSessions } from "../../src/domain/model.ts";
import { createDesignDraftStore, type AuthoredDesignDraft } from "../../src/design-draft-store.ts";
import { firstDesignReviewApprovalRevision } from "../../src/domain/design-baseline.ts";
import type { RevisionState } from "../../src/solution-revision-store.ts";
import { createSpecAssuranceConsumer, type AssuranceInput } from "../../src/spec-assurance/evaluator.ts";
import { createCurrentBaselineAssuranceProvider } from "../../src/spec-assurance/current-baseline-provider.ts";
import { approveFirstDesignReview, proposeFirstDesignReview, readFirstDesignReviewRevision } from "../../src/spec-assurance/review-first-design.ts";
import { createBuilderPlatform } from "../../src/platform.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const PROJECT = "project-current";
const OTHER_PROJECT = "project-other";
const AGENT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const TURN = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";
const SOURCE_ID = `lead-turn:${TURN}`;
const SOURCE_TEXT = "Please keep the onboarding steps clear.";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const fullKey = (key: SpsStateKey) => JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);

function fixture() {
  const values = new Map<string, JsonValue>();
  const state: RevisionState = {
    async get(key) { return structuredClone(values.get(fullKey(key)) ?? null); },
    async compareAndSet(key, expected, value) {
      const id = fullKey(key), present = values.has(id), old = values.get(id);
      const matches = expected.exists ? present && JSON.stringify(old) === JSON.stringify(expected.value) : !present;
      if (matches) values.set(id, structuredClone(value));
      return { swapped: matches };
    },
  };
  const platform = { state, events: {}, agents: {} } as unknown as SpsPlatformInvocationContext;
  const sessions: BuilderLeadSessions = { workspaceId: WORKSPACE, selectionRevision: 1, agentId: AGENT,
    sessions: { main: SESSION, "ui-design": null, background: null, "cto-inbox": null, decisions: null, "integration-review": null } };
  const turnKey: SpsStateKey = { scopeKind: "company", scopeId: WORKSPACE, namespace: "sonpark.my-builder",
    stateKey: `lead-chat.turn.v1.${TURN}` };
  values.set(fullKey(turnKey), {
    workspaceId: WORKSPACE, selectionRevision: 1, agentId: AGENT, sessionId: SESSION, channel: "main",
    schemaVersion: 1, requestId: TURN, previousRequestId: null, sequence: 0, text: SOURCE_TEXT,
    createdAt: "2026-11-04T00:00:00.000Z", state: "submitted", runId: RUN, answer: null,
    outputState: "not_ready", cancellationRequested: false, termination: "not_applicable",
  });
  const specification = (revisionId = "spec-r1") => ({ projectId: PROJECT, revisionId, productTier: "M" as const,
    requirements: [{ id: "REQ-1", description: "Onboarding steps remain clear.", acceptanceCriteriaIds: ["AC-1"] }],
    targets: ["sps-plugin" as const], dataPolicyRef: "policy-current", approvalEvidenceRef: SOURCE_ID });
  const baseline = (revisionId = "spec-r1", baselineRevisionId = "baseline-r1") => ({
    projectId: PROJECT, revisionId: baselineRevisionId, sourceDraftRevisionId: "draft-r1", draftDigest: "a".repeat(64),
    createdAt: "2026-11-04T00:00:01.000Z",
    author: { agentId: AGENT, sessionId: SESSION, runId: RUN, selectionRevision: 1 },
    userDecision: { sourceId: SOURCE_ID, sourceSha256: sha256(SOURCE_TEXT), interpretation: "Keep onboarding clear." },
    specification: specification(revisionId),
    graph: { approvedSpecRevisionId: revisionId, graphRevisionId: `graph-${revisionId}`, entities: [], relations: [], viewLayoutRef: "layout-r1" },
  });
  const store = createDesignBaselineStore(WORKSPACE, PROJECT, state);
  return { values, state, platform, sessions, store, baseline, specification };
}

async function publishInitial(f = fixture()) {
  const published = await f.store.publish({ expectedBaseRevisionId: null, revision: f.baseline() });
  assert.equal(published.status, "published");
  const current = await f.store.current();
  assert(current);
  const digest = sha256(JSON.stringify(current.revision.specification));
  const identity = { workspaceId: WORKSPACE, projectId: PROJECT, specRevisionId: "spec-r1", specDigest: digest };
  const provider = createCurrentBaselineAssuranceProvider({ workspaceId: WORKSPACE, projectId: PROJECT,
    sessions: f.sessions, platform: f.platform });
  const input: AssuranceInput = { identity, scope: { requirementIds: ["REQ-1"] }, facts: ["caller-fact"], packs: [], scenarios: [] };
  return { ...f, identity, provider, input };
}

test("reads the published current baseline and actual cited user turn, but leaves unsupported coverage UNKNOWN", async () => {
  const f = await publishInitial();
  const snapshot = await f.provider({ identity: f.identity, requirementIds: ["REQ-1"] });
  assert(snapshot);
  assert.equal(snapshot.coverageInput.identity.specRevisionId, "spec-r1");
  assert.deepEqual(snapshot.coverageInput.scope, { requirementIds: ["REQ-1"], acIds: ["AC-1"] });
  assert.deepEqual(snapshot.coverageInput.sourceRefs, []);
  assert.equal(snapshot.coverageInput.manifest, null);
  assert.deepEqual(snapshot.domainPacks, []);
  assert.deepEqual(snapshot.facts, []);
  assert(snapshot.coverageInput.materials.some(material => material.kind === "source" && material.entities.some(entity =>
    entity.id === SOURCE_ID && entity.bodyDigest === sha256(SOURCE_TEXT))));

  const result = await createSpecAssuranceConsumer(f.provider)(f.input);
  assert.equal(result.coverageAuthority, "verified");
  assert.equal(result.status, "UNKNOWN");
  assert.deepEqual(result.sourceEvidence, []);
  assert.equal(result.itemDecisions[0]?.status, "NOT_CHECKED");
  assert(result.gaps.some(gap => gap.reason === "coverage-NOT_CHECKED" || gap.reason === "coverage-UNKNOWN"));
  assert(result.gaps.some(gap => gap.reason === "no-applicable-domain-rules"));
});

test("registered inspection is Main-scoped, Workspace-bound, and performs no writes or worker effects", async () => {
  const f = await publishInitial();
  const routeStore = createDesignBaselineStore(WORKSPACE, WORKSPACE, f.state);
  const routeBaseline = f.baseline();
  const routePublished = await routeStore.publish({ expectedBaseRevisionId: null, revision: { ...routeBaseline,
    projectId: WORKSPACE, specification: { ...routeBaseline.specification, projectId: WORKSPACE } } });
  assert.equal(routePublished.status, "published");
  const bindingKey: SpsStateKey = { scopeKind: "company", scopeId: WORKSPACE, namespace: "sonpark.my-builder", stateKey: "lead-agent.v1" };
  const sessionsKey: SpsStateKey = { scopeKind: "company", scopeId: WORKSPACE, namespace: "sonpark.my-builder", stateKey: "lead-sessions.v1.1" };
  f.values.set(fullKey(bindingKey), { workspaceId: WORKSPACE, revision: 1, selectedAgentId: AGENT });
  f.values.set(fullKey(sessionsKey), { workspaceId: WORKSPACE, selectionRevision: 1, agentId: AGENT,
    sessions: { main: SESSION, "ui-design": null, background: null, "cto-inbox": null,
      decisions: "77777777-7777-4777-8777-777777777777", "integration-review": null } });
  const stateCount = f.values.size;
  let writes = 0;
  const originalCas = f.state.compareAndSet;
  f.state.compareAndSet = async (...args) => { writes++; return originalCas!(...args); };
  const tool = createBuilderPlatform().tools.find(value => value.name === "builder.inspect-spec-assurance");
  assert(tool, "inspection must be registered on the actual platform contract");
  const runContext = { companyId: WORKSPACE, agentId: AGENT, runId: RUN, sessionId: SESSION };
  const output = await tool.handler({ projectId: WORKSPACE }, runContext as never, f.platform) as { data: { result: { status: string; identity: { specRevisionId: string } } } };
  assert.equal(output.data.result.status, "UNKNOWN");
  assert.equal(output.data.result.identity.specRevisionId, "spec-r1");
  await assert.rejects(Promise.resolve().then(() => tool.handler({ projectId: WORKSPACE },
    { ...runContext, sessionId: "77777777-7777-4777-8777-777777777777" } as never, f.platform)), /restricted to the current Main/);
  await assert.rejects(Promise.resolve().then(() => tool.handler({ projectId: OTHER_WORKSPACE }, runContext as never, f.platform)), /authenticated Workspace/);
  await assert.rejects(Promise.resolve().then(() => tool.handler({ projectId: WORKSPACE }, { ...runContext, agentId: OTHER_WORKSPACE } as never, f.platform)), /current Builder Lead/);
  await assert.rejects(Promise.resolve().then(() => tool.handler({ projectId: WORKSPACE, packs: [{ packId: "forged" }] }, runContext as never, f.platform)));
  const sourceKey = [...f.values.keys()].find(key => key.includes(`lead-chat.turn.v1.${TURN}`));
  assert(sourceKey);
  const turn = f.values.get(sourceKey) as Record<string, JsonValue>;
  f.values.set(sourceKey, { ...turn, text: "Forged source bytes" });
  const stale = await tool.handler({ projectId: WORKSPACE }, runContext as never, f.platform) as { data: { result: { status: string } } };
  assert.equal(stale.data.result.status, "UNKNOWN");
  assert.equal(writes, 0);
  assert.equal(f.values.size, stateCount, "inspection must not add or mutate plugin state");
  f.values.delete(sourceKey);
  const missing = await tool.handler({ projectId: WORKSPACE }, runContext as never, f.platform) as { data: { result: { status: string; scope: { requirementIds: string[] } } } };
  assert.equal(missing.data.result.status, "UNKNOWN");
  assert.deepEqual(missing.data.result.scope.requirementIds, ["REQ-1"]);
  assert.equal(writes, 0);
});

test("stale requested revision/digest and foreign Workspace/Project use actual current identity and stay UNKNOWN", async () => {
  const f = await publishInitial();
  const staleRevision = await createSpecAssuranceConsumer(f.provider)({ ...f.input,
    identity: { ...f.identity, specRevisionId: "spec-old" } });
  const staleDigest = await createSpecAssuranceConsumer(f.provider)({ ...f.input,
    identity: { ...f.identity, specDigest: "f".repeat(64) } });
  const foreignWorkspace = await createSpecAssuranceConsumer(f.provider)({ ...f.input,
    identity: { ...f.identity, workspaceId: OTHER_WORKSPACE } });
  const foreignProject = await createSpecAssuranceConsumer(f.provider)({ ...f.input,
    identity: { ...f.identity, projectId: OTHER_PROJECT } });
  for (const result of [staleRevision, staleDigest, foreignWorkspace, foreignProject]) {
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.coverageAuthority, "identity-mismatch");
    assert.deepEqual(result.sourceEvidence, []);
  }
});

test("a newly published baseline makes the previous requested revision stale", async () => {
  const f = await publishInitial();
  const current = await f.store.current();
  assert(current);
  const next = f.baseline("spec-r2", "baseline-r2");
  const result = await f.store.publish({ expectedBaseRevisionId: current.revision.revisionId, revision: next });
  assert.equal(result.status, "published");
  const stale = await createSpecAssuranceConsumer(f.provider)(f.input);
  assert.equal(stale.status, "UNKNOWN");
  assert.equal(stale.coverageAuthority, "identity-mismatch");
  assert.deepEqual(stale.sourceEvidence, []);
});

test("a baseline replaced during the async source read is rejected as stale", async () => {
  const f = await publishInitial();
  const state = f.platform.state as SpsPlatformInvocationContext["state"] & { get: (key: SpsStateKey) => Promise<JsonValue | null> };
  const originalGet = state.get.bind(state);
  let replaced = false;
  state.get = async key => {
    const value = await originalGet(key);
    if (!replaced && key.stateKey === `lead-chat.turn.v1.${TURN}`) {
      replaced = true;
      const current = await f.store.current();
      assert(current);
      const published = await f.store.publish({ expectedBaseRevisionId: current.revision.revisionId,
        revision: f.baseline("spec-r2", "baseline-r2") });
      assert.equal(published.status, "published");
    }
    return value;
  };
  const result = await createSpecAssuranceConsumer(f.provider)(f.input);
  assert.equal(replaced, true);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.coverageAuthority, "failed");
  assert.deepEqual(result.sourceEvidence, []);
});

test("missing or digest-mismatched cited originals fail closed", async () => {
  const missing = await publishInitial();
  const turnKey = [...missing.values.keys()].find(key => key.includes(`lead-chat.turn.v1.${TURN}`));
  assert(turnKey);
  missing.values.delete(turnKey);
  const missingResult = await createSpecAssuranceConsumer(missing.provider)(missing.input);
  assert.equal(missingResult.status, "UNKNOWN");
  assert.equal(missingResult.coverageAuthority, "failed");
  assert.deepEqual(missingResult.sourceEvidence, []);

  const changed = await publishInitial();
  const sourceKey = [...changed.values.keys()].find(key => key.includes(`lead-chat.turn.v1.${TURN}`));
  assert(sourceKey);
  const turn = changed.values.get(sourceKey) as Record<string, JsonValue>;
  changed.values.set(sourceKey, { ...turn, text: "Changed after the baseline was recorded." });
  const changedResult = await createSpecAssuranceConsumer(changed.provider)(changed.input);
  assert.equal(changedResult.status, "UNKNOWN");
  assert.equal(changedResult.coverageAuthority, "failed");
  assert.deepEqual(changedResult.sourceEvidence, []);
});

test("missing current baseline is unavailable and unsupported query requirements do not gain source links", async () => {
  const f = fixture();
  const provider = createCurrentBaselineAssuranceProvider({ workspaceId: WORKSPACE, projectId: PROJECT,
    sessions: f.sessions, platform: f.platform });
  const identity = { workspaceId: WORKSPACE, projectId: PROJECT, specRevisionId: "spec-r1", specDigest: "a".repeat(64) };
  const absent = await createSpecAssuranceConsumer(provider)({ identity, scope: { requirementIds: ["REQ-1"] }, facts: [], packs: [], scenarios: [] });
  assert.equal(absent.status, "UNKNOWN");
  assert.equal(absent.coverageAuthority, "unavailable");
  assert.deepEqual(absent.sourceEvidence, []);

  const present = await publishInitial(f);
  const unsupported = await present.provider({ identity: present.identity, requirementIds: ["REQ-UNKNOWN"] });
  assert(unsupported);
  assert.deepEqual(unsupported.coverageInput.sourceRefs, []);
  assert.deepEqual(unsupported.coverageInput.materials[0]?.entities, []);
  const result = await createSpecAssuranceConsumer(present.provider)({ ...present.input,
    scope: { requirementIds: ["REQ-UNKNOWN"] } });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.sourceEvidence.length, 0);
});

test("first Baseline consumes its exact approved review, preserving requirement and AC IDs without claiming checks", async () => {
  const f = fixture();
  const firstProject = WORKSPACE;
  const key = (stateKey: string): SpsStateKey => ({ scopeKind: "company", scopeId: WORKSPACE,
    namespace: "sonpark.my-builder", stateKey });
  const sessions: BuilderLeadSessions = { ...f.sessions, sessions: { ...f.sessions.sessions,
    "ui-design": "77777777-7777-4777-8777-777777777777" } };
  f.values.set(fullKey(key("lead-agent.v1")), { workspaceId: WORKSPACE, revision: 1, selectedAgentId: AGENT });
  f.values.set(fullKey(key("lead-sessions.v1.1")), sessions as unknown as JsonValue);
  const draft = { projectId: firstProject, revisionId: "initial-draft-r1", sourceIds: [SOURCE_ID],
    specification: { revisionId: "initial-spec-r1", productTier: "M" as const,
      requirements: [{ id: "draft-REQ-1", description: "Onboarding steps remain clear.", acceptanceCriteriaIds: ["draft-AC-1"] }],
      targets: ["sps-plugin" as const], dataPolicyRef: "policy-current" },
    graph: { graphRevisionId: "initial-graph-r1", entities: [], relations: [], viewLayoutRef: "layout-r1" }, questions: [] };
  const authored: AuthoredDesignDraft = { status: "draft", selectionRevision: 1,
    author: { agentId: AGENT, sessionId: SESSION, runId: RUN },
    sourceDigests: [{ id: SOURCE_ID, sha256: sha256(SOURCE_TEXT) }], createdAt: "2026-11-04T00:00:02.000Z", draft };
  const draftStore = createDesignDraftStore(WORKSPACE, firstProject, { selectionRevision: 1, agentId: AGENT }, f.state);
  const draftPublished = await draftStore.publish({ expectedBaseRevisionId: null, revision: authored });
  assert.equal(draftPublished.status, "published");
  const proposal = await proposeFirstDesignReview({ projectId: firstProject, expectedDraftRevisionId: draft.revisionId,
    expectedReviewHeadRevisionId: null,
    pack: { packId: "initial-onboarding", version: "1.0.0", applicability: {},
      rules: [{ id: "onboarding-clear", requirementIds: ["draft-REQ-1"], appliesWhen: {}, requiresCheck: true }],
      transitions: [], exceptions: [], excludedCombinations: [] },
    sourcePins: [{ requirementId: "draft-REQ-1", acId: "draft-AC-1", sourceId: SOURCE_ID }] },
  { companyId: WORKSPACE, agentId: AGENT, runId: RUN, sessionId: SESSION }, f.platform);
  assert.equal(proposal.status, "published");
  const approved = await approveFirstDesignReview({ projectId: firstProject, expectedBundleRevisionId: proposal.revision.revisionId },
    { ...f.platform, companyId: WORKSPACE, actor: { type: "user", companyId: WORKSPACE, userId: "user-initial" } } as never);
  assert.equal(approved.status, "published");
  const approvalId = approved.revision.revisionId;
  assert.equal(firstDesignReviewApprovalRevision(`first-design-review:${approvalId}`), approvalId);
  const exact = await readFirstDesignReviewRevision(WORKSPACE, firstProject, approvalId, f.state);
  assert(exact);
  const newerProposal = await proposeFirstDesignReview({ projectId: firstProject, expectedDraftRevisionId: draft.revisionId,
    expectedReviewHeadRevisionId: approvalId,
    pack: { packId: "later-unrelated-pack", version: "2.0.0", applicability: {}, rules: [],
      transitions: [], exceptions: [], excludedCombinations: [] },
    sourcePins: [{ requirementId: "draft-REQ-1", acId: "draft-AC-1", sourceId: SOURCE_ID }] },
  { companyId: WORKSPACE, agentId: AGENT, runId: RUN, sessionId: SESSION }, f.platform);
  assert.equal(newerProposal.status, "published");
  const laterApproval = await approveFirstDesignReview({ projectId: firstProject,
    expectedBundleRevisionId: newerProposal.revision.revisionId },
  { ...f.platform, companyId: WORKSPACE, actor: { type: "user", companyId: WORKSPACE, userId: "user-later" } } as never);
  assert.equal(laterApproval.status, "published");
  assert.notEqual(laterApproval.revision.revisionId, approvalId);
  const approvedSpec = { ...draft.specification, projectId: firstProject, revisionId: "approved-spec-r1",
    approvalEvidenceRef: `first-design-review:${approvalId}` };
  const initialBaseline = { projectId: firstProject, revisionId: "initial-baseline-r1", sourceDraftRevisionId: draft.revisionId,
    draftDigest: sha256(JSON.stringify(authored)), createdAt: "2026-11-04T00:00:03.000Z",
    author: { agentId: AGENT, sessionId: SESSION, runId: RUN, selectionRevision: 1 },
    userDecision: { sourceId: `first-design-review:${approvalId}`, sourceSha256: sha256(JSON.stringify(exact)), interpretation: "Initial design approved." },
    specification: approvedSpec, graph: { approvedSpecRevisionId: approvedSpec.revisionId, graphRevisionId: "approved-graph-r1",
      entities: [], relations: [], viewLayoutRef: "layout-r1" } };
  const baselineStore = createDesignBaselineStore(WORKSPACE, firstProject, f.state);
  const published = await baselineStore.publish({ expectedBaseRevisionId: null, revision: initialBaseline });
  assert.equal(published.status, "published");
  const baseline = await baselineStore.current();
  assert(baseline);
  const currentIdentity = { workspaceId: WORKSPACE, projectId: firstProject, specRevisionId: approvedSpec.revisionId,
    specDigest: sha256(JSON.stringify(baseline.revision.specification)) };
  const provider = createCurrentBaselineAssuranceProvider({ workspaceId: WORKSPACE, projectId: firstProject,
    sessions, platform: f.platform });
  const snapshot = await provider({ identity: currentIdentity, requirementIds: ["draft-REQ-1"] });
  assert(snapshot);
  assert.equal(snapshot.domainPacks.length, 1);
  assert.equal(snapshot.domainPacks[0]?.packId, "initial-onboarding");
  assert.equal(snapshot.domainPacks[0]?.identity.specRevisionId, "approved-spec-r1");
  assert.deepEqual(snapshot.domainPacks[0]?.rules[0]?.requirementIds, ["draft-REQ-1"]);
  assert.deepEqual(snapshot.coverageInput.sourceRefs, [{ requirementId: "draft-REQ-1", acId: "draft-AC-1",
    sourceId: SOURCE_ID, sourceDigest: sha256(SOURCE_TEXT), revisionId: "approved-spec-r1" }]);
  assert(snapshot.coverageInput.materials.some(material => material.kind === "source"
    && material.entities.some(entity => entity.id === SOURCE_ID && entity.relationIds.includes("draft-REQ-1")
      && entity.relationIds.includes("draft-AC-1"))));
  assert.equal(snapshot.coverageInput.manifest, null);
  assert.equal(snapshot.coverageInput.rulesVersion, "not-provided");
  assert.deepEqual(snapshot.coverageInput.checks, []);
  const result = await createSpecAssuranceConsumer(provider)({ identity: currentIdentity,
    scope: { requirementIds: ["draft-REQ-1"] }, facts: [], packs: [], scenarios: [] });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.itemDecisions[0]?.status, "NOT_CHECKED");
  const inspect = createBuilderPlatform().tools.find(tool => tool.name === "builder.inspect-spec-assurance");
  assert(inspect);
  const beforeInspect = structuredClone(f.values);
  const routed = await inspect.handler({ projectId: firstProject },
    { companyId: WORKSPACE, agentId: AGENT, runId: RUN, sessionId: SESSION } as never, f.platform) as unknown as { data: { result: typeof result } };
  assert.equal(routed.data.result.status, "UNKNOWN");
  assert.deepEqual(routed.data.result.packVersions, [{ packId: "initial-onboarding", version: "1.0.0" }]);
  assert.deepEqual(f.values, beforeInspect);
  const originalKey = [...f.values.keys()].find(value => value.includes(`lead-chat.turn.v1.${TURN}`));
  assert(originalKey);
  const originalTurn = f.values.get(originalKey) as Record<string, JsonValue>;
  f.values.set(originalKey, { ...originalTurn, text: "Changed initial source bytes" });
  await assert.rejects(async () => provider({ identity: currentIdentity, requirementIds: ["draft-REQ-1"] }), /source bytes do not match/);

  f.values.set(originalKey, originalTurn);
  const changedSpec = { ...approvedSpec, revisionId: "remapped-spec", requirements: [
    { ...approvedSpec.requirements[0]!, id: "remapped-requirement", acceptanceCriteriaIds: ["remapped-ac"] },
  ] };
  const changed = await baselineStore.publish({ expectedBaseRevisionId: initialBaseline.revisionId, revision: {
    ...initialBaseline, revisionId: "remapped-baseline", specification: changedSpec,
    graph: { ...initialBaseline.graph, approvedSpecRevisionId: changedSpec.revisionId },
  } });
  assert.equal(changed.status, "published");
  await assert.rejects(async () => provider({ identity: { ...currentIdentity, specRevisionId: changedSpec.revisionId,
    specDigest: sha256(JSON.stringify(changed.revision.specification)) }, requirementIds: ["remapped-requirement"] }),
  /does not match the exact approved first-design bundle/);
});
