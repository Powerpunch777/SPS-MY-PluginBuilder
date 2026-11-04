import assert from "node:assert/strict";
import test from "node:test";
import type { SolutionGraphEntity, SolutionGraphRelation } from "../domain/graph-revisions.ts";
import type { TaskPacket } from "../domain/task-packets.ts";
import { calculateChangeImpact, type ChangeImpactInput, type ImpactSnapshot } from "./index.ts";

const pin = (revisionId: string) => ({ sourceId: `source-${revisionId}`, sourceSha256: "a".repeat(64), revisionId });
function snapshot(side: string, entities: readonly SolutionGraphEntity[] = [
  { id: "r1", kind: "requirement" as const },
  { id: "feature", kind: "feature" as const },
  { id: "component", kind: "component" as const },
], relations: readonly SolutionGraphRelation[] = [
  { id: "e1", sourceId: "r1", targetId: "feature", kind: "implements" as const },
  { id: "e2", sourceId: "component", targetId: "feature", kind: "depends_on" as const },
]): ImpactSnapshot {
  const spec = { projectId: "p", revisionId: `spec-${side}`, productTier: "M" as const,
    requirements: [{ id: "r1", description: "requirement", acceptanceCriteriaIds: ["ac1"] }],
    targets: ["sps-plugin" as const], dataPolicyRef: "policy", approvalEvidenceRef: "approval" };
  const graph = { approvedSpecRevisionId: spec.revisionId, graphRevisionId: `graph-${side}`, entities, relations, viewLayoutRef: "layout" };
  const ui = { projectId: "p", revisionId: `ui-${side}`, screenIds: ["screen"], interactions: [] };
  return { workspaceId: "w", projectId: "p", spec, graph, ui,
    pins: { spec: pin(spec.revisionId), graph: pin(graph.graphRevisionId), ui: pin(ui.revisionId) },
    collections: { spec: true, graph: true, ui: true } };
}
function input(old = snapshot("old"), newer = snapshot("new"), changes: string[] = ["r1"]): ChangeImpactInput {
  return { workspaceId: "w", projectId: "p", old, new: newer, changedNodeIds: changes,
    workstreamChange: { previousRevision: 1, reason: "change", diff: "updated", impactNodeIds: [],
      impactInterfaceContracts: [], impactTaskIds: [], effectiveFrom: "2026-11-04T00:00:00.000Z" },
    taskPackets: [] };
}
function task(taskId: string, projectId: string, scopeNodeIds: string[]): TaskPacket {
  return { projectId, ctoId: "cto-1", workstreamId: "ws-1", taskId, revision: 1, kind: "development",
    title: "task", goal: "goal", scopeNodeIds, requirementIds: [], dependencies: [], included: ["scope"],
    excluded: [], constraints: [], acceptance: ["accepted"], evidenceRequired: ["evidence"], reuse: [], testPlan: null };
}

test("old/new revisions stay separate for a same-ID removal or move", () => {
  const old = snapshot("old");
  const moved = snapshot("new", [{ id: "r1", kind: "requirement" }, { id: "component", kind: "component" }], []);
  const result = calculateChangeImpact(input(old, moved));
  assert.deepEqual(result.candidates.filter(item => item.entityId === "feature").map(item => item.side), ["old"]);
  assert.equal(result.candidates.some(item => item.side === "new" && item.entityId === "feature"), false);
  assert.deepEqual(result.candidates.filter(item => item.entityId === "r1").map(item => item.side), ["new", "old"]);
  assert.equal(result.candidates.find(item => item.side === "new" && item.entityId === "r1")?.reasonPaths[0]?.graphRevisionId, "graph-new");
});

test("forward and reverse traversals preserve original edge and traversal direction", () => {
  const old = snapshot("old", [
    { id: "r1", kind: "requirement", specRef: "r1" },
    { id: "feature", kind: "feature", contractRefs: ["contract-1"] },
    { id: "component", kind: "component" },
  ], [
    { id: "e1", sourceId: "r1", targetId: "feature", kind: "implements", contractRef: "contract-1" },
    { id: "e2", sourceId: "component", targetId: "feature", kind: "depends_on" },
  ]);
  const result = calculateChangeImpact(input(old, snapshot("new")));
  const oldComponent = result.candidates.find(item => item.side === "old" && item.entityId === "component")!;
  const edge = oldComponent.reasonPaths.find(path => path.edges.at(-1)?.edgeId === "e2")?.edges.at(-1);
  assert.deepEqual(edge, { edgeId: "e2", kind: "depends_on", originalFrom: "component", originalTo: "feature",
    traversalFrom: "feature", traversalTo: "component", direction: "reverse" });
  const newFeature = result.candidates.find(item => item.side === "new" && item.entityId === "feature")!;
  assert.equal(newFeature.reasonPaths.some(path => path.edges.some(item => item.direction === "forward")), true);
  const oldFeature = result.candidates.find(item => item.side === "old" && item.entityId === "feature")!;
  assert.ok(oldFeature.reasonPaths.some(path => path.sourceRefs.includes("spec-ref:r1")));
  assert.ok(oldFeature.reasonPaths.some(path => path.sourceRefs.includes("interface-contract-ref:contract-1")));
});

test("revision namespaces and workspace/project/digest pin mismatches remain UNKNOWN", () => {
  const bad = snapshot("new");
  const inputBad = input(snapshot("old"), { ...bad, workspaceId: "other", projectId: "other",
    pins: { ...bad.pins, graph: { ...bad.pins.graph!, revisionId: "wrong", sourceSha256: "bad" } } });
  const result = calculateChangeImpact(inputBad);
  assert.ok(result.missing.some(value => value.includes("workspace-mismatch")));
  assert.ok(result.missing.some(value => value.includes("project-mismatch")));
  assert.ok(result.missing.some(value => value.includes("revision-pin-mismatch")));
  assert.equal(result.candidates.some(item => item.side === "new"), false);
  assert.equal(result.candidates.some(item => item.side === "old"), true);
});

test("a foreign-project Task packet cannot seed candidates", () => {
  const value = input(snapshot("old"), snapshot("new"), []);
  const result = calculateChangeImpact({ ...value,
    workstreamChange: { ...value.workstreamChange!, impactTaskIds: ["foreign-task"] },
    taskPackets: [task("foreign-task", "another-project", ["component"])],
  });
  assert.ok(result.missing.includes("task-project-mismatch:foreign-task"));
  assert.equal(result.candidates.length, 0);
});

test("workspace, project, and revision pin mismatches exclude only the affected graph side", () => {
  const goodOld = snapshot("old");
  const goodNew = snapshot("new");
  const badOlds: ImpactSnapshot[] = [
    { ...goodOld, workspaceId: "other-workspace" },
    { ...goodOld, projectId: "other-project" },
    { ...goodOld, pins: { ...goodOld.pins, graph: { ...goodOld.pins.graph!, revisionId: "other-graph-revision" } } },
    { ...goodOld, pins: { ...goodOld.pins, spec: { ...goodOld.pins.spec!, revisionId: "other-spec-revision" } } },
    { ...goodOld, pins: { ...goodOld.pins, ui: { ...goodOld.pins.ui!, revisionId: "other-ui-revision" } } },
  ];
  for (const badOld of badOlds) {
    const result = calculateChangeImpact(input(badOld, goodNew));
    assert.equal(result.candidates.some(item => item.side === "old"), false);
    assert.equal(result.candidates.some(item => item.side === "new"), true);
  }
});

test("missing or invalid pins of each kind isolate the affected side", () => {
  const goodOld = snapshot("old");
  const goodNew = snapshot("new");
  const badOlds: Array<{ snapshot: ImpactSnapshot; issue: string }> = [
    { snapshot: { ...goodOld, pins: { ...goodOld.pins, graph: { ...goodOld.pins.graph!, sourceSha256: "bad" } } }, issue: "old:graph-source-pin-invalid-or-missing" },
    { snapshot: { ...goodOld, pins: { ...goodOld.pins, graph: null } }, issue: "old:graph-source-pin-invalid-or-missing" },
    { snapshot: { ...goodOld, pins: { ...goodOld.pins, spec: { ...goodOld.pins.spec!, sourceSha256: "bad" } } }, issue: "old:spec-source-pin-invalid-or-missing" },
    { snapshot: { ...goodOld, pins: { ...goodOld.pins, spec: null } }, issue: "old:spec-source-pin-invalid-or-missing" },
    { snapshot: { ...goodOld, pins: { ...goodOld.pins, ui: { ...goodOld.pins.ui!, sourceSha256: "bad" } } }, issue: "old:ui-source-pin-invalid-or-missing" },
    { snapshot: { ...goodOld, pins: { ...goodOld.pins, ui: null } }, issue: "old:ui-source-pin-invalid-or-missing" },
  ];
  for (const { snapshot: badOld, issue } of badOlds) {
    const result = calculateChangeImpact(input(badOld, goodNew));
    assert.ok(result.missing.includes(issue));
    assert.equal(result.candidates.some(item => item.side === "old"), false);
    assert.equal(result.candidates.some(item => item.side === "new"), true);
  }
});

test("missing collections, references and unconnected dimensions are explicit UNKNOWN", () => {
  const incomplete = snapshot("new", [{ id: "r1", kind: "requirement", specRef: "absent", contractRefs: ["no-contract"] }], []);
  const result = calculateChangeImpact({ ...input(snapshot("old"), incomplete), taskPackets: null,
    new: { ...incomplete, collections: { ...incomplete.collections, ui: false }, ui: null } });
  assert.ok(result.missing.includes("task-packet-collection-missing"));
  assert.ok(result.missing.includes("new:ui-collection-or-revision-missing"));
  assert.ok(result.missing.some(value => value.includes("unresolved-spec-requirement-ref")));
  const requirement = result.candidates.find(item => item.side === "old" && item.entityId === "r1")!;
  assert.equal(requirement.dimensions.requirement.status, "UNKNOWN");
  assert.equal(requirement.dimensions.cto.status, "UNKNOWN");
  assert.equal(Object.keys(requirement.dimensions).length, 7);
});

test("UI requirement namespace links only through a validated specRef", () => {
  const old = snapshot("old", [
    { id: "r1", kind: "requirement" }, { id: "feature", kind: "feature", specRef: "r1" },
    { id: "component", kind: "component" },
  ]);
  const ui = { ...old.ui!, interactions: [{ id: "ui-int", screenId: "screen", requirementRefs: ["r1"],
    behaviorRefs: [], stateRefs: [], apiRefs: [], preconditions: [], outcomes: [], prohibited: [],
    validationCriteria: ["check"], status: "specified" as const }] };
  const result = calculateChangeImpact(input({ ...old, ui }, snapshot("new")));
  const feature = result.candidates.find(item => item.side === "old" && item.entityId === "feature")!;
  assert.equal(feature.dimensions.ui.status, "REVIEW");
  assert.deepEqual(feature.dimensions.ui.evidence, ["ui-requirement-ref:ui-int:r1"]);
});

test("same-name UI behaviorRefs do not link to graph feature IDs", () => {
  const unlinked = snapshot("old", [
    { id: "r1", kind: "requirement" }, { id: "feature", kind: "feature" }, { id: "component", kind: "component" },
  ]);
  const sameName = { ...unlinked.ui!, interactions: [{ id: "ui-int", screenId: "screen", requirementRefs: [],
    behaviorRefs: ["feature"], stateRefs: [], apiRefs: [], preconditions: [], outcomes: [], prohibited: [],
    validationCriteria: ["check"], status: "specified" as const }] };
  const unknown = calculateChangeImpact(input({ ...unlinked, ui: sameName }, snapshot("new")));
  assert.equal(unknown.candidates.find(item => item.side === "old" && item.entityId === "feature")?.dimensions.ui.status, "UNKNOWN");
});

test("entity kind alone does not review dimensions; explicit relations and scoped Tasks do", () => {
  const graph = snapshot("old", [
    { id: "r1", kind: "requirement" }, { id: "feature", kind: "feature" },
    { id: "test-node", kind: "test" }, { id: "component", kind: "component" },
  ], [
    { id: "implements-1", sourceId: "r1", targetId: "feature", kind: "implements" },
    { id: "tested-1", sourceId: "feature", targetId: "test-node", kind: "tested_by" },
  ]);
  const noTasks = calculateChangeImpact(input(graph, snapshot("new"), ["r1"]));
  const requirement = noTasks.candidates.find(item => item.side === "old" && item.entityId === "r1")!;
  assert.equal(requirement.dimensions.requirement.status, "UNKNOWN");
  const feature = noTasks.candidates.find(item => item.side === "old" && item.entityId === "feature")!;
  assert.equal(feature.dimensions.requirement.status, "REVIEW");
  assert.equal(feature.dimensions.technical.status, "REVIEW");
  assert.equal(requirement.dimensions.product.status, "UNKNOWN");
  assert.equal(requirement.dimensions.schedule.status, "UNKNOWN");
  const testNode = noTasks.candidates.find(item => item.side === "old" && item.entityId === "test-node")!;
  assert.equal(testNode.dimensions.schedule.status, "UNKNOWN");
  assert.equal(testNode.dimensions.technical.status, "REVIEW");
  const base = input(snapshot("old"), snapshot("new"), []);
  const withTask = calculateChangeImpact({ ...base,
    workstreamChange: { ...base.workstreamChange!, impactTaskIds: ["task-1"] },
    taskPackets: [task("task-1", "p", ["component"])],
  });
  const component = withTask.candidates.find(item => item.side === "old" && item.entityId === "component")!;
  assert.equal(component.dimensions.task.status, "REVIEW");
  assert.equal(component.dimensions.cto.status, "REVIEW");
  assert.equal(component.dimensions.schedule.status, "UNKNOWN");
});

test("task and interface-contract IDs do not collide with graph node IDs", () => {
  const isolated = snapshot("old", [
    { id: "r1", kind: "requirement" }, { id: "feature", kind: "feature" },
    { id: "component", kind: "component" }, { id: "task-42", kind: "agent" },
    { id: "contract-42", kind: "approval" },
  ]);
  const value = input(isolated, snapshot("new"));
  const result = calculateChangeImpact({ ...value, workstreamChange: {
    ...value.workstreamChange!, impactTaskIds: ["task-42"], impactInterfaceContracts: ["contract-42"],
  } });
  assert.ok(result.missing.includes("unresolved-impact-task:task-42"));
  assert.ok(result.missing.includes("unmapped-interface-contract:contract-42"));
  assert.equal(result.candidates.some(item => item.side === "old" &&
    ["task-42", "contract-42"].includes(item.entityId)), false);
});

test("a same-project Task outside impactTaskIds cannot seed its scope nodes", () => {
  const value = input(snapshot("old"), snapshot("new"), []);
  const result = calculateChangeImpact({ ...value, taskPackets: [task("unrelated-task", "p", ["component"])] });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.missing.some(entry => entry.includes("task-project-mismatch")), false);
});

test("duplicate same-project Task IDs are quarantined instead of reviewing either scope", () => {
  const old = snapshot("old", [
    { id: "component", kind: "component" }, { id: "feature", kind: "feature" },
  ], []);
  const base = input(old, snapshot("new", old.graph!.entities, []), ["component"]);
  const duplicateA = task("duplicate-task", "p", ["component"]);
  const duplicateB = { ...task("duplicate-task", "p", ["feature"]), ctoId: "cto-2" };
  const value = { ...base, workstreamChange: { ...base.workstreamChange!, impactTaskIds: ["duplicate-task"] } };
  const first = calculateChangeImpact({ ...value, taskPackets: [duplicateA, duplicateB] });
  const reversed = calculateChangeImpact({ ...value, taskPackets: [duplicateB, duplicateA] });

  assert.deepEqual(first, reversed);
  assert.ok(first.missing.includes("task-duplicate-id:duplicate-task"));
  assert.equal(first.candidates.some(candidate => candidate.entityId === "feature"), false);
  const component = first.candidates.find(candidate => candidate.side === "old" && candidate.entityId === "component")!;
  assert.equal(component.dimensions.task.status, "UNKNOWN");
  assert.equal(component.dimensions.cto.status, "UNKNOWN");
  assert.equal(component.dimensions.task.evidence.some(evidence => evidence.startsWith("task-scope:")), false);
});

test("omitted non-shortest paths are reported and force conservative UNKNOWN", () => {
  const old = snapshot("old", [
    { id: "seed", kind: "feature" }, { id: "middle", kind: "component" }, { id: "target", kind: "agent" },
  ], [
    { id: "direct", sourceId: "seed", targetId: "target", kind: "triggers" },
    { id: "long-1", sourceId: "seed", targetId: "middle", kind: "depends_on" },
    { id: "long-2", sourceId: "middle", targetId: "target", kind: "depends_on" },
  ]);
  const result = calculateChangeImpact(input(old, snapshot("new"), ["seed"]));
  assert.ok(result.missing.includes("old:non-shortest-path-omitted:target:2:1"));
  const target = result.candidates.find(item => item.side === "old" && item.entityId === "target")!;
  assert.equal(target.dimensions.technical.status, "UNKNOWN");
  assert.ok(target.dimensions.technical.evidence.includes("old:non-shortest-path-omitted:target:2:1"));
});

test("cycle returns are distinguished from omitted non-cyclic alternatives", () => {
  const old = snapshot("old", [
    { id: "seed", kind: "feature" }, { id: "target", kind: "component" },
  ], [{ id: "cycle-edge", sourceId: "seed", targetId: "target", kind: "triggers" }]);
  const result = calculateChangeImpact(input(old, snapshot("new"), ["seed"]));
  assert.equal(result.missing.some(value => value.startsWith("old:non-shortest-path-omitted:")), false);
  assert.equal(result.candidates.some(item => item.side === "old" && item.entityId === "target"), true);
});

test("adjacent changed seeds retain valid paths independently on old and new graphs", () => {
  const old = snapshot("old", [
    { id: "a", kind: "feature" }, { id: "b", kind: "component" },
  ], [{ id: "a-to-b", sourceId: "a", targetId: "b", kind: "triggers" }]);
  const newer = snapshot("new", [
    { id: "a", kind: "feature" }, { id: "b", kind: "component" },
  ], [{ id: "a-to-b", sourceId: "a", targetId: "b", kind: "triggers" }]);
  const forwardOrder = calculateChangeImpact(input(old, newer, ["a", "b"]));
  const reverseOrder = calculateChangeImpact(input(old, newer, ["b", "a"]));

  assert.deepEqual(forwardOrder, reverseOrder);
  assert.equal(forwardOrder.missing.some(value => value.includes("non-shortest-path-omitted")), false);
  for (const side of ["old", "new"] as const) {
    const candidateA = forwardOrder.candidates.find(item => item.side === side && item.entityId === "a")!;
    const candidateB = forwardOrder.candidates.find(item => item.side === side && item.entityId === "b")!;
    assert.ok(candidateA.reasonPaths.some(path => path.sourceRefs.includes("seed:b")
      && path.edges.at(-1)?.direction === "reverse"));
    assert.ok(candidateB.reasonPaths.some(path => path.sourceRefs.includes("seed:a")
      && path.edges.at(-1)?.direction === "forward"));
    assert.equal(candidateA.dimensions.technical.status, "REVIEW");
    assert.equal(candidateB.dimensions.technical.status, "REVIEW");
  }
});

test("cycles, duplicate paths, ordering, and traversal limits are bounded and deterministic", () => {
  const cycle = snapshot("old", [
    { id: "r1", kind: "requirement" }, { id: "feature", kind: "feature" }, { id: "component", kind: "component" },
  ], [
    { id: "e1", sourceId: "r1", targetId: "feature", kind: "implements" },
    { id: "e2", sourceId: "feature", targetId: "component", kind: "triggers" },
    { id: "e3", sourceId: "component", targetId: "r1", kind: "data_flow" },
    { id: "e4", sourceId: "r1", targetId: "feature", kind: "implements" },
  ]);
  const base = input(cycle, snapshot("new"));
  const result = calculateChangeImpact(base, { maxVisited: 100, maxPathsPerEntity: 1 });
  assert.ok(result.missing.some(value => value.includes("path-limit")));
  assert.deepEqual(result.candidates, calculateChangeImpact(base, { maxVisited: 100, maxPathsPerEntity: 1 }).candidates);
  const limited = calculateChangeImpact(base, { maxVisited: 1 });
  assert.ok(limited.missing.some(value => value.includes("traversal-limit")));
  assert.throws(() => calculateChangeImpact(base, { maxVisited: 0 }));
});

test("duplicate entity IDs are quarantined independent of conflicting input order", () => {
  const first = { id: "collision", kind: "feature" as const };
  const second = { id: "collision", kind: "component" as const };
  const base = input(snapshot("old"), snapshot("new"), ["collision"]);
  const outputs = [first, second].map((_, index) => {
    const entities = index === 0 ? [first, second] : [second, first];
    return calculateChangeImpact({ ...base, old: snapshot("old", entities, []) });
  });
  for (const result of outputs) {
    assert.ok(result.missing.includes("old:duplicate-entity-id:collision"));
    assert.ok(result.missing.includes("old:graph-duplicate-ids-quarantined"));
    assert.equal(result.candidates.some(item => item.side === "old"), false);
  }
  assert.deepEqual(outputs[0], outputs[1]);
});

test("duplicate relation IDs quarantine conflicting edges", () => {
  const old = snapshot("old", [
    { id: "seed", kind: "feature" }, { id: "one", kind: "component" }, { id: "two", kind: "agent" },
  ], [
    { id: "same-edge", sourceId: "seed", targetId: "one", kind: "triggers" },
    { id: "same-edge", sourceId: "seed", targetId: "two", kind: "depends_on" },
  ]);
  const result = calculateChangeImpact(input(old, snapshot("new"), ["seed"]));
  assert.ok(result.missing.includes("old:duplicate-relation-id:same-edge"));
  assert.ok(result.missing.includes("old:graph-duplicate-ids-quarantined"));
  assert.equal(result.candidates.some(item => item.side === "old"), false);
});

test("dangling edges are recorded even when no seed can reach them", () => {
  const old = snapshot("old", [
    { id: "seed", kind: "feature" }, { id: "isolated", kind: "component" },
  ], [{ id: "unreachable-dangling", sourceId: "isolated", targetId: "missing-node", kind: "triggers" }]);
  const result = calculateChangeImpact(input(old, snapshot("new"), ["seed"]));
  assert.ok(result.missing.includes("old:edge-endpoint:unreachable-dangling:missing-node"));
  const seed = result.candidates.find(item => item.side === "old" && item.entityId === "seed")!;
  assert.equal(seed.dimensions.technical.status, "UNKNOWN");
  assert.ok(seed.dimensions.technical.evidence.includes("old:edge-endpoint:unreachable-dangling:missing-node"));
});

test("high fanout cannot grow the pending queue beyond the traversal bound", () => {
  const entities = [{ id: "seed", kind: "feature" as const },
    ...Array.from({ length: 100 }, (_, index) => ({ id: `leaf-${String(index).padStart(3, "0")}`, kind: "component" as const }))];
  const relations = entities.slice(1).map(entity => ({ id: `edge-${entity.id}`, sourceId: "seed", targetId: entity.id, kind: "triggers" as const }));
  const base = input(snapshot("old", entities, relations), snapshot("new", entities, relations), ["seed"]);
  const limited = calculateChangeImpact(base, { maxVisited: 2 });
  const repeated = calculateChangeImpact(base, { maxVisited: 2 });
  assert.deepEqual(limited, repeated);
  assert.ok(limited.missing.includes("old:queue-limit:2"));
  assert.ok(limited.missing.includes("new:queue-limit:2"));
  assert.ok(limited.candidates.filter(item => item.side === "old").length <= 2);
  assert.ok(limited.candidates.every(candidate => Object.values(candidate.dimensions).every(dimension => dimension.status === "UNKNOWN")));
});

test("analysis does not mutate any supplied input or claim authority/source verification", () => {
  const value = input();
  const before = JSON.stringify(value);
  const result = calculateChangeImpact(value);
  assert.equal(JSON.stringify(value), before);
  assert.equal(result.sourceVerification, "caller-pinned-structure-only");
  assert.match(result.limitations.join(" "), /authority/);
  assert.equal(result.candidates.every(item => Object.values(item.dimensions).some(d => d.status === "UNKNOWN")), true);
});
