import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { selectProjectDocuments } from "../src/domain/document-center.ts";
import { projectDeliveryDocuments } from "../src/domain/delivery-documents-view.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const bodyHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function read(freshness: "current" | "stale" | "unknown" = "current") {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const projectId = workspaceId;
  const baseline = { sourceId: `${workspaceId}/${projectId}`, revisionId: "baseline-rev-3", sha256: "a".repeat(64), sequence: 3 };
  const ui = { sourceId: `${workspaceId}/${projectId}`, revisionId: "formal-ui-rev-3", sha256: "b".repeat(64) };
  const integrationPlan = { sourceId: `${workspaceId}/${projectId}`, revisionId: "integration-plan-v1:plan3", sha256: "c".repeat(64) };
  const sourceFields = { sourceId: "22222222-2222-4222-8222-222222222222", folderKey: "workspace-source", branch: "main",
    commitSha: "1".repeat(40), treeSha: "2".repeat(40) };
  const source = { ...sourceFields, sha256: hash(sourceFields) };
  const documents = [
    { kind: "installation-guide" as const, path: "docs/install.md", classification: "guide", scope: "Supported install path",
      body: "# Install\n\nInstall the current package in its supported host.\n", bodySha256: "" },
    { kind: "user-guide" as const, path: "docs/use.md", classification: "guide", scope: "Current user workflow",
      body: "# Use\n\nOpen the product and follow its current workflow.\n", bodySha256: "" },
  ].map(document => ({ ...document, bodySha256: bodyHash(document.body) }));
  const identity = { baseline, ui, integrationPlan, source, documents };
  const revisionId = `delivery-documents-v1:${hash(identity)}`;
  return { workspaceId, projectId, read: { status: "available" as const, reason: null, source: freshness,
    currentRevisionId: revisionId, confirmed: false as const, completeness: "unknown" as const,
    document: { schemaVersion: 1 as const, workspaceId, projectId, revisionId,
      createdAt: "2026-11-07T12:00:00.000Z", status: "draft" as const, approvalStatus: "unapproved" as const,
      author: { agentId: workspaceId, sessionId: workspaceId, runId: workspaceId, selectionRevision: 1 },
      baseline, ui, integrationPlan, source, documents,
      completeness: { status: "unknown" as const, reason: "Target-specific additions are unverified." } } } };
}

test("projects exact installation and user guide revisions into delivery-filterable Document Center rows", () => {
  const readView = read();
  const documents = projectDeliveryDocuments(readView.workspaceId, readView);
  assert.equal(documents.length, 2);
  assert.deepEqual(documents.map(document => document.text), readView.read.document.documents.map(document => document.body));
  assert.notEqual(documents[0]!.revisionId, documents[1]!.revisionId);
  assert.match(documents[0]!.title, /docs\/install\.md/u);
  assert.match(documents[1]!.title, /docs\/use\.md/u);
  for (const [index, item] of documents.entries()) {
    const stored = readView.read.document.documents[index]!;
    assert.match(item.id, /^delivery-document:/u);
    assert.match(item.revisionId, new RegExp(`^delivery-document-rev:${readView.read.document.revisionId.slice("delivery-documents-v1:".length)}:${index + 1}$`, "u"));
    assert.equal(item.approvalStatus, "unapproved");
    assert.equal(item.freshnessStatus, "current");
    assert.equal(item.category, "delivery");
    assert.equal(item.sourceKind, "delivery-document");
    assert.equal(item.title, stored.path);
    assert.deepEqual(Object.keys(item).sort(), ["approvalStatus", "bodyAvailable", "category", "createdAt", "freshnessStatus", "id",
      "relatedIds", "revisionId", "sourceKind", "sourcePins", "text", "title"].sort());
    assert.ok(item.sourcePins?.some(pin => pin.sourceId === item.id && pin.revisionId === item.revisionId && pin.sha256 === stored.bodySha256));
    assert.ok(item.sourcePins?.some(pin => pin.revisionId === readView.read.document.revisionId));
    assert.ok(item.sourcePins?.some(pin => pin.revisionId === readView.read.document.baseline.revisionId));
    assert.equal(item.relatedIds?.includes(readView.read.document.integrationPlan.revisionId), true);
    assert.equal("qaStatus" in item || "g7Status" in item || "userConfirmed" in item, false);
  }
  const view = selectProjectDocuments({ documents: [...documents] }, { category: "delivery", sourceKind: "delivery-document",
    approvalStatus: "unapproved", freshnessStatus: "current" });
  assert.equal(view.total, 2);
  assert.equal(view.facets.approvalStatuses.approved, 0);
});

test("preserves current, stale, and unknown reader freshness without promoting approval", () => {
  for (const source of ["current", "stale", "unknown"] as const) {
    const wrapper = read(source);
    const documents = projectDeliveryDocuments(wrapper.workspaceId, wrapper);
    assert.equal(documents.length, 2);
    assert.ok(documents.every(document => document.freshnessStatus === source && document.approvalStatus === "unapproved"));
  }
});

test("unavailable reader has no projection and malformed hashes/revisions fail closed", () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(projectDeliveryDocuments(workspaceId, { workspaceId,
    projectId: workspaceId, read: { status: "unavailable", reason: "no draft", document: null,
      source: "unknown", currentRevisionId: null, confirmed: false, completeness: "unknown" } }), []);
  const badHash = read();
  badHash.read.document.documents[0]!.bodySha256 = "not-a-digest";
  assert.throws(() => projectDeliveryDocuments(workspaceId, badHash), /digest shape/u);
  const badRevision = read();
  badRevision.read.currentRevisionId = "delivery-documents-v1:" + "f".repeat(64);
  assert.throws(() => projectDeliveryDocuments(workspaceId, badRevision), /exact current|revision hash/u);
  const badConfirmation = read();
  badConfirmation.read.confirmed = true as never;
  assert.throws(() => projectDeliveryDocuments(workspaceId, badConfirmation), /freshness|draft status/u);
  const foreign = read();
  foreign.projectId = "33333333-3333-4333-8333-333333333333";
  assert.throws(() => projectDeliveryDocuments(workspaceId, foreign), /Cross-Workspace/u);
});
