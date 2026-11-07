import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { parseTaskPacketBoard, taskPacketRecordDigest, type TaskPacketRecord } from "./domain/task-packets.ts";
import { parseWorkstreamBoard, type WorkstreamRecord } from "./domain/workstreams.ts";
import { readG5ChangeImpactCandidates } from "./g5-change-impact-tools.ts";
import { exactToolRecord, parseLeadToolContext, resolveLeadToolAuthority } from "./lead-tool-authority.ts";
import { workstreamInstructionDigest } from "./cto-delivery-store.ts";
import { createRevisionJournal, type RevisionState } from "./solution-revision-store.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const packetScope = (projectId: string, ctoId: string, workstreamId: string) => createHash("sha256")
  .update(JSON.stringify([projectId, ctoId, workstreamId]), "utf8").digest("hex");

type Candidate = Readonly<{ recordId: string; dimension: string }>;
type Dimension = Readonly<{ status: "CANDIDATES" | "NO_CANDIDATE_OBSERVED" | "UNKNOWN"; candidates: readonly Candidate[] }>;
type ImpactData = Readonly<{ projectId: string; dimensions: Record<string, Dimension>; inventoryLimits: Record<string, unknown>;
  sourcePins: { oldBaselineRevisionId: string; newBaselineRevisionId: string; oldUiRevisionId: string; newUiRevisionId: string;
    technology: unknown; workstreams: unknown; tasks: unknown } }>;
type BoardPair<T> = Readonly<{ old: T; current: T; oldRevisionId: string; newRevisionId: string }>;

function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a bounded identifier.`);
  }
  return value;
}

export function candidateIds(value: unknown, expectedDimension: string): Readonly<{ status: Dimension["status"]; ids: ReadonlySet<string> }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid exact G5 dimension result.");
  const row = value as Record<string, unknown>;
  if (row.status !== "CANDIDATES" && row.status !== "NO_CANDIDATE_OBSERVED" && row.status !== "UNKNOWN") {
    throw new TypeError("Invalid exact G5 dimension status.");
  }
  if (!Array.isArray(row.candidates)) throw new TypeError("Invalid exact G5 candidate list.");
  const ids = new Set<string>();
  for (const raw of row.candidates) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Invalid exact G5 candidate.");
    const candidate = raw as Record<string, unknown>;
    if (candidate.dimension !== expectedDimension) throw new TypeError("G5 candidate dimension mismatch.");
    const id = boundedId(candidate.recordId, "G5 candidate recordId");
    if (ids.has(id)) throw new TypeError("G5 candidate IDs must be unique.");
    ids.add(id);
  }
  if (row.status === "CANDIDATES" && ids.size === 0 || row.status === "NO_CANDIDATE_OBSERVED" && ids.size !== 0) {
    throw new TypeError("G5 status and exact candidate list disagree.");
  }
  return Object.freeze({ status: row.status, ids });
}

export function projectExactCandidateRecords<T extends { spec: { id: string } } | { packet: { taskId: string } }>(
  pair: BoardPair<readonly T[]>, ids: ReadonlySet<string>, getId: (item: T) => string,
  status: Dimension["status"], label: string) {
  if (status === "CANDIDATES" && ids.size === 0 || status === "NO_CANDIDATE_OBSERVED" && ids.size !== 0) {
    throw new TypeError("G5 status and candidate IDs disagree.");
  }
  const old = new Map(pair.old.map(item => [getId(item), item]));
  const current = new Map(pair.current.map(item => [getId(item), item]));
  const absent = [...ids].filter(id => !old.has(id) && !current.has(id));
  if (absent.length) throw new Error(`Exact G5 ${label} candidates do not resolve to either published record: ${absent.join(", ")}.`);
  return [...ids].sort().map(id => Object.freeze({
    id,
    classification: status === "UNKNOWN" ? "UNKNOWN" as const : "AFFECTED_CANDIDATE" as const,
    oldRecord: old.get(id) ?? null,
    newRecord: current.get(id) ?? null,
  }));
}

export function checkTaskDependencyPins(record: TaskPacketRecord, board: readonly TaskPacketRecord[],
  projectId: string, ctoId: string, workstreamId: string) {
  const pins = record.dependencyPins.map(pin => {
    const dependency = board.find(row => row.packet.taskId === pin.taskId);
    const digest = dependency ? taskPacketRecordDigest(dependency, projectId, ctoId, workstreamId) : null;
    return Object.freeze({ taskId: pin.taskId, pinnedRevision: pin.revision, pinnedRecordSha256: pin.recordSha256,
      status: dependency && dependency.packet.revision === pin.revision && digest === pin.recordSha256
        ? "EXACT" as const : "STALE_OR_UNAVAILABLE" as const,
      observedRevision: dependency?.packet.revision ?? null, observedRecordSha256: digest });
  });
  return Object.freeze({ pins: Object.freeze(pins), current: pins.every(pin => pin.status === "EXACT") });
}

export function projectWorkstreamReadinessReceipt(old: WorkstreamRecord | null, current: WorkstreamRecord | null) {
  const receipt = current?.receipt ?? null;
  const exactRecordUnchanged = Boolean(old && current && hash(old) === hash(current));
  const currentReadiness = Boolean(current && receipt && receipt.revision === current.spec.revision);
  return Object.freeze({
    status: !receipt ? "ABSENT" as const : currentReadiness ? "CURRENT_CTO_READINESS_ONLY" as const : "HISTORICAL_CTO_READINESS_ONLY" as const,
    exactReceiptRevision: receipt?.revision ?? null,
    carryForward: !receipt ? "NONE" as const : currentReadiness && exactRecordUnchanged
      ? "CARRY_EXACT_CTO_READINESS_ONLY" as const : "DO_NOT_CARRY" as const,
    carryForwardReason: !receipt ? "No CTO readiness receipt is stored on this exact Workstream record."
      : currentReadiness && exactRecordUnchanged ? "The immutable old/new Workstream records, including the receipt and exact specification revision, are equal."
        : "The exact Workstream record or receipt revision changed; the prior readiness report is historical and is not a G5 ACK.",
    g5Acknowledgment: "UNKNOWN_NO_G5_ACK_SOURCE" as const,
  });
}

/**
 * Authenticated, read-only projection over the existing exact published G5 pair.
 * Readiness receipts are not G5 ACKs, and Task Packet instructions are not run evidence.
 */
export async function readG5Revalidation(params: unknown, runContext: unknown,
  platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params,
    ["projectId", "oldBaselineRevisionId", "newBaselineRevisionId", "oldUiRevisionId", "newUiRevisionId", "workstreams", "tasks"],
    ["technology"]);
  const projectId = boundedId(input.projectId, "projectId");
  const context = parseLeadToolContext(runContext);
  if (context.projectId !== undefined && context.projectId !== projectId) throw new Error("G5 project does not match the authenticated Lead context.");

  // Authorize the projection before touching any additional Workstream/Task journal.
  const authority = await resolveLeadToolAuthority(context, platform);
  if (authority.channel !== "main" && authority.channel !== "integration-review") {
    throw new Error("G5 revalidation is limited to Main or Integration Review Lead sessions.");
  }
  await authority.check();

  const comparison = await readG5ChangeImpactCandidates(input, runContext, platform);
  const data = comparison.data as unknown as ImpactData;
  const workstreamPins = exactToolRecord(input.workstreams, ["oldRevisionId", "newRevisionId"]);
  const taskInput = exactToolRecord(input.tasks, ["ctoId", "workstreamId", "oldRevisionId", "newRevisionId"]);
  const ctoId = boundedId(taskInput.ctoId, "tasks.ctoId");
  const workstreamId = boundedId(taskInput.workstreamId, "tasks.workstreamId");
  const oldWorkstreamRevisionId = boundedId(workstreamPins.oldRevisionId, "workstreams.oldRevisionId");
  const newWorkstreamRevisionId = boundedId(workstreamPins.newRevisionId, "workstreams.newRevisionId");
  const oldTaskRevisionId = boundedId(taskInput.oldRevisionId, "tasks.oldRevisionId");
  const newTaskRevisionId = boundedId(taskInput.newRevisionId, "tasks.newRevisionId");
  const samePair = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const expectedG5Pins = { oldBaselineRevisionId: boundedId(input.oldBaselineRevisionId, "oldBaselineRevisionId"),
    newBaselineRevisionId: boundedId(input.newBaselineRevisionId, "newBaselineRevisionId"),
    oldUiRevisionId: boundedId(input.oldUiRevisionId, "oldUiRevisionId"),
    newUiRevisionId: boundedId(input.newUiRevisionId, "newUiRevisionId"),
    technology: input.technology ?? null,
    workstreams: { oldRevisionId: oldWorkstreamRevisionId, newRevisionId: newWorkstreamRevisionId },
    tasks: { ctoId, workstreamId, oldRevisionId: oldTaskRevisionId, newRevisionId: newTaskRevisionId } };
  const exactG5Pins = (pins: ImpactData["sourcePins"]) => pins.oldBaselineRevisionId === expectedG5Pins.oldBaselineRevisionId
    && pins.newBaselineRevisionId === expectedG5Pins.newBaselineRevisionId
    && pins.oldUiRevisionId === expectedG5Pins.oldUiRevisionId && pins.newUiRevisionId === expectedG5Pins.newUiRevisionId
    && samePair(pins.technology ?? null, expectedG5Pins.technology)
    && samePair(pins.workstreams, expectedG5Pins.workstreams) && samePair(pins.tasks, expectedG5Pins.tasks);
  if (!exactG5Pins(data.sourcePins)) throw new Error("G5 source reader returned pins different from the exact requested historical pair.");
  await authority.check();
  const state = platform.state as RevisionState;
  const workstreamStore = createRevisionJournal(context.companyId, projectId, state, { prefix: "workstreams",
    parse: value => parseWorkstreamBoard(value, projectId), revisionId: value => value.revisionId });
  const taskStore = createRevisionJournal(context.companyId, `packets:${packetScope(projectId, ctoId, workstreamId)}`, state, {
    prefix: "task-packets", parse: value => parseTaskPacketBoard(value, projectId, ctoId, workstreamId),
    revisionId: value => value.revisionId,
  });
  const [[oldWs, newWs], [oldTasks, newTasks]] = await Promise.all([
    Promise.all([workstreamStore.publishedRevision(oldWorkstreamRevisionId), workstreamStore.publishedRevision(newWorkstreamRevisionId)]),
    Promise.all([taskStore.publishedRevision(oldTaskRevisionId), taskStore.publishedRevision(newTaskRevisionId)]),
  ]);
  if (!oldWs || !newWs || !oldTasks || !newTasks) throw new Error("An exact Workstream or Task board is not in its immutable published journal.");
  const currentWorkstreamHead = await workstreamStore.current();
  const currentTaskHead = await taskStore.current();
  await authority.check();

  const workstreams = { old: oldWs.revision.workstreams, current: newWs.revision.workstreams,
    oldRevisionId: oldWorkstreamRevisionId, newRevisionId: newWorkstreamRevisionId } satisfies BoardPair<readonly WorkstreamRecord[]>;
  const tasks = { old: oldTasks.revision.packets, current: newTasks.revision.packets,
    oldRevisionId: oldTaskRevisionId, newRevisionId: newTaskRevisionId } satisfies BoardPair<readonly TaskPacketRecord[]>;
  const wsCandidates = candidateIds(data.dimensions.ctoWorkstreams, "ctoWorkstreams");
  const taskCandidates = candidateIds(data.dimensions.tasks, "tasks");
  const affectedWorkstreams = projectExactCandidateRecords(workstreams, wsCandidates.ids, row => row.spec.id, wsCandidates.status, "Workstream");
  const affectedTasks = projectExactCandidateRecords(tasks, taskCandidates.ids, row => row.packet.taskId, taskCandidates.status, "Task");

  const handoffImpactSha256 = hash({ sourcePins: data.sourcePins, dimensions: data.dimensions });
  const handoffProposal = (workstreamId: string) => Object.freeze({
    oldBaselineRevisionId: expectedG5Pins.oldBaselineRevisionId,
    newBaselineRevisionId: expectedG5Pins.newBaselineRevisionId,
    oldUiRevisionId: expectedG5Pins.oldUiRevisionId,
    newUiRevisionId: expectedG5Pins.newUiRevisionId,
    technology: expectedG5Pins.technology,
    workstreams: expectedG5Pins.workstreams,
    tasks: expectedG5Pins.tasks,
    workstreamImpactStatus: wsCandidates.status === "NO_CANDIDATE_OBSERVED" ? "CANDIDATES" : wsCandidates.status,
    taskImpactStatus: taskCandidates.status,
    affectedTaskIds: Object.freeze([...taskCandidates.ids].sort()),
    impactSha256: handoffImpactSha256,
  });
  const handoffAcceptance = affectedWorkstreams.map(item => {
    const current = currentWorkstreamHead?.revision.workstreams.find(record => record.spec.id === item.id) ?? null;
    const handoff = current?.change.g5Handoff;
    if (!current || !handoff) return Object.freeze({ workstreamId: item.id, status: "NOT_LINKED" as const,
      currentBoardRevisionId: currentWorkstreamHead?.revision.revisionId ?? null, specRevision: current?.spec.revision ?? null,
      handoffProposal: handoffProposal(item.id) });
    const exactSource = handoff.oldBaselineRevisionId === expectedG5Pins.oldBaselineRevisionId
      && handoff.newBaselineRevisionId === expectedG5Pins.newBaselineRevisionId
      && handoff.oldUiRevisionId === expectedG5Pins.oldUiRevisionId
      && handoff.newUiRevisionId === expectedG5Pins.newUiRevisionId
      && samePair(handoff.technology, expectedG5Pins.technology)
      && samePair(handoff.workstreams, expectedG5Pins.workstreams)
      && samePair(handoff.tasks, expectedG5Pins.tasks)
      && handoff.workstreamImpactStatus === wsCandidates.status
      && handoff.taskImpactStatus === taskCandidates.status
      && handoff.impactSha256 === handoffImpactSha256
      && handoff.tasks.ctoId === ctoId && handoff.tasks.workstreamId === item.id
      && samePair([...handoff.affectedTaskIds].sort(), [...taskCandidates.ids].sort())
      && samePair([...current.change.impactTaskIds].sort(), [...taskCandidates.ids].sort())
      && current.sourceBaselineRevisionId === expectedG5Pins.newBaselineRevisionId;
    const status = !exactSource ? "STALE" as const
      : currentTaskHead?.revision.revisionId !== expectedG5Pins.tasks.newRevisionId ? "STALE_TASK_SCOPE" as const
      : !current.receipt || current.receipt.revision !== current.spec.revision ? "PENDING" as const
        : current.receipt.readiness === "ready" ? "ACKNOWLEDGED_SCOPED_HANDOFF" as const
          : current.receipt.readiness === "blocked" ? "BLOCKED" as const : "NEEDS_CLARIFICATION" as const;
    return Object.freeze({ workstreamId: item.id, status, currentBoardRevisionId: currentWorkstreamHead?.revision.revisionId ?? null,
      specRevision: current.spec.revision, receiptRevision: current.receipt?.revision ?? null,
      readiness: current.receipt?.readiness ?? null, currentTaskBoardRevisionId: currentTaskHead?.revision.revisionId ?? null,
      sourcePins: handoff, handoffProposal: handoffProposal(item.id) });
  });
  const acceptanceByWorkstream = new Map(handoffAcceptance.map(item => [item.workstreamId, item.status]));

  const taskDetails = affectedTasks.map(item => {
    const oldRecord = item.oldRecord as TaskPacketRecord | null;
    const newRecord = item.newRecord as TaskPacketRecord | null;
    const packet = newRecord ?? oldRecord!;
    const sourceCurrent = (record: TaskPacketRecord | null, workstreamBoard: readonly WorkstreamRecord[], taskBoard: readonly TaskPacketRecord[]) => {
      if (!record) return null;
      const source = workstreamBoard.find(row => row.spec.id === record.packet.workstreamId);
      const instruction = Boolean(source && record.source.specRevision === source.spec.revision
        && record.source.instructionSha256 === workstreamInstructionDigest(source));
      const dependencies = checkTaskDependencyPins(record, taskBoard, projectId, ctoId, workstreamId);
      return Object.freeze({ instruction: instruction ? "EXACT_CURRENT_WORKSTREAM_PIN" as const : "STALE_OR_UNAVAILABLE" as const,
        workstreamRevisionId: source?.spec.revision ?? null,
        instructionSha256: record.source.instructionSha256,
        dependencies: dependencies.pins, dependenciesCurrent: dependencies.current });
    };
    const oldFreshness = sourceCurrent(oldRecord, workstreams.old, tasks.old);
    const newFreshness = sourceCurrent(newRecord, workstreams.current, tasks.current);
    const freshness = newFreshness ?? oldFreshness!;
    const exactTaskRecordEquality = oldRecord !== null && newRecord !== null
      && taskPacketRecordDigest(oldRecord, projectId, ctoId, workstreamId) === taskPacketRecordDigest(newRecord, projectId, ctoId, workstreamId)
      && oldFreshness?.instruction === "EXACT_CURRENT_WORKSTREAM_PIN"
      && newFreshness?.instruction === "EXACT_CURRENT_WORKSTREAM_PIN"
      && oldFreshness.dependenciesCurrent && newFreshness.dependenciesCurrent;
    const priorEvidenceReuse = Object.freeze({ status: "UNKNOWN" as const,
      reason: "No authoritative immutable Run artifact plus independent QA evidence reader is registered; Task Packet fields and agent output are instructions/provenance only.",
      taskRecordEquality: exactTaskRecordEquality ? "EXACT_UNCHANGED_INSTRUCTION_ONLY" as const : "NOT_ESTABLISHED" as const });
    return Object.freeze({ ...item, stale: Object.freeze({ old: oldFreshness, current: newFreshness,
      instruction: freshness.instruction, dependencies: freshness.dependenciesCurrent ? "EXACT" as const : "STALE_OR_UNAVAILABLE" as const }),
      currentInstruction: Object.freeze({ packet: packet.packet, source: packet.source,
        taskRecordSha256: taskPacketRecordDigest(packet, projectId, ctoId, workstreamId),
        boardRevisionId: newRecord ? tasks.newRevisionId : tasks.oldRevisionId,
        sourceFreshness: freshness }),
      revalidationDecision: item.classification === "UNKNOWN" ? "UNKNOWN" as const : "REVALIDATE_REQUIRED" as const,
      workstreamHandoffAcceptance: acceptanceByWorkstream.get(packet.packet.workstreamId) ?? "NOT_LINKED" as const,
      priorInstructionReuse: exactTaskRecordEquality ? "CANDIDATE_EXACT_INSTRUCTION_ONLY" as const : "NOT_ESTABLISHED" as const,
      priorExecutionEvidenceReuse: priorEvidenceReuse });
  });

  const readinessReceipt = affectedWorkstreams.map(item => {
    const old = item.oldRecord as WorkstreamRecord | null;
    const current = item.newRecord as WorkstreamRecord | null;
    return Object.freeze({ workstreamId: item.id, ...projectWorkstreamReadinessReceipt(old, current) });
  });

  // Re-resolve the explicit historical IDs through the current journal ancestry.
  // A later unrelated head is valid; a changed, missing, or forked exact source is not.
  const [[oldWsAgain, newWsAgain], [oldTasksAgain, newTasksAgain]] = await Promise.all([
    Promise.all([workstreamStore.publishedRevision(oldWorkstreamRevisionId), workstreamStore.publishedRevision(newWorkstreamRevisionId)]),
    Promise.all([taskStore.publishedRevision(oldTaskRevisionId), taskStore.publishedRevision(newTaskRevisionId)]),
  ]);
  if (!oldWsAgain || !newWsAgain || !oldTasksAgain || !newTasksAgain
    || hash(oldWsAgain.revision) !== hash(oldWs.revision) || hash(newWsAgain.revision) !== hash(newWs.revision)
    || hash(oldTasksAgain.revision) !== hash(oldTasks.revision) || hash(newTasksAgain.revision) !== hash(newTasks.revision)) {
    throw new Error("An exact historical Workstream/Task publication changed or is no longer in its journal ancestry.");
  }
  const currentWorkstreamAgain = await workstreamStore.current();
  if (hash(currentWorkstreamAgain?.revision ?? null) !== hash(currentWorkstreamHead?.revision ?? null)) {
    throw new Error("The current Workstream handoff/receipt changed during G5 projection reads.");
  }
  const currentTaskAgain = await taskStore.current();
  if (hash(currentTaskAgain?.revision ?? null) !== hash(currentTaskHead?.revision ?? null)) {
    throw new Error("The current Task board changed during G5 projection reads.");
  }
  const comparisonAgain = await readG5ChangeImpactCandidates(input, runContext, platform);
  const finalG5 = comparisonAgain.data as unknown as ImpactData;
  if (!exactG5Pins(finalG5.sourcePins) || !samePair(finalG5.dimensions, data.dimensions)) {
    throw new Error("An exact historical G5 pair changed during projection reads.");
  }
  await authority.check();
  return {
    content: "Read-only projection from exact published G5, Workstream, and Task revisions. A matching current Workstream receipt acknowledges the exact G5-scoped instruction only; it is not evidence of task execution, QA, or delivery completion.",
    data: {
      projectId, sourcePins: { g5: data, workstreams: { oldRevisionId: workstreams.oldRevisionId, newRevisionId: workstreams.newRevisionId },
        tasks: { oldRevisionId: tasks.oldRevisionId, newRevisionId: tasks.newRevisionId } },
      affectedWorkstreams, revalidationCandidates: { workstreams: affectedWorkstreams.map(item => ({
        workstreamId: item.id, decision: item.classification === "UNKNOWN" ? "UNKNOWN" : "REVALIDATE_REQUIRED",
        oldRecord: item.oldRecord, currentRecord: item.newRecord,
      })), tasks: taskDetails },
      currentInstructions: { workstreams: affectedWorkstreams.map(item => {
        const current = item.newRecord as WorkstreamRecord | null;
        return { workstreamId: item.id, revision: current?.spec.revision ?? null,
          boardRevisionId: current ? workstreams.newRevisionId : workstreams.oldRevisionId,
          instruction: current?.spec ?? null,
          sourceFreshness: current ? { baseline: "EXACT_PIN_VERIFIED_BY_G5_READER", baselineRevisionId: current.sourceBaselineRevisionId,
            baselineDigest: current.baselineDigest, technology: "EXACT_PIN_VERIFIED_BY_G5_READER",
            technologyRevisionId: current.spec.technologyDecisionsRef, technologyDigest: current.technologyDigest }
            : { status: "REMOVED_FROM_CURRENT_PAIR" },
        };
      }), tasks: taskDetails.map(item => item.currentInstruction) },
      workstreamReadinessReceipts: readinessReceipt, g5WorkstreamHandoffAcceptance: handoffAcceptance,
      g5WorkstreamHandoffProposals: handoffAcceptance.map(item => ({ workstreamId: item.workstreamId, g5Handoff: item.handoffProposal })),
      affectedTasks: taskDetails,
      completeness: { exactPairRead: true, crossJournalAtomic: false,
        noCandidateMeaning: "UNKNOWN_NOT_PROOF_OF_NO_IMPACT", reapprovalAuthorized: false,
        priorExecutionEvidenceReuse: "UNKNOWN_NO_RUN_RESULT_READER",
        g5Acknowledgment: handoffAcceptance.length > 0 && handoffAcceptance.every(item => item.status === "ACKNOWLEDGED_SCOPED_HANDOFF")
          ? "EXACT_CURRENT_RECEIPTS_FOR_SCOPED_HANDOFF" : "UNKNOWN_NO_ACK_SOURCE",
        inventoryLimits: data.inventoryLimits },
    } as unknown as JsonValue,
  };
}
