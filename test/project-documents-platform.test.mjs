import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createBuilderPlatform, proposeLeadDesign, publishLeadDesignBaseline } from "../src/platform.ts";
import { createEmptyBuilderSnapshot } from "../src/domain/snapshot.ts";
import { projectBaselineDocument } from "../src/domain/project-documents-view.ts";
import { LEAD_CHANNELS } from "../src/domain/lead-sessions.ts";

const uuid = n => `${n.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const workspace = uuid(1), agent = uuid(2), runId = uuid(3), requestId = uuid(4);
const hash = text => createHash("sha256").update(text).digest("hex");

async function fixture() {
  const values = new Map();
  const state = {
    async get(key) { return structuredClone(values.get(JSON.stringify(key)) ?? null); },
    async set(key, value) { values.set(JSON.stringify(key), structuredClone(value)); },
    async compareAndSet(key, expected, value) {
      const id = JSON.stringify(key), exists = values.has(id);
      const swapped = expected.exists ? exists && JSON.stringify(values.get(id)) === JSON.stringify(expected.value) : !exists;
      if (swapped) values.set(id, structuredClone(value));
      return { swapped };
    },
  };
  const key = stateKey => ({ scopeKind: "company", scopeId: workspace, namespace: "sonpark.my-builder", stateKey });
  const sessions = Object.fromEntries(LEAD_CHANNELS.map((channel, index) => [channel, uuid(index + 20)]));
  await state.set(key("lead-agent.v1"), { workspaceId: workspace, revision: 1, selectedAgentId: agent });
  await state.set(key("lead-sessions.v1.1"), { workspaceId: workspace, selectionRevision: 1, agentId: agent, sessions });
  const snapshot = createEmptyBuilderSnapshot(workspace);
  snapshot.messages.push({ id: `consultation-${uuid(5)}`, channel: "main", actorId: null, role: "user",
    text: "Document this requirement.", createdAt: "2026-11-06T00:00:00.000Z", runId: null });
  await state.set(key("snapshot.v1"), snapshot);
  await state.set(key(`lead-chat.turn.v1.${requestId}`), { workspaceId: workspace, selectionRevision: 1,
    agentId: agent, sessionId: sessions.main, channel: "main", schemaVersion: 1, requestId,
    previousRequestId: null, sequence: 0, text: "Approve the proposed design.", createdAt: "2026-11-06T00:00:00.000Z",
    state: "submitted", runId, answer: null, outputState: "not_ready", cancellationRequested: false, termination: "not_applicable" });
  const platform = { state, agents: new Proxy({}, { get() { throw new Error("Document production cannot invoke AI."); } }) };
  const context = { companyId: workspace, agentId: agent, runId, sessionId: sessions.main };
  const draft = { projectId: workspace, revisionId: "draft-1", sourceIds: [`consultation-${uuid(5)}`],
    specification: { revisionId: "spec-1", productTier: "M", requirements: [{ id: "REQ-1", description: "Document this requirement.", acceptanceCriteriaIds: ["AC-1"] }],
      targets: ["web-api"], dataPolicyRef: "policy-1" },
    graph: { graphRevisionId: "graph-1", entities: [{ id: "feature-1", kind: "feature", specRef: "REQ-1" }], relations: [], viewLayoutRef: "layout-1" }, questions: [] };
  await proposeLeadDesign({ projectId: workspace, expectedBaseRevisionId: null, draft }, context, platform);
  return { platform, context, snapshot, values };
}

test("Main Baseline publication produces a pinned body and the registered read path exposes actual stored bytes", async () => {
  const f = await fixture();
  const contract = createBuilderPlatform();
  const propose = contract.tools.find(row => row.name === "builder.propose-first-design-review").handler;
  const proposal = await propose({ projectId: workspace, expectedDraftRevisionId: "draft-1", expectedReviewHeadRevisionId: null,
    pack: { packId: "doc-check", version: "1", applicability: {}, rules: [{ id: "doc-rule", requirementIds: ["REQ-1"],
      appliesWhen: {}, requiresCheck: true }], transitions: [], exceptions: [], excludedCombinations: [] },
    sourcePins: [{ requirementId: "REQ-1", acId: "AC-1", sourceId: `consultation-${uuid(5)}` }] }, f.context, f.platform);
  const review = contract.data.find(row => row.key === "builder.first-design-review").handler;
  const shown = await review({ companyId: workspace }, f.platform);
  assert.equal(shown.status, "ready");
  assert.equal(shown.bundle.revisionId, proposal.data.revision.revisionId);
  const approve = contract.actions.find(row => row.key === "builder.approve-first-design-review").handler;
  const input = { proposalRevisionId: shown.proposalRevisionId, expectedHead: shown.expectedHead };
  await assert.rejects(() => approve(input, { ...f.platform, companyId: workspace,
    actor: { type: "agent", companyId: workspace } }), /authenticated user/);
  const approved = await approve(input, { ...f.platform, companyId: workspace,
    actor: { type: "user", companyId: workspace, userId: "fixture-user" } });
  assert.equal(approved.status, "published");
  const result = await publishLeadDesignBaseline({ projectId: workspace, expectedBaseRevisionId: null,
    sourceDraftRevisionId: "draft-1", revisionId: "baseline-1", userSourceId: `first-design-review:${approved.revision.revisionId}`,
    interpretation: "The user confirmed this design." }, f.context, f.platform);
  assert.equal(result.data.status, "published");
  assert.equal(result.data.documentProduction.status, "published");
  const read = contract.data.find(row => row.key === "builder.baseline-document").handler;
  const body = await read({ companyId: workspace }, f.platform);
  assert.equal(body.read.status, "available");
  assert.equal(body.read.source, "current");
  assert.equal(body.read.document.bodySha256, hash(body.read.document.body));
  assert.equal(body.read.document.inventory.status, "partial");
  assert.equal(body.read.document.historicalApproval.status, "unknown");
  const projected = projectBaselineDocument(f.snapshot, body);
  assert.equal(projected.documents[0].category, "design");
  assert.equal(projected.documents[0].sourceKind, "baseline-body");
  assert.equal(projected.documents[0].approvalStatus, "unknown");
  assert.equal(projected.documents[0].freshnessStatus, "current");
  assert.equal(projected.documents[0].sourcePins.length, 6);
  assert.match(projected.documents[0].text, /Document this requirement/);
  assert.equal(projected.documents[0].revisionId, body.read.document.documentRevisionId);
  assert.equal(await read({ companyId: uuid(900) }, f.platform), null);
  assert.throws(() => projectBaselineDocument(f.snapshot, { ...body, workspaceId: uuid(900) }), /Cross-Workspace/);
  const reconcile = contract.actions.find(row => row.key === "builder.reconcile-baseline-document").handler;
  await assert.rejects(() => reconcile({ baselineRevisionId: "baseline-1" }, { ...f.platform,
    companyId: workspace, actor: { type: "agent", companyId: workspace } }), /authenticated user/);
  const replay = await reconcile({ baselineRevisionId: "baseline-1" }, { ...f.platform,
    companyId: workspace, actor: { type: "user", companyId: workspace } });
  assert.equal(replay.replayed, true);
  assert.equal(replay.document.documentRevisionId, body.read.document.documentRevisionId);

  const baselineRead = contract.data.find(row => row.key === "builder.design-baseline").handler;
  const previous = await baselineRead({ companyId: workspace, projectId: workspace }, f.platform);
  assert.equal(previous.baselineDigest, hash(JSON.stringify(previous.baseline)));
  const followup = await propose({ projectId: workspace, expectedDraftRevisionId: "draft-1",
    expectedReviewHeadRevisionId: approved.revision.revisionId,
    pack: { packId: "doc-check", version: "2", applicability: {}, rules: [{ id: "doc-rule-v2", requirementIds: ["REQ-1"],
      appliesWhen: {}, requiresCheck: true }], transitions: [], exceptions: [], excludedCombinations: [] },
    sourcePins: [{ requirementId: "REQ-1", acId: "AC-1", sourceId: `consultation-${uuid(5)}` }] }, f.context, f.platform);
  assert.equal(followup.data.status, "published");
  assert.deepEqual(followup.data.revision.priorBaseline, { revisionId: previous.baseline.revisionId,
    sequence: previous.sequence, digest: hash(JSON.stringify(previous.baseline)) });
  const followupView = await review({ companyId: workspace }, f.platform);
  assert.equal(followupView.status, "ready");
  const followupApproval = await approve({ proposalRevisionId: followupView.proposalRevisionId,
    expectedHead: followupView.expectedHead }, { ...f.platform, companyId: workspace,
    actor: { type: "user", companyId: workspace, userId: "fixture-user" } });
  assert.equal(followupApproval.status, "published");
  const next = await publishLeadDesignBaseline({ projectId: workspace, expectedBaseRevisionId: previous.baseline.revisionId,
    sourceDraftRevisionId: "draft-1", revisionId: "baseline-2",
    userSourceId: `first-design-review:${followupApproval.revision.revisionId}`,
    interpretation: "The user confirmed this updated design and rule version." }, f.context, f.platform);
  assert.equal(next.data.status, "published", JSON.stringify(next));
  const current = await baselineRead({ companyId: workspace, projectId: workspace }, f.platform);
  assert.equal(current.sequence, previous.sequence + 1);
  assert.equal(current.baseline.userDecision.sourceId, `first-design-review:${followupApproval.revision.revisionId}`);
  const inspect = contract.tools.find(row => row.name === "builder.inspect-spec-assurance").handler;
  const d3 = await inspect({ projectId: workspace }, f.context, f.platform);
  assert.ok(d3.data.result.packVersions.some(item => item.packId === "doc-check" && item.version === "2"));
  assert.equal(d3.data.result.status, "UNKNOWN");
  const oldApprovalReplay = await publishLeadDesignBaseline({ projectId: workspace,
    expectedBaseRevisionId: current.baseline.revisionId, sourceDraftRevisionId: "draft-1", revisionId: "baseline-3",
    userSourceId: `first-design-review:${approved.revision.revisionId}`, interpretation: "Stale approval." }, f.context, f.platform);
  assert.equal(oldApprovalReplay.data.status, "conflict");
});
