import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsActionContext, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createDesignDraftStore } from "../src/design-draft-store.ts";
import { parseDesignBaseline } from "../src/domain/design-baseline.ts";
import { parseUiApproval, parseUiContract, parseUiRevision, sha256Utf8 } from "../src/ui-contracts/domain.ts";
import { createUiContractStore } from "../src/ui-contracts/store.ts";
import { createRevisionJournal, type RevisionState } from "../src/solution-revision-store.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const MAIN = "33333333-3333-4333-8333-333333333333";
const UI = "44444444-4444-4444-8444-444444444444";
const BACKGROUND = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";
const USER = "77777777-7777-4777-8777-777777777777";
const PROJECT = "sample-project";
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const stateKey = (key: SpsStateKey) => JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);

function fixture() {
  const values = new Map<string, JsonValue>();
  let afterNextGet: (() => void) | null = null;
  let lostCasPrefix: string | null = null;
  let failCasPrefix: string | null = null;
  let lostValue: JsonValue | null = null;
  const state: RevisionState = {
    async get(key) {
      const value = values.get(stateKey(key)) ?? null;
      const callback = afterNextGet;
      afterNextGet = null;
      callback?.();
      return value;
    },
    async compareAndSet(key, expected, value) {
      const keyId = stateKey(key), current = values.get(keyId), exists = values.has(keyId);
      const matches = expected.exists ? exists && JSON.stringify(current) === JSON.stringify(expected.value) : !exists;
      if (failCasPrefix && key.stateKey.startsWith(failCasPrefix)) {
        failCasPrefix = null;
        return { swapped: false };
      }
      if (matches) values.set(keyId, structuredClone(value));
      if (matches && lostCasPrefix && key.stateKey.startsWith(lostCasPrefix)) {
        lostCasPrefix = null;
        lostValue = structuredClone(value);
        throw new Error("injected lost CAS receipt after write");
      }
      return { swapped: matches };
    },
  };
  const sessionIds = { main: MAIN, "ui-design": UI, background: BACKGROUND, "cto-inbox": null, decisions: null, "integration-review": null };
  const scoped = (key: string) => JSON.stringify(["company", WORKSPACE, "sonpark.my-builder", key]);
  values.set(scoped("lead-agent.v1"), { workspaceId: WORKSPACE, revision: 1, selectedAgentId: AGENT });
  values.set(scoped("lead-sessions.v1.1"), { workspaceId: WORKSPACE, selectionRevision: 1, agentId: AGENT, sessions: sessionIds });
  return { state, values, scoped,
    mutateAfterNextGet(callback: () => void) { afterNextGet = callback; },
    loseNextCasReceipt(prefix: string) { lostCasPrefix = prefix; },
    failNextCasWithoutWrite(prefix: string) { failCasPrefix = prefix; },
    get lostValue() { return lostValue; },
  };
}

function draft(revisionId: string, requirementText = "Keep the workflow clear.") {
  return { projectId: PROJECT, revisionId, sourceIds: ["consultation-11111111-1111-4111-8111-111111111111"],
    specification: { revisionId: `spec-${revisionId}`, productTier: "M", requirements: [
      { id: "REQ-1", description: requirementText, acceptanceCriteriaIds: ["AC-1"] },
      { id: "REQ-2", description: "Show the empty state.", acceptanceCriteriaIds: ["AC-2"] },
    ], targets: ["sps-plugin"], dataPolicyRef: "policy-unreviewed" },
    graph: { graphRevisionId: `graph-${revisionId}`, entities: [], relations: [], viewLayoutRef: "layout" }, questions: [] };
}

async function seedDraft(state: RevisionState, revisionId = "draft-r1", requirementText?: string) {
  const store = createDesignDraftStore(WORKSPACE, PROJECT, { selectionRevision: 1, agentId: AGENT }, state);
  const current = await store.current();
  return store.publish({ expectedBaseRevisionId: current?.revision.draft.revisionId ?? null, revision: { status: "draft", selectionRevision: 1,
    author: { agentId: AGENT, sessionId: UI, runId: RUN }, sourceDigests: [{ id: "consultation-11111111-1111-4111-8111-111111111111", sha256: hash("source") }],
    createdAt: "2026-11-06T00:00:00.000Z", draft: draft(revisionId, requirementText) } });
}

async function seedBaseline(state: RevisionState) {
  const revision = parseDesignBaseline({ projectId: PROJECT, revisionId: "baseline-r1", sourceDraftRevisionId: "draft-r0",
    draftDigest: hash("draft-r0"), createdAt: "2026-11-06T00:00:00.000Z",
    author: { agentId: AGENT, sessionId: MAIN, runId: RUN, selectionRevision: 1 },
    userDecision: { sourceId: "lead-turn:88888888-8888-4888-8888-888888888888", sourceSha256: hash("user"), interpretation: "Preserve scope." },
    specification: { projectId: PROJECT, revisionId: "baseline-spec-r1", productTier: "M", requirements: [
      { id: "REQ-1", description: "Keep the workflow clear.", acceptanceCriteriaIds: ["AC-1"] },
      { id: "REQ-2", description: "Show the empty state.", acceptanceCriteriaIds: ["AC-2"] }], targets: ["sps-plugin"],
      dataPolicyRef: "policy", approvalEvidenceRef: "lead-turn:88888888-8888-4888-8888-888888888888" },
    graph: { approvedSpecRevisionId: "baseline-spec-r1", graphRevisionId: "baseline-graph-r1", entities: [], relations: [], viewLayoutRef: "layout" },
  }, PROJECT);
  return createRevisionJournal(WORKSPACE, PROJECT, state, { prefix: "design-baseline",
    parse: value => parseDesignBaseline(value, PROJECT), revisionId: value => value.revisionId })
    .publish({ expectedBaseRevisionId: null, revision });
}

function artifact(revisionId: string, sessionId = UI, html = `<main data-revision="${revisionId}"><button>Save</button></main>`, specRevisionId = `spec-draft-r1`) {
  return { artifactId: `artifact-${revisionId}`, html, htmlSha256: sha256Utf8(html), screenIds: ["home"],
    viewport: { width: 1280, height: 800 }, sourceSessionId: sessionId, sourceSpecRevisionId: specRevisionId };
}

function contract(revisionId: string, changed = false) {
  return { projectId: PROJECT, revisionId: `contract-${revisionId}`, screenIds: ["home"], interactions: [
    { id: "save", screenId: "home", requirementRefs: ["REQ-1"], behaviorRefs: ["ACT-1"], stateRefs: [], apiRefs: ["API-1"],
      preconditions: ["valid"], outcomes: [changed ? "saved with receipt" : "saved"], prohibited: ["implicit publish"],
      validationCriteria: ["explicit action"], status: "specified" },
    { id: "empty", screenId: "home", requirementRefs: ["REQ-2"], behaviorRefs: [], stateRefs: ["STATE-EMPTY"], apiRefs: [],
      preconditions: [], outcomes: ["show empty"], prohibited: [], validationCriteria: ["no sample data"], status: "specified" },
    { id: "future", screenId: "home", requirementRefs: [], behaviorRefs: [], stateRefs: [], apiRefs: ["API-FUTURE"],
      preconditions: [], outcomes: [], prohibited: [], validationCriteria: [], status: "unknown" },
    { id: "unconnected", screenId: "home", requirementRefs: [], behaviorRefs: [], stateRefs: [], apiRefs: [],
      preconditions: [], outcomes: [], prohibited: [], validationCriteria: [], status: "unconnected" },
  ] };
}

function runContext(channel: "main" | "ui-design" | "background" = "main") {
  return { companyId: WORKSPACE, agentId: AGENT, runId: RUN,
    sessionId: channel === "main" ? MAIN : channel === "ui-design" ? UI : BACKGROUND };
}

const platform = (state: RevisionState) => ({ state }) as unknown as SpsPlatformInvocationContext;
type UiActionContext = Pick<SpsActionContext, "companyId" | "actor"> & { state: SpsPlatformInvocationContext["state"] };
const userAction = (state: RevisionState, userId = USER) => ({ companyId: WORKSPACE, actor: { type: "user", companyId: WORKSPACE, userId }, state }) as unknown as UiActionContext;
const proposalInput = (revisionId: string, sourceKind: "draft" | "baseline" = "draft", sourceRevisionId = sourceKind === "draft" ? "draft-r1" : "baseline-r1", session = UI, changed = false) => ({
  revisionId, expectedBaseRevisionId: null, source: { kind: sourceKind, revisionId: sourceRevisionId },
  artifact: artifact(revisionId, session, undefined, sourceKind === "draft" ? "spec-draft-r1" : "baseline-spec-r1"),
  contract: contract(revisionId, changed),
});

test("contract validates exact HTML bytes, spec revision, requirement references and explicit unknown state", () => {
  const parsed = parseUiContract(contract("r1"), PROJECT);
  assert.equal(parsed.interactions[0]?.requirementRefs[0], "REQ-1");
  assert.throws(() => parseUiContract({ ...contract("r1"), projectId: "other" }, PROJECT), /another project/);
  const html = "<p>exact</p>";
  assert.throws(() => parseUiRevision({ projectId: PROJECT, revisionId: "r1", source: { kind: "draft", revisionId: "d1", digest: hash("x"),
    specRevisionId: "s1", selectionRevision: 1, agentId: AGENT }, previousRevisionId: null, sourceProposalRevisionId: null,
    approvalRevisionId: null, artifact: { ...artifact("r1", UI, html, "s1"), htmlSha256: hash("wrong") },
    contract: contract("r1"), publication: "proposal", reviewByInteractionId: { save: "UNKNOWN", empty: "UNKNOWN" } }, PROJECT), /exact HTML bytes/);
  assert.throws(() => parseUiContract({ ...contract("r1"), interactions: [{ ...contract("r1").interactions[0],
    requirementRefs: [], behaviorRefs: [], apiRefs: [], status: "specified" }] }, PROJECT), /links/);
});

test("UI Design proposes against current draft before any Baseline; only a user action approves exact proposal bytes", async () => {
  const f = fixture();
  await seedDraft(f.state);
  const store = createUiContractStore(WORKSPACE, PROJECT, f.state);
  const proposal = await store.propose(proposalInput("proposal-r1"), runContext("ui-design"), platform(f.state));
  assert.equal(proposal.status, "published");
  const saved = await store.publishedProposal("proposal-r1", runContext("main"), platform(f.state));
  assert.equal(saved?.revision.source.kind, "draft");
  assert.equal(saved?.revision.artifact.htmlSha256, hash(saved!.revision.artifact.html));
  assert.equal(saved?.revision.reviewByInteractionId.save, "UNKNOWN");
  await assert.rejects(() => store.publishFormal({ revisionId: "formal-r1", expectedBaseRevisionId: null,
    proposalRevisionId: "proposal-r1", approvalRevisionId: "approval-r1" }, runContext("main"), platform(f.state)), /authenticated user approval/);
  await assert.rejects(() => store.approveProposalAction({ revisionId: "approval-agent", expectedBaseRevisionId: null,
    proposalRevisionId: "proposal-r1", htmlSha256: saved!.revision.artifact.htmlSha256, approvedInteractionIds: ["save"] },
  { ...userAction(f.state), actor: { type: "agent", companyId: WORKSPACE, userId: USER } } as unknown as UiActionContext), /authenticated Workspace user/);
  await assert.rejects(() => store.approveProposalAction({ revisionId: "approval-hash", expectedBaseRevisionId: null,
    proposalRevisionId: "proposal-r1", htmlSha256: hash("different"), approvedInteractionIds: ["save"] }, userAction(f.state)), /HTML changed/);
  const approvalInput = { revisionId: "approval-r1", expectedBaseRevisionId: null,
    proposalRevisionId: "proposal-r1", htmlSha256: saved!.revision.artifact.htmlSha256, approvedInteractionIds: ["save", "empty"] };
  const approved = await store.approveProposalAction(approvalInput, userAction(f.state));
  assert.equal(approved.status, "published");
  const approvalReplay = await store.approveProposalAction(approvalInput, userAction(f.state));
  assert.equal(approvalReplay.status, "replayed");
  if (approved.status === "published" && approvalReplay.status === "replayed") {
    assert.equal(approvalReplay.approval.approvedAt, approved.approval.approvedAt);
    assert.deepEqual(approvalReplay.approval, approved.approval);
  }
  await assert.rejects(() => store.approveProposalAction(approvalInput, userAction(f.state, "88888888-8888-4888-8888-888888888888")), /different request or user/);
  await assert.rejects(() => store.approveProposalAction({ ...approvalInput, approvedInteractionIds: ["save"] }, userAction(f.state)), /different request or user/);
  await assert.rejects(() => store.approveProposalAction({ ...approvalInput, expectedBaseRevisionId: "approval-other" }, userAction(f.state)), /different request or user/);
  await assert.rejects(() => store.approveProposalAction(approvalInput,
    { ...userAction(f.state), companyId: "88888888-8888-4888-8888-888888888888" } as unknown as UiActionContext), /authenticated Workspace user/);
  const formal = await store.publishFormal({ revisionId: "formal-r1", expectedBaseRevisionId: null,
    proposalRevisionId: "proposal-r1", approvalRevisionId: "approval-r1" }, runContext("main"), platform(f.state));
  assert.equal(formal.status, "published");
  if (formal.status === "published") {
    assert.equal(formal.revision.sourceProposalRevisionId, "proposal-r1");
    assert.equal(formal.revision.approvalRevisionId, "approval-r1");
    assert.equal(formal.revision.artifact.html, saved!.revision.artifact.html);
    assert.equal(formal.revision.reviewByInteractionId.save, "APPROVED");
  }
});

test("a mismatched optional project scope is rejected before UI journal writes", async () => {
  const f = fixture();
  await seedDraft(f.state);
  const store = createUiContractStore(WORKSPACE, PROJECT, f.state);
  const before = new Map(f.values);
  await assert.rejects(() => store.propose(proposalInput("proposal-wrong-project"),
    { ...runContext("ui-design"), projectId: "88888888-8888-4888-8888-888888888888" }, platform(f.state)), /Workspace or project scope/);
  assert.deepEqual(f.values, before);
  await assert.rejects(() => store.currentFormal({ ...runContext("main"), projectId: "not-a-uuid" }, platform(f.state)), /verified current Host Agent/);
  assert.deepEqual(f.values, before);
});

test("Baseline-backed proposals are supported, while official publication remains Main-only", async () => {
  const f = fixture();
  await seedBaseline(f.state);
  const store = createUiContractStore(WORKSPACE, PROJECT, f.state);
  const proposal = await store.propose(proposalInput("proposal-baseline", "baseline", "baseline-r1", BACKGROUND), runContext("background"), platform(f.state));
  assert.equal(proposal.status, "published");
  await store.approveProposalAction({ revisionId: "approval-baseline", expectedBaseRevisionId: null,
    proposalRevisionId: "proposal-baseline", htmlSha256: sha256Utf8(artifact("proposal-baseline", UI, undefined, "baseline-spec-r1").html),
    approvedInteractionIds: ["save"] }, userAction(f.state));
  await assert.rejects(() => store.publishFormal({ revisionId: "formal-denied", expectedBaseRevisionId: null,
    proposalRevisionId: "proposal-baseline", approvalRevisionId: "approval-baseline" }, runContext("ui-design"), platform(f.state)), /Only the Main/);
  const formal = await store.publishFormal({ revisionId: "formal-baseline", expectedBaseRevisionId: null,
    proposalRevisionId: "proposal-baseline", approvalRevisionId: "approval-baseline" }, runContext("main"), platform(f.state));
  assert.equal(formal.status, "published");
  if (formal.status === "published") assert.equal(formal.revision.source.kind, "baseline");
});

test("only impacted contract elements require reapproval; opaque HTML changes remain UNKNOWN", async () => {
  const f = fixture();
  await seedDraft(f.state);
  const store = createUiContractStore(WORKSPACE, PROJECT, f.state);
  await store.propose(proposalInput("proposal-r1"), runContext("ui-design"), platform(f.state));
  const html = artifact("proposal-r1").html;
  await store.approveProposalAction({ revisionId: "approval-r1", expectedBaseRevisionId: null, proposalRevisionId: "proposal-r1",
    htmlSha256: hash(html), approvedInteractionIds: ["save", "empty"] }, userAction(f.state));
  await store.publishFormal({ revisionId: "formal-r1", expectedBaseRevisionId: null, proposalRevisionId: "proposal-r1", approvalRevisionId: "approval-r1" },
    runContext("main"), platform(f.state));

  await store.propose({ ...proposalInput("proposal-r2", "draft", "draft-r1", UI, true), expectedBaseRevisionId: "proposal-r1",
    artifact: artifact("proposal-r2", UI, artifact("proposal-r1").html) },
    runContext("ui-design"), platform(f.state));
  const changedHtml = artifact("proposal-r1").html;
  await store.approveProposalAction({ revisionId: "approval-r2", expectedBaseRevisionId: "approval-r1", proposalRevisionId: "proposal-r2",
    htmlSha256: hash(changedHtml), approvedInteractionIds: ["save"] }, userAction(f.state));
  const formal = await store.publishFormal({ revisionId: "formal-r2", expectedBaseRevisionId: "formal-r1",
    proposalRevisionId: "proposal-r2", approvalRevisionId: "approval-r2" }, runContext("main"), platform(f.state));
  assert.equal(formal.status, "published");
  if (formal.status === "published") {
    assert.equal(formal.revision.reviewByInteractionId.save, "APPROVED");
    assert.equal(formal.revision.reviewByInteractionId.empty, "APPROVED");
  }

  await store.propose({ ...proposalInput("proposal-r3", "draft", "draft-r1", UI, true), expectedBaseRevisionId: "proposal-r2",
    artifact: artifact("proposal-r3", UI, "<main>unmapped layout change</main>") }, runContext("ui-design"), platform(f.state));
  await store.approveProposalAction({ revisionId: "approval-r3", expectedBaseRevisionId: "approval-r2", proposalRevisionId: "proposal-r3",
    htmlSha256: hash("<main>unmapped layout change</main>"), approvedInteractionIds: ["save", "empty", "future", "unconnected"] }, userAction(f.state));
  const last = await store.publishFormal({ revisionId: "formal-r3", expectedBaseRevisionId: "formal-r2",
    proposalRevisionId: "proposal-r3", approvalRevisionId: "approval-r3" }, runContext("main"), platform(f.state));
  assert.equal(last.status, "published");
  if (last.status === "published") {
    assert.equal(last.revision.reviewByInteractionId.save, "APPROVED");
    assert.equal(last.revision.reviewByInteractionId.empty, "APPROVED");
    assert.equal(last.revision.reviewByInteractionId.future, "UNKNOWN");
    assert.equal(last.revision.reviewByInteractionId.unconnected, "UNCONNECTED");
  }
});

test("a changed requirement source reopens only its linked UI interaction", async () => {
  const f = fixture();
  await seedDraft(f.state);
  const store = createUiContractStore(WORKSPACE, PROJECT, f.state);
  await store.propose(proposalInput("proposal-r1"), runContext("ui-design"), platform(f.state));
  await store.approveProposalAction({ revisionId: "approval-r1", expectedBaseRevisionId: null, proposalRevisionId: "proposal-r1",
    htmlSha256: hash(artifact("proposal-r1").html), approvedInteractionIds: ["save", "empty"] }, userAction(f.state));
  await store.publishFormal({ revisionId: "formal-r1", expectedBaseRevisionId: null, proposalRevisionId: "proposal-r1", approvalRevisionId: "approval-r1" },
    runContext("main"), platform(f.state));

  await seedDraft(f.state, "draft-r2", "A changed workflow requirement.");
  const nextInput = { ...proposalInput("proposal-r2", "draft", "draft-r2"), expectedBaseRevisionId: "proposal-r1",
    artifact: artifact("proposal-r2", UI, artifact("proposal-r1").html, "spec-draft-r2") };
  await store.propose(nextInput, runContext("ui-design"), platform(f.state));
  await store.approveProposalAction({ revisionId: "approval-r2", expectedBaseRevisionId: "approval-r1", proposalRevisionId: "proposal-r2",
    htmlSha256: hash(artifact("proposal-r1").html), approvedInteractionIds: ["save"] }, userAction(f.state));
  const formal = await store.publishFormal({ revisionId: "formal-r2", expectedBaseRevisionId: "formal-r1",
    proposalRevisionId: "proposal-r2", approvalRevisionId: "approval-r2" }, runContext("main"), platform(f.state));
  assert.equal(formal.status, "published");
  if (formal.status === "published") {
    assert.equal(formal.revision.reviewByInteractionId.save, "APPROVED");
    assert.equal(formal.revision.reviewByInteractionId.empty, "APPROVED");
  }
});

test("stale expected heads, stale draft source, forged approval fields, and unknown inputs do not publish", async () => {
  const f = fixture();
  await seedDraft(f.state);
  const store = createUiContractStore(WORKSPACE, PROJECT, f.state);
  await assert.rejects(() => store.propose({ ...proposalInput("proposal-bad"), approved: true }, runContext("ui-design"), platform(f.state)), /fields/);
  assert.equal((await store.propose(proposalInput("proposal-r1"), runContext("ui-design"), platform(f.state))).status, "published");
  assert.equal((await store.propose({ ...proposalInput("proposal-r2"), expectedBaseRevisionId: null }, runContext("ui-design"), platform(f.state))).status, "conflict");
  await store.approveProposalAction({ revisionId: "approval-r1", expectedBaseRevisionId: null, proposalRevisionId: "proposal-r1",
    htmlSha256: hash(artifact("proposal-r1").html), approvedInteractionIds: ["save"] }, userAction(f.state));
  assert.equal((await store.approveProposalAction({ revisionId: "approval-conflict", expectedBaseRevisionId: null,
    proposalRevisionId: "proposal-r1", htmlSha256: hash(artifact("proposal-r1").html), approvedInteractionIds: ["save"] }, userAction(f.state))).status, "conflict");
  await seedDraft(f.state, "draft-r2", "A changed workflow.");
  const stale = await store.publishFormal({ revisionId: "formal-stale", expectedBaseRevisionId: null,
    proposalRevisionId: "proposal-r1", approvalRevisionId: "approval-r1" }, runContext("main"), platform(f.state));
  assert.equal(stale.status, "conflict");
});

test("approval recovers an entry CAS receipt lost after the immutable entry write", async () => {
  const f = fixture();
  await seedDraft(f.state);
  const store = createUiContractStore(WORKSPACE, PROJECT, f.state);
  await store.propose(proposalInput("proposal-entry-loss"), runContext("ui-design"), platform(f.state));
  f.loseNextCasReceipt("ui-approvals-revision.v1.");
  const result = await store.approveProposalAction({ revisionId: "approval-entry-loss", expectedBaseRevisionId: null,
    proposalRevisionId: "proposal-entry-loss", htmlSha256: hash(artifact("proposal-entry-loss").html),
    approvedInteractionIds: ["save"] }, userAction(f.state));
  assert.equal(result.status, "replayed");
  assert.ok(f.lostValue);
  if (result.status === "replayed" && f.lostValue) {
    assert.equal(result.approval.approvedAt, parseUiApproval((f.lostValue as any).revision, PROJECT).approvedAt);
  }
});

test("approval replays an exact request after the head CAS receipt is lost", async () => {
  const f = fixture();
  await seedDraft(f.state);
  const store = createUiContractStore(WORKSPACE, PROJECT, f.state);
  await store.propose(proposalInput("proposal-head-loss"), runContext("ui-design"), platform(f.state));
  f.loseNextCasReceipt("ui-approvals-head.v1.");
  const input = { revisionId: "approval-head-loss", expectedBaseRevisionId: null, proposalRevisionId: "proposal-head-loss",
    htmlSha256: hash(artifact("proposal-head-loss").html), approvedInteractionIds: ["save"] };
  const result = await store.approveProposalAction(input, userAction(f.state));
  assert.equal(result.status, "replayed");
  const replay = await store.approveProposalAction(input, userAction(f.state));
  assert.equal(replay.status, "replayed");
  if (result.status === "replayed" && replay.status === "replayed") {
    assert.deepEqual(replay.approval, result.approval);
    assert.equal(replay.approval.approvedAt, result.approval.approvedAt);
  }
});

test("staged approval lookup is read-only, verifies its digest, and refuses a changed head", async () => {
  const f = fixture();
  const journal = createRevisionJournal(WORKSPACE, PROJECT, f.state, {
    prefix: "ui-approvals", parse: value => parseUiApproval(value, PROJECT), revisionId: value => value.revisionId,
  });
  const stagedApproval = parseUiApproval({ projectId: PROJECT, revisionId: "approval-staged", expectedBaseRevisionId: null,
    proposalRevisionId: "proposal-staged", proposalDigest: hash("proposal"), htmlSha256: hash("html"),
    contractRevisionId: "contract-staged", approvedInteractionIds: ["save"], actorUserId: USER,
    approvedAt: "2026-11-06T00:00:00.000Z" }, PROJECT);
  f.failNextCasWithoutWrite("ui-approvals-head.v1.");
  const failedPublish = await journal.publish({ expectedBaseRevisionId: null, revision: stagedApproval });
  assert.equal(failedPublish.status, "conflict");
  const beforeLookup = new Map(f.values);
  const staged = await journal.stagedRevision("approval-staged", null);
  assert.equal(staged.status, "staged");
  assert.deepEqual(f.values, beforeLookup);
  assert.equal(await journal.current(), null);
  assert.deepEqual(f.values, beforeLookup);

  const entryKey = [...f.values.keys()].find(key => key.includes("ui-approvals-revision.v1."));
  assert.ok(entryKey);
  if (!entryKey) return;
  const original = f.values.get(entryKey)!;
  const tampered = structuredClone(original) as any;
  tampered.revision.actorUserId = "88888888-8888-4888-8888-888888888888";
  f.values.set(entryKey, tampered);
  await assert.rejects(() => journal.stagedRevision("approval-staged", null), /digest mismatch/);
  f.values.set(entryKey, original);

  const differentlyNamed = parseUiApproval({ ...stagedApproval, revisionId: "approval-under-wrong-key" }, PROJECT);
  f.failNextCasWithoutWrite("ui-approvals-head.v1.");
  assert.equal((await journal.publish({ expectedBaseRevisionId: null, revision: differentlyNamed })).status, "conflict");
  const revisionPrefix = `ui-approvals-revision.v1.${hash(PROJECT)}.`;
  const actualEntryKey = JSON.stringify(["company", WORKSPACE, "sonpark.my-builder", `${revisionPrefix}${hash(differentlyNamed.revisionId)}`]);
  const wrongEntryKey = JSON.stringify(["company", WORKSPACE, "sonpark.my-builder", `${revisionPrefix}${hash("approval-wrong-key")}`]);
  const selfConsistentRaw = f.values.get(actualEntryKey);
  assert.ok(selfConsistentRaw);
  if (!selfConsistentRaw) return;
  f.values.set(wrongEntryKey, selfConsistentRaw);
  await assert.rejects(() => journal.stagedRevision("approval-wrong-key", null), /does not match its requested key/);
  f.values.delete(wrongEntryKey);

  const competing = parseUiApproval({ ...stagedApproval, revisionId: "approval-competing" }, PROJECT);
  assert.equal((await journal.publish({ expectedBaseRevisionId: null, revision: competing })).status, "published");
  const beforeStaleLookup = new Map(f.values);
  assert.equal((await journal.stagedRevision("approval-staged", null)).status, "conflict");
  assert.deepEqual(f.values, beforeStaleLookup);
  assert.equal((await journal.current())?.revision.revisionId, "approval-competing");
});
