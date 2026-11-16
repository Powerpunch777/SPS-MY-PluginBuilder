import assert from "node:assert/strict";
import test from "node:test";
import { G5_DIMENSIONS, produceG5ChangeImpactCandidates } from "../src/domain/g5-change-impact.ts";

const projectId = "project-a";
function snap(revisionId: string, records: readonly Record<string, unknown>[]) {
  return { projectId, revisionId, records };
}
function pair(oldRecords: readonly Record<string, unknown>[], newRecords: readonly Record<string, unknown>[], oldId = "r1", newId = "r2") {
  return { old: snap(oldId, oldRecords), new: snap(newId, newRecords) };
}
function complete(overrides: Partial<Record<(typeof G5_DIMENSIONS)[number], ReturnType<typeof pair>>>) {
  return Object.fromEntries(G5_DIMENSIONS.map((dimension, index) => [dimension,
    overrides[dimension] ?? pair([], [], `old-${dimension}-${index}`, `new-${dimension}-${index}`)]));
}

test("separates direct revision changes from evidence-backed reverse-reference candidates", () => {
  const result = produceG5ChangeImpactCandidates({ projectId, dimensions: complete({
    requirements: pair([{ id: "req-a", text: "before" }], [{ id: "req-a", text: "after" }]),
    tasks: pair([{ id: "task-a", requirementRefs: ["req-a"] }, { id: "task-b", requirementRefs: ["req-other"] }],
      [{ id: "task-a", requirementRefs: ["req-a"] }, { id: "task-b", requirementRefs: ["req-other"] }]),
  }) });
  assert.equal(result.dimensions.requirements.status, "CANDIDATES");
  assert.deepEqual(result.dimensions.requirements.candidates, [
    { dimension: "requirements", recordId: "req-a", basis: "direct-revision-diff", via: ["req-a"] },
  ]);
  assert.deepEqual(result.dimensions.tasks.candidates, [
    { dimension: "tasks", recordId: "task-a", basis: "derived-reference", via: ["req-a"] },
  ]);
  assert.equal(result.dimensions.tasks.status, "CANDIDATES");
  assert.equal(result.dimensions.ui.status, "NO_CANDIDATE_OBSERVED");
  assert.equal(result.approvalCreated, false);
  assert.equal(result.executionAuthorized, false);
});

test("keeps complete but unmapped dimensions at no-candidate-observed, never no-impact", () => {
  const result = produceG5ChangeImpactCandidates({ projectId, dimensions: complete({
    graph: pair([{ id: "node-a", value: 1 }], [{ id: "node-a", value: 1 }]),
  }) });
  assert.equal(result.dimensions.graph.status, "NO_CANDIDATE_OBSERVED");
  assert.equal(result.dimensions.scheduleProductScope.status, "NO_CANDIDATE_OBSERVED");
  assert.deepEqual(G5_DIMENSIONS, ["requirements", "ui", "technology", "graph", "ctoWorkstreams", "tasks", "scheduleProductScope"]);
});

test("rejects cross-project, duplicate-ID, and same-ID mutated snapshots", () => {
  assert.throws(() => produceG5ChangeImpactCandidates({ projectId, dimensions: {
    requirements: { old: snap("r1", []), new: { projectId: "other", revisionId: "r2", records: [] } },
  } }), /another project/);
  assert.throws(() => produceG5ChangeImpactCandidates({ projectId, dimensions: {
    graph: pair([{ id: "x" }, { id: "x" }], [{ id: "x" }]),
  } }), /duplicate IDs/);
  assert.throws(() => produceG5ChangeImpactCandidates({ projectId, dimensions: {
    technology: pair([{ id: "t", value: 1 }], [{ id: "t", value: 2 }], "same", "same"),
  } }), /reused one immutable revision ID/);
});

test("rejects references with malformed values rather than inventing relationship edges", () => {
  assert.throws(() => produceG5ChangeImpactCandidates({ projectId, dimensions: {
    requirements: pair([{ id: "r", value: 1 }], [{ id: "r", value: 2 }]),
    tasks: pair([{ id: "t", requirementRefs: ["r"] }], [{ id: "t", requirementRefs: [42] }]),
  } }), /bounded identifier/);
});

test("preserves detected candidates but returns UNKNOWN if any source dimension is missing", () => {
  const result = produceG5ChangeImpactCandidates({ projectId, dimensions: {
    requirements: pair([{ id: "req-a", text: "before" }], [{ id: "req-a", text: "after" }]),
  } });
  assert.equal(result.dimensions.requirements.status, "UNKNOWN");
  assert.equal(result.dimensions.requirements.candidates[0]?.basis, "direct-revision-diff");
  assert.equal(result.dimensions.graph.status, "UNKNOWN");
});
