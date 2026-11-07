import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { fixture, W, A, C, S, R, ctx } from "./fixtures/cto-platform.ts";
import { createRevisionJournal } from "../src/solution-revision-store.ts";
import { parseUiRevision, type UiRevision } from "../src/ui-contracts/domain.ts";
import { createIntegrationPlanStore, type IntegrationPlan } from "../src/builder-gates/integration-plan.ts";
import { proposeDeliveryDocuments, readCurrentDeliveryDocuments } from "../src/project-documents/delivery-documents.ts";
import { createBuilderPlatform } from "../src/platform.ts";
import { key, mapKey } from "./fixtures/cto-platform.ts";

const { default: manifest } = await import(new URL("../src/manifest.mjs", import.meta.url).href);
const manifestTools = (manifest as { tools: Array<{ name: string }> }).tools;

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
  let candidate: { status: "missing" | "current" | "denied"; reason?: string; commitSha?: string; treeSha?: string } = { status: "missing" };
  const platform = { ...f.platform, localFolders: withGit ? {
    async matchWorkspaceSourceV1(folderKey: string, sourceId: string) { return { folderKey, workspaceSourceId: sourceId, match: "same_root" }; },
    async readWorkspaceSourceGitTipV1(sourceId: string, folderKey: string, branch: string) {
      if (branch === "integration/candidate") return candidate.status === "missing"
        ? { status: "denied", reason: "branch_unavailable", sourceId, folderKey, branch }
        : candidate.status === "denied" ? { status: "denied", reason: candidate.reason, sourceId, folderKey, branch }
          : { status: "current", sourceId, folderKey, branch, commitSha: candidate.commitSha, treeSha: candidate.treeSha,
            observedAt: "2026-11-07T12:00:00.000Z" };
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
  return { ...f, platform, plan, documents, setTip(commit: string, tree: string) { commitSha = commit; treeSha = tree; },
    setCandidate(commit: string, tree: string) { candidate = { status: "current", commitSha: commit, treeSha: tree }; },
    denyCandidate(reason: string) { candidate = { status: "denied", reason }; } };
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
  assert.equal(result.revision.source.branch, "main", "only an authoritative missing candidate permits the pinned base fallback");
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

test("registered Main tool and document data path expose the same unapproved revision without AI", async () => {
  const f = await setup();
  const contract = createBuilderPlatform();
  const propose = contract.tools!.find(tool => tool.name === "builder.propose-delivery-documents")!;
  const read = contract.tools!.find(tool => tool.name === "builder.read-delivery-documents")!;
  assert.ok(manifestTools.some(tool => tool.name === propose.name));
  assert.ok(manifestTools.some(tool => tool.name === read.name));
  const result = await propose.handler!({ projectId: W, expectedBaseRevisionId: null, documents: f.documents }, ctx(), f.platform);
  const stored = result.data as unknown as { status: string; revision: { revisionId: string } };
  assert.equal(stored.status, "published");
  const data = contract.data!.find(source => source.key === "builder.delivery-documents")!;
  const shown = await data.handler({ companyId: W }, f.platform) as unknown as { workspaceId: string; projectId: string;
    read: Awaited<ReturnType<typeof readCurrentDeliveryDocuments>> };
  assert.equal(shown.workspaceId, W);
  assert.equal(shown.projectId, W);
  assert.equal(shown.read.document?.revisionId, stored.revision.revisionId);
  assert.equal(shown.read.confirmed, false);
  assert.equal(shown.read.completeness, "unknown");
  assert.equal(shown.read.document?.approvalStatus, "unapproved");
  assert.deepEqual((await read.handler!({ projectId: W }, ctx(), f.platform)).data, shown);
  assert.equal(f.sends, 0);
  await assert.rejects(async () => await read.handler!({ projectId: SOURCE }, ctx(), f.platform), /authenticated Workspace/u);
  await assert.rejects(async () => await data.handler({ companyId: W, confirmed: true }, f.platform), /fields/u);
  f.values.set(mapKey(key("lead-sessions.v1.1")), { workspaceId: W, selectionRevision: 1, agentId: A,
    sessions: { main: S, "ui-design": C, background: null, decisions: null, "cto-inbox": null, "integration-review": null } });
  assert.deepEqual((await read.handler!({ projectId: W }, ctx(C), f.platform)).data, shown);
  await assert.rejects(async () => await propose.handler!({ projectId: W, expectedBaseRevisionId: stored.revision.revisionId,
    documents: f.documents }, ctx(C), f.platform), /Only the Main/u);
  await assert.rejects(async () => await read.handler!({ projectId: W }, { ...ctx(), agentId: SOURCE }, f.platform), /current Builder Lead/u);
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

test("a current integration candidate supersedes the base; candidate drift stales the prior draft", async () => {
  const f = await setup();
  f.setCandidate("5".repeat(40), "6".repeat(40));
  const result = await proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: null, documents: f.documents }, ctx(), f.platform);
  assert.equal(result.status, "published");
  if (result.status !== "published") return;
  assert.equal(result.revision.source.branch, "integration/candidate");
  assert.equal(result.revision.source.commitSha, "5".repeat(40));
  assert.equal(result.revision.source.treeSha, "6".repeat(40));
  assert.equal((await readCurrentDeliveryDocuments(W, f.platform)).source, "current");
  f.setCandidate("7".repeat(40), "8".repeat(40));
  const stale = await readCurrentDeliveryDocuments(W, f.platform);
  assert.equal(stale.source, "stale");
  assert.equal(stale.document?.revisionId, result.revision.revisionId);
});

test("candidate permission failure is unknown and never falls back to the plan base", async () => {
  const f = await setup();
  f.denyCandidate("permission_denied");
  const before = f.writes;
  const result = await proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: null, documents: f.documents }, ctx(), f.platform);
  assert.equal(result.status, "unknown");
  assert.match(result.reason, /neither current nor authoritatively unavailable/u);
  assert.equal(f.writes, before);
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

test("delivery document paths reject absolute, ADS, traversal, reserved and nonportable names before writing", async () => {
  const f = await setup();
  const before = f.writes;
  const invalidPaths = ["C:/docs/install.md", "docs/install:stream.md", "docs\\install.md", "../install.md",
    "docs/./install.md", "docs/CON.txt", "docs/NUL", "docs/name.", "docs/name ", "docs/hidden\u200f.md", "docs/control\u0001.md"];
  for (const path of invalidPaths) {
    const documents = f.documents.map(item => item.kind === "installation-guide" ? { ...item, path } : item);
    await assert.rejects(proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: null, documents }, ctx(), f.platform),
      /normalized relative delivery path|non-empty valid bounded text/u, path);
  }
  const duplicatePaths = f.documents.map((item, index) => ({ ...item, path: index === 0 ? "Docs/Guide.md" : "docs/guide.MD" }));
  await assert.rejects(proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: null, documents: duplicatePaths }, ctx(), f.platform),
    /unique paths\/kinds/u);
  assert.equal(f.writes, before);
  assert.equal((await readCurrentDeliveryDocuments(W, f.platform)).status, "unavailable");
});
