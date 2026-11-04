import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey, ToolRunContext } from "@sonparkserver/plugin-sdk/platform";
import { createDesignBaselineStore } from "../design-baseline-tools.ts";
import { createUiContractStore } from "./store.ts";
import { parseUiRevision, sha256Utf8 } from "./domain.ts";
import { createRevisionJournal, type RevisionState } from "../solution-revision-store.ts";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const mainSession = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const uiSession = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const backgroundSession = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const intakeSession = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const discussionSession = "99999999-9999-4999-8999-999999999999";
const projectId = "sample-project";
const baselineRevisionId = "baseline-r1";
const specRevisionId = "spec-r1";
const mainSourceRequestId = "11111111-1111-4111-8111-111111111111";
const uiSourceRequestId = "22222222-2222-4222-8222-222222222222";
const mainRunId = "12121212-1212-4212-8212-121212121212";
const uiRunId = "23232323-2323-4232-8232-232323232323";

type StateValue = JsonValue;
function makeState(cas = true) {
  const values = new Map<string, StateValue>();
  const key = (input: SpsStateKey) => `${input.scopeId}/${input.stateKey}`;
  let beforeGet: ((input: SpsStateKey) => void) | undefined;
  let afterCas: ((input: SpsStateKey) => Promise<void> | void) | undefined;
  let loseCasResponsePrefix: string | null = null;
  let failHeadCasPrefix: string | null = null;
  const state: RevisionState = {
    get: async (input: SpsStateKey) => {
      const found = values.get(key(input)) ?? null;
      beforeGet?.(input);
      return found;
    },
    ...(cas ? { compareAndSet: async (input: SpsStateKey,
      expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) => {
      if (failHeadCasPrefix && input.stateKey.startsWith(failHeadCasPrefix) && input.stateKey.includes("head.v1.")) {
        failHeadCasPrefix = null;
        return { swapped: false };
      }
      const existing = values.get(key(input));
      const matches = expected.exists ? existing !== undefined && JSON.stringify(existing) === JSON.stringify(expected.value)
        : existing === undefined;
      if (!matches) return { swapped: false };
      values.set(key(input), value);
      await afterCas?.(input);
      if (loseCasResponsePrefix && input.stateKey.startsWith(loseCasResponsePrefix)) {
        loseCasResponsePrefix = null;
        throw new Error("simulated lost CAS response after the state write");
      }
      return { swapped: true };
    } } : {}),
  };
  return { state, values, setBeforeGet(fn?: typeof beforeGet) { beforeGet = fn; },
    setAfterCas(fn?: typeof afterCas) { afterCas = fn; },
    loseCasResponse(prefix: string) { loseCasResponsePrefix = prefix; },
    failHead(prefix: string) { failHeadCasPrefix = prefix; } };
}

const sessionIds = { user_conversation: mainSession, ui_design: uiSession, background_planning: backgroundSession,
  question_intake: intakeSession, question_discussion: discussionSession };

function seedAuthority(values: Map<string, StateValue>) {
  values.set(`${workspaceId}/lead-agent.v1`, { workspaceId, revision: 7, selectedAgentId: agentId });
  values.set(`${workspaceId}/lead-contexts.v2.7`, { schemaVersion: 2, workspaceId, selectionRevision: 7, agentId,
    requestId: "34343434-3434-4434-8434-343434343434", status: "ready", pendingContext: null,
    contexts: sessionIds });
}

function turn(value: { requestId: string; sessionId: string; runId: string; channel: string; text: string }) {
  return { workspaceId, selectionRevision: 7, agentId, sessionId: value.sessionId, channel: value.channel,
    schemaVersion: 1, requestId: value.requestId, previousRequestId: null, sequence: 0, text: value.text,
    createdAt: "2026-11-04T00:00:00.000Z", state: "succeeded", runId: value.runId, answer: null,
    outputState: "not_ready", cancellationRequested: false, termination: "not_applicable" };
}

function setTurn(values: Map<string, StateValue>, value: Parameters<typeof turn>[0]) {
  values.set(`${workspaceId}/lead-chat.turn.v1.${value.requestId}`, turn(value));
}

function runContext(kind: "main" | "ui" | "background" = "main"): ToolRunContext {
  return { companyId: workspaceId, agentId, runId: kind === "ui" ? uiRunId : mainRunId,
    sessionId: kind === "ui" ? uiSession : kind === "background" ? backgroundSession : mainSession };
}

function platform(state: ReturnType<typeof makeState>["state"]): SpsPlatformInvocationContext {
  return { state } as unknown as SpsPlatformInvocationContext;
}

function baseline(revisionId = baselineRevisionId, draftDigest = "a".repeat(64), specId = specRevisionId) {
  return { projectId, revisionId, sourceDraftRevisionId: "draft-r1", draftDigest, createdAt: "2026-11-04T00:00:00.000Z",
    author: { agentId, sessionId: mainSession, runId: mainRunId, selectionRevision: 7 },
    userDecision: { sourceId: `lead-turn:${mainSourceRequestId}`, sourceSha256: "c".repeat(64), interpretation: "approved baseline" },
    specification: { projectId, revisionId: specId, productTier: "M", requirements: [{ id: "REQ-1", description: `Save for ${specId}`, acceptanceCriteriaIds: [specId === specRevisionId ? "AC-1" : "AC-2"] }],
      targets: ["sps-plugin"], dataPolicyRef: "policy-1", approvalEvidenceRef: `lead-turn:${mainSourceRequestId}` },
    graph: { approvedSpecRevisionId: specId, graphRevisionId: "graph-r1", entities: [], relations: [], viewLayoutRef: "layout-r1" } };
}

async function setup(options: { cas?: boolean } = {}) {
  const fixture = makeState(options.cas !== false);
  seedAuthority(fixture.values);
  setTurn(fixture.values, { requestId: mainSourceRequestId, sessionId: mainSession, runId: mainRunId,
    channel: "user_conversation", text: "I approve this UI revision." });
  setTurn(fixture.values, { requestId: uiSourceRequestId, sessionId: uiSession, runId: uiRunId,
    channel: "ui_design", text: "Please use this design draft." });
  const baseStore = createDesignBaselineStore(workspaceId, projectId, fixture.state);
  const basePublished = await baseStore.publish({ expectedBaseRevisionId: null, revision: baseline() });
  assert.equal(basePublished.status, "published");
  const store = createUiContractStore(workspaceId, projectId, fixture.state);
  return { ...fixture, store, baseStore };
}

function revisionDraft(revisionId: string, sourceSessionId = uiSession, previousRevisionId: string | null = null,
  sourceBaselineRevisionId = baselineRevisionId, baselineDraftDigest = "a".repeat(64), sourceSpecRevisionId = specRevisionId) {
  const html = "<main><button data-ui-id=\"save-button\">Save</button></main>";
  return { revisionId, sourceBaselineRevisionId, sourceBaselineDigest: sha256Utf8(JSON.stringify(baseline(sourceBaselineRevisionId, baselineDraftDigest, sourceSpecRevisionId))),
    sourceSpecRevisionId, sourceProposalRevisionId: null, previousRevisionId,
    artifact: { artifactId: `artifact-${revisionId}`, html, htmlSha256: sha256Utf8(html), screenIds: ["home"],
      viewport: { width: 1280, height: 800 }, sourceSessionId, sourceSpecRevisionId },
    contract: { projectId, revisionId: `contract-${revisionId}`, screenIds: ["home"], interactions: [
      { id: "save-button", screenId: "home", requirementRefs: ["REQ-1"], behaviorRefs: ["ACT-1"], stateRefs: [], apiRefs: ["API-1"],
        preconditions: ["valid"], outcomes: ["saved"], prohibited: [], validationCriteria: ["explicit"], status: "specified" },
      { id: "future-control", screenId: "home", requirementRefs: [], behaviorRefs: [], stateRefs: [], apiRefs: [], preconditions: [],
        outcomes: [], prohibited: [], validationCriteria: [], status: "unconnected" },
      { id: "empty-state", screenId: "home", requirementRefs: ["REQ-2"], behaviorRefs: [], stateRefs: ["STATE-EMPTY"], apiRefs: [],
        preconditions: [], outcomes: ["empty"], prohibited: [], validationCriteria: ["no sample data"], status: "specified" },
    ] } };
}

async function seedPublishedFormalHistory(fixture: Awaited<ReturnType<typeof setup>>, revisionId: string,
  reviewByInteractionId: Record<string, "APPROVED" | "REVIEW_REQUIRED" | "UNKNOWN" | "UNCONNECTED">) {
  const draft = revisionDraft(revisionId, mainSession, null);
  const revision = parseUiRevision({ ...draft, projectId, publication: "formal",
    approvalSource: { sourceId: `lead-turn:${mainSourceRequestId}`, sourceSha256: sha256Utf8("I approve this UI revision.") },
    reviewByInteractionId }, projectId);
  const journal = createRevisionJournal(workspaceId, projectId, fixture.state, {
    prefix: "ui-contracts", parse: value => parseUiRevision(value, projectId), revisionId: value => value.revisionId,
  });
  const result = await journal.publish({ expectedBaseRevisionId: null, revision });
  assert.equal(result.status, "published");
  return revision;
}

async function propose(setupResult: Awaited<ReturnType<typeof setup>>, revisionId = "proposal-r1", expectedBaseRevisionId: string | null = null,
  changedReferenceIds: string[] = []) {
  return setupResult.store.propose({ expectedBaseRevisionId, sourceRequestId: uiSourceRequestId, changedReferenceIds,
    revision: revisionDraft(revisionId, uiSession, expectedBaseRevisionId) }, runContext("ui"), platform(setupResult.state as never));
}

test("UI and Background proposals stay separate from Main formal publication and preserve both sources", async () => {
  const fixture = await setup();
  const proposalResult = await propose(fixture);
  assert.equal(proposalResult.status, "published");
  const proposal = await fixture.store.publishedProposal("proposal-r1", runContext("main"), platform(fixture.state as never));
  assert.equal(proposal?.revision.publication, "proposal");
  assert.equal(proposal?.revision.approvalSource.sourceId, `lead-turn:${uiSourceRequestId}`);
  const formalResult = await fixture.store.publishFormal({ expectedBaseRevisionId: null, sourceRequestId: mainSourceRequestId,
    proposalRevisionId: "proposal-r1", revisionId: "formal-r1", changedReferenceIds: [], revision: null }, runContext("main"), platform(fixture.state as never));
  assert.equal(formalResult.status, "published");
  const formal = await fixture.store.currentFormal(runContext("ui"), platform(fixture.state as never));
  assert.equal(formal?.revision.publication, "formal");
  assert.equal(formal?.revision.sourceProposalRevisionId, "proposal-r1");
  assert.equal(formal?.revision.artifact.html, proposal?.revision.artifact.html);
  assert.equal(formal?.revision.artifact.htmlSha256, proposal?.revision.artifact.htmlSha256);
  assert.deepEqual(formal?.revision.contract, proposal?.revision.contract);
  assert.equal(formal?.revision.approvalSource.sourceId, `lead-turn:${mainSourceRequestId}`);
  assert.equal((await fixture.store.publishedProposal("proposal-r1", runContext("ui"), platform(fixture.state as never)))?.revision.approvalSource.sourceId,
    `lead-turn:${uiSourceRequestId}`);
});

test("Background can publish a proposal citing an allowed actual user turn", async () => {
  const fixture = await setup();
  const sourceText = "I approve this UI revision.";
  const result = await fixture.store.propose({ expectedBaseRevisionId: null, sourceRequestId: mainSourceRequestId,
    changedReferenceIds: [], revision: revisionDraft("background-proposal", backgroundSession) },
  runContext("background"), platform(fixture.state as never));
  assert.equal(result.status, "published");
  const proposal = await fixture.store.publishedProposal("background-proposal", runContext("main"), platform(fixture.state as never));
  assert.equal(proposal?.revision.publication, "proposal");
  assert.equal(proposal?.revision.approvalSource.sourceId, `lead-turn:${mainSourceRequestId}`);
  assert.equal(proposal?.revision.approvalSource.sourceSha256, sha256Utf8(sourceText));
  assert.equal(proposal?.revision.artifact.sourceSessionId, backgroundSession);
});

test("UI proposal source hash matches the exact actual user text", async () => {
  const fixture = await setup();
  const sourceText = "시안 저장 전 확인\nPlease use this design draft.  ";
  setTurn(fixture.values, { requestId: uiSourceRequestId, sessionId: uiSession, runId: uiRunId,
    channel: "ui_design", text: sourceText });

  const result = await propose(fixture, "proposal-source-hash");
  assert.equal(result.status, "published");
  const proposal = await fixture.store.publishedProposal("proposal-source-hash", runContext("main"), platform(fixture.state as never));
  assert.equal(proposal?.revision.approvalSource.sourceId, `lead-turn:${uiSourceRequestId}`);
  assert.equal(proposal?.revision.approvalSource.sourceSha256, sha256Utf8(sourceText));
  assert.notEqual(proposal?.revision.approvalSource.sourceSha256, sha256Utf8(sourceText.trim()));
});

test("Main can publish its own actual revision without a fabricated prior proposal", async () => {
  const fixture = await setup();
  const direct = revisionDraft("formal-direct", mainSession);
  const result = await fixture.store.publishFormal({ expectedBaseRevisionId: null, sourceRequestId: mainSourceRequestId,
    proposalRevisionId: null, revisionId: "formal-direct", changedReferenceIds: [], revision: direct },
  runContext("main"), platform(fixture.state as never));
  assert.equal(result.status, "published");
  const stored = await fixture.store.currentFormal(runContext("main"), platform(fixture.state as never));
  assert.equal(stored?.revision.sourceProposalRevisionId, null);
  assert.equal(stored?.revision.artifact.html, direct.artifact.html);
  assert.equal(stored?.revision.approvalSource.sourceId, `lead-turn:${mainSourceRequestId}`);
  assert.equal(stored?.revision.reviewByInteractionId["save-button"], "UNKNOWN");
});

test("formal publication rejects a Main turn from a different run without writing journal state", async () => {
  const fixture = await setup();
  setTurn(fixture.values, { requestId: mainSourceRequestId, sessionId: mainSession,
    runId: "13131313-1313-4313-8313-131313131313", channel: "user_conversation", text: "I approve this UI revision." });
  const beforeKeys = [...fixture.values.keys()].filter(key => key.includes("ui-contracts-"));
  await assert.rejects(() => fixture.store.publishFormal({ expectedBaseRevisionId: null, sourceRequestId: mainSourceRequestId,
    proposalRevisionId: null, revisionId: "formal-stale-run", changedReferenceIds: [],
    revision: revisionDraft("formal-stale-run", mainSession) }, runContext("main"), platform(fixture.state as never)),
  /current Main run\/session/);
  assert.deepEqual([...fixture.values.keys()].filter(key => key.includes("ui-contracts-")), beforeKeys);
  assert.equal([...fixture.values.keys()].some(key => key.includes("ui-contracts-revision") && key.includes("formal-stale-run")), false);
});

test("formal publication rejects a Main turn from a different session without writing journal state", async () => {
  const fixture = await setup();
  // Keep the record in the actual Main channel, but give it a stale session binding.
  fixture.values.set(`${workspaceId}/lead-chat.turn.v1.${mainSourceRequestId}`, {
    ...turn({ requestId: mainSourceRequestId, sessionId: uiSession, runId: mainRunId,
      channel: "user_conversation", text: "I approve this UI revision." }),
  });
  const beforeKeys = [...fixture.values.keys()].filter(key => key.includes("ui-contracts-"));
  await assert.rejects(() => fixture.store.publishFormal({ expectedBaseRevisionId: null, sourceRequestId: mainSourceRequestId,
    proposalRevisionId: null, revisionId: "formal-stale-session", changedReferenceIds: [],
    revision: revisionDraft("formal-stale-session", mainSession) }, runContext("main"), platform(fixture.state as never)));
  assert.deepEqual([...fixture.values.keys()].filter(key => key.includes("ui-contracts-")), beforeKeys);
  assert.equal([...fixture.values.keys()].some(key => key.includes("ui-contracts-revision") && key.includes("formal-stale-session")), false);
});

test("formal history rejects a journal entry whose approval source hash changed without a new digest", async () => {
  const fixture = await setup();
  await fixture.store.publishFormal({ expectedBaseRevisionId: null, sourceRequestId: mainSourceRequestId,
    proposalRevisionId: null, revisionId: "formal-hash-tamper", changedReferenceIds: [],
    revision: revisionDraft("formal-hash-tamper", mainSession) }, runContext("main"), platform(fixture.state as never));
  const entryKey = [...fixture.values.entries()].find(([key, value]) => key.includes("ui-contracts-revision.v1.")
    && (value as { revision?: { revisionId?: string } }).revision?.revisionId === "formal-hash-tamper")?.[0];
  assert.ok(entryKey);
  const stored = fixture.values.get(entryKey) as Record<string, unknown>;
  const revision = stored.revision as Record<string, unknown>;
  const approvalSource = revision.approvalSource as Record<string, unknown>;
  fixture.values.set(entryKey, { ...stored, revision: { ...revision,
    approvalSource: { ...approvalSource, sourceSha256: "f".repeat(64) } } } as JsonValue);
  await assert.rejects(() => fixture.store.publishedFormal("formal-hash-tamper", runContext("main"),
    platform(fixture.state as never)), /digest mismatch/);
  await assert.rejects(() => fixture.store.currentFormal(runContext("main"), platform(fixture.state as never)), /digest mismatch/);
});

test("forged source IDs and non-user assistant/background turns are rejected", async () => {
  const fixture = await setup();
  await assert.rejects(() => fixture.store.propose({ expectedBaseRevisionId: null, sourceRequestId: "33333333-3333-4333-8333-333333333333",
    changedReferenceIds: [], revision: revisionDraft("proposal-forged") }, runContext("ui"), platform(fixture.state as never)), /unavailable|changed/);
  setTurn(fixture.values, { requestId: "44444444-4444-4444-8444-444444444444", sessionId: backgroundSession,
    runId: uiRunId, channel: "background_planning", text: "background generated text" });
  await assert.rejects(() => fixture.store.propose({ expectedBaseRevisionId: null, sourceRequestId: "44444444-4444-4444-8444-444444444444",
    changedReferenceIds: [], revision: revisionDraft("proposal-background", backgroundSession) }, runContext("background"), platform(fixture.state as never)), /unavailable|changed/);
});

test("Workspace and caller role claims cannot grant Main formal publication", async () => {
  const fixture = await setup();
  await assert.rejects(() => fixture.store.propose({ expectedBaseRevisionId: null, sourceRequestId: uiSourceRequestId,
    changedReferenceIds: [], revision: revisionDraft("proposal-workspace") }, { ...runContext("ui"), companyId: "12345678-1234-4234-8234-123456789012" },
  platform(fixture.state as never)), /Workspace/);
  await propose(fixture);
  await assert.rejects(() => fixture.store.publishFormal({ expectedBaseRevisionId: null, sourceRequestId: mainSourceRequestId,
    proposalRevisionId: "proposal-r1", revisionId: "forged-formal", changedReferenceIds: [], revision: null, role: "main" },
  runContext("ui"), platform(fixture.state as never)), /unknown|Only Main/);
});

test("current binding is rechecked before journal writes", async () => {
  const fixture = await setup();
  let changed = false;
  fixture.setBeforeGet(input => {
    if (!changed && input.stateKey?.startsWith("design-baseline-head.v1.")) {
      changed = true;
      fixture.values.set(`${workspaceId}/lead-agent.v1`, { workspaceId, revision: 8, selectedAgentId: agentId });
    }
  });
  await assert.rejects(() => propose(fixture), /selection changed|authority changed|context record is unavailable/);
  fixture.setBeforeGet(undefined);
  assert.equal([...fixture.values.keys()].some(key => key.includes("ui-proposals-head.v1.")), false);
});

test("stale CAS base reports the actual base and CAS-less Hosts are rejected", async () => {
  const fixture = await setup();
  await propose(fixture, "proposal-r1");
  const stale = await propose(fixture, "proposal-stale", "proposal-old");
  assert.equal(stale.status, "conflict");
  if (stale.status === "conflict") assert.equal(stale.actualBaseRevisionId, "proposal-r1");
  const seeded = await setup();
  const noCasState = { get: seeded.state.get };
  const noCasStore = createUiContractStore(workspaceId, projectId, noCasState as never);
  await assert.rejects(() => noCasStore.propose({ expectedBaseRevisionId: null, sourceRequestId: uiSourceRequestId,
    changedReferenceIds: [], revision: revisionDraft("proposal-no-cas") }, runContext("ui"), platform(noCasState as never)), /compareAndSet/);
});

test("partially committed proposal entry stays out of published history", async () => {
  const fixture = await setup();
  fixture.failHead("ui-proposals-head");
  const result = await propose(fixture);
  assert.equal(result.status, "conflict");
  assert.equal(await fixture.store.publishedProposal("proposal-r1", runContext("main"), platform(fixture.state as never)), null);
  await assert.rejects(() => fixture.store.publishFormal({ expectedBaseRevisionId: null, sourceRequestId: mainSourceRequestId,
    proposalRevisionId: "proposal-r1", revisionId: "formal-from-staged", changedReferenceIds: [], revision: null },
  runContext("main"), platform(fixture.state as never)), /Only a published UI\/Background proposal/);
});

test("published proposal history supports positive and negative lookups", async () => {
  const fixture = await setup();
  await propose(fixture);
  await propose(fixture, "proposal-r2", "proposal-r1");
  assert.equal((await fixture.store.publishedProposal("proposal-r1", runContext("main"), platform(fixture.state as never)))?.sequence, 1);
  assert.equal((await fixture.store.publishedProposal("missing-r", runContext("main"), platform(fixture.state as never))), null);
});

test("proposal review marks changed interactions and leaves unrelated interactions unapproved", async () => {
  const fixture = await setup();
  await propose(fixture);
  await fixture.store.publishFormal({ expectedBaseRevisionId: null, sourceRequestId: mainSourceRequestId,
    proposalRevisionId: "proposal-r1", revisionId: "formal-r1", changedReferenceIds: [], revision: null }, runContext("main"), platform(fixture.state as never));
  const second = await propose(fixture, "proposal-r2", "proposal-r1", ["API-1"]);
  assert.equal(second.status, "published");
  const proposed = await fixture.store.publishedProposal("proposal-r2", runContext("main"), platform(fixture.state as never));
  assert.equal(proposed?.revision.reviewByInteractionId["save-button"], "REVIEW_REQUIRED");
  assert.equal(proposed?.revision.reviewByInteractionId["empty-state"], "UNKNOWN");
  assert.equal(proposed?.revision.reviewByInteractionId["future-control"], "UNCONNECTED");
});

test("formal review history persists across revisions and the original published record stays queryable", async () => {
  const fixture = await setup();
  const original = await seedPublishedFormalHistory(fixture, "formal-seed", {
    "save-button": "REVIEW_REQUIRED", "empty-state": "APPROVED", "future-control": "UNCONNECTED",
  });
  const originalPublished = await fixture.store.publishedFormal("formal-seed", runContext("main"), platform(fixture.state as never));
  assert.deepEqual(originalPublished?.revision.reviewByInteractionId, original.reviewByInteractionId);
  assert.equal(originalPublished?.revision.sourceProposalRevisionId, null);
  assert.equal(originalPublished?.revision.approvalSource.sourceId, `lead-turn:${mainSourceRequestId}`);

  const partial = revisionDraft("formal-partial", mainSession, "formal-seed");
  const partialResult = await fixture.store.publishFormal({ expectedBaseRevisionId: "formal-seed", sourceRequestId: mainSourceRequestId,
    proposalRevisionId: null, revisionId: "formal-partial", changedReferenceIds: ["API-1"], revision: partial },
  runContext("main"), platform(fixture.state as never));
  assert.equal(partialResult.status, "published");
  const partialPublished = await fixture.store.currentFormal(runContext("main"), platform(fixture.state as never));
  assert.equal(partialPublished?.revision.reviewByInteractionId["save-button"], "REVIEW_REQUIRED");
  assert.equal(partialPublished?.revision.reviewByInteractionId["empty-state"], "APPROVED");

  const unchanged = revisionDraft("formal-unchanged", mainSession, "formal-partial");
  const unchangedResult = await fixture.store.publishFormal({ expectedBaseRevisionId: "formal-partial", sourceRequestId: mainSourceRequestId,
    proposalRevisionId: null, revisionId: "formal-unchanged", changedReferenceIds: [], revision: unchanged },
  runContext("main"), platform(fixture.state as never));
  assert.equal(unchangedResult.status, "published");
  const current = await fixture.store.currentFormal(runContext("main"), platform(fixture.state as never));
  assert.equal(current?.revision.reviewByInteractionId["save-button"], "REVIEW_REQUIRED");
  assert.equal(current?.revision.reviewByInteractionId["empty-state"], "APPROVED");
});

test("a successful publication after a Spec change keeps prior review and history without carrying unverified approvals", async () => {
  const fixture = await setup();
  const original = await seedPublishedFormalHistory(fixture, "formal-before-spec-change", {
    "save-button": "REVIEW_REQUIRED", "empty-state": "APPROVED", "future-control": "UNCONNECTED",
  });
  const nextBaseline = baseline("baseline-after-spec-change", "d".repeat(64), "spec-r2");
  const baselineResult = await fixture.baseStore.publish({ expectedBaseRevisionId: baselineRevisionId, revision: nextBaseline });
  assert.equal(baselineResult.status, "published");

  const changedSpecDraft = revisionDraft("formal-after-spec-change", mainSession, original.revisionId,
    nextBaseline.revisionId, nextBaseline.draftDigest, nextBaseline.specification.revisionId);
  const result = await fixture.store.publishFormal({ expectedBaseRevisionId: original.revisionId,
    sourceRequestId: mainSourceRequestId, proposalRevisionId: null, revisionId: "formal-after-spec-change",
    changedReferenceIds: ["REQ-1"], revision: changedSpecDraft }, runContext("main"), platform(fixture.state as never));
  assert.equal(result.status, "published");

  const current = await fixture.store.currentFormal(runContext("main"), platform(fixture.state as never));
  assert.equal(current?.revision.sourceBaselineRevisionId, nextBaseline.revisionId);
  assert.equal(current?.revision.sourceSpecRevisionId, "spec-r2");
  assert.equal(current?.revision.reviewByInteractionId["save-button"], "REVIEW_REQUIRED");
  assert.equal(current?.revision.reviewByInteractionId["empty-state"], "UNKNOWN");
  assert.equal(current?.revision.reviewByInteractionId["future-control"], "UNCONNECTED");

  const oldPublished = await fixture.store.publishedFormal(original.revisionId, runContext("main"), platform(fixture.state as never));
  assert.deepEqual(oldPublished?.revision.reviewByInteractionId, original.reviewByInteractionId);
  assert.equal(oldPublished?.revision.sourceBaselineRevisionId, baselineRevisionId);
  assert.equal(oldPublished?.revision.sourceSpecRevisionId, specRevisionId);
});

test("a Spec change with no changed-reference list preserves formal REVIEW_REQUIRED and its original record", async () => {
  const fixture = await setup();
  const original = await seedPublishedFormalHistory(fixture, "formal-spec-empty-diff-before", {
    "save-button": "REVIEW_REQUIRED", "empty-state": "APPROVED", "future-control": "UNCONNECTED",
  });
  const nextBaseline = baseline("baseline-spec-empty-diff", "e".repeat(64), "spec-r3");
  const baselineResult = await fixture.baseStore.publish({ expectedBaseRevisionId: baselineRevisionId, revision: nextBaseline });
  assert.equal(baselineResult.status, "published");

  const draft = revisionDraft("formal-spec-empty-diff-after", mainSession, original.revisionId,
    nextBaseline.revisionId, nextBaseline.draftDigest, nextBaseline.specification.revisionId);
  const result = await fixture.store.publishFormal({ expectedBaseRevisionId: original.revisionId,
    sourceRequestId: mainSourceRequestId, proposalRevisionId: null, revisionId: draft.revisionId,
    changedReferenceIds: [], revision: draft }, runContext("main"), platform(fixture.state as never));
  assert.equal(result.status, "published");

  const current = await fixture.store.currentFormal(runContext("main"), platform(fixture.state as never));
  assert.equal(current?.revision.reviewByInteractionId["save-button"], "REVIEW_REQUIRED");
  assert.equal(current?.revision.reviewByInteractionId["empty-state"], "UNKNOWN");
  assert.equal(current?.revision.reviewByInteractionId["future-control"], "UNCONNECTED");

  const oldPublished = await fixture.store.publishedFormal(original.revisionId, runContext("main"), platform(fixture.state as never));
  assert.deepEqual(oldPublished?.revision.reviewByInteractionId, original.reviewByInteractionId);
  assert.equal(oldPublished?.revision.sourceBaselineRevisionId, baselineRevisionId);
  assert.equal(oldPublished?.revision.sourceSpecRevisionId, specRevisionId);
  assert.equal(oldPublished?.revision.approvalSource.sourceSha256, original.approvalSource.sourceSha256);
});

test("same-Spec formal history keeps a removed interaction UNCONNECTED with explicit impacts and does not approve a new interaction", async () => {
  const fixture = await setup();
  const original = await seedPublishedFormalHistory(fixture, "formal-same-spec-before-unconnected", {
    "save-button": "REVIEW_REQUIRED", "empty-state": "APPROVED", "future-control": "UNCONNECTED",
  });

  const explicitDraft = revisionDraft("formal-same-spec-explicit-unconnected", mainSession, original.revisionId);
  const save = explicitDraft.contract.interactions[0]!;
  save.requirementRefs = [];
  save.behaviorRefs = [];
  save.stateRefs = [];
  save.apiRefs = [];
  save.preconditions = [];
  save.outcomes = [];
  save.validationCriteria = [];
  save.status = "unconnected";
  const emptyState = explicitDraft.contract.interactions[2]!;
  emptyState.requirementRefs = [];
  emptyState.behaviorRefs = [];
  emptyState.stateRefs = [];
  emptyState.apiRefs = [];
  emptyState.preconditions = [];
  emptyState.outcomes = [];
  emptyState.validationCriteria = [];
  emptyState.status = "unconnected";
  explicitDraft.contract.interactions.push({ id: "new-specified-control", screenId: "home", requirementRefs: ["REQ-3"],
    behaviorRefs: ["ACT-3"], stateRefs: [], apiRefs: [], preconditions: [], outcomes: ["created"], prohibited: [],
    validationCriteria: ["explicit"], status: "specified" });
  const explicit = await fixture.store.publishFormal({ expectedBaseRevisionId: original.revisionId,
    sourceRequestId: mainSourceRequestId, proposalRevisionId: null, revisionId: explicitDraft.revisionId,
    changedReferenceIds: ["API-1"], revision: explicitDraft }, runContext("main"), platform(fixture.state as never));
  assert.equal(explicit.status, "published");
  const explicitCurrent = await fixture.store.currentFormal(runContext("main"), platform(fixture.state as never));
  assert.equal(explicitCurrent?.revision.reviewByInteractionId["save-button"], "UNCONNECTED");
  assert.equal(explicitCurrent?.revision.reviewByInteractionId["empty-state"], "UNCONNECTED");
  assert.equal(explicitCurrent?.revision.reviewByInteractionId["new-specified-control"], "UNKNOWN");

  const emptyDraft = revisionDraft("formal-same-spec-empty-unconnected", mainSession, explicitDraft.revisionId);
  emptyDraft.contract.interactions.push(explicitDraft.contract.interactions[3]!);
  const emptySave = emptyDraft.contract.interactions[0]!;
  emptySave.requirementRefs = [];
  emptySave.behaviorRefs = [];
  emptySave.stateRefs = [];
  emptySave.apiRefs = [];
  emptySave.preconditions = [];
  emptySave.outcomes = [];
  emptySave.validationCriteria = [];
  emptySave.status = "unconnected";
  const emptyStateNext = emptyDraft.contract.interactions[2]!;
  emptyStateNext.requirementRefs = [];
  emptyStateNext.behaviorRefs = [];
  emptyStateNext.stateRefs = [];
  emptyStateNext.apiRefs = [];
  emptyStateNext.preconditions = [];
  emptyStateNext.outcomes = [];
  emptyStateNext.validationCriteria = [];
  emptyStateNext.status = "unconnected";
  const empty = await fixture.store.publishFormal({ expectedBaseRevisionId: explicitDraft.revisionId,
    sourceRequestId: mainSourceRequestId, proposalRevisionId: null, revisionId: emptyDraft.revisionId,
    changedReferenceIds: [], revision: emptyDraft }, runContext("main"), platform(fixture.state as never));
  assert.equal(empty.status, "published");
  const emptyCurrent = await fixture.store.currentFormal(runContext("main"), platform(fixture.state as never));
  assert.equal(emptyCurrent?.revision.reviewByInteractionId["save-button"], "UNCONNECTED");
  assert.equal(emptyCurrent?.revision.reviewByInteractionId["new-specified-control"], "UNKNOWN");

  const oldPublished = await fixture.store.publishedFormal(original.revisionId, runContext("main"), platform(fixture.state as never));
  assert.deepEqual(oldPublished?.revision.reviewByInteractionId, original.reviewByInteractionId);
  assert.equal(oldPublished?.revision.contract.interactions[0]?.status, "specified");
});

test("changed-Spec formal history with an empty impact list keeps a now-unconnected interaction truthful", async () => {
  const fixture = await setup();
  const original = await seedPublishedFormalHistory(fixture, "formal-changed-spec-before-unconnected", {
    "save-button": "REVIEW_REQUIRED", "empty-state": "APPROVED", "future-control": "UNCONNECTED",
  });
  const nextBaseline = baseline("baseline-changed-spec-unconnected", "f".repeat(64), "spec-unconnected-r2");
  assert.equal((await fixture.baseStore.publish({ expectedBaseRevisionId: baselineRevisionId, revision: nextBaseline })).status, "published");

  const draft = revisionDraft("formal-changed-spec-unconnected", mainSession, original.revisionId,
    nextBaseline.revisionId, nextBaseline.draftDigest, nextBaseline.specification.revisionId);
  const save = draft.contract.interactions[0]!;
  save.requirementRefs = [];
  save.behaviorRefs = [];
  save.stateRefs = [];
  save.apiRefs = [];
  save.preconditions = [];
  save.outcomes = [];
  save.validationCriteria = [];
  save.status = "unconnected";
  const result = await fixture.store.publishFormal({ expectedBaseRevisionId: original.revisionId,
    sourceRequestId: mainSourceRequestId, proposalRevisionId: null, revisionId: draft.revisionId,
    changedReferenceIds: [], revision: draft }, runContext("main"), platform(fixture.state as never));
  assert.equal(result.status, "published");

  const current = await fixture.store.currentFormal(runContext("main"), platform(fixture.state as never));
  assert.equal(current?.revision.sourceBaselineRevisionId, nextBaseline.revisionId);
  assert.equal(current?.revision.sourceBaselineDigest, sha256Utf8(JSON.stringify(nextBaseline)));
  assert.equal(current?.revision.sourceSpecRevisionId, "spec-unconnected-r2");
  assert.equal(current?.revision.reviewByInteractionId["save-button"], "UNCONNECTED");
  assert.equal(current?.revision.reviewByInteractionId["empty-state"], "UNKNOWN");
  const originalPublished = await fixture.store.publishedFormal(original.revisionId, runContext("main"), platform(fixture.state as never));
  assert.deepEqual(originalPublished?.revision.reviewByInteractionId, original.reviewByInteractionId);
  assert.equal(originalPublished?.revision.sourceSpecRevisionId, specRevisionId);
  assert.equal(originalPublished?.revision.contract.interactions[0]?.status, "specified");
});

test("concurrent formal CAS publishes only the actual winning head", async () => {
  const fixture = await setup();
  const publish = async (revisionId: string) => fixture.store.publishFormal({ expectedBaseRevisionId: null,
    sourceRequestId: mainSourceRequestId, proposalRevisionId: null, revisionId, changedReferenceIds: [],
    revision: revisionDraft(revisionId, mainSession) }, runContext("main"), platform(fixture.state as never));
  const results = await Promise.all([publish("formal-race-a"), publish("formal-race-b")]);
  assert.equal(results.filter(result => result.status === "published").length, 1);
  assert.equal(results.filter(result => result.status === "conflict").length, 1);
  const current = await fixture.store.currentFormal(runContext("main"), platform(fixture.state as never));
  assert.ok(current);
  const winnerId = current.revision.revisionId;
  const loserId = winnerId === "formal-race-a" ? "formal-race-b" : "formal-race-a";
  assert.ok(await fixture.store.publishedFormal(winnerId, runContext("main"), platform(fixture.state as never)));
  assert.equal(await fixture.store.publishedFormal(loserId, runContext("main"), platform(fixture.state as never)), null);
});

test("a lost successful CAS response is checked against the actual published head and history", async () => {
  const fixture = await setup();
  fixture.loseCasResponse("ui-contracts-head.v1.");
  await assert.rejects(() => fixture.store.publishFormal({ expectedBaseRevisionId: null, sourceRequestId: mainSourceRequestId,
    proposalRevisionId: null, revisionId: "formal-response-lost", changedReferenceIds: [],
    revision: revisionDraft("formal-response-lost", mainSession) }, runContext("main"), platform(fixture.state as never)), /lost CAS response/);
  const current = await fixture.store.currentFormal(runContext("main"), platform(fixture.state as never));
  assert.equal(current?.revision.revisionId, "formal-response-lost");
  assert.equal((await fixture.store.publishedFormal("formal-response-lost", runContext("main"), platform(fixture.state as never)))?.revision.revisionId,
    "formal-response-lost");
});

test("a post-CAS authority change reports the actual published head and history", async () => {
  const fixture = await setup();
  let changed = false;
  fixture.setAfterCas(input => {
    if (!changed && input.stateKey?.startsWith("ui-contracts-head.v1.")) {
      changed = true;
      fixture.values.set(`${workspaceId}/lead-agent.v1`, { workspaceId, revision: 8, selectedAgentId: agentId });
    }
  });
  await assert.rejects(() => fixture.store.publishFormal({ expectedBaseRevisionId: null, sourceRequestId: mainSourceRequestId,
    proposalRevisionId: null, revisionId: "formal-post-authority-change", changedReferenceIds: [],
    revision: revisionDraft("formal-post-authority-change", mainSession) }, runContext("main"), platform(fixture.state as never)),
  /selection changed|authority changed|context record is unavailable/);
  fixture.setAfterCas(undefined);
  fixture.values.set(`${workspaceId}/lead-agent.v1`, { workspaceId, revision: 7, selectedAgentId: agentId });
  const current = await fixture.store.currentFormal(runContext("main"), platform(fixture.state as never));
  assert.equal(current?.revision.revisionId, "formal-post-authority-change");
  assert.ok(await fixture.store.publishedFormal("formal-post-authority-change", runContext("main"), platform(fixture.state as never)));
});

test("a post-CAS baseline change reports the actual published head and history", async () => {
  const fixture = await setup();
  let changed = false;
  fixture.setAfterCas(async input => {
    if (!changed && input.stateKey?.startsWith("ui-contracts-head.v1.")) {
      changed = true;
      const result = await fixture.baseStore.publish({ expectedBaseRevisionId: baselineRevisionId,
        revision: baseline("baseline-post-cas", "d".repeat(64)) });
      assert.equal(result.status, "published");
    }
  });
  await assert.rejects(() => fixture.store.publishFormal({ expectedBaseRevisionId: null, sourceRequestId: mainSourceRequestId,
    proposalRevisionId: null, revisionId: "formal-post-baseline-change", changedReferenceIds: [],
    revision: revisionDraft("formal-post-baseline-change", mainSession) }, runContext("main"), platform(fixture.state as never)), /baseline or Spec revision is stale/);
  fixture.setAfterCas(undefined);
  const current = await fixture.store.currentFormal(runContext("main"), platform(fixture.state as never));
  assert.equal(current?.revision.revisionId, "formal-post-baseline-change");
  assert.ok(await fixture.store.publishedFormal("formal-post-baseline-change", runContext("main"), platform(fixture.state as never)));
});

test("current published baseline ID, digest and Spec revision are required", async () => {
  const fixture = await setup();
  const draftDigestOnly = revisionDraft("proposal-draft-digest");
  draftDigestOnly.sourceBaselineDigest = baseline().draftDigest;
  await assert.rejects(() => fixture.store.propose({ expectedBaseRevisionId: null, sourceRequestId: uiSourceRequestId,
    changedReferenceIds: [], revision: draftDigestOnly }, runContext("ui"), platform(fixture.state as never)), /baseline or Spec revision is stale/);
  await fixture.baseStore.publish({ expectedBaseRevisionId: baselineRevisionId, revision: baseline("baseline-r2", "b".repeat(64)) });
  await assert.rejects(() => propose(fixture), /baseline or Spec revision is stale/);
});
