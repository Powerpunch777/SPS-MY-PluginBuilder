import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createDesignBaselineStore } from "../../src/design-baseline-tools.ts";
import type { RevisionState } from "../../src/solution-revision-store.ts";
import { createSpecAssuranceConsumer, type AssuranceInput } from "../../src/spec-assurance/evaluator.ts";
import { createCurrentBaselineAssuranceProvider } from "../../src/spec-assurance/current-baseline-provider.ts";
import { confirmCurrentBaselineSpecAssurancePack, proposeSpecAssurancePack } from "../../src/spec-assurance/pack-producer.ts";
import { createSpecAssurancePackStore } from "../../src/spec-assurance/pack-store.ts";
import { createBuilderPlatform } from "../../src/platform.ts";
import { CONFIRM_CURRENT_BASELINE_SPEC_ASSURANCE_PACK_ACTION, SPEC_ASSURANCE_PACK_PROPOSAL_TOOL }
  from "../../src/spec-assurance/tool-declarations.mjs";

const W = "11111111-1111-4111-8111-111111111111", A = "33333333-3333-4333-8333-333333333333";
const S = "44444444-4444-4444-8444-444444444444", T = "55555555-5555-4555-8555-555555555555";
const R = "66666666-6666-4666-8666-666666666666", SOURCE = `lead-turn:${T}`;
const BODY = "The user requires clear onboarding steps and a visible completion state.";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const keyId = (key: SpsStateKey) => JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);

function fixture() {
  const values = new Map<string, JsonValue>();
  const state: RevisionState = {
    async get(key) { return structuredClone(values.get(keyId(key)) ?? null); },
    async compareAndSet(key, expected, value) {
      const id = keyId(key), present = values.has(id), old = values.get(id);
      const match = expected.exists ? present && JSON.stringify(old) === JSON.stringify(expected.value) : !present;
      if (match) values.set(id, structuredClone(value));
      return { swapped: match };
    },
  };
  const stateKey = (stateKey: string): SpsStateKey => ({ scopeKind: "company", scopeId: W,
    namespace: "sonpark.my-builder", stateKey });
  values.set(keyId(stateKey("lead-agent.v1")), { workspaceId: W, revision: 1, selectedAgentId: A });
  values.set(keyId(stateKey("lead-sessions.v1.1")), { workspaceId: W, selectionRevision: 1, agentId: A,
    sessions: { main: S, "ui-design": null, background: null, "cto-inbox": null, decisions: null, "integration-review": null } });
  values.set(keyId(stateKey(`lead-chat.turn.v1.${T}`)), { workspaceId: W, selectionRevision: 1, agentId: A, sessionId: S,
    channel: "main", schemaVersion: 1, requestId: T, previousRequestId: null, sequence: 0, text: BODY,
    createdAt: "2026-11-04T00:00:00.000Z", state: "submitted", runId: R, answer: null,
    outputState: "not_ready", cancellationRequested: false, termination: "not_applicable" });
  const spec = { projectId: W, revisionId: "spec-followup-1", productTier: "M" as const,
    requirements: [{ id: "REQ-1", description: "Onboarding is clear.", acceptanceCriteriaIds: ["AC-1"] }],
    targets: ["sps-plugin" as const], dataPolicyRef: "policy-1", approvalEvidenceRef: SOURCE };
  const baseline = { projectId: W, revisionId: "baseline-followup-1", sourceDraftRevisionId: "draft-1", draftDigest: "a".repeat(64),
    createdAt: "2026-11-04T00:00:01.000Z", author: { agentId: A, sessionId: S, runId: R, selectionRevision: 1 },
    userDecision: { sourceId: SOURCE, sourceSha256: sha(BODY), interpretation: "Keep onboarding clear." }, specification: spec,
    graph: { approvedSpecRevisionId: spec.revisionId, graphRevisionId: "graph-1", entities: [], relations: [], viewLayoutRef: "layout-1" } };
  const platform = { state, events: {}, agents: {} } as unknown as SpsPlatformInvocationContext;
  const main = { companyId: W, agentId: A, runId: R, sessionId: S };
  const model = { facts: ["onboarding"], rulesVersion: "d3-r1",
    coverageRules: [{ id: "complete-rule", requiresCheck: true, requiredEvidenceKinds: ["specification", "source"] }],
    coverageTargets: [{ targetKind: "requirement", targetId: "REQ-1", ruleIds: ["complete-rule"] },
      { targetKind: "ac", targetId: "AC-1", ruleIds: ["complete-rule"] }],
    scenarios: [{ id: "complete-onboarding", state: "started", event: "complete", nextState: "done", exceptionId: null }],
    itemDecisions: [{ requirementId: "REQ-1", status: "RESOLVED", reason: "User-approved requirement relationship.", sourceIds: [SOURCE] }],
    acceptanceCriteria: [{ requirementId: "REQ-1", acId: "AC-1", sourceId: SOURCE, quote: BODY }] };
  const proposalInput = { projectId: W, expectedBaseRevisionId: null, packId: "onboarding", version: "2.0.0",
    applicability: { all: ["onboarding"] },
    rules: [{ id: "complete-rule", requirementIds: ["REQ-1"], appliesWhen: { all: [] }, requiresCheck: true,
      modelCases: [{ when: { all: [] }, state: "started", event: "complete", allowedNextStates: ["done"] }] }],
    transitions: [{ from: "started", event: "complete", to: "done" }], exceptions: [], excludedCombinations: [],
    rulesVersion: "d3-r1", coverageRules: model.coverageRules, coverageTargets: model.coverageTargets,
    sourceRefs: [{ requirementId: "REQ-1", acId: null, sourceId: SOURCE },
      { requirementId: "REQ-1", acId: "AC-1", sourceId: SOURCE }], designModel: model };
  const provider = (packId = "onboarding") => createCurrentBaselineAssuranceProvider({ workspaceId: W, projectId: W,
    sessions: { workspaceId: W, selectionRevision: 1, agentId: A,
      sessions: { main: S, "ui-design": null, background: null, "cto-inbox": null, decisions: null, "integration-review": null } },
    platform, packId });
  const userAction = { ...platform, companyId: W, actor: { type: "user" as const, companyId: W, userId: "user-1" } };
  return { values, state, platform, baseline, spec, main, model, proposalInput, provider, userAction };
}

async function propose(f = fixture()) {
  await createDesignBaselineStore(W, W, f.state).publish({ expectedBaseRevisionId: null, revision: f.baseline });
  const result = await proposeSpecAssurancePack(f.proposalInput, f.main, f.platform) as unknown as {
    data: { proposal: { revision: { revisionId: string; status: string; baselineRevisionId: string } } };
  };
  return { ...f, proposal: result.data.proposal.revision };
}

test("a follow-up pack/model remains untrusted until an authenticated user confirms its exact pins", async () => {
  const f = await propose();
  const store = createSpecAssurancePackStore(W, W, f.state);
  assert.equal(f.proposal.status, "PROPOSED");
  assert.equal((await store.currentApproval("onboarding")), null);
  const identity = { workspaceId: W, projectId: W, specRevisionId: f.spec.revisionId, specDigest: sha(JSON.stringify(f.spec)) };
  await assert.rejects(async () => await f.provider()({ identity, requirementIds: ["REQ-1"] }), /user-approved/u);

  await assert.rejects(confirmCurrentBaselineSpecAssurancePack({ projectId: W, packId: "onboarding",
    expectedProposalRevisionId: f.proposal.revisionId, expectedBaselineRevisionId: f.baseline.revisionId,
    expectedApprovalRevisionId: null, userId: "forged" }, f.userAction as never));
  const confirmed = await confirmCurrentBaselineSpecAssurancePack({ projectId: W, packId: "onboarding",
    expectedProposalRevisionId: f.proposal.revisionId, expectedBaselineRevisionId: f.baseline.revisionId,
    expectedApprovalRevisionId: null }, f.userAction as never) as { status: string };
  assert.equal(confirmed.status, "published");
  const savedProposal = (await store.current("onboarding"))!.revision;
  const savedApproval = (await store.currentApproval("onboarding"))!.revision;
  assert.equal(savedApproval.proposalDigest, sha(JSON.stringify(savedProposal)));
  assert.equal(savedApproval.designModelDigest, sha(JSON.stringify(savedProposal.designModel)));
  assert.equal(savedProposal.baselineRevisionId, f.baseline.revisionId);
  assert.equal(savedProposal.baselineSequence, 1);
  assert.deepEqual(savedProposal.identity, { workspaceId: W, projectId: W,
    specRevisionId: f.spec.revisionId, specDigest: sha(JSON.stringify(f.spec)) });
  assert(savedProposal.sourceRefs.every(ref => ref.sourceId === SOURCE && ref.sourceDigest === sha(BODY)
    && ref.revisionId === f.spec.revisionId));
  assert.deepEqual(savedApproval.identity, savedProposal.identity);

  const provider = f.provider();
  const snapshot = await provider({ identity, requirementIds: ["REQ-1"] });
  assert(snapshot);
  assert.equal(snapshot.domainPacks[0]?.packId, "onboarding");
  assert.equal(snapshot.designModelEvidence?.kind, "design-model-v1");
  assert.equal(snapshot.coverageInput.manifest?.rulesVersion, "d3-r1");
  assert.equal(snapshot.scenarios?.[0]?.id, "complete-onboarding");
  const input: AssuranceInput = { identity, scope: { requirementIds: ["REQ-1"] }, facts: [], packs: [], scenarios: [] };
  const result = await createSpecAssuranceConsumer(provider)(input);
  assert.equal(result.coverageAuthority, "verified");
  assert.equal(result.designModelEvidence?.approvalRevisionId, (await store.currentApproval("onboarding"))?.revision.revisionId);
  assert.equal(result.scenarios[0]?.scenarioId, "complete-onboarding");
  assert.notEqual(result.status, "UNKNOWN");

  const bindingKey = keyId({ scopeKind: "company", scopeId: W, namespace: "sonpark.my-builder", stateKey: "lead-agent.v1" });
  const oldBinding = f.values.get(bindingKey)!;
  const sessionKey = keyId({ scopeKind: "company", scopeId: W, namespace: "sonpark.my-builder", stateKey: "lead-sessions.v1.1" });
  const oldSessions = f.values.get(sessionKey)!;
  f.values.set(bindingKey, { workspaceId: W, revision: 2, selectedAgentId: "77777777-7777-4777-8777-777777777777" });
  f.values.set(keyId({ scopeKind: "company", scopeId: W, namespace: "sonpark.my-builder", stateKey: "lead-sessions.v1.2" }),
    { workspaceId: W, selectionRevision: 2, agentId: "77777777-7777-4777-8777-777777777777",
      sessions: { main: "88888888-8888-4888-8888-888888888888", "ui-design": null, background: null,
        "cto-inbox": null, decisions: null, "integration-review": null } });
  await assert.rejects(async () => await provider({ identity, requirementIds: ["REQ-1"] }), /Lead selection changed/u);
  f.values.set(bindingKey, oldBinding);
  f.values.set(sessionKey, oldSessions);

  const nextSpec = { ...f.spec, revisionId: "spec-followup-2" };
  const nextBaseline = { ...f.baseline, revisionId: "baseline-followup-2", specification: nextSpec,
    graph: { ...f.baseline.graph, approvedSpecRevisionId: nextSpec.revisionId } };
  await createDesignBaselineStore(W, W, f.state).publish({ expectedBaseRevisionId: f.baseline.revisionId, revision: nextBaseline });
  await assert.rejects(async () => await provider({ identity: { ...identity, specRevisionId: nextSpec.revisionId,
    specDigest: sha(JSON.stringify(nextSpec)) }, requirementIds: ["REQ-1"] }), /proposal-baseline/u);
});

test("stale Baseline, changed source bytes, and Lead-selection drift reject confirmation or provider reads", async () => {
  const f = await propose();
  const params = { projectId: W, packId: "onboarding", expectedProposalRevisionId: f.proposal.revisionId,
    expectedBaselineRevisionId: f.baseline.revisionId, expectedApprovalRevisionId: null };
  assert.deepEqual(await confirmCurrentBaselineSpecAssurancePack({ ...params, expectedBaselineRevisionId: "stale-baseline" },
    f.userAction as never), { status: "stale" });
  await assert.rejects(confirmCurrentBaselineSpecAssurancePack(params,
    { ...f.userAction, actor: { type: "agent", companyId: W, agentId: A } } as never), /authenticated Builder user/u);
  const turnKey = [...f.values.keys()].find(key => key.includes("lead-chat.turn.v1."))!;
  const original = f.values.get(turnKey) as Record<string, JsonValue>;
  f.values.set(turnKey, { ...original, text: "modified original source" });
  await assert.rejects(confirmCurrentBaselineSpecAssurancePack(params, f.userAction as never), /changed during pack confirmation/u);
  const identity = { workspaceId: W, projectId: W, specRevisionId: f.spec.revisionId, specDigest: sha(JSON.stringify(f.spec)) };
  await assert.rejects(async () => await f.provider()({ identity, requirementIds: ["REQ-1"] }));

  f.values.set(turnKey, original);
  f.values.set(JSON.stringify(["company", W, "sonpark.my-builder", "lead-agent.v1"]),
    { workspaceId: W, revision: 2, selectedAgentId: "77777777-7777-4777-8777-777777777777" });
  await assert.rejects(confirmCurrentBaselineSpecAssurancePack(params, f.userAction as never), /current Builder Lead/u);
});

test("same-version model edits receive distinct immutable proposal revisions", async () => {
  const f = await propose();
  const changed = { ...f.proposalInput, expectedBaseRevisionId: f.proposal.revisionId,
    designModel: { ...f.model, facts: ["onboarding", "optional"] } };
  const result = await proposeSpecAssurancePack(changed, f.main, f.platform) as unknown as {
    data: { proposal: { status: string; revision: { revisionId: string } } };
  };
  assert.equal(result.data.proposal.status, "published");
  assert.notEqual(result.data.proposal.revision.revisionId, f.proposal.revisionId);
  assert.equal((await createSpecAssurancePackStore(W, W, f.state).current("onboarding"))?.revision.revisionId,
    result.data.proposal.revision.revisionId);
  const nextBaseline = { ...f.baseline, revisionId: "baseline-followup-2", createdAt: "2026-11-05T00:00:00.000Z" };
  await createDesignBaselineStore(W, W, f.state).publish({ expectedBaseRevisionId: f.baseline.revisionId, revision: nextBaseline });
  const nextProposal = await proposeSpecAssurancePack({ ...changed,
    expectedBaseRevisionId: result.data.proposal.revision.revisionId }, f.main, f.platform) as unknown as {
    data: { proposal: { status: string; revision: { revisionId: string } } };
  };
  assert.equal(nextProposal.data.proposal.status, "published");
  assert.notEqual(nextProposal.data.proposal.revision.revisionId, result.data.proposal.revision.revisionId);
});

test("confirmation action accepts only exact displayed revision pins", () => {
  assert.deepEqual(CONFIRM_CURRENT_BASELINE_SPEC_ASSURANCE_PACK_ACTION.parametersSchema.required,
    ["projectId", "packId", "expectedProposalRevisionId", "expectedBaselineRevisionId", "expectedApprovalRevisionId"]);
  assert.equal(CONFIRM_CURRENT_BASELINE_SPEC_ASSURANCE_PACK_ACTION.parametersSchema.additionalProperties, false);
  const schema = SPEC_ASSURANCE_PACK_PROPOSAL_TOOL.parametersSchema as unknown as { properties: { designModel: {
    required: string[]; properties: { coverageRules: { items: { required: string[] } } } } } };
  const model = schema.properties.designModel;
  assert.deepEqual(model.required, ["facts", "rulesVersion", "coverageRules", "coverageTargets", "scenarios", "itemDecisions", "acceptanceCriteria"]);
  assert.deepEqual(model.properties.coverageRules.items.required, ["id", "requiresCheck", "requiredEvidenceKinds"]);
});

test("registered current-Baseline review reads exact pins and reuses the authenticated confirmation without changing Baseline", async () => {
  const f = await propose();
  const contract = createBuilderPlatform();
  const read = contract.data.find(item => item.key === "builder.current-baseline-spec-assurance-pack")?.handler;
  const confirm = contract.actions.find(item => item.key === "builder.confirm-current-baseline-spec-assurance-pack")?.handler;
  assert.ok(read, "Current-Baseline review data must be registered");
  assert.ok(confirm, "The existing confirmation must be registered");
  assert.equal((await read({ companyId: W, projectId: W }, f.platform) as any).status, "empty");
  const before = await read({ companyId: W, projectId: W, packId: "onboarding" }, f.platform) as any;
  assert.equal(before.status, "ready");
  assert.equal(before.data.current.revision.revisionId, f.proposal.revisionId);
  assert.equal(before.data.currentApproval, null);
  const input = { projectId: W, packId: "onboarding", expectedProposalRevisionId: f.proposal.revisionId,
    expectedBaselineRevisionId: f.baseline.revisionId, expectedApprovalRevisionId: null };
  await assert.rejects(async () => await confirm(input, { ...f.userAction, actor: { type: "agent", companyId: W, agentId: A } } as never));
  await assert.rejects(async () => await read({ companyId: W, projectId: "22222222-2222-4222-8222-222222222222", packId: "onboarding" }, f.platform));
  const result = await confirm(input, f.userAction as never) as any;
  assert.equal(result.status, "published");
  const after = await read({ companyId: W, projectId: W, packId: "onboarding" }, f.platform) as any;
  assert.equal(after.data.currentApproval.revision.proposalRevisionId, f.proposal.revisionId);
  const baseline = await createDesignBaselineStore(W, W, f.state).current();
  assert.equal(baseline?.revision.revisionId, f.baseline.revisionId);
  assert.equal(baseline?.sequence, 1);
});
