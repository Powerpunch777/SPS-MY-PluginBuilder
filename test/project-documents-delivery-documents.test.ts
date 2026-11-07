import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { fixture, W, A, C, S, R, ctx } from "./fixtures/cto-platform.ts";
import { createRevisionJournal } from "../src/solution-revision-store.ts";
import { parseUiRevision, type UiRevision } from "../src/ui-contracts/domain.ts";
import { createIntegrationPlanStore, type IntegrationPlan } from "../src/builder-gates/integration-plan.ts";
import { proposeDeliveryDocuments, readCurrentDeliveryDocuments } from "../src/project-documents/delivery-documents.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const SOURCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMMIT = "1".repeat(40), TREE = "2".repeat(40);

async function setup(withGit = true) {
  const f = await fixture(W);
  const baseline = f.baseline;
  const html = "<main>delivery docs fixture</main>";
  const ui = parseUiRevision({ projectId: W, revisionId: "formal-ui-delivery-fixture",
    source: { kind: "baseline", revisionId: baseline.revisionId, digest: hash(baseline),
      specRevisionId: baseline.specification.revisionId, selectionRevision: null, agentId: null },
    previousRevisionId: null, sourceProposalRevisionId: "ui-proposal-fixture", approvalRevisionId: "ui-approval-fixture",
    publication: "formal", artifact: { artifactId: "ui-artifact-fixture", html,
      htmlSha256: createHash("sha256").update(html).digest("hex"), screenIds: ["home"],
      viewport: { width: 1280, height: 720 }, sourceSessionId: C, sourceSpecRevisionId: baseline.specification.revisionId },
    contract: { projectId: W, revisionId: "ui-contract-fixture", screenIds: ["home"], interactions: [] }, reviewByInteractionId: {} }, W);
  await createRevisionJournal<UiRevision>(W, W, f.state, { prefix: "ui-contracts", parse: value => parseUiRevision(value, W),
    revisionId: value => value.revisionId }).publish({ expectedBaseRevisionId: null, revision: ui });
  let commitSha = COMMIT, treeSha = TREE;
  const platform = { ...f.platform, localFolders: withGit ? {
    async matchWorkspaceSourceV1(folderKey: string, sourceId: string) { return { folderKey, workspaceSourceId: sourceId, match: "same_root" }; },
    async readWorkspaceSourceGitTipV1(sourceId: string, folderKey: string, branch: string) {
      return { status: "current", sourceId, folderKey, branch, commitSha, treeSha, observedAt: "2026-11-07T12:00:00.000Z" };
    },
  } : undefined } as unknown as SpsPlatformInvocationContext;
  const planContent = { schemaVersion: 1 as const, workspaceId: W, baselineRevisionId: baseline.revisionId,
    baselineDigest: hash(baseline), uiRevisionId: ui.revisionId, uiDigest: hash(ui), sourceId: SOURCE, folderKey: "workspace-source",
    baseBranch: "main", baseCommit: COMMIT, baseTree: TREE, candidateBranch: "integration/candidate",
    author: { agentId: A, sessionId: S, runId: R, selectionRevision: 1 } };
  const plan: IntegrationPlan = { ...planContent, revisionId: `integration-plan-v1:${hash(planContent)}` };
  await createIntegrationPlanStore(W, f.state).publish({ expectedBaseRevisionId: null, revision: plan });
  const documents = [
    { kind: "installation-guide" as const, path: "docs/install.md", classification: "delivery-guide", scope: "Supported installation steps for this target", body: "# Installation\n\nInstall the package using the documented host workflow.\n" },
    { kind: "user-guide" as const, path: "docs/use.md", classification: "delivery-guide", scope: "User-facing operation for the current product scope", body: "# User guide\n\nOpen the application and use its documented workflow.\n" },
  ];
  return { ...f, platform, plan, documents, setTip(commit: string, tree: string) { commitSha = commit; treeSha = tree; } };
}

test("Main saves immutable guide drafts pinned to current Baseline, formal UI, plan and Host Source tip", async () => {
  const f = await setup();
  const result = await proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: null, documents: f.documents }, ctx(), f.platform);
  assert.equal(result.status, "published");
  if (result.status !== "published") return;
  assert.equal(result.source, "current");
  assert.equal(result.revision.status, "draft");
  assert.equal(result.revision.approvalStatus, "unapproved");
  assert.equal(result.revision.completeness.status, "unknown");
  assert.equal(result.revision.baseline.revisionId, f.baseline.revisionId);
  assert.equal(result.revision.integrationPlan.revisionId, f.plan.revisionId);
  assert.deepEqual(result.revision.documents.map(document => document.kind), ["installation-guide", "user-guide"]);
  assert.ok(result.revision.documents.every(document => document.bodySha256 === createHash("sha256").update(document.body, "utf8").digest("hex")));
  assert.deepEqual(result.revision.author, { agentId: A, sessionId: S, runId: R, selectionRevision: 1 });
  const read = await readCurrentDeliveryDocuments(W, f.platform);
  assert.equal(read.status, "available");
  assert.equal(read.source, "current");
  assert.equal(read.confirmed, false);
  assert.equal(read.completeness, "unknown");
  assert.equal(read.document?.revisionId, result.revision.revisionId);
  const replay = await proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: null, documents: f.documents }, ctx(), f.platform);
  assert.equal(replay.status, "published");
  if (replay.status === "published") assert.equal(replay.replayed, true);
});

test("a changed Source Git tip is stale and does not replace the immutable document", async () => {
  const f = await setup();
  const first = await proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: null, documents: f.documents }, ctx(), f.platform);
  assert.equal(first.status, "published");
  if (first.status !== "published") return;
  f.setTip("3".repeat(40), "4".repeat(40));
  const read = await readCurrentDeliveryDocuments(W, f.platform);
  assert.equal(read.status, "available");
  assert.equal(read.source, "stale");
  assert.equal(read.document?.revisionId, first.revision.revisionId);
  assert.equal(read.document?.documents[0]?.body, f.documents[0]?.body);
  const changed = await proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: first.revision.revisionId,
    documents: f.documents }, ctx(), f.platform);
  assert.equal(changed.status, "conflict");
});

test("a lost response after the journal head CAS is recovered by replaying the same immutable revision", async () => {
  const f = await setup();
  let lost = false;
  f.setAfterCas(async input => {
    if (!lost && input.stateKey.startsWith("project-document-delivery-head.v1.")) {
      lost = true;
      throw new Error("fixture: response lost after commit");
    }
  });
  const params = { projectId: W, expectedBaseRevisionId: null, documents: f.documents };
  await assert.rejects(proposeDeliveryDocuments(params, ctx(), f.platform), /response lost after commit/u);
  f.setAfterCas(async () => {});
  const replay = await proposeDeliveryDocuments(params, ctx(), f.platform);
  assert.equal(replay.status, "published");
  if (replay.status !== "published") return;
  assert.equal(replay.replayed, true);
  assert.equal(replay.sequence, 1);
  assert.equal((await readCurrentDeliveryDocuments(W, f.platform)).document?.revisionId, replay.revision.revisionId);
});

test("stale document journal CAS is reported without replacing the current revision", async () => {
  const f = await setup();
  const first = await proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: null, documents: f.documents }, ctx(), f.platform);
  assert.equal(first.status, "published");
  if (first.status !== "published") return;
  const changedDocs = f.documents.map(item => item.kind === "user-guide" ? { ...item, body: `${item.body}\nA revised paragraph.\n` } : item);
  const conflict = await proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: null, documents: changedDocs }, ctx(), f.platform);
  assert.equal(conflict.status, "conflict");
  const current = await readCurrentDeliveryDocuments(W, f.platform);
  assert.equal(current.document?.revisionId, first.revision.revisionId);
  assert.equal(current.document?.documents[1]?.body, f.documents[1]?.body);
});

test("missing Git tip contract is unsupported, not caller-overridable", async () => {
  const f = await setup(false);
  const result = await proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: null, documents: f.documents }, ctx(), f.platform);
  assert.deepEqual(result, { status: "unsupported", reason: "Host Workspace Source/Git tip reader is unavailable." });
  const read = await readCurrentDeliveryDocuments(W, f.platform);
  assert.equal(read.status, "unavailable");
  assert.equal(read.source, "unknown");
});

test("drafts require substantive installation and user guide bodies and Main authority", async () => {
  const f = await setup();
  await assert.rejects(proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: null,
    documents: f.documents.map(item => item.kind === "user-guide" ? { ...item, body: "  " } : item) }, ctx(), f.platform), /non-empty/u);
  await assert.rejects(proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: null, documents: f.documents },
    { ...ctx(), sessionId: C }, f.platform), /current Lead session|prepared current Lead session|Main/u);
  assert.equal((await readCurrentDeliveryDocuments(W, f.platform)).status, "unavailable");
});
