import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsActionContext, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { readG5ChangeImpactCandidates } from "../src/g5-change-impact-tools.ts";
import { LEAD_CHANNELS } from "../src/domain/lead-sessions.ts";
import { parseDesignBaseline } from "../src/domain/design-baseline.ts";
import { createDesignBaselineStore } from "../src/design-baseline-tools.ts";
import { createUiContractStore } from "../src/ui-contracts/store.ts";
import { sha256Utf8 } from "../src/ui-contracts/domain.ts";
import { createBuilderPlatform } from "../src/platform.ts";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "33333333-3333-4333-8333-333333333333";
const RUN = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const MAIN = "66666666-6666-4666-8666-666666666666";
const REVIEW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = COMPANY;
const OTHER_PROJECT = "77777777-7777-4777-8777-777777777777";
const USER = "99999999-9999-4999-8999-999999999999";
const userAction = createBuilderPlatform().actions!.find(action => action.key === "builder.read-change-impact")!.handler;
const userContext = (state: SpsActionContext["state"]) => ({
  companyId: COMPANY, actor: { type: "user", companyId: COMPANY, userId: USER }, state,
}) as SpsActionContext;
const address = (key: SpsStateKey) => JSON.stringify(key);
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function fixture(sessionId = MAIN) {
  const values = new Map<string, JsonValue>();
  let reads = 0;
  const key = (stateKey: string) => ({ scopeKind: "company" as const, scopeId: COMPANY,
    namespace: "sonpark.my-builder", stateKey });
  const state = { async get(stateKey: SpsStateKey) { reads += 1; return structuredClone(values.get(address(stateKey)) ?? null); } };
  const sessions = Object.fromEntries(LEAD_CHANNELS.map((channel, index) => [channel,
    channel === "main" ? MAIN : channel === "integration-review" ? REVIEW : `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`]));
  values.set(address(key("lead-agent.v1")), { workspaceId: COMPANY, revision: 1, selectedAgentId: AGENT });
  values.set(address(key("lead-sessions.v1.1")), { workspaceId: COMPANY, selectionRevision: 1, agentId: AGENT, sessions });
  const platform = { state, events: {}, agents: {} } as unknown as SpsPlatformInvocationContext;
  const runContext = { companyId: COMPANY, agentId: AGENT, runId: RUN, sessionId };
  const params = { projectId: PROJECT, oldBaselineRevisionId: "base-old", newBaselineRevisionId: "base-new",
    oldUiRevisionId: "ui-old", newUiRevisionId: "ui-new" };
  return { values, key, platform, runContext, params, get reads() { return reads; } };
}

test("server reader rejects caller snapshots and unknown params before any state read", async () => {
  const f = fixture();
  await assert.rejects(() => readG5ChangeImpactCandidates({ ...f.params, snapshots: { requirements: [] } }, f.runContext, f.platform), /Invalid Builder tool fields/);
  assert.equal(f.reads, 0);
});

test("only Main and Integration Review can request the authenticated source comparison", async () => {
  const f = fixture("00000000-0000-4000-8000-000000000009");
  await assert.rejects(() => readG5ChangeImpactCandidates(f.params, f.runContext, f.platform), /prepared current Lead session/);
  assert.equal(f.reads, 2);
});

test("Main reader resolves the exact pinned published Baseline from its Workspace journal", async () => {
  const f = fixture();
  await assert.rejects(() => readG5ChangeImpactCandidates(f.params, f.runContext, f.platform), /Both exact Baseline revisions must exist/);
  assert(f.reads >= 2);
});

test("Integration Review is authorized for read-only comparison but receives no execution authority", async () => {
  const f = fixture(REVIEW);
  await assert.rejects(() => readG5ChangeImpactCandidates(f.params, f.runContext, f.platform), /Both exact Baseline revisions must exist/);
  assert(f.reads >= 2);
});

test("project mismatch in authenticated Lead context is rejected before source reads", async () => {
  const f = fixture();
  const context = { ...f.runContext, projectId: "88888888-8888-4888-8888-888888888888" };
  await assert.rejects(() => readG5ChangeImpactCandidates(f.params, context, f.platform), /does not match the authenticated Lead context/);
  assert.equal(f.reads, 0);
});

test("registered comparison rejects an Agent, cross-project lookup, and forged source records without state reads", async () => {
  const f = fixture();
  const context = userContext(f.platform.state);
  await assert.rejects(async () => userAction(f.params, { ...context, actor: { ...context.actor, type: "agent" } } as SpsActionContext), /authenticated user action/);
  await assert.rejects(async () => userAction({ ...f.params, projectId: OTHER_PROJECT }, context), /does not match the authenticated Workspace/);
  await assert.rejects(async () => userAction({ ...f.params, snapshots: {} }, context), /Invalid Builder tool fields/);
  assert.equal(f.reads, 0);
});

test("reads paired Baselines and user-approved formal UI from their exact published journals", async () => {
  const f = fixture();
  const state = {
    async get(key: SpsStateKey) { return structuredClone(f.values.get(address(key)) ?? null); },
    async compareAndSet(key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
      const id = address(key), current = f.values.get(id), exists = f.values.has(id);
      const swapped = expected.exists ? exists && JSON.stringify(current) === JSON.stringify(expected.value) : !exists;
      if (swapped) f.values.set(id, structuredClone(value));
      return { swapped };
    },
  };
  const platform = { ...f.platform, state } as unknown as SpsPlatformInvocationContext;
  const baselineStore = createDesignBaselineStore(COMPANY, PROJECT, state);
  const publishBaseline = async (revisionId: string, description: string, expectedBaseRevisionId: string | null) => {
    const specification = { projectId: PROJECT, revisionId: `spec-${revisionId}`, productTier: "M",
      requirements: [{ id: "REQ-1", description, acceptanceCriteriaIds: ["AC-1"] }], targets: ["sps-plugin"],
      dataPolicyRef: "policy-unreviewed", approvalEvidenceRef: `lead-turn:${RUN}` };
    const baseline = parseDesignBaseline({ projectId: PROJECT, revisionId, sourceDraftRevisionId: `draft-${revisionId}`,
      draftDigest: sha(`draft-${revisionId}`), createdAt: "2026-11-06T00:00:00.000Z",
      author: { agentId: AGENT, sessionId: MAIN, runId: RUN, selectionRevision: 1 },
      userDecision: { sourceId: `lead-turn:${RUN}`, sourceSha256: sha(description), interpretation: description },
      specification, graph: { approvedSpecRevisionId: specification.revisionId, graphRevisionId: `graph-${revisionId}`,
        entities: [], relations: [], viewLayoutRef: "layout" },
    }, PROJECT);
    return baselineStore.publish({ expectedBaseRevisionId, revision: baseline });
  };
  const sessions = { ...Object.fromEntries(LEAD_CHANNELS.map(channel => [channel, null])),
    main: MAIN, "ui-design": "44444444-4444-4444-8444-444444444444", "integration-review": REVIEW };
  f.values.set(address(f.key("lead-sessions.v1.1")), { workspaceId: COMPANY, selectionRevision: 1, agentId: AGENT, sessions });
  const uiRun = { ...f.runContext, sessionId: sessions["ui-design"] };
  const ui = createUiContractStore(COMPANY, PROJECT, state);
  const publishApprovedUi = async (revisionId: string, description: string, previousFormalId: string | null) => {
    const baseline = await baselineStore.current();
    assert(baseline);
    const html = `<main>${description}</main>`;
    const proposal = await ui.propose({ revisionId: `proposal-${revisionId}`,
      expectedBaseRevisionId: previousFormalId ? "proposal-ui-old" : null,
      source: { kind: "baseline", revisionId: baseline.revision.revisionId },
      artifact: { artifactId: `artifact-${revisionId}`, html, htmlSha256: sha256Utf8(html), screenIds: ["home"],
        viewport: { width: 1280, height: 800 }, sourceSessionId: sessions["ui-design"],
        sourceSpecRevisionId: baseline.revision.specification.revisionId },
      contract: { projectId: PROJECT, revisionId: `contract-${revisionId}`, screenIds: ["home"], interactions: [
        { id: "save", screenId: "home", requirementRefs: ["REQ-1"], behaviorRefs: [], stateRefs: [], apiRefs: [],
          preconditions: [], outcomes: [description], prohibited: [], validationCriteria: ["save exactly"], status: "specified" },
      ] },
    }, uiRun, platform);
    assert.equal(proposal.status, "published");
    const approved = await ui.approveProposalAction({ revisionId: `approval-${revisionId}`,
      expectedBaseRevisionId: previousFormalId ? "approval-ui-old" : null,
      proposalRevisionId: `proposal-${revisionId}`, htmlSha256: sha256Utf8(html), approvedInteractionIds: ["save"] },
    { companyId: COMPANY, actor: { type: "user", companyId: COMPANY, userId: "99999999-9999-4999-8999-999999999999" }, state } as unknown as
      Pick<SpsActionContext, "companyId" | "actor"> & { state: SpsPlatformInvocationContext["state"] });
    assert.equal(approved.status, "published");
    const formal = await ui.publishFormal({ revisionId, expectedBaseRevisionId: previousFormalId,
      proposalRevisionId: `proposal-${revisionId}`, approvalRevisionId: `approval-${revisionId}` }, f.runContext, platform);
    assert.equal(formal.status, "published");
  };

  await publishBaseline("baseline-old", "old requirement", null);
  await publishApprovedUi("ui-old", "old UI", null);
  await publishBaseline("baseline-new", "new requirement", "baseline-old");
  await publishApprovedUi("ui-new", "new UI", "ui-old");
  const request = { ...f.params, oldBaselineRevisionId: "baseline-old",
    newBaselineRevisionId: "baseline-new", oldUiRevisionId: "ui-old", newUiRevisionId: "ui-new" };
  const beforeCompare = structuredClone(f.values);
  const result = await readG5ChangeImpactCandidates(request, f.runContext, platform);
  const fromUser = await userAction(request, userContext(platform.state));
  assert.deepEqual(fromUser, result.data);
  assert.deepEqual(f.values, beforeCompare, "comparison must not publish or modify any record");
  const data = result.data as unknown as { dimensions: Record<string, { status: string; candidates: readonly { recordId: string }[] }>;
    productExecutionAuthorized: boolean; sourcePins: { formalUi: readonly { approvalRevisionId: string | null }[] } };
  assert.equal(data.dimensions.requirements.status, "UNKNOWN");
  assert.deepEqual(data.dimensions.requirements.candidates.map(candidate => candidate.recordId), ["REQ-1"]);
  assert.equal(data.dimensions.ui.status, "UNKNOWN");
  assert.equal(data.dimensions.ui.candidates[0]?.recordId, "save");
  assert.equal(data.dimensions.scheduleProductScope.status, "UNKNOWN");
  assert.equal(data.productExecutionAuthorized, false);
  assert.deepEqual(data.sourcePins.formalUi.map(pin => pin.approvalRevisionId), ["approval-ui-old", "approval-ui-new"]);
});
