import assert from "node:assert/strict";
import test from "node:test";
import { parseBuilderSnapshot, createEmptyBuilderSnapshot } from "../src/domain/snapshot.ts";
import { selectProjectDocuments, parseDocumentCenterQuery, projectConsultationDocuments } from "../src/domain/document-center.ts";
import type { BuilderDocument } from "../src/domain/model.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sha = "a".repeat(64);
function doc(overrides: Partial<BuilderDocument> = {}): BuilderDocument {
  return { id: "baseline-body:doc-a", title: "통합 설계 기준선", revisionId: "doc-r1", text: "요구사항 REQ-1",
    createdAt: "2026-11-05T00:00:00.000Z", category: "design", sourceKind: "baseline-body", approvalStatus: "unknown",
    freshnessStatus: "current", bodyAvailable: true,
    sourcePins: [{ sourceId: "baseline-source", revisionId: "base-r1", sha256: sha }], relatedIds: ["REQ-1"], ...overrides };
}

test("legacy BuilderDocuments remain unclassified with unknown approval and freshness", () => {
  const base = createEmptyBuilderSnapshot(workspaceId);
  const parsed = parseBuilderSnapshot({ ...base, documents: [{ id: "legacy-1", title: "Old document", revisionId: "r1",
    text: "legacy body", createdAt: "2026-11-01T00:00:00.000Z" }] }, workspaceId);
  assert.deepEqual(parsed.documents[0], { id: "legacy-1", title: "Old document", revisionId: "r1", text: "legacy body",
    createdAt: "2026-11-01T00:00:00.000Z", category: "unclassified", sourceKind: "builder-document", approvalStatus: "unknown",
    freshnessStatus: "unknown", bodyAvailable: true, sourcePins: [], relatedIds: [] });
});

test("source mapping rejects unsupported categories and invented approval/freshness", () => {
  const base = createEmptyBuilderSnapshot(workspaceId);
  for (const metadata of [
    { ...doc(), category: "delivery" },
    { ...doc(), approvalStatus: "approved" },
    { ...doc(), approvalStatus: "unapproved" },
    { ...doc(), freshnessStatus: "review-required" },
    { ...doc(), bodyAvailable: false },
    { ...doc(), freshnessStatus: "current", sourceKind: "workstream", id: "workstream:ws-1" },
  ]) {
    assert.throws(() => parseBuilderSnapshot({ ...base, documents: [metadata] }, workspaceId));
  }
});

test("local selector searches, filters, sorts and exposes truthful facets", () => {
  const documents = [doc(), doc({ id: "draft:draft-1", title: "Draft plan", revisionId: "draft-r2", text: "alpha design",
    createdAt: "2026-11-06T00:00:00.000Z", sourceKind: "design-draft", approvalStatus: "unapproved", freshnessStatus: "unknown",
    sourcePins: [], relatedIds: ["REQ-2"] }),
  doc({ id: "workstream:ws-1", title: "Runtime Workstream", revisionId: "3", text: "QA scope", sourceKind: "workstream",
    category: "development", approvalStatus: "unknown", freshnessStatus: "unknown", sourcePins: [], relatedIds: ["WS-1", "REQ-1"] })];
  const byText = selectProjectDocuments({ documents }, { search: "ALPHA", sortBy: "title" });
  assert.equal(byText.total, 1);
  assert.equal(byText.items[0]?.id, "draft:draft-1");
  const filtered = selectProjectDocuments({ documents }, { category: "development", sourceKind: "workstream",
    freshnessStatus: "unknown", sortBy: "revisionId", direction: "asc" });
  assert.deepEqual(filtered.items.map(item => item.id), ["workstream:ws-1"]);
  assert.equal(filtered.facets.categories.design, 2);
  assert.equal(filtered.facets.categories.development, 1);
  assert.equal(filtered.facets.approvalStatuses.approved, 0);
  assert.equal(filtered.facets.approvalStatuses.unapproved, 1);
  assert.equal(filtered.facets.freshnessStatuses.current, 1);
  assert.deepEqual(selectProjectDocuments({ documents }, { relatedId: "REQ-1" }).items.map(item => item.id), ["baseline-body:doc-a", "workstream:ws-1"]);
  assert.equal(selectProjectDocuments({ documents }, { relatedId: "REQ" }).total, 0);
});

test("the existing consultation capture is shown once without including AI output or granting approval", () => {
  const sourceId = "consultation-22222222-2222-4222-8222-222222222222";
  const original = { id: sourceId, channel: "main" as const, role: "user" as const, actorId: null, runId: null,
    text: "Actual captured text", createdAt: "2026-11-06T00:00:00.000Z" };
  const messages = [original, { ...original, id: "other-source" }, { ...original,
    id: "consultation-33333333-3333-4333-8333-333333333333", role: "assistant" as const }];
  const documents = projectConsultationDocuments({ messages, documents: [] });
  assert.equal(documents.length, 1);
  assert.deepEqual(documents[0]?.relatedIds, [sourceId]);
  assert.equal(documents[0]?.revisionId, sourceId);
  assert.equal(documents[0]?.text, original.text);
  assert.equal(documents[0]?.approvalStatus, "unknown");
  assert.equal(documents[0]?.freshnessStatus, "unknown");
  assert.equal(projectConsultationDocuments({ messages, documents }).length, 1);
});

test("query parser rejects unknown filters and remains local/no-op on empty inputs", () => {
  assert.throws(() => parseDocumentCenterQuery({ freshness: "fresh" }), /fields/);
  assert.throws(() => parseDocumentCenterQuery({ category: "invented" }), /Unsupported document category/);
  assert.throws(() => parseDocumentCenterQuery({ sortBy: "updatedAt" }), /sort field/);
  assert.equal(selectProjectDocuments({ documents: [] }).total, 0);
});
