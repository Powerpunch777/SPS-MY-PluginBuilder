import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsActionContext, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createDesignDraftStore, type AuthoredDesignDraft } from "../../src/design-draft-store.ts";
import { createDesignBaselineStore } from "../../src/design-baseline-tools.ts";
import { createEmptyBuilderSnapshot } from "../../src/domain/snapshot.ts";
import type { RevisionState } from "../../src/solution-revision-store.ts";
import { approveFirstDesignReview, assertCurrentFirstDesignApproval, proposeFirstDesignReview,
  readFirstDesignApprovalBinding, readFirstDesignApprovalRevision, readFirstDesignReviewBundle,
  readFirstDesignReviewRevision } from "../../src/spec-assurance/review-first-design.ts";
import { createCurrentBaselineAssuranceProvider } from "../../src/spec-assurance/current-baseline-provider.ts";
import { createSpecAssuranceConsumer } from "../../src/spec-assurance/evaluator.ts";
import { PROPOSE_FIRST_DESIGN_REVIEW_TOOL } from "../../src/spec-assurance/tool-declarations.mjs";
import { createBuilderPlatform } from "../../src/platform.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = WORKSPACE;
const AGENT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const TURN = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";
const SOURCE_ID = `lead-turn:${TURN}`;
const SOURCE_TEXT = "Original user request for the initial design.";
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const keyOf = (key: SpsStateKey) => JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);

function fixture(actor: { type: "user" | "agent" | "system"; companyId: string; userId?: string | null } = { type: "user", companyId: WORKSPACE, userId: "user-17" },
  source = { id: SOURCE_ID, text: SOURCE_TEXT }) {
  const values = new Map<string, JsonValue>();
  const state: RevisionState = {
    async get(key) { return structuredClone(values.get(keyOf(key)) ?? null); },
    async compareAndSet(key, expected, value) {
      const id = keyOf(key), exists = values.has(id), old = values.get(id);
      const match = expected.exists ? exists && JSON.stringify(old) === JSON.stringify(expected.value) : !exists;
      if (match) values.set(id, structuredClone(value));
      return { swapped: match };
    },
  };
  const put = (stateKey: string, value: JsonValue) => values.set(keyOf({ scopeKind: "company", scopeId: WORKSPACE,
    namespace: "sonpark.my-builder", stateKey }), structuredClone(value));
  put("lead-agent.v1", { workspaceId: WORKSPACE, revision: 1, selectedAgentId: AGENT });
  put("lead-sessions.v1.1", { workspaceId: WORKSPACE, selectionRevision: 1, agentId: AGENT,
    sessions: { main: SESSION, "ui-design": null, background: null, "cto-inbox": null, decisions: null, "integration-review": null } });
  if (source.id.startsWith("lead-turn:")) put(`lead-chat.turn.v1.${TURN}`, { workspaceId: WORKSPACE, selectionRevision: 1, agentId: AGENT, sessionId: SESSION,
    channel: "main", schemaVersion: 1, requestId: TURN, previousRequestId: null, sequence: 0, text: source.text,
    createdAt: "2026-11-06T00:00:00.000Z", state: "submitted", runId: RUN, answer: null, outputState: "not_ready",
    cancellationRequested: false, termination: "not_applicable", inputKind: "user" });
  else {
    const snapshot = createEmptyBuilderSnapshot(WORKSPACE);
    snapshot.messages.push({ id: source.id, channel: "main", actorId: null, role: "user", text: source.text,
      createdAt: "2026-11-06T00:00:00.000Z", runId: null });
    put("snapshot.v1", snapshot as unknown as JsonValue);
  }
  const draft = { projectId: PROJECT, revisionId: "draft-v1", sourceIds: [source.id],
    specification: { revisionId: "spec-v1", productTier: "M" as const, requirements: [{ id: "REQ-1", description: "Keep onboarding clear.", acceptanceCriteriaIds: ["AC-1"] }],
      targets: ["sps-plugin" as const], dataPolicyRef: "policy-v1" },
    graph: { graphRevisionId: "graph-v1", entities: [], relations: [], viewLayoutRef: "layout-v1" }, questions: [] };
  const authored: AuthoredDesignDraft = { status: "draft", selectionRevision: 1,
    author: { agentId: AGENT, sessionId: SESSION, runId: RUN }, sourceDigests: [{ id: source.id, sha256: digest(source.text) }],
    createdAt: "2026-11-06T00:00:01.000Z", draft };
  const drafts = createDesignDraftStore(WORKSPACE, PROJECT, { selectionRevision: 1, agentId: AGENT }, state);
  const published = drafts.publish({ expectedBaseRevisionId: null, revision: authored });
  const platform = { state, agents: {} } as unknown as SpsPlatformInvocationContext;
  const runContext = { companyId: WORKSPACE, agentId: AGENT, sessionId: SESSION, runId: RUN };
  const context = { ...platform, companyId: WORKSPACE, actor } as unknown as SpsActionContext;
  const pack = { packId: "onboarding", version: "1.0.0",
    applicability: {}, rules: [{ id: "onboarding-clear", requirementIds: ["REQ-1"], appliesWhen: {}, requiresCheck: true }],
    transitions: [], exceptions: [], excludedCombinations: [] };
  const params = { projectId: PROJECT, expectedDraftRevisionId: "draft-v1", expectedReviewHeadRevisionId: null,
    pack, sourcePins: [{ requirementId: "REQ-1", acId: "AC-1", sourceId: source.id }] };
  return { values, state, put, drafts, published, context, platform, runContext, params, pack, source };
}

function storeAdditionalConsultationSource(f: ReturnType<typeof fixture>, source: { id: string; text: string }) {
  const snapshot = f.values.get(keyOf({ scopeKind: "company", scopeId: WORKSPACE,
    namespace: "sonpark.my-builder", stateKey: "snapshot.v1" })) as unknown as ReturnType<typeof createEmptyBuilderSnapshot>
    | undefined ?? createEmptyBuilderSnapshot(WORKSPACE);
  snapshot.messages.push({ id: source.id, channel: "main", actorId: null, role: "user", text: source.text,
    createdAt: "2026-11-07T00:00:00.000Z", runId: null });
  f.put("snapshot.v1", snapshot as unknown as JsonValue);
}

function modelProposal(f: ReturnType<typeof fixture>) {
  return { ...f.params,
    pack: { ...f.pack, applicability: { all: ["design.onboarding"] },
      rules: [{ ...f.pack.rules[0]!, modelCases: [{ when: {}, state: "new", event: "open", allowedNextStates: ["ready"] }] }],
      transitions: [{ from: "new", event: "open", to: "ready" }] },
    sourcePins: [{ requirementId: "REQ-1", acId: null, sourceId: f.source.id }, ...f.params.sourcePins],
    designModel: { facts: ["design.onboarding"], rulesVersion: "reviewed-v1",
      coverageRules: [{ id: "onboarding-clear", requiresCheck: true, requiredEvidenceKinds: ["specification", "source"] }],
      coverageTargets: [{ targetKind: "requirement", targetId: "REQ-1", ruleIds: ["onboarding-clear"] },
        { targetKind: "ac", targetId: "AC-1", ruleIds: ["onboarding-clear"] }],
      scenarios: [{ id: "scenario-open", state: "new", event: "open", nextState: "ready", exceptionId: null }],
      itemDecisions: [{ requirementId: "REQ-1", status: "RESOLVED", reason: "Exact user-reviewed requirement.", sourceIds: [f.source.id] }],
      acceptanceCriteria: [{ requirementId: "REQ-1", acId: "AC-1", sourceId: f.source.id, quote: f.source.text }] } };
}

async function publishTestBaseline(f: ReturnType<typeof fixture>, revisionId = "baseline-v1") {
  return createDesignBaselineStore(WORKSPACE, PROJECT, f.state).publish({ expectedBaseRevisionId: null, revision: {
    projectId: PROJECT, revisionId, sourceDraftRevisionId: "draft-v1", draftDigest: "a".repeat(64),
    createdAt: "2026-11-06T00:00:02.000Z", author: { agentId: AGENT, sessionId: SESSION, runId: RUN, selectionRevision: 1 },
    userDecision: { sourceId: SOURCE_ID, sourceSha256: digest(SOURCE_TEXT), interpretation: "Keep onboarding clear." },
    specification: { projectId: PROJECT, revisionId: `spec-${revisionId}`, productTier: "M",
      requirements: [{ id: "REQ-1", description: "Keep onboarding clear.", acceptanceCriteriaIds: ["AC-1"] }],
      targets: ["sps-plugin"], dataPolicyRef: "policy-v1", approvalEvidenceRef: SOURCE_ID },
    graph: { approvedSpecRevisionId: `spec-${revisionId}`, graphRevisionId: `graph-${revisionId}`,
      entities: [], relations: [], viewLayoutRef: "layout-v1" },
  } });
}

const consultationClassification = (sourceId: string) => ({ sourceId, classification: "clarification" as const,
  rationale: "Main records how this exact consultation source relates to the pinned Baseline." });

test("exact approved design-model inputs produce static checks, not runtime QA, and caller scenarios cannot replace them", async () => {
  const f = fixture(); await f.published;
  const proposal = await proposeFirstDesignReview(modelProposal(f), f.runContext, f.platform);
  if (!proposal.revision) throw new Error("Model proposal was not published.");
  const approved = await approveFirstDesignReview({ projectId: PROJECT, expectedBundleRevisionId: proposal.revision.revisionId }, f.context);
  if (!("revision" in approved)) throw new Error("Exact model approval was not published.");
  const bundle = approved.revision;
  assert(bundle.designModel);
  assert.equal(bundle.designModel.acceptanceCriteria[0]?.textSha256, digest(f.source.text));
  const binding = await assertCurrentFirstDesignApproval({ projectId: PROJECT, approvedRevisionId: bundle.revisionId }, f.runContext, f.platform);
  assert(binding);
  const spec = { ...bundle.draft.specification, projectId: PROJECT, revisionId: "published-model-spec",
    approvalEvidenceRef: binding.reviewReference };
  const published = await createDesignBaselineStore(WORKSPACE, PROJECT, f.state).publish({ expectedBaseRevisionId: null,
    revision: { projectId: PROJECT, revisionId: "published-model-baseline", sourceDraftRevisionId: bundle.draftRevisionId,
      draftDigest: digest(JSON.stringify((await f.drafts.current())!.revision)), createdAt: "2026-11-06T00:02:00.000Z",
      author: { agentId: AGENT, sessionId: SESSION, runId: RUN, selectionRevision: 1 },
      userDecision: { sourceId: binding.reviewReference, sourceSha256: binding.bundleDigest, interpretation: "Exact model and design approved." },
      specification: spec, graph: { ...bundle.draft.graph, approvedSpecRevisionId: spec.revisionId } } });
  assert.equal(published.status, "published");
  const sessions = { workspaceId: WORKSPACE, selectionRevision: 1, agentId: AGENT,
    sessions: { main: SESSION, "ui-design": null, background: null, "cto-inbox": null, decisions: null, "integration-review": null } };
  const provider = createCurrentBaselineAssuranceProvider({ workspaceId: WORKSPACE, projectId: PROJECT, sessions, platform: f.platform });
  const currentBaseline = await createDesignBaselineStore(WORKSPACE, PROJECT, f.state).current();
  assert(currentBaseline);
  const identity = { workspaceId: WORKSPACE, projectId: PROJECT, specRevisionId: spec.revisionId,
    specDigest: digest(JSON.stringify(currentBaseline.revision.specification)) };
  const loaded = await provider({ identity, requirementIds: ["REQ-1"] });
  assert(loaded?.coverageInput.manifest);
  assert.deepEqual(loaded.scenarios, bundle.designModel.scenarios);
  assert.equal(loaded.coverageInput.checks.every(item => item.status === "passed"), true);
  const result = await createSpecAssuranceConsumer(provider)({ identity, scope: { requirementIds: ["REQ-1"] },
    facts: ["caller-forged-condition"], packs: [],
    scenarios: [{ id: "caller-failure", state: "new", event: "open", nextState: "wrong", exceptionId: null }] });
  assert.equal(result.coverageAuthority, "verified");
  assert.equal(result.status, "PASS");
  assert.equal(result.itemDecisions[0]?.status, "RESOLVED");
  assert.deepEqual(result.designModelEvidence, { kind: "design-model-v1", approvalRevisionId: bundle.revisionId,
    materialSha256: digest(JSON.stringify(bundle.designModel)) });
  assert.deepEqual(result.scenarios.map(item => item.scenarioId), ["scenario-open"]);
  assert.equal(result.checkerResults[0]?.status, "PASS");
  assert.equal(result.gaps.some(item => item.ruleId === "item-decision-status"), false);
  const inspect = createBuilderPlatform().tools.find(tool => tool.name === "builder.inspect-spec-assurance");
  assert(inspect);
  const before = structuredClone(f.values);
  const inspected = await inspect.handler({ projectId: PROJECT }, f.runContext, f.platform) as unknown as {
    data: { result: typeof result };
  };
  assert.equal(inspected.data.result.status, "PASS");
  assert.equal(inspected.data.result.itemDecisions[0]?.status, "RESOLVED");
  assert.deepEqual(f.values, before, "static inspection must not publish completion, QA, permission, or a new revision");
});

test("design-model changes create a different proposal and invalid AC quotes never enter the review journal", async () => {
  const f = fixture(); await f.published;
  const input = modelProposal(f);
  await assert.rejects(proposeFirstDesignReview({ ...input, designModel: { ...input.designModel,
    acceptanceCriteria: [{ ...input.designModel.acceptanceCriteria[0]!, quote: "This text is not in the source." }] } },
  f.runContext, f.platform), /exact pinned original-source quote/);
  assert.equal(await readFirstDesignReviewBundle(WORKSPACE, PROJECT, f.state), null);
  const first = await proposeFirstDesignReview(input, f.runContext, f.platform);
  if (!first.revision) throw new Error("First model proposal was not published.");
  const changed = await proposeFirstDesignReview({ ...input, expectedReviewHeadRevisionId: first.revision.revisionId,
    designModel: { ...input.designModel, itemDecisions: [{ ...input.designModel.itemDecisions[0]!, status: "UNDECIDED" }] } },
  f.runContext, f.platform);
  if (!changed.revision) throw new Error("Changed model proposal was not published.");
  assert.notEqual(first.revision.revisionId, changed.revision.revisionId);
  await assert.rejects(proposeFirstDesignReview({ ...input, designModel: { ...input.designModel,
    coverageTargets: [{ targetKind: "requirement", targetId: "forged-requirement", ruleIds: [] }] } }, f.runContext, f.platform),
  /exact in-scope/);
});

test("authenticated first-design flow stores proposal and exact-user attestation before any Baseline", async () => {
  const f = fixture();
  await f.published;
  const proposal = await proposeFirstDesignReview(f.params, f.runContext, f.platform);
  if (!("revision" in proposal) || !proposal.revision) throw new Error("Proposal revision was not published.");
  assert.equal(proposal.status, "published");
  assert.equal(proposal.revision.status, "PROPOSED");
  assert.equal(proposal.revision.author.agentId, AGENT);
  assert.equal(proposal.revision.author.sessionId, SESSION);
  assert.equal(proposal.revision.author.runId, RUN);
  assert.equal(proposal.revision.author.selectionRevision, 1);
  assert.equal(proposal.revision.priorBaseline, null);
  assert.equal(proposal.revision.draftDigest, digest(JSON.stringify(proposal.revision.draft)));
  assert.deepEqual(proposal.revision.sourcePins, [{ requirementId: "REQ-1", acId: "AC-1", sourceId: SOURCE_ID, sourceDigest: digest(SOURCE_TEXT) }]);
  assert.equal(proposal.revision.pack.version, "1.0.0");
  assert.deepEqual(proposal.revision.pack.identity, { workspaceId: WORKSPACE, projectId: PROJECT,
    specRevisionId: "spec-v1", specDigest: digest(JSON.stringify(proposal.revision.draft.specification)) });

  const approved = await approveFirstDesignReview({ projectId: PROJECT, expectedBundleRevisionId: proposal.revision.revisionId }, f.context);
  assert.equal(approved.status, "published");
  assert.equal(approved.revision.status, "APPROVED");
  assert.deepEqual(approved.revision.approval, { userId: "user-17", approvedAt: approved.revision.approval?.approvedAt,
    attestedBundleRevisionId: proposal.revision.revisionId });
  const binding = await readFirstDesignApprovalBinding(WORKSPACE, PROJECT, f.state);
  assert.equal(binding?.draftRevisionId, "draft-v1");
  assert.equal(binding?.packVersion, "1.0.0");
  assert.equal(binding?.attestedBundleRevisionId, proposal.revision.revisionId);
  const currentBinding = await assertCurrentFirstDesignApproval({ projectId: PROJECT, approvedRevisionId: approved.revision.revisionId },
    f.runContext, f.platform);
  assert.equal(currentBinding?.reviewReference, "first-design-review:" + approved.revision.revisionId);
  assert.equal(currentBinding?.bundleDigest, digest(JSON.stringify(approved.revision)));
  assert.equal((await readFirstDesignApprovalRevision(WORKSPACE, PROJECT, approved.revision.revisionId, f.state))?.status, "APPROVED");
  assert.equal((await readFirstDesignReviewRevision(WORKSPACE, PROJECT, proposal.revision.revisionId, f.state))?.status, "PROPOSED");
  assert.equal(await readFirstDesignApprovalRevision(WORKSPACE, PROJECT, proposal.revision.revisionId, f.state), null);
});

test("Main proposal derives pack identity, pins the exact Draft, and requires an observed review-head CAS", async () => {
  const f = fixture();
  await f.published;
  const staleDraft = await proposeFirstDesignReview({ ...f.params, expectedDraftRevisionId: "draft-old" }, f.runContext, f.platform);
  assert.deepEqual(staleDraft, { status: "conflict", actualDraftRevisionId: "draft-v1", content: "DesignDraft changed; refresh before proposing." });

  const first = await proposeFirstDesignReview(f.params, f.runContext, f.platform);
  if (!("revision" in first) || !first.revision) throw new Error("Initial review proposal was not published.");
  assert.equal(first.status, "published");
  const replay = await proposeFirstDesignReview(f.params, f.runContext, f.platform);
  assert.equal(replay.status, "replayed");
  const corrected = await proposeFirstDesignReview({ ...f.params, expectedReviewHeadRevisionId: first.revision.revisionId,
    pack: { ...f.pack, version: "1.0.1" } }, f.runContext, f.platform);
  if (!("revision" in corrected) || !corrected.revision) throw new Error("Corrected review proposal was not published.");
  assert.equal(corrected.status, "published");
  assert.notEqual(corrected.revision.revisionId, first.revision.revisionId);
  assert.equal((await readFirstDesignReviewRevision(WORKSPACE, PROJECT, first.revision.revisionId, f.state))?.revisionId,
    first.revision.revisionId);
  const staleHead = await proposeFirstDesignReview({ ...f.params, expectedReviewHeadRevisionId: first.revision.revisionId,
    pack: { ...f.pack, version: "1.0.2" } }, f.runContext, f.platform);
  assert.deepEqual(staleHead, { status: "conflict", actualReviewHeadRevisionId: corrected.revision.revisionId,
    actualDraftRevisionId: "draft-v1", content: "Review head changed; refresh before proposing. No revision was overwritten." });
});

test("proposal requires the active Main run and user claims cannot enter the AI proposal", async () => {
  const activeMain = fixture({ type: "agent", companyId: WORKSPACE, userId: null });
  activeMain.put("lead-sessions.v1.1", { workspaceId: WORKSPACE, selectionRevision: 1, agentId: AGENT,
    sessions: { main: null, "ui-design": null, background: null, "cto-inbox": null, decisions: null,
      "integration-review": SESSION } });
  await assert.rejects(proposeFirstDesignReview(activeMain.params, activeMain.runContext, activeMain.platform), /Only the Main Lead context/);
  await assert.rejects(proposeFirstDesignReview({ ...activeMain.params,
    consultationClassifications: [consultationClassification("consultation-55555555-5555-4555-8555-555555555555")] },
  activeMain.runContext, activeMain.platform), /Only the Main Lead context/);
  const noMain = fixture();
  await assert.rejects(proposeFirstDesignReview(noMain.params, { ...noMain.runContext,
    sessionId: "77777777-7777-4777-8777-777777777777" }, noMain.platform), /prepared current Lead session/);
  const agentAction = fixture({ type: "agent", companyId: WORKSPACE, userId: "forged" });
  await assert.rejects(approveFirstDesignReview({ projectId: PROJECT, expectedBundleRevisionId: "anything", userId: "forged" }, agentAction.context), /authenticated Builder user/);
  const f = fixture();
  await assert.rejects(proposeFirstDesignReview({ ...f.params, userId: "attacker" }, f.runContext, f.platform), /Invalid Builder tool fields/);
  await assert.rejects(proposeFirstDesignReview(f.params, { ...f.runContext, projectId: "77777777-7777-4777-8777-777777777777" }, f.platform), /single-project Workspace/);
});

test("AI proposal reader verifies captured consultation user text through the Workspace snapshot", async () => {
  const source = { id: "consultation-55555555-5555-4555-8555-555555555555", text: "Captured consultation text from the user." };
  const f = fixture(undefined, source);
  await f.published;
  const proposal = await proposeFirstDesignReview(f.params, f.runContext, f.platform);
  if (!("revision" in proposal) || !proposal.revision) throw new Error("Proposal revision was not published.");
  assert.equal(proposal.revision.sourcePins[0]?.sourceId, source.id);
  assert.equal(proposal.revision.sourcePins[0]?.sourceDigest, digest(source.text));
});

test("approval rejects stale Draft revisions and changed source bytes", async () => {
  const f = fixture();
  await f.published;
  const proposal = await proposeFirstDesignReview(f.params, f.runContext, f.platform);
  if (!("revision" in proposal) || !proposal.revision) throw new Error("Proposal revision was not published.");
  f.put(`lead-chat.turn.v1.${TURN}`, { workspaceId: WORKSPACE, selectionRevision: 1, agentId: AGENT, sessionId: SESSION,
    channel: "main", schemaVersion: 1, requestId: TURN, previousRequestId: null, sequence: 0, text: "changed source",
    createdAt: "2026-11-06T00:00:00.000Z", state: "submitted", runId: RUN, answer: null, outputState: "not_ready",
    cancellationRequested: false, termination: "not_applicable", inputKind: "user" });
  await assert.rejects(approveFirstDesignReview({ projectId: PROJECT, expectedBundleRevisionId: proposal.revision.revisionId }, f.context), /source bytes/);
});

test("approval re-reads captured consultation text instead of trusting its stored Draft digest", async () => {
  const source = { id: "consultation-55555555-5555-4555-8555-555555555555", text: "Captured consultation text from the user." };
  const f = fixture(undefined, source);
  await f.published;
  const proposal = await proposeFirstDesignReview(f.params, f.runContext, f.platform);
  if (!("revision" in proposal) || !proposal.revision) throw new Error("Proposal revision was not published.");
  const snapshot = f.values.get(keyOf({ scopeKind: "company", scopeId: WORKSPACE, namespace: "sonpark.my-builder", stateKey: "snapshot.v1" })) as unknown as ReturnType<typeof createEmptyBuilderSnapshot>;
  snapshot.messages[0]!.text = "Changed consultation text.";
  f.put("snapshot.v1", snapshot as unknown as JsonValue);
  await assert.rejects(approveFirstDesignReview({ projectId: PROJECT, expectedBundleRevisionId: proposal.revision.revisionId }, f.context), /source bytes/);
});

test("review action rejects incomplete pins and unbound pack versions", async () => {
  const f = fixture();
  await f.published;
  const bad = { ...f.params, pack: { ...f.pack, version: "2.0.0", requirementIdentity: "caller-claim" } };
  await assert.rejects(proposeFirstDesignReview(bad, f.runContext, f.platform), /Invalid Builder tool fields/);
  const noPins = { ...f.params, sourcePins: [] };
  await assert.rejects(proposeFirstDesignReview(noPins, f.runContext, f.platform), /Requirement-to-original-source pins are required/);
  const sparse = { ...f.params, sourcePins: new Array(1) };
  await assert.rejects(proposeFirstDesignReview(sparse, f.runContext, f.platform), /dense list/);
});

test("approval requires the current exact proposal revision and never auto-retries stale IDs", async () => {
  const f = fixture();
  await f.published;
  const proposal = await proposeFirstDesignReview(f.params, f.runContext, f.platform);
  const stale = await approveFirstDesignReview({ projectId: PROJECT, expectedBundleRevisionId: "first-review-stale" }, f.context);
  assert.deepEqual(stale, { status: "conflict" });
  assert.equal((await readFirstDesignReviewBundle(WORKSPACE, PROJECT, f.state))?.status, "PROPOSED");
  assert.equal(proposal.status, "published");
});

test("the same review journal proposes and approves follow-up bundles pinned to the exact prior Baseline", async () => {
  const f = fixture();
  await f.published;
  const baseline = createDesignBaselineStore(WORKSPACE, PROJECT, f.state);
  const first = await baseline.publish({ expectedBaseRevisionId: null, revision: {
    projectId: PROJECT, revisionId: "baseline-v1", sourceDraftRevisionId: "draft-v1", draftDigest: "a".repeat(64),
    createdAt: "2026-11-06T00:00:02.000Z", author: { agentId: AGENT, sessionId: SESSION, runId: RUN, selectionRevision: 1 },
    userDecision: { sourceId: SOURCE_ID, sourceSha256: digest(SOURCE_TEXT), interpretation: "Keep onboarding clear." },
    specification: { projectId: PROJECT, revisionId: "spec-v1", productTier: "M",
      requirements: [{ id: "REQ-1", description: "Keep onboarding clear.", acceptanceCriteriaIds: ["AC-1"] }],
      targets: ["sps-plugin"], dataPolicyRef: "policy-v1", approvalEvidenceRef: SOURCE_ID },
    graph: { approvedSpecRevisionId: "spec-v1", graphRevisionId: "graph-v1", entities: [], relations: [], viewLayoutRef: "layout-v1" },
  } });
  assert.equal(first.status, "published");
  const proposal = await proposeFirstDesignReview(f.params, f.runContext, f.platform);
  assert.equal(proposal.status, "published");
  if (proposal.status !== "published") throw new Error("Follow-up review proposal was not published.");
  const impact = proposal.revision.followUpImpact;
  assert(impact, "new follow-up proposals bind a server-derived pre-approval impact projection");
  assert.equal(impact.sourceIdentity.priorBaselineRevisionId, first.revision.revisionId);
  assert.equal(impact.sourceIdentity.pendingDraftRevisionId, proposal.revision.draftRevisionId);
  assert.equal(impact.overallStatus, "UNKNOWN");
  assert.equal(impact.dimensions.requirements.status, "NO_CANDIDATE_OBSERVED");
  assert.equal(impact.dimensions.graph.status, "NO_CANDIDATE_OBSERVED");
  for (const dimension of ["ui", "technology", "ctoWorkstreams", "tasks", "scheduleProductScope"] as const) {
    assert.equal(impact.dimensions[dimension].status, "UNKNOWN");
  }
  assert.equal(impact.approvalCreated, false);
  assert.equal(impact.baselinePublished, false);
  assert.equal(impact.executionAuthorized, false);
  assert.deepEqual(await readFirstDesignReviewBundle(WORKSPACE, PROJECT, f.state).then(bundle => bundle?.followUpImpact), impact);
  await assert.rejects(proposeFirstDesignReview({ ...f.params, followUpImpact: impact }, f.runContext, f.platform),
    /Invalid Builder tool fields/u);
  assert.deepEqual(proposal.revision.priorBaseline, { revisionId: first.revision.revisionId, sequence: first.sequence,
    digest: digest(JSON.stringify(first.revision)) });
  const approved = await approveFirstDesignReview({ projectId: PROJECT,
    expectedBundleRevisionId: proposal.revision.revisionId }, f.context);
  if (approved.status !== "published") throw new Error("Follow-up review approval was not published.");
  assert.equal(approved.revision.priorBaseline?.revisionId, first.revision.revisionId);
  assert.deepEqual(approved.revision.followUpImpact, impact, "approval attests to the exact stored comparison projection");
  assert.deepEqual((await readFirstDesignApprovalBinding(WORKSPACE, PROJECT, f.state))?.bundle.followUpImpact, impact);
});

test("follow-up review approval conflicts if its observed prior Baseline changes", async () => {
  const f = fixture();
  await f.published;
  const baseline = createDesignBaselineStore(WORKSPACE, PROJECT, f.state);
  const first = await baseline.publish({ expectedBaseRevisionId: null, revision: {
    projectId: PROJECT, revisionId: "baseline-old", sourceDraftRevisionId: "draft-v1", draftDigest: "a".repeat(64),
    createdAt: "2026-11-06T00:00:02.000Z", author: { agentId: AGENT, sessionId: SESSION, runId: RUN, selectionRevision: 1 },
    userDecision: { sourceId: SOURCE_ID, sourceSha256: digest(SOURCE_TEXT), interpretation: "Old baseline." },
    specification: { projectId: PROJECT, revisionId: "spec-old", productTier: "M",
      requirements: [{ id: "REQ-1", description: "Keep onboarding clear.", acceptanceCriteriaIds: ["AC-1"] }],
      targets: ["sps-plugin"], dataPolicyRef: "policy-v1", approvalEvidenceRef: SOURCE_ID },
    graph: { approvedSpecRevisionId: "spec-old", graphRevisionId: "graph-old", entities: [], relations: [], viewLayoutRef: "layout-v1" },
  } });
  if (first.status !== "published") throw new Error("Initial test Baseline was not published.");
  const proposal = await proposeFirstDesignReview(f.params, f.runContext, f.platform);
  if (proposal.status !== "published") throw new Error("Follow-up review proposal was not published.");
  await baseline.publish({ expectedBaseRevisionId: first.revision.revisionId, revision: {
    ...first.revision, revisionId: "baseline-new", specification: { ...first.revision.specification, revisionId: "spec-new",
      approvalEvidenceRef: SOURCE_ID }, graph: { ...first.revision.graph, approvedSpecRevisionId: "spec-new", graphRevisionId: "graph-new" },
  } });
  assert.deepEqual(await approveFirstDesignReview({ projectId: PROJECT,
    expectedBundleRevisionId: proposal.revision.revisionId }, f.context), { status: "conflict" });
});

test("follow-up report readers suppress the projection when the current exact Draft drifts", async () => {
  const f = fixture();
  await f.published;
  await publishTestBaseline(f);
  const proposal = await proposeFirstDesignReview(f.params, f.runContext, f.platform);
  if (proposal.status !== "published") throw new Error("Follow-up review proposal was not published.");
  assert((await readFirstDesignReviewBundle(WORKSPACE, PROJECT, f.state))?.followUpImpact);

  const current = await f.drafts.current();
  assert(current);
  const nextDraft = { ...current.revision, draft: { ...current.revision.draft,
    revisionId: "draft-v2", specification: { ...current.revision.draft.specification, revisionId: "spec-v2",
      requirements: [{ ...current.revision.draft.specification.requirements[0]!, description: "Changed after review proposal." }] },
    graph: { ...current.revision.draft.graph, graphRevisionId: "graph-v2" } } };
  const changed = await f.drafts.publish({ expectedBaseRevisionId: current.revision.draft.revisionId, revision: nextDraft });
  assert.equal(changed.status, "published");
  assert.equal(await readFirstDesignReviewBundle(WORKSPACE, PROJECT, f.state), null);
  assert.equal(await readFirstDesignApprovalBinding(WORKSPACE, PROJECT, f.state), null);
  assert.deepEqual(await approveFirstDesignReview({ projectId: PROJECT,
    expectedBundleRevisionId: proposal.revision.revisionId }, f.context), { status: "conflict" });
});

test("Main records a current consultation classification against the exact follow-up Baseline without changing it", async () => {
  const source = { id: "consultation-55555555-5555-4555-8555-555555555555", text: "A newly read Workspace consultation." };
  const f = fixture();
  await f.published;
  storeAdditionalConsultationSource(f, source);
  const baseline = await publishTestBaseline(f);
  assert.equal(baseline.status, "published");
  if (baseline.status !== "published") throw new Error("Test Baseline was not published.");

  const proposal = await proposeFirstDesignReview({ ...f.params,
    consultationClassifications: [consultationClassification(source.id)] }, f.runContext, f.platform);
  assert.equal(proposal.status, "published");
  if (proposal.status !== "published") throw new Error("Consultation classification proposal was not published.");
  const recorded = proposal.revision.consultationClassifications?.[0];
  assert.deepEqual(recorded, { ...consultationClassification(source.id), sourceDigest: digest(source.text) });
  assert.deepEqual(Object.keys(recorded ?? {}).sort(), ["classification", "rationale", "sourceDigest", "sourceId"]);
  assert.equal(proposal.revision.priorBaseline?.revisionId, baseline.revision.revisionId);
  assert.equal(proposal.revision.status, "PROPOSED");
  assert.equal(proposal.revision.approval, undefined);
  assert.equal((await createDesignBaselineStore(WORKSPACE, PROJECT, f.state).current())?.revision.revisionId,
    baseline.revision.revisionId, "classification proposal must not publish or alter the Baseline");
});

test("consultation classification rejects initial Baseline, duplicate, missing, and foreign Workspace sources", async () => {
  const source = { id: "consultation-55555555-5555-4555-8555-555555555555", text: "Current Workspace consultation." };
  const initial = fixture();
  await initial.published;
  storeAdditionalConsultationSource(initial, source);
  await assert.rejects(proposeFirstDesignReview({ ...initial.params,
    consultationClassifications: [consultationClassification(source.id)] }, initial.runContext, initial.platform), /existing current Baseline/u);
  assert.equal(await readFirstDesignReviewBundle(WORKSPACE, PROJECT, initial.state), null);

  const f = fixture();
  await f.published;
  storeAdditionalConsultationSource(f, source);
  await publishTestBaseline(f);
  await assert.rejects(proposeFirstDesignReview({ ...f.params, consultationClassifications: [
    consultationClassification(source.id), consultationClassification(source.id),
  ] }, f.runContext, f.platform), /unique/u);
  await assert.rejects(proposeFirstDesignReview({ ...f.params,
    consultationClassifications: [consultationClassification("consultation-77777777-7777-4777-8777-777777777777")] },
  f.runContext, f.platform), /Original consultation source is unavailable in this Workspace/u);

  const snapshot = f.values.get(keyOf({ scopeKind: "company", scopeId: WORKSPACE, namespace: "sonpark.my-builder", stateKey: "snapshot.v1" })) as
    unknown as ReturnType<typeof createEmptyBuilderSnapshot>;
  snapshot.messages[0]!.channel = "ui-design";
  f.put("snapshot.v1", snapshot as unknown as JsonValue);
  await assert.rejects(proposeFirstDesignReview({ ...f.params,
    consultationClassifications: [consultationClassification(source.id)] }, f.runContext, f.platform), /Original consultation source is unavailable/u);
});

test("consultation source drift rejects approval and invalidates its prior approval binding", async () => {
  const source = { id: "consultation-55555555-5555-4555-8555-555555555555", text: "Pinned consultation source." };
  const f = fixture();
  await f.published;
  storeAdditionalConsultationSource(f, source);
  await publishTestBaseline(f);
  const proposal = await proposeFirstDesignReview({ ...f.params,
    consultationClassifications: [consultationClassification(source.id)] }, f.runContext, f.platform);
  if (proposal.status !== "published") throw new Error("Consultation classification proposal was not published.");
  const snapshot = f.values.get(keyOf({ scopeKind: "company", scopeId: WORKSPACE, namespace: "sonpark.my-builder", stateKey: "snapshot.v1" })) as
    unknown as ReturnType<typeof createEmptyBuilderSnapshot>;
  snapshot.messages[0]!.text = "Changed consultation source bytes.";
  f.put("snapshot.v1", snapshot as unknown as JsonValue);
  assert.deepEqual(await approveFirstDesignReview({ projectId: PROJECT,
    expectedBundleRevisionId: proposal.revision.revisionId }, f.context), { status: "conflict" });
  assert.equal((await readFirstDesignReviewBundle(WORKSPACE, PROJECT, f.state))?.status, "PROPOSED");
  snapshot.messages[0]!.text = source.text;
  f.put("snapshot.v1", snapshot as unknown as JsonValue);
  const approved = await approveFirstDesignReview({ projectId: PROJECT,
    expectedBundleRevisionId: proposal.revision.revisionId }, f.context);
  assert.equal(approved.status, "published");
  snapshot.messages[0]!.text = "Drift after the exact user attestation.";
  f.put("snapshot.v1", snapshot as unknown as JsonValue);
  assert.equal(await assertCurrentFirstDesignApproval({ projectId: PROJECT, approvedRevisionId: approved.revision.revisionId },
    f.runContext, f.platform), null);
});

test("tool schema exposes only bounded Main-authored follow-up classification fields", () => {
  const schema = PROPOSE_FIRST_DESIGN_REVIEW_TOOL.parametersSchema as unknown as { properties: Record<string, any> };
  assert.deepEqual(schema.properties.consultationClassifications.items.properties.classification.enum,
    ["clarification", "correction", "change-request"]);
  assert.equal(schema.properties.consultationClassifications.maxItems, 32);
  assert.equal(schema.properties.consultationClassifications.items.additionalProperties, false);
  assert.equal(schema.properties.consultationClassifications.items.properties.sourceDigest, undefined);
  assert.equal(schema.properties.consultationClassifications.items.properties.receivedAt, undefined);
});
