import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsActionContext, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { createDesignDraftStore, type AuthoredDesignDraft } from "../../src/design-draft-store.ts";
import { createDesignBaselineStore } from "../../src/design-baseline-tools.ts";
import { createEmptyBuilderSnapshot } from "../../src/domain/snapshot.ts";
import type { RevisionState } from "../../src/solution-revision-store.ts";
import { assertCurrentFirstDesignApproval, approveFirstDesignReview, proposeFirstDesignReview } from "../../src/spec-assurance/review-first-design.ts";
import { createCurrentBaselineAssuranceProvider } from "../../src/spec-assurance/current-baseline-provider.ts";
import { createSpecAssuranceConsumer } from "../../src/spec-assurance/evaluator.ts";
import { parseDesignModelMaterial } from "../../src/spec-assurance/design-model-material.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = WORKSPACE;
const AGENT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const TURN = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";
const SOURCE_ID = `lead-turn:${TURN}`;
const SOURCE_TEXT = "The original user request says onboarding must remain clear.";
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const keyOf = (key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) =>
  JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);

function codecFixture() {
  const identity = { workspaceId: WORKSPACE, projectId: PROJECT, specRevisionId: "spec-v1", specDigest: digest("spec") };
  const requirements = [{ id: "REQ-1", acceptanceCriteriaIds: ["AC-1"] }];
  const pack = { packId: "onboarding", version: "1.0.0", identity, applicability: {},
    rules: [{ id: "onboarding-clear", requirementIds: ["REQ-1"], appliesWhen: {}, requiresCheck: true }],
    transitions: [], exceptions: [], excludedCombinations: [] };
  const sourcePins = [
    { requirementId: "REQ-1", acId: null, sourceId: SOURCE_ID, sourceDigest: digest(SOURCE_TEXT) },
    { requirementId: "REQ-1", acId: "AC-1", sourceId: SOURCE_ID, sourceDigest: digest(SOURCE_TEXT) },
  ];
  const input = {
    facts: ["design.onboarding"], rulesVersion: "reviewed-v1",
    coverageRules: [{ id: "onboarding-clear", requiresCheck: true, requiredEvidenceKinds: ["specification", "source"] }],
    coverageTargets: [
      { targetKind: "requirement", targetId: "REQ-1", ruleIds: ["onboarding-clear"] },
      { targetKind: "ac", targetId: "AC-1", ruleIds: ["onboarding-clear"] },
    ],
    scenarios: [{ id: "scenario-open", state: "new", event: "open", nextState: "ready", exceptionId: null }],
    itemDecisions: [{ requirementId: "REQ-1", status: "RESOLVED", reason: "Pinned source supports this decision.", sourceIds: [SOURCE_ID] }],
    acceptanceCriteria: [{ requirementId: "REQ-1", acId: "AC-1", sourceId: SOURCE_ID, quote: SOURCE_TEXT }],
  };
  return { identity, requirements, pack, sourcePins, input, sourceBodies: new Map([[SOURCE_ID, SOURCE_TEXT]]) };
}

function reviewFixture() {
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
  put(`lead-chat.turn.v1.${TURN}`, { workspaceId: WORKSPACE, selectionRevision: 1, agentId: AGENT, sessionId: SESSION,
    channel: "main", schemaVersion: 1, requestId: TURN, previousRequestId: null, sequence: 0, text: SOURCE_TEXT,
    createdAt: "2026-11-06T00:00:00.000Z", state: "submitted", runId: RUN, answer: null, outputState: "not_ready",
    cancellationRequested: false, termination: "not_applicable", inputKind: "user" });
  const draft = { projectId: PROJECT, revisionId: "draft-v1", sourceIds: [SOURCE_ID],
    specification: { revisionId: "spec-v1", productTier: "M" as const,
      requirements: [{ id: "REQ-1", description: "Keep onboarding clear.", acceptanceCriteriaIds: ["AC-1"] }],
      targets: ["sps-plugin" as const], dataPolicyRef: "policy-v1" },
    graph: { graphRevisionId: "graph-v1", entities: [], relations: [], viewLayoutRef: "layout-v1" }, questions: [] };
  const authored: AuthoredDesignDraft = { status: "draft", selectionRevision: 1,
    author: { agentId: AGENT, sessionId: SESSION, runId: RUN }, sourceDigests: [{ id: SOURCE_ID, sha256: digest(SOURCE_TEXT) }],
    createdAt: "2026-11-06T00:00:01.000Z", draft };
  const drafts = createDesignDraftStore(WORKSPACE, PROJECT, { selectionRevision: 1, agentId: AGENT }, state);
  const published = drafts.publish({ expectedBaseRevisionId: null, revision: authored });
  const platform = { state, agents: {} } as unknown as SpsPlatformInvocationContext;
  const runContext = { companyId: WORKSPACE, agentId: AGENT, sessionId: SESSION, runId: RUN };
  const context = { ...platform, companyId: WORKSPACE, actor: { type: "user", companyId: WORKSPACE, userId: "user-17" } } as unknown as SpsActionContext;
  const pack = { packId: "onboarding", version: "1.0.0", applicability: {},
    rules: [{ id: "onboarding-clear", requirementIds: ["REQ-1"], appliesWhen: {}, requiresCheck: true }],
    transitions: [], exceptions: [], excludedCombinations: [] };
  const params = { projectId: PROJECT, expectedDraftRevisionId: "draft-v1", expectedReviewHeadRevisionId: null,
    pack, sourcePins: [{ requirementId: "REQ-1", acId: "AC-1", sourceId: SOURCE_ID }] };
  return { state, values, drafts, published, platform, context, runContext, pack, params };
}

test("independent QA: codec binds exact requirement, AC, rule, original source and caller-derived identity", () => {
  const f = codecFixture();
  const accepted = parseDesignModelMaterial(f.input, f.identity, f.requirements, f.pack, f.sourcePins, false, f.sourceBodies);
  assert.equal(accepted.acceptanceCriteria[0]?.text, SOURCE_TEXT);
  assert.equal(accepted.acceptanceCriteria[0]?.textSha256, digest(SOURCE_TEXT));

  const rejects = (input: unknown) => assert.throws(() => parseDesignModelMaterial(input, f.identity, f.requirements,
    f.pack, f.sourcePins, false, f.sourceBodies));
  rejects({ ...f.input, identity: f.identity });
  rejects({ ...f.input, coverageTargets: [{ targetKind: "requirement", targetId: "REQ-OTHER", ruleIds: ["onboarding-clear"] }] });
  rejects({ ...f.input, coverageTargets: [{ targetKind: "ac", targetId: "AC-OTHER", ruleIds: ["onboarding-clear"] }] });
  rejects({ ...f.input, coverageRules: [{ ...f.input.coverageRules[0], id: "rule-remapped" }] });
  rejects({ ...f.input, coverageTargets: [{ targetKind: "requirement", targetId: "REQ-1", ruleIds: ["rule-remapped"] }] });
  rejects({ ...f.input, coverageTargets: [{ targetKind: "requirement", targetId: "REQ-OUTSIDE", ruleIds: [] }] });
  rejects({ ...f.input, acceptanceCriteria: [{ ...f.input.acceptanceCriteria[0], quote: "Arbitrary caller-authored criterion." }] });
  rejects({ ...f.input, itemDecisions: [{ ...f.input.itemDecisions[0], sourceIds: [SOURCE_ID, SOURCE_ID] }] });
  rejects({ ...f.input, itemDecisions: [{ ...f.input.itemDecisions[0], sourceIds: ["unknown-source"] }] });
});

test("independent QA: current provider requires exact user approval and legacy model-less review remains UNKNOWN", async () => {
  const f = reviewFixture();
  await f.published;
  const proposal = await proposeFirstDesignReview(f.params, f.runContext, f.platform);
  if (!proposal.revision) throw new Error("Model-less review proposal was not published.");
  assert.equal(proposal.revision.status, "PROPOSED");
  assert.equal(proposal.revision.designModel, undefined);
  assert.equal(await assertCurrentFirstDesignApproval({ projectId: PROJECT, approvedRevisionId: proposal.revision.revisionId },
    f.runContext, f.platform), null, "a caller-visible proposal is not current approval");

  const approved = await approveFirstDesignReview({ projectId: PROJECT, expectedBundleRevisionId: proposal.revision.revisionId }, f.context);
  if (!("revision" in approved)) throw new Error("Exact user approval was not published.");
  const binding = await assertCurrentFirstDesignApproval({ projectId: PROJECT, approvedRevisionId: approved.revision.revisionId },
    f.runContext, f.platform);
  assert(binding);
  const spec = { ...approved.revision.draft.specification, projectId: PROJECT, revisionId: "baseline-spec-v1",
    approvalEvidenceRef: binding.reviewReference };
  const baseline = await createDesignBaselineStore(WORKSPACE, PROJECT, f.state).publish({ expectedBaseRevisionId: null,
    revision: { projectId: PROJECT, revisionId: "baseline-v1", sourceDraftRevisionId: approved.revision.draftRevisionId,
      draftDigest: digest(JSON.stringify((await f.drafts.current())!.revision)), createdAt: "2026-11-06T00:02:00.000Z",
      author: { agentId: AGENT, sessionId: SESSION, runId: RUN, selectionRevision: 1 },
      userDecision: { sourceId: binding.reviewReference, sourceSha256: binding.bundleDigest, interpretation: "User approved exact review." },
      specification: spec, graph: { ...approved.revision.draft.graph, approvedSpecRevisionId: spec.revisionId } } });
  assert.equal(baseline.status, "published");

  const sessions = { workspaceId: WORKSPACE, selectionRevision: 1, agentId: AGENT,
    sessions: { main: SESSION, "ui-design": null, background: null, "cto-inbox": null, decisions: null, "integration-review": null } };
  const provider = createCurrentBaselineAssuranceProvider({ workspaceId: WORKSPACE, projectId: PROJECT, sessions, platform: f.platform });
  const current = await createDesignBaselineStore(WORKSPACE, PROJECT, f.state).current();
  assert(current);
  const identity = { workspaceId: WORKSPACE, projectId: PROJECT, specRevisionId: spec.revisionId,
    specDigest: digest(JSON.stringify(current.revision.specification)) };
  const result = await createSpecAssuranceConsumer(provider)({ identity, scope: { requirementIds: ["REQ-1"] }, facts: [], packs: [], scenarios: [] });
  assert.equal(result.status, "UNKNOWN");
});
