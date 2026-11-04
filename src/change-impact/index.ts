import type { ApprovedSpecRevision } from "../domain/specification-revisions.ts";
import { GRAPH_RELATION_KINDS } from "../domain/graph-revisions.ts";
import type { SolutionRevision } from "../domain/graph-revisions.ts";
import type { WorkstreamChange } from "../domain/workstreams.ts";
import type { TaskPacket } from "../domain/task-packets.ts";
import type { UiContract } from "../ui-contracts/domain.ts";

export type ImpactDimension = "requirement" | "ui" | "technical" | "cto" | "task" | "schedule" | "product";
export type ImpactStatus = "REVIEW" | "UNKNOWN";
export type ImpactSide = "old" | "new";

export type ImpactSourcePin = Readonly<{
  sourceId: string;
  sourceSha256: string;
  revisionId: string;
}>;

export type ImpactSnapshot = Readonly<{
  workspaceId: string;
  projectId: string;
  spec: ApprovedSpecRevision | null;
  graph: SolutionRevision | null;
  ui: UiContract | null;
  pins: Readonly<{ spec: ImpactSourcePin | null; graph: ImpactSourcePin | null; ui: ImpactSourcePin | null }>;
  collections: Readonly<{ spec: boolean; graph: boolean; ui: boolean }>;
}>;

export type ChangeImpactInput = Readonly<{
  workspaceId: string;
  projectId: string;
  old: ImpactSnapshot;
  new: ImpactSnapshot;
  changedNodeIds: readonly string[];
  workstreamChange: WorkstreamChange | null;
  taskPackets: readonly TaskPacket[] | null;
}>;

export type ImpactPathEdge = Readonly<{
  edgeId: string;
  kind: SolutionRevision["relations"][number]["kind"];
  originalFrom: string;
  originalTo: string;
  traversalFrom: string;
  traversalTo: string;
  direction: "forward" | "reverse";
}>;

export type ImpactReasonPath = Readonly<{
  side: ImpactSide;
  graphRevisionId: string;
  edges: readonly ImpactPathEdge[];
  sourceRefs: readonly string[];
}>;

export type ImpactDimensionResult = Readonly<{ status: ImpactStatus; evidence: readonly string[] }>;
export type ImpactCandidate = Readonly<{
  side: ImpactSide;
  entityId: string;
  entityKind: SolutionRevision["entities"][number]["kind"];
  reasonPaths: readonly ImpactReasonPath[];
  dimensions: Readonly<Record<ImpactDimension, ImpactDimensionResult>>;
}>;

export type ChangeImpactResult = Readonly<{
  workspaceId: string;
  projectId: string;
  candidates: readonly ImpactCandidate[];
  missing: readonly string[];
  sourceVerification: "caller-pinned-structure-only";
  limitations: readonly string[];
}>;

export type ChangeImpactOptions = Readonly<{ maxVisited?: number; maxPathsPerEntity?: number }>;

const DIMENSIONS: readonly ImpactDimension[] = ["requirement", "ui", "technical", "cto", "task", "schedule", "product"];
const HASH = /^[0-9a-f]{64}$/u;
const DEFAULT_MAX_VISITED = 10_000;
const DEFAULT_MAX_PATHS = 16;

function nonblank(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function stable(values: readonly string[]): string[] { return [...new Set(values)].sort((a, b) => a.localeCompare(b, "en")); }

function analyzeSide(
  side: ImpactSide,
  snapshot: ImpactSnapshot,
  isolated: boolean,
  seeds: readonly string[],
  scopedTasks: readonly TaskPacket[],
  maxVisited: number,
  maxPaths: number,
  missing: Set<string>,
): ImpactCandidate[] {
  const graph = snapshot.graph;
  if (!graph) { missing.add(`${side}:graph`); return []; }
  if (isolated) { missing.add(`${side}:graph-isolation-mismatch`); return []; }
  // Treat caller supplied graph structure as untrusted even when it has a
  // parser-shaped TypeScript type. Duplicate IDs make Map selection depend on
  // input order, so quarantine the entire side before deriving any REVIEW.
  const entityIds = new Set<string>();
  let hasDuplicateEntityId = false;
  for (const entity of graph.entities) {
    if (entityIds.has(entity.id)) {
      missing.add(`${side}:duplicate-entity-id:${entity.id}`);
      hasDuplicateEntityId = true;
    }
    entityIds.add(entity.id);
  }
  const relationIds = new Set<string>();
  let hasDuplicateRelationId = false;
  for (const relation of graph.relations) {
    if (relationIds.has(relation.id)) {
      missing.add(`${side}:duplicate-relation-id:${relation.id}`);
      hasDuplicateRelationId = true;
    }
    relationIds.add(relation.id);
  }
  if (hasDuplicateEntityId || hasDuplicateRelationId) {
    missing.add(`${side}:graph-duplicate-ids-quarantined`);
    return [];
  }
  const entities = new Map(graph.entities.map(entity => [entity.id, entity]));
  const adjacency = new Map<string, Array<{ edge: SolutionRevision["relations"][number]; from: string; to: string; direction: "forward" | "reverse" }>>();
  for (const relation of graph.relations) {
    if (!GRAPH_RELATION_KINDS.includes(relation.kind)) {
      missing.add(`${side}:unsupported-graph-relation:${relation.id}`);
      continue;
    }
    // Check every relation, including unreachable ones, before traversal. A
    // dangling record is incomplete graph evidence even if no seed reaches it.
    if (!entities.has(relation.sourceId)) missing.add(`${side}:edge-endpoint:${relation.id}:${relation.sourceId}`);
    if (!entities.has(relation.targetId)) missing.add(`${side}:edge-endpoint:${relation.id}:${relation.targetId}`);
    if (!entities.has(relation.sourceId) || !entities.has(relation.targetId)) continue;
    for (const [from, to, direction] of [[relation.sourceId, relation.targetId, "forward"], [relation.targetId, relation.sourceId, "reverse"]] as const) {
      const list = adjacency.get(from) ?? [];
      list.push({ edge: relation, from, to, direction }); adjacency.set(from, list);
    }
  }
  for (const list of adjacency.values()) list.sort((a, b) => a.edge.id.localeCompare(b.edge.id, "en") || a.direction.localeCompare(b.direction, "en"));
  const entityRefs = (id: string): string[] => {
    const entity = entities.get(id);
    return [
      ...(entity?.specRef ? [`spec-ref:${entity.specRef}`] : []),
      ...(entity?.contractRefs ?? []).map(ref => `interface-contract-ref:${ref}`),
    ];
  };
  const sources = stable(seeds);
  for (const source of sources) if (!entities.has(source)) missing.add(`${side}:seed:${source}`);
  const paths = new Map<string, ImpactReasonPath[]>();
  const queue: Array<{ id: string; seed: string; path: ImpactPathEdge[]; refs: string[]; visitedNodes: string[] }> = [];
  let enqueued = 0;
  for (const source of sources) if (entities.has(source)) {
    if (enqueued >= maxVisited) {
      missing.add(`${side}:queue-limit:${maxVisited}`);
      missing.add(`${side}:traversal-limit:${maxVisited}`);
      break;
    }
    queue.push({ id: source, seed: source, path: [], refs: [`graph:${graph.graphRevisionId}`, `seed:${source}`, ...entityRefs(source)], visitedNodes: [source] });
    enqueued += 1;
  }
  const bestDepth = new Map<string, Map<string, number>>();
  while (queue.length) {
    const current = queue.shift()!;
    const seedDepths = bestDepth.get(current.seed) ?? new Map<string, number>();
    const oldDepth = seedDepths.get(current.id);
    if (oldDepth !== undefined && oldDepth < current.path.length) {
      missing.add(`${side}:non-shortest-path-omitted:${current.id}:${current.path.length}:${oldDepth}`);
      continue;
    }
    seedDepths.set(current.id, current.path.length);
    bestDepth.set(current.seed, seedDepths);
    const list = paths.get(current.id) ?? [];
    if (list.length < maxPaths) list.push(Object.freeze({ side, graphRevisionId: graph.graphRevisionId,
      edges: Object.freeze(current.path), sourceRefs: Object.freeze(stable(current.refs)) }));
    else missing.add(`${side}:path-limit:${current.id}:${maxPaths}`);
    paths.set(current.id, list);
    for (const step of adjacency.get(current.id) ?? []) {
      if (!entities.has(step.to)) { missing.add(`${side}:edge-target:${step.edge.id}:${step.to}`); continue; }
      // A path that returns to one of its own nodes is a cycle, not an omitted
      // alternative route to a new graph region.
      if (current.visitedNodes.includes(step.to)) continue;
      const prior = current.path.some(edge => edge.edgeId === step.edge.id);
      if (prior) continue;
      // Bound cumulative queue creation, which also bounds pending queue size.
      // Sorting sources and adjacency above keeps the retained prefix stable.
      if (enqueued >= maxVisited) {
        missing.add(`${side}:queue-limit:${maxVisited}`);
        missing.add(`${side}:traversal-limit:${maxVisited}`);
        continue;
      }
      queue.push({ id: step.to, seed: current.seed, path: [...current.path, Object.freeze({ edgeId: step.edge.id, kind: step.edge.kind,
        originalFrom: step.edge.sourceId, originalTo: step.edge.targetId, traversalFrom: step.from, traversalTo: step.to,
        direction: step.direction })], refs: [...current.refs, `edge:${step.edge.id}`,
        ...(step.edge.contractRef ? [`interface-contract-ref:${step.edge.contractRef}`] : []), ...entityRefs(step.to)],
        visitedNodes: [...current.visitedNodes, step.to] });
      enqueued += 1;
    }
  }
  const result: ImpactCandidate[] = [];
  for (const [entityId, reasonPaths] of paths) {
    const entity = entities.get(entityId)!;
    const attached = new Set<ImpactDimension>();
    const dimensions = Object.create(null) as Record<ImpactDimension, ImpactDimensionResult>;
    const requirementIds = new Set(snapshot.spec?.requirements.map(requirement => requirement.id) ?? []);
    const linkedRequirement = entity.specRef !== undefined && requirementIds.has(entity.specRef);
    const explicitRequirementEdges = reasonPaths.flatMap(path => path.edges.filter(edge => {
      const source = entities.get(edge.originalFrom);
      const target = entities.get(edge.originalTo);
      return edge.kind === "implements" && source?.kind === "requirement" && target?.kind === "feature";
    }).map(edge => `graph-relation:implements:${edge.edgeId}`));
    if (linkedRequirement || explicitRequirementEdges.length) attached.add("requirement");
    const graphEvidence = stable(reasonPaths.flatMap(path => path.edges.map(edge => `graph-relation:${edge.kind}:${edge.edgeId}`)));
    if (graphEvidence.length) attached.add("technical");
    const linkedInteractions = (snapshot.ui?.interactions ?? []).filter(interaction =>
      interaction.status === "specified" && linkedRequirement && interaction.requirementRefs.includes(entity.specRef!));
    if (linkedInteractions.length) attached.add("ui");
    const linkedTasks = scopedTasks.filter(task => task.scopeNodeIds.includes(entityId));
    if (linkedTasks.length) attached.add("task");
    if (linkedTasks.some(task => nonblank(task.ctoId))) attached.add("cto");
    for (const dimension of DIMENSIONS) {
      const evidence = [
        ...(dimension === "requirement" ? [
          ...(linkedRequirement ? [`spec-requirement-ref:${entity.specRef}`] : []),
          ...explicitRequirementEdges,
        ] : []),
        ...(dimension === "technical" ? graphEvidence : []),
        ...(dimension === "ui" ? linkedInteractions.map(interaction => `ui-requirement-ref:${interaction.id}:${entity.specRef}`) : []),
        ...(dimension === "task" ? linkedTasks.map(task => `task-scope:${task.taskId}:${entityId}`) : []),
        ...(dimension === "cto" ? linkedTasks.filter(task => nonblank(task.ctoId)).map(task => `task-cto-scope:${task.taskId}:${task.ctoId}:${entityId}`) : []),
        ...(!attached.has(dimension) ? [`no-verified-${dimension}-mapping`] : []),
      ];
      dimensions[dimension] = Object.freeze({
        status: attached.has(dimension) ? "REVIEW" : "UNKNOWN",
        evidence: Object.freeze(stable(evidence)),
      });
    }
    if (entity.specRef && !linkedRequirement) missing.add(`${side}:unresolved-spec-requirement-ref:${entityId}:${entity.specRef}`);
    const contractRefs = new Set(graph.relations.flatMap(relation => relation.contractRef ? [relation.contractRef] : []));
    for (const ref of entity.contractRefs ?? []) if (!contractRefs.has(ref)) {
      missing.add(`${side}:unresolved-interface-contract-ref:${entityId}:${ref}`);
    }
    result.push(Object.freeze({ side, entityId, entityKind: entity.kind, reasonPaths: Object.freeze(reasonPaths), dimensions: Object.freeze(dimensions) }));
  }
  return result;
}

/** Calculates conservative candidates from the supplied revisions; it does not validate authority or source existence. */
export function calculateChangeImpact(input: ChangeImpactInput, options: ChangeImpactOptions = {}): ChangeImpactResult {
  const maxVisited = options.maxVisited ?? DEFAULT_MAX_VISITED;
  const maxPaths = options.maxPathsPerEntity ?? DEFAULT_MAX_PATHS;
  if (!Number.isSafeInteger(maxVisited) || maxVisited < 1 || !Number.isSafeInteger(maxPaths) || maxPaths < 1) {
    throw new TypeError("Traversal bounds must be positive safe integers.");
  }
  if (!nonblank(input.workspaceId) || !nonblank(input.projectId)) throw new TypeError("Workspace and project IDs are required.");
  const missing = new Set<string>();
  const mismatch = (side: ImpactSide, snapshot: ImpactSnapshot): boolean => {
    let isolateGraph = false;
    if (snapshot.workspaceId !== input.workspaceId) { missing.add(`${side}:workspace-mismatch`); isolateGraph = true; }
    if (snapshot.projectId !== input.projectId) { missing.add(`${side}:project-mismatch`); isolateGraph = true; }
    if (!snapshot.collections.spec || !snapshot.spec) missing.add(`${side}:spec-collection-or-revision-missing`);
    if (!snapshot.collections.graph || !snapshot.graph) missing.add(`${side}:graph-collection-or-revision-missing`);
    if (!snapshot.collections.ui || !snapshot.ui) missing.add(`${side}:ui-collection-or-revision-missing`);
    if (snapshot.spec && snapshot.projectId !== snapshot.spec.projectId) { missing.add(`${side}:spec-project-mismatch`); isolateGraph = true; }
    if (snapshot.graph && snapshot.spec && snapshot.graph.approvedSpecRevisionId !== snapshot.spec.revisionId) {
      missing.add(`${side}:graph-spec-revision-mismatch`); isolateGraph = true;
    }
    for (const kind of ["spec", "graph", "ui"] as const) {
      const pin = snapshot.pins[kind];
      if (!pin || !HASH.test(pin.sourceSha256) || !nonblank(pin.sourceId) || !nonblank(pin.revisionId)) {
        missing.add(`${side}:${kind}-source-pin-invalid-or-missing`);
        isolateGraph = true;
      }
      const actualRevision = kind === "spec" ? snapshot.spec?.revisionId
        : kind === "graph" ? snapshot.graph?.graphRevisionId : snapshot.ui?.revisionId;
      if (pin && actualRevision && pin.revisionId !== actualRevision) {
        missing.add(`${side}:${kind}-revision-pin-mismatch`);
        isolateGraph = true;
      }
    }
    if (snapshot.ui && snapshot.ui.projectId !== input.projectId) { missing.add(`${side}:ui-project-mismatch`); isolateGraph = true; }
    for (const interaction of snapshot.ui?.interactions ?? []) {
      for (const ref of interaction.requirementRefs) if (!snapshot.spec?.requirements.some(requirement => requirement.id === ref)) {
        missing.add(`${side}:unresolved-ui-requirement-ref:${interaction.id}:${ref}`);
      }
      for (const [namespace, refs] of [["behavior", interaction.behaviorRefs], ["state", interaction.stateRefs], ["api", interaction.apiRefs]] as const) {
        for (const ref of refs) missing.add(`${side}:unmapped-ui-${namespace}-ref:${interaction.id}:${ref}`);
      }
    }
    return isolateGraph;
  };
  const oldIsolated = mismatch("old", input.old);
  const newIsolated = mismatch("new", input.new);
  const seeds = new Set(input.changedNodeIds.filter(nonblank));
  if (input.changedNodeIds.some(value => !nonblank(value))) missing.add("invalid-changed-node-id");
  const change = input.workstreamChange;
  const requestedTaskIds = new Set<string>();
  if (!change) missing.add("workstream-change-missing");
  else {
    change.impactNodeIds.forEach(id => seeds.add(id));
    // These are separate identifier namespaces. Until an explicit graph edge
    // connects them, treating either value as a node ID can invent a relation
    // when unrelated IDs happen to have the same spelling.
    for (const id of change.impactInterfaceContracts) missing.add(`unmapped-interface-contract:${id}`);
    change.impactTaskIds.forEach(id => requestedTaskIds.add(id));
  }
  const scopedTasks: TaskPacket[] = [];
  if (!input.taskPackets) missing.add("task-packet-collection-missing");
  else {
    const requestedPackets = input.taskPackets.filter(task => requestedTaskIds.has(task.taskId));
    const sameProjectCounts = new Map<string, number>();
    for (const task of requestedPackets) if (task.projectId === input.projectId) {
      sameProjectCounts.set(task.taskId, (sameProjectCounts.get(task.taskId) ?? 0) + 1);
    }
    const ambiguousTaskIds = new Set<string>();
    for (const [taskId, count] of sameProjectCounts) if (count > 1) {
      ambiguousTaskIds.add(taskId);
      missing.add(`task-duplicate-id:${taskId}`);
    }
    for (const task of requestedPackets) {
      if (task.projectId !== input.projectId) {
        missing.add(`task-project-mismatch:${task.taskId}`);
        continue;
      }
      if (ambiguousTaskIds.has(task.taskId)) continue;
      scopedTasks.push(task);
      if (task.scopeNodeIds.length === 0) { missing.add(`task-scope-unconnected:${task.taskId}`); continue; }
      task.scopeNodeIds.forEach(id => seeds.add(id));
    }
  }
  for (const taskId of requestedTaskIds) if (!input.taskPackets?.some(task => task.taskId === taskId)) {
    missing.add(`unresolved-impact-task:${taskId}`);
  }
  const oldCandidates = analyzeSide("old", input.old, oldIsolated, [...seeds], scopedTasks, maxVisited, maxPaths, missing);
  const newCandidates = analyzeSide("new", input.new, newIsolated, [...seeds], scopedTasks, maxVisited, maxPaths, missing);
  if (!input.old.graph?.relations.length || !input.new.graph?.relations.length) missing.add("graph-relations-empty-or-missing");
  const candidates = [...oldCandidates, ...newCandidates].sort((a, b) => a.side.localeCompare(b.side, "en") || a.entityId.localeCompare(b.entityId, "en"));
  const finalCandidates = candidates.map(candidate => {
    if (!missing.size) return candidate;
    const dimensions = Object.create(null) as Record<ImpactDimension, ImpactDimensionResult>;
    for (const dimension of DIMENSIONS) {
      const current = candidate.dimensions[dimension];
      dimensions[dimension] = Object.freeze({ status: "UNKNOWN", evidence: Object.freeze([...current.evidence, ...stable([...missing])]) });
    }
    return Object.freeze({ ...candidate, dimensions: Object.freeze(dimensions) });
  });
  return Object.freeze({ workspaceId: input.workspaceId, projectId: input.projectId, candidates: Object.freeze(finalCandidates),
    missing: Object.freeze(stable([...missing])), sourceVerification: "caller-pinned-structure-only",
    limitations: Object.freeze(["Source IDs and hashes are caller claims; bytes and authority are not verified.",
      "A pure calculation cannot prove complete collections, approval, source existence, or runtime behavior.",
      "Unmapped impact dimensions remain UNKNOWN; candidates require human review."]) });
}
