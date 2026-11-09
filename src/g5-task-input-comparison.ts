import { createHash } from "node:crypto";
import { firstDesignReviewApprovalRevision, type DesignBaseline } from "./domain/design-baseline.ts";
import { taskPacketRecordDigest, type TaskPacketBoard, type TaskPacketRecord } from "./domain/task-packets.ts";
import type { AuthoredTechnologyDecisions } from "./domain/authored-technology-decisions.ts";
import type { WorkstreamRecord } from "./domain/workstreams.ts";
import type { RevisionState } from "./solution-revision-store.ts";
import { readFirstDesignApprovalRevision } from "./spec-assurance/review-first-design.ts";
import type { UiRevision } from "./ui-contracts/domain.ts";
import { workstreamInstructionDigest } from "./cto-delivery-store.ts";

export type G5TaskInputSide = Readonly<{ baseline: DesignBaseline; ui: UiRevision; technology: AuthoredTechnologyDecisions;
  workstream: WorkstreamRecord; tasks: TaskPacketBoard }>;
type Review = NonNullable<Awaited<ReturnType<typeof readFirstDesignApprovalRevision>>>;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const order = <T extends { id: string }>(rows: readonly T[]) => [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

async function approvedReview(workspaceId: string, baseline: DesignBaseline, state: RevisionState): Promise<Review | null> {
  const id = firstDesignReviewApprovalRevision(baseline.userDecision.sourceId);
  if (!id || baseline.specification.approvalEvidenceRef !== baseline.userDecision.sourceId) return null;
  const review = await readFirstDesignApprovalRevision(workspaceId, baseline.projectId, id, state);
  const spec = baseline.specification, graph = baseline.graph;
  return review?.status === "APPROVED" && review.approval && review.draftRevisionId === baseline.sourceDraftRevisionId
    && digest(review) === baseline.userDecision.sourceSha256
    && same([review.draft.specification.productTier, review.draft.specification.targets,
      review.draft.specification.dataPolicyRef, review.draft.specification.requirements],
    [spec.productTier, spec.targets, spec.dataPolicyRef, spec.requirements])
    && same([review.draft.graph.entities, review.draft.graph.relations, review.draft.graph.viewLayoutRef],
      [graph.entities, graph.relations, graph.viewLayoutRef]) ? review : null;
}

function scopedInputs(side: G5TaskInputSide, review: Review, task: TaskPacketRecord,
  requiredSource?: Readonly<{ requestId: string; instructionSha256: string }>) {
  const { projectId, ctoId, workstreamId, packets } = side.tasks;
  const byId = new Map(packets.map(record => [record.packet.taskId, record]));
  const closure = new Map<string, TaskPacketRecord>();
  const pending = [task];
  while (pending.length) {
    const record = pending.pop()!;
    if (closure.has(record.packet.taskId)) continue;
    if (requiredSource && (record.source.requestId !== requiredSource.requestId
      || record.source.specRevision !== side.workstream.spec.revision
      || record.source.instructionSha256 !== requiredSource.instructionSha256
      || record.author.agentId !== side.workstream.ctoAgentId || record.author.sessionId !== side.workstream.ctoSessionId
      || record.packet.scopeNodeIds.some(id => !side.workstream.spec.scopeNodeIds.includes(id)))) return null;
    closure.set(record.packet.taskId, record);
    for (const pin of record.dependencyPins) {
      const dependency = byId.get(pin.taskId);
      if (!dependency || dependency.packet.revision !== pin.revision
        || taskPacketRecordDigest(dependency, projectId, ctoId, workstreamId) !== pin.recordSha256) return null;
      pending.push(dependency);
    }
  }

  const graph = side.baseline.graph, spec = side.baseline.specification;
  const nodes = new Set(side.workstream.spec.scopeNodeIds), requirements = new Set<string>();
  for (const { packet } of closure.values()) {
    for (const id of packet.scopeNodeIds) nodes.add(id);
    for (const id of packet.requirementIds) requirements.add(id);
  }
  // Follow both directions, including nodes which implement the same requirement.
  // Typed prefixes keep an identically named requirement and graph entity distinct.
  const links = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    const left = links.get(a) ?? new Set<string>(), right = links.get(b) ?? new Set<string>();
    left.add(b); right.add(a); links.set(a, left); links.set(b, right);
  };
  for (const row of graph.entities) {
    if (row.specRef) connect(`n:${row.id}`, `r:${row.specRef}`);
    for (const contract of row.contractRefs ?? []) connect(`n:${row.id}`, `c:${contract}`);
  }
  for (const row of graph.relations) {
    connect(`n:${row.sourceId}`, `n:${row.targetId}`);
    if (row.contractRef) connect(`n:${row.sourceId}`, `c:${row.contractRef}`);
  }
  for (const row of spec.requirements) for (const ac of row.acceptanceCriteriaIds) connect(`r:${row.id}`, `a:${ac}`);
  const queue = [...[...nodes].map(id => `n:${id}`), ...[...requirements].map(id => `r:${id}`)];
  const visited = new Set(queue);
  for (let index = 0; index < queue.length; index++) {
    for (const next of links.get(queue[index]!) ?? []) if (!visited.has(next)) { visited.add(next); queue.push(next); }
  }
  for (const key of visited) {
    if (key.startsWith("n:")) nodes.add(key.slice(2));
    if (key.startsWith("r:")) requirements.add(key.slice(2));
  }
  const entities = order(graph.entities.filter(row => nodes.has(row.id)));
  const relevantRequirements = order(spec.requirements.filter(row => requirements.has(row.id)));
  if (!requirements.size || entities.length !== nodes.size || relevantRequirements.length !== requirements.size) return null;

  const model = review.designModel;
  if (!model || [...requirements].some(id => !review.sourcePins.some(pin => pin.requirementId === id)
    || !model.itemDecisions.some(item => item.requirementId === id && item.status !== "UNDECIDED"))) return null;
  const acIds = new Set(relevantRequirements.flatMap(row => row.acceptanceCriteriaIds));
  if (relevantRequirements.some(row => row.acceptanceCriteriaIds.some(id => !model.acceptanceCriteria.some(ac =>
    ac.requirementId === row.id && ac.acId === id)))) return null;
  const { identity: _identity, ...pack } = review.pack;
  const { revision: _revision, sourceSpecRevisionId: _spec, technologyDecisionsRef: _technology, ...workstream } = side.workstream.spec;
  return {
    tasks: [...closure.values()].sort((a, b) => a.packet.taskId.localeCompare(b.packet.taskId)).map(({ packet }) => {
      const { revision: _revision, ...inputs } = packet;
      return inputs;
    }),
    workstream, owner: [side.workstream.ctoAgentId, side.workstream.ctoSessionId],
    spec: { tier: spec.productTier, targets: spec.targets, dataPolicy: spec.dataPolicyRef, requirements: relevantRequirements },
    graph: { entities, relations: order(graph.relations.filter(row => nodes.has(row.sourceId) || nodes.has(row.targetId))),
      viewLayoutRef: graph.viewLayoutRef },
    ui: { htmlSha256: side.ui.artifact.htmlSha256, viewport: side.ui.artifact.viewport, screens: side.ui.contract.screenIds,
      interactions: side.ui.contract.interactions, review: side.ui.reviewByInteractionId },
    technology: side.technology.register.entries,
    assurance: { pack, facts: model.facts, scenarios: model.scenarios, rulesVersion: model.rulesManifest.rulesVersion,
      rules: model.rulesManifest.rules, targets: model.rulesManifest.targets.filter(row => row.targetKind === "requirement"
        ? requirements.has(row.targetId) : acIds.has(row.targetId)),
      sourcePins: review.sourcePins.filter(row => requirements.has(row.requirementId)),
      decisions: model.itemDecisions.filter(row => requirements.has(row.requirementId)),
      criteria: model.acceptanceCriteria.filter(row => requirements.has(row.requirementId)) },
  };
}

/** Server-owned projection from already matched published G5 pairs. It compares
 * recorded inputs, not QA outcomes, product-wide schedule, or live execution authority. */
export async function comparePublishedG5TaskInputs(workspaceId: string, before: G5TaskInputSide, after: G5TaskInputSide, state: RevisionState) {
  const [oldReview, newReview] = await Promise.all([
    approvedReview(workspaceId, before.baseline, state).catch(() => null),
    approvedReview(workspaceId, after.baseline, state).catch(() => null),
  ]);
  const { projectId, ctoId, workstreamId } = after.tasks;
  const bounded = before.tasks.projectId === projectId && before.tasks.ctoId === ctoId && before.tasks.workstreamId === workstreamId
    && before.workstream.spec.dependencies.length === 0 && after.workstream.spec.dependencies.length === 0
    && before.workstream.spec.interfaceContracts.length === 0 && after.workstream.spec.interfaceContracts.length === 0;
  return after.tasks.packets.map(current => {
    const taskId = current.packet.taskId;
    const previous = before.tasks.packets.find(row => row.packet.taskId === taskId);
    const identity = { taskId, kind: current.packet.kind, previousDigest: previous
      ? taskPacketRecordDigest(previous, projectId, ctoId, workstreamId) : null,
    comparedDigest: taskPacketRecordDigest(current, projectId, ctoId, workstreamId) };
    const result = (status: "unchanged-recorded-inputs" | "changed" | "unknown", reason: string | null, inputsSha256: string | null = null) =>
      ({ ...identity, status, reason, inputsSha256 });
    if (!previous) return result("changed", "no-prior-task");
    if (!bounded || !oldReview || !newReview) return result("unknown", "approved-scope-or-external-dependency-unavailable");
    const oldInputs = scopedInputs(before, oldReview, previous), newInputs = scopedInputs(after, newReview, current);
    if (!oldInputs || !newInputs) return result("unknown", "task-dependency-or-design-material-incomplete");
    return same(oldInputs, newInputs) ? result("unchanged-recorded-inputs", null, digest(newInputs))
      : result("changed", "recorded-qa-inputs-differ");
  });
}

/** Compare the selected development/QA pair across the three already-resolved
 * journal stages. Packet provenance is checked but is not a semantic input. */
export async function compareG5TaskInputChain(workspaceId: string, previous: G5TaskInputSide, compared: G5TaskInputSide,
  current: G5TaskInputSide, taskId: string, qaTaskId: string, currentRequestId: string, state: RevisionState) {
  const { projectId, ctoId, workstreamId } = current.tasks;
  const recordDigest = (record: TaskPacketRecord) => taskPacketRecordDigest(record, projectId, ctoId, workstreamId);
  const stages = [previous, compared, current] as const;
  const [oldReview, nextReview] = await Promise.all([
    approvedReview(workspaceId, previous.baseline, state), approvedReview(workspaceId, compared.baseline, state),
  ]);
  if (!oldReview || !nextReview || !same(current.baseline, compared.baseline)) return null;
  const resolve = (side: G5TaskInputSide, review: Review, requestId?: string) => {
    if (side.tasks.projectId !== projectId || side.tasks.ctoId !== ctoId || side.tasks.workstreamId !== workstreamId
      || side.workstream.spec.dependencies.length || side.workstream.spec.interfaceContracts.length) return null;
    const task = side.tasks.packets.find(row => row.packet.taskId === taskId);
    const qa = side.tasks.packets.find(row => row.packet.taskId === qaTaskId);
    if (task?.packet.kind !== "development" || qa?.packet.kind !== "qa" || !qa.packet.testPlan) return null;
    const implementationDigest = recordDigest(task), qaDigest = recordDigest(qa);
    if (!qa.dependencyPins.some(pin => pin.taskId === taskId && pin.revision === task.packet.revision
      && pin.recordSha256 === implementationDigest)) return null;
    const source = { requestId: requestId ?? task.source.requestId, instructionSha256: workstreamInstructionDigest(side.workstream) };
    const taskInputs = scopedInputs(side, review, task, source), qaInputs = scopedInputs(side, review, qa, source);
    if (!taskInputs || !qaInputs) return null;
    return Object.freeze({ implementationDigest, qaDigest, implementationRevision: task.packet.revision, qaRevision: qa.packet.revision,
      implementationInputsSha256: digest(taskInputs), qaInputsSha256: digest(qaInputs),
      implementationSource: Object.freeze({ ...task.source }), qaSource: Object.freeze({ ...qa.source }) });
  };
  const first = resolve(stages[0], oldReview), second = resolve(stages[1], nextReview), third = resolve(stages[2], nextReview, currentRequestId);
  if (!first || !second || !third
    || first.implementationRevision >= second.implementationRevision || second.implementationRevision >= third.implementationRevision
    || first.qaRevision >= second.qaRevision || second.qaRevision >= third.qaRevision
    || first.implementationInputsSha256 !== second.implementationInputsSha256 || second.implementationInputsSha256 !== third.implementationInputsSha256
    || first.qaInputsSha256 !== second.qaInputsSha256 || second.qaInputsSha256 !== third.qaInputsSha256) return null;
  return Object.freeze({ previous: first, compared: second, current: third });
}
