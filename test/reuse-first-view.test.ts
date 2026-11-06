import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { parseReuseFirstView, projectReuseFirstCandidates, projectReuseFirstDocuments } from "../src/domain/reuse-first-view.ts";
import { createEmptyBuilderSnapshot, parseBuilderSnapshot } from "../src/domain/snapshot.ts";
import { selectProjectDocuments } from "../src/domain/document-center.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = `lead-turn:${randomUUID()}`;
const QUOTE = "Use the approved SDK for integration.\nSupport desktop delivery.";
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

// TEST_FIXTURE_ONLY: synthetic immutable Reuse-First journal shape for projection tests.
function fixture(change: Record<string, unknown> = {}) {
  const candidate = {
    candidateId: "candidate-sdk-1", name: "Reusable integration SDK", kind: "code",
    scope: { workspaceId: WORKSPACE, projectId: WORKSPACE },
    origin: { url: "https://example.test/sdk", version: "4.2.1" },
    source: { sourceId: SOURCE_ID, fromLine: 8, throughLine: 9, sha256: sha256(QUOTE), quote: QUOTE },
    license: { status: "unknown", evidenceRefs: [] },
    reuse: { status: "blocked-unverified", reusableAcrossProjects: false },
    product: { tier: "L", route: "CUSTOM", deliveryTargets: ["desktop", "web-api"] },
    createdAt: "2026-11-06T12:30:00.000Z",
    ...change,
  };
  return { workspaceId: WORKSPACE, projectId: WORKSPACE, sequence: 3,
    revision: { revisionId: "reuse-revision-3", candidates: [candidate] } };
}

test("projects current candidate as a document with distinct product axes and explicit unknown rights/freshness", () => {
  const view = parseReuseFirstView(fixture(), WORKSPACE, WORKSPACE);
  const [document] = projectReuseFirstDocuments(view);
  assert.ok(document);
  assert.equal(document.id, "reuse-first:candidate-sdk-1");
  assert.equal(document.title, "Reusable integration SDK");
  assert.equal(document.revisionId, "reuse-revision-3");
  assert.equal(document.createdAt, "2026-11-06T12:30:00.000Z");
  assert.equal(document.category, "technical-research");
  assert.equal(document.sourceKind, "reuse-candidate");
  assert.equal(document.approvalStatus, "unknown");
  assert.equal(document.freshnessStatus, "unknown");
  assert.equal(document.bodyAvailable, true);
  assert.deepEqual(document.sourcePins, []);
  assert.deepEqual(document.relatedIds, ["candidate-sdk-1", SOURCE_ID, "reuse-revision-3"]);
  assert.match(document.text, /출처 버전: 4\.2\.1/u);
  assert.match(document.text, /재사용 후보 기록: 3/u);
  assert.match(document.text, new RegExp(`원문: ${SOURCE_ID}, 8-9행`, "u"));
  assert.match(document.text, new RegExp(`서버에 기록된 인용문 SHA-256: ${sha256(QUOTE)}`, "u"));
  assert.match(document.text, /원문 최신성: 미확인/u);
  assert.match(document.text, /라이선스: 미확인/u);
  assert.match(document.text, /재사용 권리: blocked-unverified/u);
  assert.match(document.text, /상품 규모: L\n개발 방식: CUSTOM\n납품 대상: desktop, web-api/u);
});

test("reuses the actual snapshot and Document Center source/category mapping without an approval claim", () => {
  const projected = projectReuseFirstCandidates(createEmptyBuilderSnapshot(WORKSPACE), fixture());
  const snapshot = parseBuilderSnapshot(projected, WORKSPACE);
  const result = selectProjectDocuments(snapshot, { sourceKind: "reuse-candidate", category: "technical-research",
    search: "CUSTOM", relatedId: SOURCE_ID });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.id, "reuse-first:candidate-sdk-1");
  assert.equal(result.items[0]?.approvalStatus, "unknown");
});

test("rejects cross-Workspace/project envelopes, candidate scopes, malformed sequence, and extra envelope fields", () => {
  assert.throws(() => parseReuseFirstView(fixture(), "22222222-2222-4222-8222-222222222222", WORKSPACE), /scope/u);
  assert.throws(() => parseReuseFirstView({ ...fixture(), projectId: "another-project" }, WORKSPACE, WORKSPACE), /scope/u);
  assert.throws(() => parseReuseFirstView({ ...fixture(), sequence: 0 }, WORKSPACE, WORKSPACE), /scope/u);
  assert.throws(() => parseReuseFirstView({ ...fixture(), extra: true }, WORKSPACE, WORKSPACE), /fields/u);
  const foreignCandidate = fixture();
  (foreignCandidate.revision.candidates[0] as unknown as { scope: { workspaceId: string } }).scope.workspaceId = "22222222-2222-4222-8222-222222222222";
  assert.throws(() => parseReuseFirstView(foreignCandidate, WORKSPACE, WORKSPACE), /scope mismatch/u);
});

test("validates digest and quote shape without claiming client-side hash verification", () => {
  const malformedDigest = fixture();
  (malformedDigest.revision.candidates[0] as unknown as { source: { sha256: string } }).source.sha256 = "not-a-sha256";
  assert.throws(() => parseReuseFirstView(malformedDigest, WORKSPACE, WORKSPACE), /source evidence is malformed/u);
  const emptyQuote = fixture();
  (emptyQuote.revision.candidates[0] as unknown as { source: { quote: string } }).source.quote = "  ";
  assert.throws(() => parseReuseFirstView(emptyQuote, WORKSPACE, WORKSPACE), /source evidence is malformed/u);
  const oversizedQuote = fixture();
  (oversizedQuote.revision.candidates[0] as unknown as { source: { quote: string } }).source.quote = "x".repeat(32 * 1024 + 1);
  assert.throws(() => parseReuseFirstView(oversizedQuote, WORKSPACE, WORKSPACE), /source evidence is malformed/u);

  const changedQuote = fixture();
  (changedQuote.revision.candidates[0] as unknown as { source: { quote: string } }).source.quote = "different text";
  const projected = projectReuseFirstDocuments(parseReuseFirstView(changedQuote, WORKSPACE, WORKSPACE))[0]!;
  assert.match(projected.text, /서버에 기록된 인용문 SHA-256/u);
  assert.match(projected.text, /원문 최신성: 미확인/u);

  const unsupportedSource = fixture();
  (unsupportedSource.revision.candidates[0] as unknown as { source: { sourceId: string } }).source.sourceId = "consultation-not-eligible";
  assert.throws(() => parseReuseFirstView(unsupportedSource, WORKSPACE, WORKSPACE), /source evidence is malformed/u);
  const empty = parseReuseFirstView({ workspaceId: WORKSPACE, projectId: WORKSPACE, sequence: 1,
    revision: { revisionId: "reuse-revision-1", candidates: [] } }, WORKSPACE, WORKSPACE);
  assert.deepEqual(projectReuseFirstDocuments(empty), []);
});

test("browser bundle for snapshot projection contains no Node-only imports", async () => {
  const result = await build({ entryPoints: [path.resolve("src/domain/reuse-first-view.ts")], bundle: true, write: false,
    platform: "browser", format: "esm" });
  const output = result.outputFiles.map(file => file.text).join("\n");
  assert.doesNotMatch(output, /node:crypto|node_modules\/node:/u);
});

test("snapshot adapter treats null as no journal and appends current candidate documents", () => {
  const snapshot = { workspaceId: WORKSPACE, documents: [{ id: "existing", title: "Existing", revisionId: "r1",
    createdAt: "2026-11-06T00:00:00.000Z", text: "existing body" }] };
  assert.equal(projectReuseFirstCandidates(snapshot, null), snapshot);
  const projected = projectReuseFirstCandidates(snapshot, fixture());
  assert.equal(projected.documents.length, 2);
  assert.equal(projected.documents[0], snapshot.documents[0]);
  assert.equal(projected.documents[1]?.id, "reuse-first:candidate-sdk-1");
});
