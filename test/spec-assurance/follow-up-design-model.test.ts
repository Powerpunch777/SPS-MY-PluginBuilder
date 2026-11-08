import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createDesignDraftStore, type AuthoredDesignDraft } from "../../src/design-draft-store.ts";
import type { RevisionState } from "../../src/solution-revision-store.ts";
import { approveFirstDesignReview, assertCurrentFirstDesignApproval, proposeFirstDesignReview } from "../../src/spec-assurance/review-first-design.ts";
import { createBuilderPlatform } from "../../src/platform.ts";

const W = "11111111-1111-4111-8111-111111111111";
const AGENT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const TURN = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";
const SOURCE_ID = `lead-turn:${TURN}`;
const SOURCE_TEXT = "Original user request for the initial design.";
const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex");
const stateId = (key: SpsStateKey) => JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);

function fixture() {
  const values = new Map<string, JsonValue>();
  const state: RevisionState = {
    async get(key) { return structuredClone(values.get(stateId(key)) ?? null); },
    async compareAndSet(key, expected, value) {
      const id = stateId(key), exists = values.has(id), old = values.get(id);
      const match = expected.exists ? exists && JSON.stringify(old) === JSON.stringify(expected.value) : !exists;
      if (match) values.set(id, structuredClone(value));
      return { swapped: match };
    },
  };
  const put = (stateKey: string, value: JsonValue) => values.set(stateId({ scopeKind: "company", scopeId: W,
    namespace: "sonpark.my-builder", stateKey }), structuredClone(value));
  put("lead-agent.v1", { workspaceId: W, revision: 1, selectedAgentId: AGENT });
  put("lead-sessions.v1.1", { workspaceId: W, selectionRevision: 1, agentId: AGENT,
    sessions: { main: SESSION, "ui-design": null, background: null, "cto-inbox": null, decisions: null, "integration-review": null } });
  put(`lead-chat.turn.v1.${TURN}`, { workspaceId: W, selectionRevision: 1, agentId: AGENT, sessionId: SESSION,
    channel: "main", schemaVersion: 1, requestId: TURN, previousRequestId: null, sequence: 0, text: SOURCE_TEXT,
    createdAt: "2026-11-06T00:00:00.000Z", state: "submitted", runId: RUN, answer: null, outputState: "not_ready",
    cancellationRequested: false, termination: "not_applicable", inputKind: "user" });
  const makeDraft = (revisionId: string, specRevisionId: string, description: string) => ({ projectId: W, revisionId,
    sourceIds: [SOURCE_ID], specification: { revisionId: specRevisionId, productTier: "M" as const,
      requirements: [{ id: "REQ-1", description, acceptanceCriteriaIds: ["AC-1"] }], targets: ["sps-plugin" as const], dataPolicyRef: "policy-v1" },
    graph: { graphRevisionId: `graph-${revisionId}`, entities: [], relations: [], viewLayoutRef: `layout-${revisionId}` }, questions: [] });
  const authored = (draft: ReturnType<typeof makeDraft>): AuthoredDesignDraft => ({ status: "draft", selectionRevision: 1,
    author: { agentId: AGENT, sessionId: SESSION, runId: RUN }, sourceDigests: [{ id: SOURCE_ID, sha256: hash(SOURCE_TEXT) }],
    createdAt: "2026-11-06T00:00:01.000Z", draft });
  const drafts = createDesignDraftStore(W, W, { selectionRevision: 1, agentId: AGENT }, state);
  const firstDraft = makeDraft("draft-v1", "spec-v1", "Keep onboarding clear.");
  const firstAuthored = authored(firstDraft);
  const initialWrite = drafts.publish({ expectedBaseRevisionId: null, revision: firstAuthored });
  const platform = { state, agents: {} } as never;
  const runContext = { companyId: W, agentId: AGENT, sessionId: SESSION, runId: RUN };
  const userContext = { state, companyId: W, actor: { type: "user", companyId: W, userId: "user-reviewer" } } as never;
  const sessions = { workspaceId: W, selectionRevision: 1, agentId: AGENT,
    sessions: { main: SESSION, "ui-design": null, background: null, "cto-inbox": null, decisions: null, "integration-review": null } };
  return { values, state, put, drafts, firstDraft, firstAuthored, initialWrite, makeDraft, authored,
    platform, runContext, userContext, sessions };
}

function modelInput(f: ReturnType<typeof fixture>, draftRevisionId: string, reviewHead: string | null, version: "v1" | "v2") {
  const nextState = version === "v1" ? "ready" : "reviewed";
  const modelRulesVersion = version === "v1" ? "reviewed-v1" : "reviewed-v2";
  return { projectId: W, expectedDraftRevisionId: draftRevisionId, expectedReviewHeadRevisionId: reviewHead,
    pack: { packId: "onboarding", version: version === "v1" ? "1.0.0" : "2.0.0",
      applicability: { all: ["design.onboarding"] },
      rules: [{ id: "onboarding-clear", requirementIds: ["REQ-1"], appliesWhen: {}, requiresCheck: true,
        modelCases: [{ when: {}, state: "new", event: "open", allowedNextStates: [nextState] }] }],
      transitions: [{ from: "new", event: "open", to: nextState }], exceptions: [], excludedCombinations: [] },
    sourcePins: [{ requirementId: "REQ-1", acId: null, sourceId: SOURCE_ID },
      { requirementId: "REQ-1", acId: "AC-1", sourceId: SOURCE_ID }],
    designModel: { facts: ["design.onboarding"], rulesVersion: modelRulesVersion,
      coverageRules: [{ id: "onboarding-clear", requiresCheck: true, requiredEvidenceKinds: ["specification", "source"] }],
      coverageTargets: [{ targetKind: "requirement", targetId: "REQ-1", ruleIds: ["onboarding-clear"] },
        { targetKind: "ac", targetId: "AC-1", ruleIds: ["onboarding-clear"] }],
      scenarios: [{ id: version === "v1" ? "scenario-open" : "scenario-follow-up", state: "new", event: "open", nextState, exceptionId: null }],
      itemDecisions: [{ requirementId: "REQ-1", status: "RESOLVED", reason: version === "v1" ? "Initial reviewed design." : "Follow-up reviewed design.", sourceIds: [SOURCE_ID] }],
      acceptanceCriteria: [{ requirementId: "REQ-1", acId: "AC-1", sourceId: SOURCE_ID, quote: SOURCE_TEXT }] } };
}

async function publishBaseline(f: ReturnType<typeof fixture>, binding: Awaited<ReturnType<typeof assertCurrentFirstDesignApproval>>,
  revisionId: string, expectedBaseRevisionId: string | null) {
  assert(binding);
  const publish = createBuilderPlatform().tools.find(tool => tool.name === "builder.publish-design-baseline");
  assert(publish);
  const response = await publish.handler({ projectId: W, expectedBaseRevisionId,
    sourceDraftRevisionId: binding.bundle.draftRevisionId, revisionId, userSourceId: binding.reviewReference,
    interpretation: "Exact reviewed design published." }, f.runContext, f.platform) as { data?: { status?: string; revision?: unknown } };
  return response.data;
}

async function registeredInspect(f: ReturnType<typeof fixture>) {
  const inspect = createBuilderPlatform().tools.find(tool => tool.name === "builder.inspect-spec-assurance");
  assert(inspect);
  return inspect.handler({ projectId: W }, f.runContext, f.platform) as Promise<{ data: { result: {
    status: string; designModelEvidence?: { approvalRevisionId: string }; scenarios?: readonly { scenarioId: string }[];
    packVersions: readonly { packId: string; version: string }[];
    sourceEvidence: readonly { sourceId: string; sourceDigest: string; revisionId: string }[];
  } } }>;
}

async function publishInitialApprovedBaseline(f: ReturnType<typeof fixture>) {
  await f.initialWrite;
  const proposed = await proposeFirstDesignReview(modelInput(f, "draft-v1", null, "v1"), f.runContext, f.platform);
  assert.equal(proposed.status, "published");
  if (!("revision" in proposed)) throw new Error("Initial review was not stored.");
  const approved = await approveFirstDesignReview({ projectId: W, expectedBundleRevisionId: proposed.revision.revisionId }, f.userContext);
  assert.equal(approved.status, "published");
  if (!("revision" in approved)) throw new Error("Initial review approval was not stored.");
  const binding = await assertCurrentFirstDesignApproval({ projectId: W, approvedRevisionId: approved.revision.revisionId }, f.runContext, f.platform);
  assert(binding);
  const baseline = await publishBaseline(f, binding, "baseline-v1", null);
  assert.equal(baseline?.status, "published");
  return { baseline: baseline!.revision as { revisionId: string }, approvalId: approved.revision.revisionId };
}

test("follow-up model is user-approved, Main-published, and consumed by registered D3 inspection", async () => {
  const f = fixture();
  const initial = await publishInitialApprovedBaseline(f);
  const draft = f.makeDraft("draft-v2", "spec-v2", "Clarify the reviewed onboarding transition.");
  const authored = f.authored(draft);
  const draftWrite = await f.drafts.publish({ expectedBaseRevisionId: "draft-v1", revision: authored });
  assert.equal(draftWrite.status, "published");

  const proposed = await proposeFirstDesignReview(modelInput(f, "draft-v2", initial.approvalId, "v2"), f.runContext, f.platform);
  assert.equal(proposed.status, "published");
  if (!("revision" in proposed) || !proposed.revision) throw new Error("Follow-up model proposal was not stored.");
  assert.deepEqual(proposed.revision.priorBaseline, { revisionId: initial.baseline.revisionId, sequence: 1,
    digest: hash(JSON.stringify(initial.baseline)) });

  const beforeApproval = await registeredInspect(f);
  assert.equal(beforeApproval.data.result.designModelEvidence?.approvalRevisionId, initial.approvalId,
    "a PROPOSED model must not replace the current Baseline's approved model");
  assert.deepEqual(beforeApproval.data.result.scenarios?.map(row => row.scenarioId), ["scenario-open"]);

  const approved = await approveFirstDesignReview({ projectId: W, expectedBundleRevisionId: proposed.revision.revisionId }, f.userContext);
  assert.equal(approved.status, "published");
  if (!("revision" in approved)) throw new Error("Authenticated user approval was not stored.");
  const binding = await assertCurrentFirstDesignApproval({ projectId: W, approvedRevisionId: approved.revision.revisionId }, f.runContext, f.platform);
  assert(binding);
  assert.equal(binding.bundle.designModel?.scenarios[0]?.id, "scenario-follow-up");
  const published = await publishBaseline(f, binding, "baseline-v2", initial.baseline.revisionId);
  assert.equal(published?.status, "published");

  const result = (await registeredInspect(f)).data.result;
  assert.equal(result.status, "PASS");
  assert.equal(result.designModelEvidence?.approvalRevisionId, approved.revision.revisionId);
  assert.deepEqual(result.scenarios?.map(row => row.scenarioId), ["scenario-follow-up"]);
  assert.deepEqual(result.packVersions, [{ packId: "onboarding", version: "2.0.0" }]);
  assert.deepEqual(result.sourceEvidence, [{ sourceId: SOURCE_ID, sourceDigest: hash(SOURCE_TEXT),
    revisionId: `baseline-spec-${hash(`${W}\0baseline-v2`)}` }]);
});

test("an unapproved follow-up never replaces the old model and changed Draft blocks its approval", async () => {
  const f = fixture();
  const initial = await publishInitialApprovedBaseline(f);
  const draft = f.makeDraft("draft-v2", "spec-v2", "Proposed follow-up text.");
  const authored = f.authored(draft);
  assert.equal((await f.drafts.publish({ expectedBaseRevisionId: "draft-v1", revision: authored })).status, "published");
  const proposed = await proposeFirstDesignReview(modelInput(f, "draft-v2", initial.approvalId, "v2"), f.runContext, f.platform);
  if (!("revision" in proposed) || !proposed.revision) throw new Error("Follow-up model proposal was not stored.");

  const stillOld = await registeredInspect(f);
  assert.equal(stillOld.data.result.designModelEvidence?.approvalRevisionId, initial.approvalId);
  assert.deepEqual(stillOld.data.result.scenarios?.map(row => row.scenarioId), ["scenario-open"]);

  const changedDraft = f.makeDraft("draft-v3", "spec-v3", "Draft changed after follow-up proposal.");
  assert.equal((await f.drafts.publish({ expectedBaseRevisionId: "draft-v2", revision: f.authored(changedDraft) })).status, "published");
  const approval = await approveFirstDesignReview({ projectId: W, expectedBundleRevisionId: proposed.revision.revisionId }, f.userContext);
  assert.deepEqual(approval, { status: "conflict" });
  const afterConflict = await registeredInspect(f);
  assert.equal(afterConflict.data.result.designModelEvidence?.approvalRevisionId, initial.approvalId);
  assert.deepEqual(afterConflict.data.result.scenarios?.map(row => row.scenarioId), ["scenario-open"]);
});
