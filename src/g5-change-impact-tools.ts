import { createHash } from "node:crypto";
import type { JsonValue, SpsActionContext, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { produceG5ChangeImpactCandidates, type G5Dimension, type G5Snapshot } from "./domain/g5-change-impact.ts";
import { parseTaskPacketBoard, parseTaskPacketRecord, type TaskPacketRecord } from "./domain/task-packets.ts";
import { parseDesignBaseline } from "./domain/design-baseline.ts";
import { parseAuthoredTechnologyDecisions } from "./domain/authored-technology-decisions.ts";
import { parseUiApproval, revisionDigest } from "./ui-contracts/domain.ts";
import { parseUiRevision, type UiRevision } from "./ui-contracts/domain.ts";
import { createRevisionJournal, type RevisionState } from "./solution-revision-store.ts";
import { exactToolRecord, parseLeadToolContext, resolveLeadToolAuthority } from "./lead-tool-authority.ts";
import { workstreamInstructionDigest } from "./cto-delivery-store.ts";
import { parseWorkstreamBoard, type WorkstreamRecord } from "./domain/workstreams.ts";
import { compareG5TaskInputChain, comparePublishedG5TaskInputs, type G5TaskInputSide } from "./g5-task-input-comparison.ts";
import { parseProjectCtos } from "./domain/project-ctos.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a bounded identifier.`);
  }
  return value;
}

function revisionPair(value: unknown, label: string): Readonly<{ oldRevisionId: string; newRevisionId: string }> {
  const row = exactToolRecord(value, ["oldRevisionId", "newRevisionId"]);
  return Object.freeze({ oldRevisionId: id(row.oldRevisionId, `${label}.oldRevisionId`),
    newRevisionId: id(row.newRevisionId, `${label}.newRevisionId`) });
}

function snapshot(projectId: string, revisionId: string, records: readonly Record<string, unknown>[]): G5Snapshot {
  return Object.freeze({ projectId, revisionId, records: Object.freeze(records) }) as G5Snapshot;
}

function dimensionsPair(old: G5Snapshot, current: G5Snapshot) {
  return Object.freeze({ old, new: current });
}

function createG5WorkstreamReader(workspaceId: string, projectId: string, state: RevisionState) {
  return createRevisionJournal(workspaceId, projectId, state, { prefix: "workstreams",
    parse: value => parseWorkstreamBoard(value, projectId), revisionId: value => value.revisionId });
}

function createG5BaselineReader(workspaceId: string, projectId: string, state: RevisionState) {
  return createRevisionJournal(workspaceId, projectId, state, { prefix: "design-baseline",
    parse: value => parseDesignBaseline(value, projectId), revisionId: value => value.revisionId });
}

function createG5TechnologyReader(workspaceId: string, projectId: string, state: RevisionState) {
  return createRevisionJournal(workspaceId, projectId, state, { prefix: "technology-decisions",
    parse: value => parseAuthoredTechnologyDecisions(value, projectId), revisionId: value => value.register.revisionId });
}

function createG5TaskReader(workspaceId: string, projectId: string, ctoId: string, workstreamId: string, state: RevisionState) {
  const packetScope = createHash("sha256").update(JSON.stringify([projectId, ctoId, workstreamId]), "utf8").digest("hex");
  parseTaskPacketBoard({ projectId, ctoId, workstreamId, revisionId: "g5-scope-check", packets: [] }, projectId, ctoId, workstreamId);
  return createRevisionJournal(workspaceId, `packets:${packetScope}`, state, { prefix: "task-packets",
    parse: value => parseTaskPacketBoard(value, projectId, ctoId, workstreamId), revisionId: value => value.revisionId });
}

function createG5UiReader(workspaceId: string, projectId: string, state: RevisionState, prefix: "ui-contracts" | "ui-proposals") {
  return createRevisionJournal(workspaceId, projectId, state, { prefix,
    parse: value => parseUiRevision(value, projectId), revisionId: value => value.revisionId });
}

function uiRecords(revision: UiRevision): readonly Record<string, unknown>[] {
  return revision.contract.interactions.map(item => ({ ...item,
    requirementRefs: item.requirementRefs,
    uiRefs: [item.screenId, ...item.behaviorRefs, ...item.stateRefs, ...item.apiRefs],
  }));
}

/**
 * Authenticated, read-only G5 source adapter for registration as a Builder tool.
 * Exact published journal entries are read from the invocation's Workspace state;
 * no caller-provided source records are accepted.
 */
export async function readG5ChangeImpactCandidates(params: unknown, runContext: unknown,
  platform: SpsPlatformInvocationContext, includeTaskInputs = true) {
  const input = impactInput(params);
  const projectId = id(input.projectId, "projectId");
  const context = parseLeadToolContext(runContext);
  if (projectId !== context.companyId || context.projectId !== undefined && context.projectId !== projectId) {
    throw new Error("G5 project does not match the authenticated Lead context.");
  }
  const authority = await resolveLeadToolAuthority(context, platform);
  if (authority.channel !== "main" && authority.channel !== "integration-review") {
    throw new Error("G5 source comparison is limited to Main or Integration Review Lead sessions.");
  }
  return comparePublishedRevisions(input, context.companyId, projectId, platform.state as RevisionState, authority.check, includeTaskInputs);
}

function impactInput(params: unknown) {
  return exactToolRecord(params,
    ["projectId", "oldBaselineRevisionId", "newBaselineRevisionId", "oldUiRevisionId", "newUiRevisionId"],
    ["technology", "workstreams", "tasks"]);
}

export async function readUserG5ChangeImpact(params: unknown, context: Pick<SpsActionContext, "actor" | "companyId" | "state">) {
  const check = async () => {
    if (context.actor.type !== "user" || context.actor.companyId !== context.companyId || !context.actor.userId) {
      throw new Error("G5 comparison requires an authenticated Workspace user.");
    }
  };
  await check();
  const input = impactInput(params);
  const workspaceId = id(context.companyId, "workspaceId");
  if (input.projectId !== workspaceId) throw new Error("G5 project does not match the authenticated Workspace.");
  return (await comparePublishedRevisions(input, workspaceId, workspaceId, context.state as RevisionState, check, true)).data;
}

export type CurrentG5EffectInput = Readonly<{
  workspaceId: string; projectId: string; ctoId: string; workstreamId: string; taskId: string;
  workstream: WorkstreamRecord;
  taskRecord: TaskPacketRecord;
  assertCurrent(): Promise<void>;
  state: RevisionState;
}>;

/** Server-only recorded-input proof. The callback must revalidate the current
 * authorized CTO invocation; this read never renews a historical Run grant. */
export async function readCurrentG5TaskInputProof(input: CurrentG5EffectInput & Readonly<{
  qaTaskId: string; currentRequestId: string;
}>) {
  try {
    const row = exactToolRecord(input, ["workspaceId", "projectId", "ctoId", "workstreamId", "taskId",
      "workstream", "taskRecord", "assertCurrent", "state", "qaTaskId", "currentRequestId"]);
    const workspaceId = id(row.workspaceId, "workspaceId"), projectId = id(row.projectId, "projectId");
    const ctoId = id(row.ctoId, "ctoId"), workstreamId = id(row.workstreamId, "workstreamId");
    const taskId = id(row.taskId, "taskId"), qaTaskId = id(row.qaTaskId, "qaTaskId");
    const currentRequestId = id(row.currentRequestId, "currentRequestId");
    if (workspaceId !== projectId || taskId === qaTaskId || typeof row.assertCurrent !== "function"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(currentRequestId)) {
      throw new Error("Invalid current G5 proof scope.");
    }
    const state = row.state as RevisionState, callback = row.assertCurrent as () => Promise<void>;
    const workstream = parseWorkstreamBoard({ projectId, revisionId: "g5-current-proof-snapshot", workstreams: [row.workstream] }, projectId).workstreams[0]!;
    const taskRecord = parseTaskPacketRecord(row.taskRecord, projectId, ctoId, workstreamId);
    const assertCurrent = async () => {
      if (await callback() !== undefined) throw new Error("Current G5 proof authority was not asserted.");
    };
    const scope = { workspaceId, projectId, ctoId, workstreamId, taskId, workstream, taskRecord, assertCurrent, state };
    const registryKey = { scopeKind: "company" as const, scopeId: workspaceId, namespace: "sonpark.my-builder",
      stateKey: `project-ctos.v1.${createHash("sha256").update(projectId).digest("hex")}` };
    const inspect = async () => {
      await assertCurrent();
      const registry = await state.get(registryKey);
      const cto = parseProjectCtos(registry, workspaceId, projectId).ctos.find(item => item.ctoId === ctoId);
      if (!cto || cto.status !== "ACTIVE" || cto.agentId !== workstream.ctoAgentId || cto.sessionId !== workstream.ctoSessionId) {
        throw new Error("Current G5 CTO role is unavailable.");
      }
      const resolved = await readAcknowledgedG5EffectScope(scope);
      const pair = resolved.taskPair, handoff = workstream.change.g5Handoff!;
      const technologyStore = createG5TechnologyReader(workspaceId, projectId, state);
      const technology = await technologyStore.current();
      if (!pair || pair.previous.taskBoardSequence >= pair.compared.taskBoardSequence
        || pair.compared.taskBoardSequence >= resolved.currentTasks.sequence
        || pair.previous.workstreamBoardSequence >= pair.compared.workstreamBoardSequence
        || pair.compared.workstreamBoardSequence >= resolved.currentWorkstreams.sequence
        || !technology || hash(technology.revision) !== hash(pair.compared.source.technology)
        || hash(technology.revision) !== workstream.technologyDigest) {
        throw new Error("Current G5 published ancestry or Technology is unavailable.");
      }
      const current: G5TaskInputSide = { baseline: resolved.currentBaseline.revision, ui: resolved.currentUi.revision,
        technology: technology.revision, workstream, tasks: resolved.currentTasks.revision };
      const chain = await compareG5TaskInputChain(workspaceId, pair.previous.source, pair.compared.source, current,
        taskId, qaTaskId, currentRequestId, state);
      if (!chain) throw new Error("Current G5 Task inputs are changed or incomplete.");
      await resolved.check();
      if (hash(await technologyStore.current()) !== hash(technology) || hash(await state.get(registryKey)) !== hash(registry)) {
        throw new Error("Current G5 Technology or CTO changed during observation.");
      }
      await assertCurrent();
      const value = Object.freeze({ kind: "g5-task-qa-carry-forward-v1" as const, taskId, qaTaskId,
        handoffSha256: hash(handoff), priorTaskBoardRevisionId: pair.previous.source.tasks.revisionId,
        comparedTaskBoardRevisionId: pair.compared.source.tasks.revisionId,
        currentTaskBoardRevisionId: current.tasks.revisionId,
        task: Object.freeze({ prior: chain.previous.implementationDigest, compared: chain.compared.implementationDigest,
          current: chain.current.implementationDigest, inputsSha256: chain.current.implementationInputsSha256 }),
        qa: Object.freeze({ prior: chain.previous.qaDigest, compared: chain.compared.qaDigest,
          current: chain.current.qaDigest, inputsSha256: chain.current.qaInputsSha256 }) });
      return { value, observations: hash([registry, pair, resolved.currentBaseline, resolved.currentUi,
        resolved.currentWorkstreams, resolved.currentTasks, technology, chain]) };
    };
    const first = await inspect(), expected = hash(first);
    return Object.freeze({ status: "available" as const, value: first.value, async check(): Promise<void> {
      if (hash(await inspect()) !== expected) throw new Error("Current G5 Task input proof changed.");
    } });
  } catch {
    return Object.freeze({ status: "unknown" as const, reason: "current-g5-task-input-proof-unavailable" });
  }
}

/** Internal dispatch guard. This is deliberately not registered as a CTO-facing tool. */
export async function assertCurrentCtoTaskG5Effect(input: CurrentG5EffectInput): Promise<Readonly<{
  status: "not-scoped" | "candidate" | "unaffected-exact" | "unknown";
  impactStatus: "NOT_APPLICABLE" | "CANDIDATES" | "NO_CANDIDATE_OBSERVED" | "UNKNOWN" }>> {
  if (!input.workstream.change.g5Handoff) return Object.freeze({ status: "not-scoped", impactStatus: "NOT_APPLICABLE" });
  const { taskDimension, candidateIds } = await readAcknowledgedG5EffectScope(input);
  if (taskDimension.status === "UNKNOWN") {
    return Object.freeze({ status: candidateIds.includes(input.taskId) ? "candidate" : "unknown", impactStatus: "UNKNOWN" });
  }
  if (taskDimension.status === "CANDIDATES") {
    return Object.freeze({ status: candidateIds.includes(input.taskId) ? "candidate" : "unaffected-exact", impactStatus: "CANDIDATES" });
  }
  return Object.freeze({ status: "unknown", impactStatus: taskDimension.status });
}

async function readAcknowledgedG5EffectScope(input: CurrentG5EffectInput) {
  const { workspaceId, projectId, ctoId, workstreamId, taskId, workstream, taskRecord, assertCurrent, state } = input;
  if (workspaceId !== projectId) throw new Error("G5 effect scope requires the current Workspace project boundary.");
  const handoff = workstream.change.g5Handoff;
  if (!handoff || handoff.tasks.ctoId !== ctoId || handoff.tasks.workstreamId !== workstreamId
    || workstream.spec.projectId !== projectId || workstream.spec.id !== workstreamId
    || workstream.spec.assignedCtoId !== ctoId || taskRecord.packet.taskId !== taskId
    || taskRecord.packet.ctoId !== ctoId || taskRecord.packet.workstreamId !== workstreamId
    || !workstream.receipt || workstream.receipt.revision !== workstream.spec.revision
    || workstream.receipt.readiness !== "ready") {
    throw new Error("G5 task dispatch requires the exact current scoped Workstream acknowledgement and Task binding.");
  }

  await assertCurrent();
  const baselineStore = createG5BaselineReader(workspaceId, projectId, state);
  const uiStore = createG5UiReader(workspaceId, projectId, state, "ui-contracts");
  const workstreamStore = createG5WorkstreamReader(workspaceId, projectId, state);
  const taskStore = createG5TaskReader(workspaceId, projectId, ctoId, workstreamId, state);
  const [currentBaseline, currentUi, currentWorkstreams, currentTasks] = await Promise.all([
    baselineStore.current(), uiStore.current(), workstreamStore.current(), taskStore.current(),
  ]);
  const liveWorkstream = currentWorkstreams?.revision.workstreams.find(row => row.spec.id === workstreamId);
  const pairedWorkstreams = await workstreamStore.publishedRevision(handoff.workstreams.newRevisionId);
  const pairedWorkstream = pairedWorkstreams?.revision.workstreams.find(row => row.spec.id === workstreamId);
  const sameSpecExceptRevision = Boolean(pairedWorkstream
    && hash({ ...pairedWorkstream.spec, revision: workstream.spec.revision }) === hash(workstream.spec));
  if (!currentBaseline || currentBaseline.revision.revisionId !== handoff.newBaselineRevisionId
    || workstream.sourceBaselineRevisionId !== currentBaseline.revision.revisionId
    || workstream.baselineDigest !== hash(currentBaseline.revision)
    || !currentUi || currentUi.revision.revisionId !== handoff.newUiRevisionId
    || currentUi.revision.publication !== "formal" || currentUi.revision.source.kind !== "baseline"
    || currentUi.revision.source.revisionId !== currentBaseline.revision.revisionId
    || !currentWorkstreams || !liveWorkstream || hash(liveWorkstream) !== hash(workstream) || !sameSpecExceptRevision
    || !pairedWorkstream || pairedWorkstream.sourceBaselineRevisionId !== currentBaseline.revision.revisionId
    || pairedWorkstream.spec.technologyDecisionsRef !== workstream.spec.technologyDecisionsRef
    || !currentTasks || !await taskStore.publishedRevision(handoff.tasks.newRevisionId)) {
    throw new Error("G5 effect scope is stale: current approved Baseline, formal UI, Workstream or Task ancestry changed.");
  }

  const comparison = await comparePublishedRevisionSources({ projectId,
    oldBaselineRevisionId: handoff.oldBaselineRevisionId, newBaselineRevisionId: handoff.newBaselineRevisionId,
    oldUiRevisionId: handoff.oldUiRevisionId, newUiRevisionId: handoff.newUiRevisionId,
    ...(handoff.technology ? { technology: handoff.technology } : {}),
    workstreams: handoff.workstreams, tasks: handoff.tasks }, workspaceId, projectId, state, assertCurrent);
  const data = comparison.result.data as unknown as { sourcePins: Record<string, unknown>; dimensions: Record<string, {
    status: "CANDIDATES" | "NO_CANDIDATE_OBSERVED" | "UNKNOWN"; candidates: readonly { recordId: string }[] }> };
  const taskDimension = data.dimensions.tasks;
  const impactSha256 = hash({ sourcePins: data.sourcePins, dimensions: data.dimensions });
  const candidateIds = taskDimension?.candidates.map(candidate => candidate.recordId).sort() ?? [];
  if (!taskDimension || impactSha256 !== handoff.impactSha256
    || taskDimension.status !== handoff.taskImpactStatus
    || JSON.stringify(candidateIds) !== JSON.stringify([...handoff.affectedTaskIds].sort())
    || JSON.stringify([...workstream.change.impactTaskIds].sort()) !== JSON.stringify(candidateIds)) {
    throw new Error("G5 effect scope or impact digest no longer matches its exact published source pair.");
  }

  const liveTask = currentTasks.revision.packets.find(row => row.packet.taskId === taskId);
  if (!liveWorkstream || !liveTask || hash(liveWorkstream) !== hash(workstream)
    || hash(liveTask) !== hash(taskRecord)) {
    throw new Error("G5 dispatch Task or Workstream changed during effect-scope resolution.");
  }
  const currentHeads = hash([currentBaseline, currentUi, currentWorkstreams, currentTasks]);
  const check = async () => {
    await assertCurrent();
    const heads = await Promise.all([baselineStore.current(), uiStore.current(), workstreamStore.current(), taskStore.current()]);
    if (hash(heads) !== currentHeads) throw new Error("G5 approved scope or current Task changed during dispatch preflight.");
    await assertCurrent();
  };
  await check();
  return { taskDimension, candidateIds, taskPair: comparison.taskPair, impactSha256,
    currentBaseline, currentUi, currentWorkstreams, currentTasks, check };
}

type PublishedG5TaskInputSide = Readonly<{
  source: G5TaskInputSide;
  baselineSequence: number;
  uiSequence: number;
  technologySequence: number;
  workstreamBoardRevisionId: string;
  workstreamBoardSequence: number;
  taskBoardSequence: number;
}>;

async function comparePublishedRevisions(input: ReturnType<typeof impactInput>, workspaceId: string, projectId: string,
  state: RevisionState, check: () => Promise<void>, includeTaskInputs = false) {
  return (await comparePublishedRevisionSources(input, workspaceId, projectId, state, check, includeTaskInputs)).result;
}

async function comparePublishedRevisionSources(input: ReturnType<typeof impactInput>, workspaceId: string, projectId: string,
  state: RevisionState, check: () => Promise<void>, includeTaskInputs = false) {
  await check();
  const oldBaselineId = id(input.oldBaselineRevisionId, "oldBaselineRevisionId");
  const newBaselineId = id(input.newBaselineRevisionId, "newBaselineRevisionId");
  const oldUiId = id(input.oldUiRevisionId, "oldUiRevisionId");
  const newUiId = id(input.newUiRevisionId, "newUiRevisionId");
  const baselineStore = createG5BaselineReader(workspaceId, projectId, state);
  const [oldBaselineEntry, newBaselineEntry] = await Promise.all([
    baselineStore.publishedRevision(oldBaselineId), baselineStore.publishedRevision(newBaselineId),
  ]);
  if (!oldBaselineEntry || !newBaselineEntry) throw new Error("Both exact Baseline revisions must exist in the immutable published project journal.");
  const oldBaseline = oldBaselineEntry.revision, newBaseline = newBaselineEntry.revision;

  const formalUiStore = createG5UiReader(workspaceId, projectId, state, "ui-contracts");
  const proposalStore = createG5UiReader(workspaceId, projectId, state, "ui-proposals");
  const [oldUiEntry, newUiEntry] = await Promise.all([
    formalUiStore.publishedRevision(oldUiId), formalUiStore.publishedRevision(newUiId),
  ]);
  if (!oldUiEntry || !newUiEntry) throw new Error("Both exact formal UI revisions must exist in the immutable published project journal.");
  const approvalStore = createRevisionJournal(workspaceId, projectId, state, {
    prefix: "ui-approvals", parse: value => parseUiApproval(value, projectId), revisionId: value => value.revisionId,
  });
  for (const [label, baseline, formal] of [["old", oldBaseline, oldUiEntry.revision], ["new", newBaseline, newUiEntry.revision]] as const) {
    if (formal.publication !== "formal" || formal.source.kind !== "baseline" || formal.source.revisionId !== baseline.revisionId
      || formal.source.specRevisionId !== baseline.specification.revisionId
      || formal.approvalRevisionId === null || formal.sourceProposalRevisionId === null) {
      throw new Error(`The ${label} formal UI revision is not pinned to its exact Baseline and source Spec.`);
    }
    const [proposal, approval] = await Promise.all([
      proposalStore.publishedRevision(formal.sourceProposalRevisionId),
      approvalStore.publishedRevision(formal.approvalRevisionId),
    ]);
    if (!proposal || !approval || proposal.revision.publication !== "proposal"
      || approval.revision.proposalRevisionId !== proposal.revision.revisionId
      || approval.revision.proposalDigest !== revisionDigest(proposal.revision)
      || approval.revision.htmlSha256 !== proposal.revision.artifact.htmlSha256
      || approval.revision.contractRevisionId !== proposal.revision.contract.revisionId
      || formal.artifact.htmlSha256 !== proposal.revision.artifact.htmlSha256
      || formal.contract.revisionId !== proposal.revision.contract.revisionId
      || JSON.stringify(formal.artifact) !== JSON.stringify(proposal.revision.artifact)
      || JSON.stringify(formal.contract) !== JSON.stringify(proposal.revision.contract)
      || JSON.stringify(formal.source) !== JSON.stringify(proposal.revision.source)) {
      throw new Error(`The ${label} formal UI approval, proposal, HTML, and Contract pins do not resolve exactly.`);
    }
  }

  const oldRequirements = oldBaseline.specification.requirements.map(item => ({ ...item }));
  const newRequirements = newBaseline.specification.requirements.map(item => ({ ...item }));
  const oldGraph = [
    ...oldBaseline.graph.entities.map(item => ({ ...item, ...(item.specRef ? { requirementRefs: [item.specRef] } : {}) })),
    ...oldBaseline.graph.relations.map(item => ({ ...item, graphRefs: [item.sourceId, item.targetId],
      ...(item.contractRef ? { uiRefs: [item.contractRef] } : {}) })),
  ];
  const newGraph = [
    ...newBaseline.graph.entities.map(item => ({ ...item, ...(item.specRef ? { requirementRefs: [item.specRef] } : {}) })),
    ...newBaseline.graph.relations.map(item => ({ ...item, graphRefs: [item.sourceId, item.targetId],
      ...(item.contractRef ? { uiRefs: [item.contractRef] } : {}) })),
  ];
  const dimensions: Partial<Record<G5Dimension, Readonly<{ old: G5Snapshot; new: G5Snapshot }>>> = {
    requirements: dimensionsPair(snapshot(projectId, oldBaseline.specification.revisionId, oldRequirements),
      snapshot(projectId, newBaseline.specification.revisionId, newRequirements)),
    ui: dimensionsPair(snapshot(projectId, oldUiId, uiRecords(oldUiEntry.revision)), snapshot(projectId, newUiId, uiRecords(newUiEntry.revision))),
    graph: dimensionsPair(snapshot(projectId, oldBaseline.graph.graphRevisionId, oldGraph),
      snapshot(projectId, newBaseline.graph.graphRevisionId, newGraph)),
  };

  type PublishedTechnology = NonNullable<Awaited<ReturnType<ReturnType<typeof createG5TechnologyReader>["publishedRevision"]>>>;
  let technologyPair: readonly [PublishedTechnology, PublishedTechnology] | null = null;
  if (input.technology !== undefined) {
    const pins = revisionPair(input.technology, "technology");
    const store = createG5TechnologyReader(workspaceId, projectId, state);
    const [before, after] = await Promise.all([store.publishedRevision(pins.oldRevisionId), store.publishedRevision(pins.newRevisionId)]);
    if (!before || !after) throw new Error("Exact old/new Technology revisions are not published in this project journal.");
    for (const [entry, baseline, label] of [[before.revision, oldBaseline, "old"], [after.revision, newBaseline, "new"]] as const) {
      if (entry.register.sourceBaselineRevisionId !== baseline.revisionId
        || entry.register.sourceSpecRevisionId !== baseline.specification.revisionId
        || entry.register.sourceGraphRevisionId !== baseline.graph.graphRevisionId) {
        throw new Error(`The ${label} Technology revision is not pinned to its exact Baseline/Spec/Graph.`);
      }
    }
    dimensions.technology = dimensionsPair(
      snapshot(projectId, pins.oldRevisionId, before.revision.register.entries.map(item => ({ ...item, graphRefs: item.scopeNodeIds }))),
      snapshot(projectId, pins.newRevisionId, after.revision.register.entries.map(item => ({ ...item, graphRefs: item.scopeNodeIds }))),
    );
    technologyPair = [before, after];
  }

  type PublishedWorkstream = Awaited<ReturnType<ReturnType<typeof createG5WorkstreamReader>["publishedRevision"]>>;
  let workstreamEntries: readonly [string, NonNullable<PublishedWorkstream>][] | null = null;
  if (input.workstreams !== undefined) {
    const pins = revisionPair(input.workstreams, "workstreams");
    const store = createG5WorkstreamReader(workspaceId, projectId, state);
    const [before, after] = await Promise.all([store.publishedRevision(pins.oldRevisionId), store.publishedRevision(pins.newRevisionId)]);
    if (!before || !after) throw new Error("Exact old/new Workstream boards are not published in this project journal.");
    const validateBoard = async (board: typeof before, baseline: typeof oldBaseline, label: string) => {
      for (const record of board.revision.workstreams) {
        if (record.sourceBaselineRevisionId !== baseline.revisionId || record.baselineDigest !== hash(baseline)) {
          throw new Error(`The ${label} Workstream ${record.spec.id} does not match its exact Baseline pin.`);
        }
        const technology = await createG5TechnologyReader(workspaceId, projectId, state)
          .publishedRevision(record.spec.technologyDecisionsRef);
        if (!technology || technology.revision.register.sourceBaselineRevisionId !== baseline.revisionId
          || technology.revision.register.sourceSpecRevisionId !== baseline.specification.revisionId
          || technology.revision.register.sourceGraphRevisionId !== baseline.graph.graphRevisionId
          || record.technologyDigest !== hash(technology.revision)) {
          throw new Error(`Workstream ${record.spec.id} has an unavailable or mismatched exact Technology pin.`);
        }
      }
    };
    await Promise.all([validateBoard(before, oldBaseline, "old"), validateBoard(after, newBaseline, "new")]);
    const projectWorkstreams = (board: typeof before) => board.revision.workstreams.map(record => ({
      id: record.spec.id, spec: record.spec, ctoAgentId: record.ctoAgentId, ctoSessionId: record.ctoSessionId,
      graphRefs: record.spec.scopeNodeIds, technologyRefs: [record.spec.technologyDecisionsRef],
      ctoRefs: [record.spec.assignedCtoId],
    }));
    dimensions.ctoWorkstreams = dimensionsPair(snapshot(projectId, pins.oldRevisionId, projectWorkstreams(before)),
      snapshot(projectId, pins.newRevisionId, projectWorkstreams(after)));
    workstreamEntries = [[pins.oldRevisionId, before], [pins.newRevisionId, after]];
  }

  let taskInputComparisons: Awaited<ReturnType<typeof comparePublishedG5TaskInputs>> | null = null;
  let taskPair: Readonly<{ previous: PublishedG5TaskInputSide; compared: PublishedG5TaskInputSide }> | null = null;
  if (input.tasks !== undefined) {
    const taskInput = exactToolRecord(input.tasks, ["ctoId", "workstreamId", "oldRevisionId", "newRevisionId"]);
    const ctoId = id(taskInput.ctoId, "tasks.ctoId"), workstreamId = id(taskInput.workstreamId, "tasks.workstreamId");
    const pins = revisionPair({ oldRevisionId: taskInput.oldRevisionId, newRevisionId: taskInput.newRevisionId }, "tasks");
    if (!workstreamEntries) throw new Error("Exact old/new Workstream boards are required to validate Task source pins.");
    const store = createG5TaskReader(workspaceId, projectId, ctoId, workstreamId, state);
    const [before, after] = await Promise.all([store.publishedRevision(pins.oldRevisionId), store.publishedRevision(pins.newRevisionId)]);
    if (!before || !after) throw new Error("Exact old/new Task boards are not published in their project/CTO/Workstream journal.");
    const assertTaskPins = (board: typeof before, workstreamBoardRevisionId: string, baseline: typeof oldBaseline, label: string) => {
      const sourceWorkstream = workstreamEntries!.find(([revisionId]) => revisionId === workstreamBoardRevisionId)?.[1]
        ?.revision.workstreams.find(item => item.spec.id === workstreamId && item.spec.assignedCtoId === ctoId);
      if (!sourceWorkstream) throw new Error(`The ${label} Task board has no exact assigned Workstream source record.`);
      const sourceDigest = workstreamInstructionDigest(sourceWorkstream);
      const requirementIds = new Set(baseline.specification.requirements.map(item => item.id));
      for (const record of board.revision.packets) {
        if (record.source.specRevision !== sourceWorkstream.spec.revision
          || record.source.instructionSha256 !== sourceDigest
          || record.packet.requirementIds.some(requirementId => !requirementIds.has(requirementId))) {
          throw new Error(`Task ${record.packet.taskId} source/requirement pins do not match the exact ${label} Workstream and Baseline.`);
        }
      }
      return sourceWorkstream;
    };
    const oldWorkstream = assertTaskPins(before, workstreamEntries[0][0], oldBaseline, "old");
    const newWorkstream = assertTaskPins(after, workstreamEntries[1][0], newBaseline, "new");
    const packetRecords = (board: typeof before) => board.revision.packets.map(record => ({
      id: record.packet.taskId, packet: record.packet, graphRefs: record.packet.scopeNodeIds, requirementRefs: record.packet.requirementIds,
      workstreamRefs: [record.packet.workstreamId], taskRefs: record.packet.dependencies,
    }));
    dimensions.tasks = dimensionsPair(snapshot(projectId, pins.oldRevisionId, packetRecords(before)),
      snapshot(projectId, pins.newRevisionId, packetRecords(after)));
    if (technologyPair && oldWorkstream.spec.technologyDecisionsRef === technologyPair[0].revision.register.revisionId
      && newWorkstream.spec.technologyDecisionsRef === technologyPair[1].revision.register.revisionId) {
      const publishedSide = (baseline: typeof oldBaselineEntry, ui: typeof oldUiEntry, technology: PublishedTechnology,
        workstream: WorkstreamRecord, workstreamBoard: NonNullable<PublishedWorkstream>, tasks: typeof before): PublishedG5TaskInputSide => ({
        source: { baseline: baseline.revision, ui: ui.revision, technology: technology.revision, workstream, tasks: tasks.revision },
        baselineSequence: baseline.sequence, uiSequence: ui.sequence, technologySequence: technology.sequence,
        workstreamBoardRevisionId: workstreamBoard.revision.revisionId, workstreamBoardSequence: workstreamBoard.sequence,
        taskBoardSequence: tasks.sequence,
      });
      taskPair = {
        previous: publishedSide(oldBaselineEntry, oldUiEntry, technologyPair[0], oldWorkstream, workstreamEntries[0]![1], before),
        compared: publishedSide(newBaselineEntry, newUiEntry, technologyPair[1], newWorkstream, workstreamEntries[1]![1], after),
      };
      if (includeTaskInputs) taskInputComparisons = await comparePublishedG5TaskInputs(workspaceId, taskPair.previous.source, taskPair.compared.source, state);
    }
  }

  await check();
  const result = produceG5ChangeImpactCandidates({ projectId, dimensions });
  return { taskPair, result: {
    content: "Source comparison completed from exact published project revisions. Candidate links are not approval, execution authority, full-inventory proof, or a claim of no impact.",
    data: {
      ...result,
      sourcePins: { oldBaselineRevisionId: oldBaselineId, newBaselineRevisionId: newBaselineId,
        oldUiRevisionId: oldUiId, newUiRevisionId: newUiId, baselines: [
          { revisionId: oldBaselineId, sequence: oldBaselineEntry.sequence,
            specRevisionId: oldBaseline.specification.revisionId, graphRevisionId: oldBaseline.graph.graphRevisionId },
          { revisionId: newBaselineId, sequence: newBaselineEntry.sequence,
            specRevisionId: newBaseline.specification.revisionId, graphRevisionId: newBaseline.graph.graphRevisionId },
        ], formalUi: [oldUiEntry.revision, newUiEntry.revision].map(revision => ({
          revisionId: revision.revisionId, proposalRevisionId: revision.sourceProposalRevisionId,
          approvalRevisionId: revision.approvalRevisionId, contractRevisionId: revision.contract.revisionId,
          htmlSha256: revision.artifact.htmlSha256,
        })),
        technology: input.technology === undefined ? null : input.technology,
        workstreams: input.workstreams === undefined ? null : input.workstreams,
        tasks: input.tasks === undefined ? null : input.tasks },
      readConsistency: "exact-published-records; no cross-journal atomic snapshot",
      ...(includeTaskInputs ? { recordedTaskInputs: taskInputComparisons } : {}),
      inventoryLimits: { technology: input.technology === undefined ? "UNKNOWN" : "exact-pair-only",
        ctoWorkstreams: input.workstreams === undefined ? "UNKNOWN" : "workstream-board-only; CTO registry not loaded",
        tasks: input.tasks === undefined ? "UNKNOWN" : "one-CTO-workstream-board-only",
        scheduleProductScope: "UNKNOWN; no authoritative source reader registered" },
      productExecutionAuthorized: false,
    } as unknown as JsonValue,
  } };
}
