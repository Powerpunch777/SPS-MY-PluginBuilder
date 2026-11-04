import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { adaptDesignBaseline, createDesignBaselineSource } from "./adapters.ts";
import { buildIntegratedBaselineDocument, INTEGRATED_BASELINE_SECTIONS } from "./baseline.ts";
import { exportApprovedSnapshotMarkdown } from "./markdown.ts";
import { createApprovedSnapshot, DOCUMENT_CATEGORIES, parseProjectDocument, type ProjectDocumentRecord } from "./model.ts";
import { createProjectDocumentReader } from "./read-model.ts";
import { createDesignBaselineStore } from "../design-baseline-tools.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "sample-project";
const now = "2026-11-04T00:00:00.000Z";

function document(input: Partial<ProjectDocumentRecord> = {}): ProjectDocumentRecord {
  return parseProjectDocument({
    workspaceId, projectId, id: "doc-1", category: "design", type: "design-note", title: "Design note",
    body: "A canonical read view.", revisionId: "revision-1", createdAt: now, modifiedAt: now, authorId: null,
    approval: { state: "approved", evidenceId: "approval-1", actorId: "agent-1", decidedAt: now },
    freshness: "current", freshnessReason: null, references: [
      { kind: "revision", id: "source-revision", revisionId: "source-revision", label: "Source" },
      { kind: "document", id: "detail-1", revisionId: "detail-r1", label: "Requirement detail" },
    ],
    ...input,
  }, { workspaceId, projectId });
}

test("document records enforce project scope and preserve separate approval/freshness axes", () => {
  assert.equal(DOCUMENT_CATEGORIES.length, 9);
  assert.throws(() => parseProjectDocument({ ...document(), projectId: "other-project" }, { workspaceId, projectId }), /Cross-Workspace or cross-project/);
  const reviewRequired = document({ approval: { state: "approved", evidenceId: "approval-1", actorId: "agent-1", decidedAt: now },
    freshness: "review-required", freshnessReason: "A referenced requirement revision changed." });
  assert.equal(reviewRequired.approval.state, "approved");
  assert.equal(reviewRequired.freshness, "review-required");
  assert.throws(() => document({ freshness: "current", freshnessReason: "stale" }), /must not carry a stale reason/);
});

test("approved Markdown export is pinned, bounded and neutralizes executable markup", () => {
  const record = document({ body: "<script>alert(1)</script> [bad](javascript:alert(1))" });
  const snapshot = createApprovedSnapshot({ document: record,
    sourceRevisions: [
      { kind: "revision", id: "source-revision", revisionId: "source-revision" },
      { kind: "document", id: "detail-1", revisionId: "detail-r1" },
    ], capturedAt: now });
  const exported = exportApprovedSnapshotMarkdown(snapshot);
  assert.match(exported, /revision-1/);
  assert.match(exported, /source-revision/);
  assert.match(exported, /2026-11-04T00:00:00.000Z/);
  assert.doesNotMatch(exported, /<script>/i);
  assert.doesNotMatch(exported, /javascript:/i);
  assert.throws(() => createApprovedSnapshot({ document: document({ approval: { state: "draft", evidenceId: null, actorId: null, decidedAt: null } }),
    sourceRevisions: [], capturedAt: now }), /Only an already-approved/);
  assert.throws(() => createApprovedSnapshot({ document: record,
    sourceRevisions: [{ kind: "revision", id: "unrelated", revisionId: "r1" }], capturedAt: now }), /not pinned/);
  assert.throws(() => createApprovedSnapshot({ document: record,
    sourceRevisions: [{ kind: "revision", id: "source-revision", revisionId: "source-revision" }], capturedAt: now }), /every versioned document reference/);
  const noReferences = document({ references: [] });
  assert.deepEqual(createApprovedSnapshot({ document: noReferences, sourceRevisions: [], capturedAt: now }).sourceRevisions, [],
    "an approved document with no versioned references legitimately needs no source pins");
  assert.equal(snapshot.bodySha256, createHash("sha256").update(record.body, "utf8").digest("hex"));
});

test("integrated baseline keeps nine sections and detail links without fabricating unavailable source data", () => {
  const sections = INTEGRATED_BASELINE_SECTIONS.map(id => ({ id, title: id, status: "unavailable" as const,
    body: null, detailRefs: [], unavailableReason: "canonical source adapter is unavailable" }));
  const integrated = buildIntegratedBaselineDocument({ workspaceId, projectId, documentId: "baseline-view", revisionId: "baseline-r1",
    createdAt: now, modifiedAt: now, authorId: "lead-agent", approval: { state: "approved", evidenceId: "approval-1", actorId: "lead-agent", decidedAt: now },
    freshness: "unknown", freshnessReason: "No freshness provider was supplied.", sections });
  assert.equal(integrated.category, "design");
  assert.match(integrated.body, /## overview-scope/);
  assert.match(integrated.body, /자료를 사용할 수 없습니다/);
  assert.ok(integrated.references.some(reference => reference.id === "baseline-r1"));
  assert.throws(() => buildIntegratedBaselineDocument({ workspaceId, projectId, documentId: "bad", revisionId: "r1",
    createdAt: now, modifiedAt: now, authorId: null, approval: { state: "unknown", evidenceId: null, actorId: null, decidedAt: null },
    freshness: "unknown", freshnessReason: "unknown", sections: sections.slice(1) }), /all nine sections/);
});

test("read model enforces two-phase authorization, pagination and typed detail reads", async () => {
  const values = [document(), document({ id: "doc-2", title: "Second note", revisionId: "revision-2" })];
  let authorized = 0;
  let cursorReads = 0;
  const source = {
    id: "design-source", category: "design" as const,
    async read({ cursor, limit }: { cursor: string | null; limit: number }) {
      cursorReads += 1;
      const offset = cursor === null ? 0 : Number(cursor);
      const items = values.slice(offset, offset + limit);
      const next = offset + items.length < values.length ? String(offset + items.length) : null;
      return { items, nextCursor: next, hasMore: next !== null };
    },
    async readOne({ documentId }: { documentId: string }) { return values.find(value => value.id === documentId) ?? null; },
  };
  const reader = createProjectDocumentReader({ scope: { workspaceId, projectId }, sources: [source],
    async authorize(scope) { authorized += 1; assert.equal(scope.workspaceId, workspaceId); assert.equal(scope.projectId, projectId); },
    async readEvents(scope) { return { events: [], nextCursor: null, hasMore: false }; },
  });
  const first = await reader.list({ limit: 1 });
  assert.equal(first.items[0]?.id, "doc-1");
  assert.equal(first.hasMore, true);
  const second = await reader.list({ limit: 1, cursor: first.nextCursor });
  assert.equal(second.items[0]?.id, "doc-2");
  assert.equal(second.hasMore, false);
  assert.equal((await reader.read("doc-2"))?.revisionId, "revision-2");
  assert.equal(authorized, 6, "each list/detail read checks authority before and after the source call");
  assert.equal(cursorReads, 1, "cursor continuation reads its immutable cached result rather than the source again");
  assert.equal(first.unavailable.length, 8);
});

test("read model pagination retains unconsumed rows from every source", async () => {
  const rows = [
    document({ id: "design-new", modifiedAt: "2026-11-04T00:00:03.000Z" }),
    document({ id: "design-old", modifiedAt: "2026-11-04T00:00:01.000Z" }),
  ];
  const consultations = rows.map(row => document({ ...row, id: row.id.replace("design", "consultation"), category: "consultation" }));
  const source = (id: string, category: "design" | "consultation", items: ProjectDocumentRecord[]) => ({
    id, category,
    async read({ cursor, limit }: { cursor: string | null; limit: number }) {
      const offset = cursor === null ? 0 : Number(cursor);
      const page = items.slice(offset, offset + limit);
      const next = offset + page.length < items.length ? String(offset + page.length) : null;
      return { items: page, nextCursor: next, hasMore: next !== null };
    },
    async readOne({ documentId }: { documentId: string }) { return items.find(row => row.id === documentId) ?? null; },
  });
  const reader = createProjectDocumentReader({ scope: { workspaceId, projectId },
    sources: [source("design", "design", rows), source("consultation", "consultation", consultations)],
    async authorize() {}, async readEvents() { return { events: [], nextCursor: null, hasMore: false }; },
  });
  const first = await reader.list({ limit: 1 });
  const second = await reader.list({ limit: 1, cursor: first.nextCursor });
  const third = await reader.list({ limit: 1, cursor: second.nextCursor });
  const fourth = await reader.list({ limit: 1, cursor: third.nextCursor });
  assert.deepEqual([first.items[0]?.id, second.items[0]?.id, third.items[0]?.id, fourth.items[0]?.id],
    ["consultation-new", "design-new", "consultation-old", "design-old"]);
  assert.equal(fourth.hasMore, false);
  const expectedUnavailable = DOCUMENT_CATEGORIES
    .filter(category => category !== "design" && category !== "consultation")
    .map(category => ({ category, reason: "source-not-configured" }));
  for (const page of [first, second, third, fourth]) {
    assert.deepEqual(page.unavailable, expectedUnavailable,
      "each cursor page preserves the initial immutable availability snapshot");
  }
  const designOnly = await reader.list({ category: "design", limit: 1 });
  assert.deepEqual(designOnly.unavailable, [], "category filtering reports availability only for the requested category");
  const designContinuation = await reader.list({ category: "design", limit: 1, cursor: designOnly.nextCursor });
  assert.deepEqual(designContinuation.unavailable, designOnly.unavailable,
    "a filtered continuation retains its query's availability snapshot");
});

test("read model snapshots complete observed pages and binds cursors to query, filter, sort and limit", async () => {
  const values = [
    document({ id: "z", title: "Zulu", modifiedAt: "2026-11-04T00:00:03.000Z", category: "design" }),
    document({ id: "a", title: "Alpha", modifiedAt: "2026-11-04T00:00:01.000Z", category: "design" }),
    document({ id: "m", title: "Middle", modifiedAt: "2026-11-04T00:00:02.000Z", category: "design" }),
  ];
  const source = {
    id: "unordered-design", category: "design" as const,
    async read({ cursor, limit }: { cursor: string | null; limit: number }) {
      assert.equal(cursor, null, "the reader never claims unsupported source continuation stability");
      return { items: values.slice(0, limit), nextCursor: null, hasMore: false };
    },
    async readOne({ documentId }: { documentId: string }) { return values.find(row => row.id === documentId) ?? null; },
  };
  const reader = createProjectDocumentReader({ scope: { workspaceId, projectId }, sources: [source],
    async authorize() {}, async readEvents() { return { events: [], nextCursor: null, hasMore: false }; },
  });
  const first = await reader.list({ limit: 1, sort: "title" });
  assert.deepEqual(first.items.map(row => row.id), ["a"]);
  assert.ok(first.nextCursor);
  await assert.rejects(reader.list({ limit: 1, sort: "title", category: "design", cursor: first.nextCursor }), /scope, query, sort, or limit/,
    "a cursor cannot be reused under a changed filter");
  values.splice(0, values.length, document({ id: "changed", title: "Changed Alpha" }));
  const second = await reader.list({ limit: 1, sort: "title", cursor: first.nextCursor });
  assert.deepEqual(second.items.map(row => row.id), ["m"], "source mutations do not alter a cursor's pinned observed result");
  const filtered = await reader.list({ limit: 1, sort: "title", text: "alpha" });
  assert.deepEqual(filtered.items.map(row => row.id), ["changed"], "filters apply to the actual current source result");
  values.splice(0, values.length,
    document({ id: "z", title: "Zulu", modifiedAt: "2026-11-04T00:00:03.000Z" }),
    document({ id: "a", title: "Alpha", modifiedAt: "2026-11-04T00:00:01.000Z" }),
    document({ id: "m", title: "Middle", modifiedAt: "2026-11-04T00:00:02.000Z" }));
  const paginated = await reader.list({ limit: 1, sort: "title" });
  await assert.rejects(reader.list({ limit: 2, sort: "title", cursor: paginated.nextCursor }), /scope, query, sort, or limit/,
    "a cursor cannot be reused with a different page limit");
  await assert.rejects(reader.list({ limit: 1, sort: "modified-desc", cursor: paginated.nextCursor }), /scope, query, sort, or limit/,
    "a cursor cannot be reused with a different sort");
});

test("read model fails closed when a source cannot prove its bounded page is complete", async () => {
  const row = document({ id: "partial" });
  const source = {
    id: "partial-design", category: "design" as const,
    async read() { return { items: [row], nextCursor: "provider-next", hasMore: true }; },
    async readOne() { return row; },
  };
  const reader = createProjectDocumentReader({ scope: { workspaceId, projectId }, sources: [source],
    async authorize() {}, async readEvents() { return { events: [], nextCursor: null, hasMore: false }; },
  });
  const page = await reader.list({ limit: 1, sort: "title" });
  assert.deepEqual(page.items, [], "a partial page is not presented as a globally sorted result");
  assert.equal(page.nextCursor, null);
  assert.equal(page.hasMore, false);
  assert.ok(page.unavailable.some(row => row.category === "design" && row.reason === "source-not-supported"));
});

test("design baseline publication preserves source IDs without fabricating approval or freshness", () => {
  const publicationSourceId = "lead-turn:11111111-1111-4111-8111-111111111115";
  const baseline = {
    projectId, revisionId: "baseline-1", sourceDraftRevisionId: "draft-1", draftDigest: "a".repeat(64), createdAt: now,
    author: { agentId: "11111111-1111-4111-8111-111111111112", sessionId: "11111111-1111-4111-8111-111111111113",
      runId: "11111111-1111-4111-8111-111111111114", selectionRevision: 1 },
    userDecision: { sourceId: publicationSourceId, sourceSha256: "b".repeat(64), interpretation: "Keep the accepted design." },
    specification: { revisionId: "spec-1", requirements: [{ id: "REQ-1", description: "A requirement", acceptanceCriteriaIds: ["AC-1"] }] },
    graph: { graphRevisionId: "graph-1", entities: [], relations: [] },
  } as never;
  const adapted = adaptDesignBaseline({ workspaceId, projectId, sequence: 1, revision: baseline });
  assert.deepEqual(adapted.approval, { state: "unknown", evidenceId: null, actorId: null, decidedAt: null });
  assert.equal(adapted.freshness, "unknown");
  assert.ok(adapted.references.some(reference => reference.id === publicationSourceId));
  assert.ok(adapted.references.some(reference => reference.id === "spec-1"));
  assert.ok(adapted.references.some(reference => reference.id === "graph-1"));
  assert.match(adapted.body, /AC-1/);
  assert.throws(() => createApprovedSnapshot({ document: adapted, sourceRevisions: [], capturedAt: now }), /Only an already-approved/);
});

test("design baseline document adapter reads the real CAS journal across restart and rejects conflicts/scope changes", async () => {
  const values = new Map<string, unknown>();
  const keyOf = (key: unknown) => JSON.stringify(key);
  const state = {
    async get(key: unknown) { return values.has(keyOf(key)) ? values.get(keyOf(key)) as never : null; },
    async compareAndSet(key: unknown, expected: { exists: false } | { exists: true; value: unknown }, value: unknown) {
      const currentKey = keyOf(key), exists = values.has(currentKey), current = values.get(currentKey);
      const matches = expected.exists ? exists && JSON.stringify(current) === JSON.stringify(expected.value) : !exists;
      if (matches) values.set(currentKey, value);
      return { swapped: matches };
    },
  } as never;
  const publicationSourceId = "lead-turn:11111111-1111-4111-8111-111111111115";
  const revision = {
    projectId, revisionId: "baseline-persisted-1", sourceDraftRevisionId: "draft-1", draftDigest: "a".repeat(64), createdAt: now,
    author: { agentId: "11111111-1111-4111-8111-111111111112", sessionId: "11111111-1111-4111-8111-111111111113",
      runId: "11111111-1111-4111-8111-111111111114", selectionRevision: 1 },
    userDecision: { sourceId: publicationSourceId, sourceSha256: "b".repeat(64), interpretation: "Persist the accepted baseline." },
    specification: { projectId, revisionId: "spec-persisted-1", productTier: "S",
      requirements: [{ id: "REQ-PERSISTED-1", description: "Persist the project decision.", acceptanceCriteriaIds: ["AC-PERSISTED-1"] }], targets: ["sps-plugin"],
      dataPolicyRef: "data-policy-1", approvalEvidenceRef: publicationSourceId },
    graph: { approvedSpecRevisionId: "spec-persisted-1", graphRevisionId: "graph-persisted-1", entities: [], relations: [], viewLayoutRef: "layout-1" },
  };
  const firstProcess = createDesignBaselineStore(workspaceId, projectId, state);
  assert.equal((await firstProcess.publish({ expectedBaseRevisionId: null, revision })).status, "published");
  const afterRestart = createDesignBaselineSource(workspaceId, projectId, state);
  const page = await afterRestart.read({ workspaceId, projectId, cursor: null, limit: 20 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.id, "design-baseline:baseline-persisted-1");
  const published = await afterRestart.readOne({ workspaceId, projectId, documentId: "design-baseline:baseline-persisted-1" });
  assert.equal(published?.approval.state, "unknown");
  assert.equal(published?.approval.evidenceId, null);
  assert.throws(() => createApprovedSnapshot({ document: published!, sourceRevisions: [], capturedAt: now }), /Only an already-approved/,
    "a Main publication cannot be exported through the approval-only snapshot path");
  await assert.rejects(afterRestart.read({ workspaceId, projectId: "other-project", cursor: null, limit: 20 }), /scope mismatch/);
  assert.equal((await firstProcess.publish({ expectedBaseRevisionId: "wrong-base", revision: { ...revision, revisionId: "baseline-conflict" } })).status, "conflict");
  assert.equal((await createDesignBaselineStore(workspaceId, projectId, state).current())?.revision.revisionId, "baseline-persisted-1");
});
