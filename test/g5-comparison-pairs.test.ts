import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { parseDesignBaseline } from "../src/domain/design-baseline.ts";
import { createDesignBaselineStore } from "../src/design-baseline-tools.ts";
import { readG5ComparisonPairs, readUserG5ComparisonPairs } from "../src/g5-comparison-pairs.ts";
import { LEAD_CHANNELS } from "../src/domain/lead-sessions.ts";
import { createRevisionJournal, type RevisionState } from "../src/solution-revision-store.ts";
import { parseUiApproval, parseUiRevision, sha256Utf8 } from "../src/ui-contracts/domain.ts";
import { createUiContractStore } from "../src/ui-contracts/store.ts";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const MAIN = "33333333-3333-4333-8333-333333333333";
const UI = "44444444-4444-4444-8444-444444444444";
const RUN = "55555555-5555-4555-8555-555555555555";
const USER = "66666666-6666-4666-8666-666666666666";
const address = (key: SpsStateKey) => JSON.stringify(key);
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function fixture() {
  const values = new Map<string, JsonValue>();
  const key = (stateKey: string): SpsStateKey => ({ scopeKind: "company", scopeId: COMPANY,
    namespace: "sonpark.my-builder", stateKey });
  const sessions = Object.fromEntries(LEAD_CHANNELS.map(channel => [channel,
    channel === "main" ? MAIN : channel === "ui-design" ? UI : null]));
  values.set(address(key("lead-agent.v1")), { workspaceId: COMPANY, revision: 1, selectedAgentId: AGENT });
  values.set(address(key("lead-sessions.v1.1")), { workspaceId: COMPANY, selectionRevision: 1, agentId: AGENT, sessions });
  const state: RevisionState = {
    async get(stateKey) { return structuredClone(values.get(address(stateKey)) ?? null); },
    async compareAndSet(stateKey, expected, value) {
      const id = address(stateKey), current = values.get(id), exists = values.has(id);
      const matches = expected.exists ? exists && JSON.stringify(current) === JSON.stringify(expected.value) : !exists;
      if (matches) values.set(id, structuredClone(value));
      return { swapped: matches };
    },
  };
  return { state, values, key, platform: { state, events: {}, agents: {} } as unknown as SpsPlatformInvocationContext,
    runContext: { companyId: COMPANY, agentId: AGENT, runId: RUN, sessionId: MAIN } };
}

async function publishBaseline(f: ReturnType<typeof fixture>, revisionId: string, parent: string | null) {
  const sourceId = `lead-turn:${RUN}`;
  const specification = { projectId: COMPANY, revisionId: `spec-${revisionId}`, productTier: "M",
    requirements: [{ id: "REQ-1", description: "Requirement", acceptanceCriteriaIds: ["AC-1"] }],
    targets: ["sps-plugin"], dataPolicyRef: "policy", approvalEvidenceRef: sourceId };
  const revision = parseDesignBaseline({ projectId: COMPANY, revisionId, sourceDraftRevisionId: `draft-${revisionId}`,
    draftDigest: hash(`draft-${revisionId}`), createdAt: "2026-11-06T00:00:00.000Z",
    author: { agentId: AGENT, sessionId: MAIN, runId: RUN, selectionRevision: 1 },
    userDecision: { sourceId, sourceSha256: hash(revisionId), interpretation: "Exact test baseline." },
    specification, graph: { approvedSpecRevisionId: specification.revisionId, graphRevisionId: `graph-${revisionId}`,
      entities: [], relations: [], viewLayoutRef: "layout" } }, COMPANY);
  return createDesignBaselineStore(COMPANY, COMPANY, f.state).publish({ expectedBaseRevisionId: parent, revision });
}

async function publishApprovedFormalUi(f: ReturnType<typeof fixture>, baselineId: string,
  formalId: string, suffix: string, approvalId = `approval-${suffix}`) {
  const baseline = await createDesignBaselineStore(COMPANY, COMPANY, f.state).publishedRevision(baselineId);
  assert(baseline);
  const store = createUiContractStore(COMPANY, COMPANY, f.state);
  const context = { ...f.runContext, sessionId: MAIN };
  const revisionJournal = <T>(prefix: string, parse: (value: unknown) => T, revisionId: (value: T) => string) =>
    createRevisionJournal(COMPANY, COMPANY, f.state, { prefix, parse, revisionId });
  const proposalHead = await revisionJournal("ui-proposals", value => parseUiRevision(value, COMPANY), value => value.revisionId).current();
  const approvalHead = await revisionJournal("ui-approvals", value => parseUiApproval(value, COMPANY), value => value.revisionId).current();
  const formalHead = await revisionJournal("ui-contracts", value => parseUiRevision(value, COMPANY), value => value.revisionId).current();
  const proposalId = `proposal-${suffix}`, contractId = `contract-${suffix}`;
  const html = `<main>${suffix}</main>`;
  const proposal = await store.propose({ revisionId: proposalId, expectedBaseRevisionId: proposalHead?.revision.revisionId ?? null,
    source: { kind: "baseline", revisionId: baselineId },
    artifact: { artifactId: `artifact-${suffix}`, html, htmlSha256: sha256Utf8(html), screenIds: ["home"],
      viewport: { width: 1280, height: 800 }, sourceSessionId: UI, sourceSpecRevisionId: baseline.revision.specification.revisionId },
    contract: { projectId: COMPANY, revisionId: contractId, screenIds: ["home"], interactions: [
      { id: `interaction-${suffix}`, screenId: "home", requirementRefs: ["REQ-1"], behaviorRefs: [], stateRefs: [], apiRefs: [],
        preconditions: [], outcomes: ["works"], prohibited: [], validationCriteria: ["exact"], status: "specified" },
    ] } }, { ...f.runContext, sessionId: UI }, f.platform);
  assert.equal(proposal.status, "published");
  const userContext = { companyId: COMPANY, actor: { type: "user", companyId: COMPANY, userId: USER }, state: f.state } as never;
  const approval = await store.approveProposalAction({ revisionId: approvalId, expectedBaseRevisionId: approvalHead?.revision.revisionId ?? null,
    proposalRevisionId: proposalId, htmlSha256: sha256Utf8(html), approvedInteractionIds: [`interaction-${suffix}`] }, userContext);
  assert.equal(approval.status, "published");
  return store.publishFormal({ revisionId: formalId, expectedBaseRevisionId: formalHead?.revision.revisionId ?? null,
    proposalRevisionId: proposalId, approvalRevisionId: approvalId }, f.runContext, f.platform);
}

test("selector returns only exact approved formal UI bindings and ordered pair options", async () => {
  const f = fixture();
  await publishBaseline(f, "base-1", null);
  await publishApprovedFormalUi(f, "base-1", "formal-1", "one");
  await publishBaseline(f, "base-2", "base-1");
  await publishApprovedFormalUi(f, "base-2", "formal-2", "two");
  const before = structuredClone(f.values);
  const result = await readG5ComparisonPairs({ projectId: COMPANY }, f.runContext, f.platform);
  const data = result.data as unknown as { selectableBaselines: Array<{ baselineRevisionId: string; approvedFormalUi: Array<{ formalUiRevisionId: string; approvalRevisionId: string }> }>;
    comparisonPairs: Array<{ oldBaselineRevisionId: string; newBaselineRevisionId: string; selected: boolean }>;
    coverage: { complete: boolean; currentPairInferred: boolean; writesPerformed: boolean } };
  assert.deepEqual(data.selectableBaselines.map(row => [row.baselineRevisionId, row.approvedFormalUi[0]?.formalUiRevisionId]),
    [["base-2", "formal-2"], ["base-1", "formal-1"]]);
  assert.deepEqual(data.comparisonPairs.map(pair => [pair.oldBaselineRevisionId, pair.newBaselineRevisionId, pair.selected]),
    [["base-1", "base-2", false]]);
  assert.equal(data.coverage.complete, true);
  assert.equal(data.coverage.currentPairInferred, false);
  assert.equal(data.coverage.writesPerformed, false);
  assert.deepEqual(f.values, before);
  const partial = await readG5ComparisonPairs({ projectId: COMPANY, limit: 1 }, f.runContext, f.platform);
  const coverage = (partial.data as unknown as { coverage: { complete: boolean; baselineHasMore: boolean; formalUiHasMore: boolean } }).coverage;
  assert.equal(coverage.complete, false);
  assert.ok(coverage.baselineHasMore || coverage.formalUiHasMore);
});

test("orphan or mismatched approval records are omitted and reported", async () => {
  const f = fixture();
  await publishBaseline(f, "base-1", null);
  await publishApprovedFormalUi(f, "base-1", "formal-1", "one");
  const formalJournal = createRevisionJournal(COMPANY, COMPANY, f.state, { prefix: "ui-contracts",
    parse: value => parseUiRevision(value, COMPANY), revisionId: value => value.revisionId });
  const approvalJournal = createRevisionJournal(COMPANY, COMPANY, f.state, { prefix: "ui-approvals",
    parse: value => parseUiApproval(value, COMPANY), revisionId: value => value.revisionId });
  const approval = await approvalJournal.publishedRevision("approval-one");
  const formal = await formalJournal.publishedRevision("formal-1");
  assert(approval);
  assert(formal);
  const tampered = parseUiApproval({ ...approval.revision, proposalDigest: "0".repeat(64) }, COMPANY);
  await approvalJournal.publish({ expectedBaseRevisionId: "approval-one", revision: { ...tampered, revisionId: "approval-tampered" } });
  const orphan = parseUiRevision({ ...formal.revision, revisionId: "formal-orphan", previousRevisionId: "formal-1",
    approvalRevisionId: "approval-tampered" }, COMPANY);
  await formalJournal.publish({ expectedBaseRevisionId: "formal-1", revision: orphan });
  const result = await readG5ComparisonPairs({ projectId: COMPANY }, f.runContext, f.platform);
  const data = result.data as unknown as { selectableBaselines: Array<{ baselineRevisionId: string; approvedFormalUi: unknown[] }>;
    coverage: { excluded: { mismatchedApprovalProposalOrArtifact: number } } };
  assert.equal(data.selectableBaselines.find(row => row.baselineRevisionId === "base-1")?.approvedFormalUi.length, 1,
    "the mismatched formal revision is omitted while the exact original remains selectable");
  assert.equal(data.coverage.excluded.mismatchedApprovalProposalOrArtifact, 1);
});

test("strict bounds and Lead channel authorization reject caller guesses", async () => {
  const f = fixture();
  await assert.rejects(() => readG5ComparisonPairs({ projectId: COMPANY, limit: 51 }, f.runContext, f.platform), /limit must be/);
  await assert.rejects(() => readG5ComparisonPairs({ projectId: "another-workspace" }, f.runContext, f.platform), /authenticated Workspace/u);
  await assert.rejects(() => readG5ComparisonPairs({ projectId: COMPANY, oldBaselineRevisionId: "guessed" }, f.runContext, f.platform), /Invalid Builder tool fields/);
  await assert.rejects(() => readG5ComparisonPairs({ projectId: COMPANY }, { ...f.runContext,
    sessionId: "99999999-9999-4999-8999-999999999999" }, f.platform), /prepared current Lead session/);
});

test("authenticated selector action is read-only and strictly Workspace-bound", async () => {
  const f = fixture();
  const context = { companyId: COMPANY, actor: { type: "user", companyId: COMPANY, userId: USER }, state: f.state };
  const before = structuredClone(f.values);
  const result = await readUserG5ComparisonPairs({ projectId: COMPANY }, context);
  assert.equal(result.projectId, COMPANY);
  assert.deepEqual(f.values, before);
  await assert.rejects(() => readUserG5ComparisonPairs({ projectId: "another-workspace" }, context), /authenticated Workspace/u);
  await assert.rejects(() => readUserG5ComparisonPairs({ projectId: COMPANY }, {
    ...context, actor: { type: "agent", companyId: COMPANY, userId: USER },
  }), /authenticated Workspace user/u);
  await assert.rejects(() => readUserG5ComparisonPairs({ projectId: COMPANY }, {
    ...context, actor: { type: "user", companyId: "another-workspace", userId: USER },
  }), /authenticated Workspace user/u);
});

