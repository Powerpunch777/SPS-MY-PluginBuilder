import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import { setupVerifiedWorkstreamPlatform } from "../fixtures/verified-workstream-platform.ts";
import { createDesignBaselineStore } from "../../src/design-baseline-tools.ts";
import type { RevisionState } from "../../src/solution-revision-store.ts";
import { readCurrentBaselinePackReview } from "../../src/spec-assurance/current-baseline-pack-review.ts";
import { createSpecAssurancePackStore, currentBaselineSpecAssurancePackRevisionId,
  specAssurancePackApprovalRevisionId } from "../../src/spec-assurance/pack-store.ts";
import { designModelMaterialDigest, parseDesignModelMaterial } from "../../src/spec-assurance/design-model-material.ts";
import { coverageRulesManifestDigest } from "../../src/spec-coverage/evaluator.ts";
import type { DomainPack } from "../../src/spec-assurance/evaluator.ts";
import { W, now } from "../fixtures/cto-platform.ts";

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

async function publishPackFixture() {
  const f = await setupVerifiedWorkstreamPlatform();
  const state = f.f.state as unknown as RevisionState;
  const baselineStore = createDesignBaselineStore(W, W, state);
  const baselineEntry = (await baselineStore.current())!;
  const baseline = baselineEntry.revision;
  const spec = baseline.specification;
  const identity = { workspaceId: W, projectId: W, specRevisionId: spec.revisionId, specDigest: sha(JSON.stringify(spec)) };
  const scope = { requirementIds: ["REQ-1"], acIds: ["AC-1"] };
  const sourceId = baseline.userDecision.sourceId;
  const sourceRefs = [{ requirementId: "REQ-1", acId: null, sourceId, sourceDigest: baseline.userDecision.sourceSha256,
    revisionId: spec.revisionId }, { requirementId: "REQ-1", acId: "AC-1", sourceId,
    sourceDigest: baseline.userDecision.sourceSha256, revisionId: spec.revisionId }];
  const coverageRules = [{ id: "onboarding-rule", requiresCheck: true, requiredEvidenceKinds: ["specification", "source"] }];
  const coverageTargets = [{ targetKind: "requirement", targetId: "REQ-1", ruleIds: ["onboarding-rule"] },
    { targetKind: "ac", targetId: "AC-1", ruleIds: ["onboarding-rule"] }];
  const manifestBase = { identity, scope, rulesVersion: "review-v1", rules: coverageRules, targets: coverageTargets };
  const rulesManifest = { ...manifestBase, digest: coverageRulesManifestDigest({ ...manifestBase, digest: "0".repeat(64) }) };
  const pack: DomainPack = { packId: "onboarding", version: "1.0.0", identity, applicability: { all: ["onboarding"] },
    rules: [{ id: "onboarding-rule", requirementIds: ["REQ-1"], appliesWhen: { all: [] }, requiresCheck: true,
      modelCases: [{ when: { all: [] }, state: "started", event: "complete", allowedNextStates: ["ready"] }] }],
    transitions: [{ from: "started", event: "complete", to: "ready" }], exceptions: [], excludedCombinations: [] };
  const model = parseDesignModelMaterial({ facts: ["onboarding"], rulesVersion: "review-v1", coverageRules, coverageTargets,
    scenarios: [{ id: "complete-onboarding", state: "started", event: "complete", nextState: "ready", exceptionId: null }],
    itemDecisions: [{ requirementId: "REQ-1", status: "RESOLVED", reason: "User source supports the exact requirement.", sourceIds: [sourceId] }],
    acceptanceCriteria: [{ requirementId: "REQ-1", acId: "AC-1", sourceId, quote: "User-approved test scope for the Builder verification fixture." }] },
    identity, [{ id: "REQ-1", acceptanceCriteriaIds: ["AC-1"] }], pack, sourceRefs, false,
    new Map([[sourceId, "User-approved test scope for the Builder verification fixture."]]));
  const packId = "onboarding", version = "1.0.0", modelDigest = designModelMaterialDigest(model);
  const revisionId = currentBaselineSpecAssurancePackRevisionId(packId, version, identity, baseline.revisionId,
    baselineEntry.sequence, sourceRefs, modelDigest);
  const store = createSpecAssurancePackStore(W, W, state);
  const proposal = { status: "PROPOSED", revisionId, workspaceId: W, projectId: W,
    baselineRevisionId: baseline.revisionId, baselineSequence: baselineEntry.sequence, identity,
    scopeBindings: [{ requirementId: "REQ-1", acIds: ["AC-1"] }], author: baseline.author, createdAt: now,
    pack, rulesManifest, sourceRefs, designModel: model };
  const saved = await store.publish(packId, { expectedBaseRevisionId: null, revision: proposal });
  assert.equal(saved.status, "published");
  return { ...f, state, baselineStore, baseline, baselineEntry, store, proposal: saved.revision };
}

test("review projection includes the exact current proposal, static model, source pins, baseline and approval head", async () => {
  const f = await publishPackFixture();
  const first = await readCurrentBaselinePackReview({ workspaceId: W, projectId: W, packId: "onboarding", platform: f.f.platform });
  assert.equal(first.status, "ready", JSON.stringify({ data: first.data,
    expected: { baseline: f.baseline.revisionId, sequence: f.baselineEntry.sequence,
      specRevision: f.baseline.specification.revisionId, specDigest: sha(JSON.stringify(f.baseline.specification)),
      checks: [f.proposal.workspaceId === W, f.proposal.projectId === W, f.proposal.pack.packId === "onboarding",
        f.proposal.baselineRevisionId === f.baseline.revisionId, f.proposal.baselineSequence === f.baselineEntry.sequence,
        f.proposal.identity.specRevisionId === f.baseline.specification.revisionId,
        f.proposal.identity.specDigest === sha(JSON.stringify(f.baseline.specification))] } }));
  assert(first.data);
  assert.equal(first.data.matchesCurrentBaseline, true);
  assert.equal(first.data.currentBaselineRevisionId, f.baseline.revisionId);
  assert.deepEqual(first.data.current.revision, f.proposal);
  assert.equal((first.data.current.revision as typeof f.proposal).designModel?.scenarios[0]?.id, "complete-onboarding");
  assert.equal((first.data.current.revision as typeof f.proposal).sourceRefs.length, 2);
  assert.equal(first.data.currentApproval, null);

  const approvalBase = { status: "APPROVED" as const, workspaceId: W, projectId: W, packId: "onboarding",
    proposalRevisionId: f.proposal.revisionId, proposalDigest: sha(JSON.stringify(f.proposal)),
    baselineRevisionId: f.baseline.revisionId, baselineSequence: f.baselineEntry.sequence, identity: f.proposal.identity,
    designModelDigest: designModelMaterialDigest(f.proposal.designModel!), user: { userId: "user-1", approvedAt: now,
      agentId: f.proposal.author.agentId, sessionId: f.proposal.author.sessionId, selectionRevision: f.proposal.author.selectionRevision } };
  await f.store.publishApproval("onboarding", { expectedBaseRevisionId: null,
    revision: { ...approvalBase, revisionId: specAssurancePackApprovalRevisionId(approvalBase) } });
  const approved = await readCurrentBaselinePackReview({ workspaceId: W, projectId: W, packId: "onboarding", platform: f.f.platform });
  assert.equal(approved.status, "ready");
  assert.equal((approved.data?.currentApproval?.revision as Record<string, unknown>).proposalRevisionId, f.proposal.revisionId);

  const changedBaseline = { ...f.baseline, revisionId: "followup-baseline-next", sourceDraftRevisionId: "followup-draft-next" };
  await f.baselineStore.publish({ expectedBaseRevisionId: f.baseline.revisionId, revision: changedBaseline });
  const stale = await readCurrentBaselinePackReview({ workspaceId: W, projectId: W, packId: "onboarding", platform: f.f.platform });
  assert.equal(stale.status, "stale");
  assert.equal(stale.data?.matchesCurrentBaseline, false);
  assert.equal((stale.data?.currentApproval?.revision as Record<string, unknown>).proposalRevisionId, f.proposal.revisionId,
    "the prior approval history remains observable but cannot make the stale proposal current");
});

test("missing pack is empty; malformed and cross-project lookup identifiers are rejected", async () => {
  const f = await setupVerifiedWorkstreamPlatform();
  assert.deepEqual(await readCurrentBaselinePackReview({ workspaceId: W, projectId: W, packId: "not-created", platform: f.f.platform }),
    { status: "empty" });
  await assert.rejects(readCurrentBaselinePackReview({ workspaceId: W, projectId: W, packId: "\0", platform: f.f.platform }));
  await assert.rejects(readCurrentBaselinePackReview({ workspaceId: W, projectId: "other-project", packId: "onboarding", platform: f.f.platform }));
});

test("a current first-design-sourced baseline remains inspectable but cannot expose the follow-up confirm control", async () => {
  const f = await publishPackFixture();
  const read = await readCurrentBaselinePackReview({ workspaceId: W, projectId: W, packId: "onboarding", platform: f.f.platform });
  assert.equal(read.status, "ready");
  const temp = await mkdtemp(path.join(import.meta.dirname, "..", "..", "node_modules", ".current-pack-gate-test-"));
  const output = path.join(temp, "panel.mjs");
  try {
    await build({ entryPoints: [path.resolve(import.meta.dirname, "../../src/ui/CurrentBaselinePackReviewPanel.tsx")],
      outfile: output, bundle: true, external: ["react", "react/jsx-runtime"], platform: "node", format: "esm", jsx: "automatic" });
    const { CurrentBaselinePackReviewPanel } = await import(pathToFileURL(output).href);
    const html = renderToStaticMarkup(createElement(CurrentBaselinePackReviewPanel, {
      view: { status: "ready", data: read.data }, onConfirm() { throw new Error("ineligible confirmation must not be called"); },
    }));
    assert.match(html, /Main 사용자 결정 출처에 연결되지 않아 확인할 수 없습니다/u);
    assert.match(html, /<button[^>]*disabled=""/u);
    assert.match(html, /first-design-review:/u);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
