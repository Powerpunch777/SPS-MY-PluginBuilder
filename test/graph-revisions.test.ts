import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCtoExecutionUpdates,
  applyLeadGraphPatch,
  type SolutionRevision,
} from "../src/domain/graph-revisions.ts";

function revision(overrides: Partial<SolutionRevision> = {}): SolutionRevision {
  return {
    approvedSpecRevisionId: "spec-r01",
    graphRevisionId: "graph-r01",
    entities: [
      { id: "feature-a", kind: "feature", specRef: "REQ-1", contractRefs: ["API-1"] },
      { id: "feature-b", kind: "feature" },
      { id: "workflow-a", kind: "workflow" },
    ],
    relations: [{ id: "a-depends-b", sourceId: "feature-a", targetId: "feature-b", kind: "depends_on", contractRef: "API-1" }],
    viewLayoutRef: "layout-r01",
    ...overrides,
  };
}

test("applies a v15 SolutionRevision only against its expected base and returns a deeply immutable copy", () => {
  const current = revision();
  const proposed = revision({ graphRevisionId: "graph-r02", approvedSpecRevisionId: "spec-r02" });
  const result = applyLeadGraphPatch(current, { expectedBaseRevisionId: "graph-r01", revision: proposed });

  assert.equal(result.status, "applied");
  if (result.status !== "applied") return;
  assert.deepEqual(result.revision, proposed);
  assert.notEqual(result.revision, proposed);
  assert.notEqual(result.revision.entities, proposed.entities);
  assert(Object.isFrozen(result.revision));
  assert(Object.isFrozen(result.revision.entities));
  assert(Object.isFrozen(result.revision.entities[0]));
  assert(Object.isFrozen(result.revision.entities[0]!.contractRefs));
  assert(Object.isFrozen(result.revision.relations[0]));
  assert.equal(proposed.graphRevisionId, "graph-r02");
});

test("returns a conflict for stale and missing expected base revisions without applying the proposal", () => {
  const current = revision();
  const stale = applyLeadGraphPatch(current, {
    expectedBaseRevisionId: "graph-r00",
    revision: revision({ graphRevisionId: "graph-r02" }),
  });
  const missing = applyLeadGraphPatch(null, {
    expectedBaseRevisionId: "graph-r01",
    revision: revision(),
  });

  assert.deepEqual(stale, { status: "conflict", expectedBaseRevisionId: "graph-r00", actualBaseRevisionId: "graph-r01" });
  assert.deepEqual(missing, { status: "conflict", expectedBaseRevisionId: "graph-r01", actualBaseRevisionId: null });
});

test("requires a new graph revision ID after matching the expected base", () => {
  assert.throws(() => applyLeadGraphPatch(revision(), {
    expectedBaseRevisionId: "graph-r01",
    revision: revision(),
  }), /must identify a new revision/);
});

test("rejects duplicate IDs, unsupported fields, and dangling relation endpoints", () => {
  assert.throws(() => applyLeadGraphPatch(null, {
    expectedBaseRevisionId: null,
    revision: revision({ entities: [
      { id: "duplicate", kind: "feature" },
      { id: "duplicate", kind: "component" },
    ], relations: [] }),
  }), /duplicate IDs/);

  assert.throws(() => applyLeadGraphPatch(null, {
    expectedBaseRevisionId: null,
    revision: revision({ entities: [{ id: "feature-a", kind: "feature", status: "running" } as never], relations: [] }),
  }), /unknown or missing fields/);

  assert.throws(() => applyLeadGraphPatch(null, {
    expectedBaseRevisionId: null,
    revision: revision({ relations: [{ id: "dangling", sourceId: "feature-a", targetId: "absent", kind: "implements" }] }),
  }), /outside the revision/);
});

test("rejects cycles in depends_on only while allowing cycles in other relation kinds", () => {
  const acyclicDependsWithDataFlowCycle = revision({ relations: [
    { id: "flow-ab", sourceId: "feature-a", targetId: "feature-b", kind: "data_flow" },
    { id: "flow-ba", sourceId: "feature-b", targetId: "feature-a", kind: "triggers" },
    { id: "depends", sourceId: "feature-a", targetId: "feature-b", kind: "depends_on" },
  ] });
  assert.equal(applyLeadGraphPatch(null, { expectedBaseRevisionId: null, revision: acyclicDependsWithDataFlowCycle }).status, "applied");

  const dependencyCycle = revision({ relations: [
    { id: "depends-ab", sourceId: "feature-a", targetId: "feature-b", kind: "depends_on" },
    { id: "depends-ba", sourceId: "feature-b", targetId: "feature-a", kind: "depends_on" },
  ] });
  assert.throws(() => applyLeadGraphPatch(null, { expectedBaseRevisionId: null, revision: dependencyCycle }), /depends_on relations must form a DAG/);
});

test("keeps CTO execution updates separate from Lead design revisions", () => {
  const design = revision();
  const result = applyCtoExecutionUpdates(design, [], [
    { entityId: "feature-a", status: "verified", evidenceRefs: ["test-run-42"] },
  ]);

  assert.deepEqual(result, [{ entityId: "feature-a", status: "verified", evidenceRefs: ["test-run-42"] }]);
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result[0]));
  assert.deepEqual(design, revision());
  assert.throws(() => applyCtoExecutionUpdates(design, [], [
    { entityId: "feature-a", status: "verified", evidenceRefs: [] },
  ]), /requires evidence/);
  assert.throws(() => applyCtoExecutionUpdates(design, [], [
    { entityId: "unknown", status: "running", evidenceRefs: [] },
  ]), /unknown entity/);
});
