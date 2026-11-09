import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { parseTaskPacket, parseTaskPacketBoard, taskPacketRecordDigest, type TaskPacketBoard, type TaskPacketRecord } from "./domain/task-packets.ts";
import { createRevisionJournal, type RevisionState } from "./solution-revision-store.ts";
import { exactToolRecord } from "./lead-tool-authority.ts";
import { resolveCtoPlanningAuthority } from "./cto-planning-authority.ts";
import { workstreamInstructionDigest } from "./cto-delivery-store.ts";
import { readWorkstreams } from "./workstream-tools.ts";
import { reviewTaskParallelPlan } from "./task-parallel-plan.ts";

const json = (value: unknown) => value as JsonValue;
function id(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError("A bounded Task Packet scope ID is required.");
  return value;
}

export function createTaskPacketStore(workspaceId: string, projectId: string, ctoId: string, workstreamId: string,
  state: RevisionState) {
  parseTaskPacketBoard({ projectId, ctoId, workstreamId, revisionId: "scope-check", packets: [] }, projectId, ctoId, workstreamId);
  const key = createHash("sha256").update(JSON.stringify([projectId, ctoId, workstreamId])).digest("hex");
  return createRevisionJournal(workspaceId, `packets:${key}`, state, { prefix: "task-packets",
    parse: value => parseTaskPacketBoard(value, projectId, ctoId, workstreamId), revisionId: value => value.revisionId });
}

export async function resolveCtoTaskAuthority(projectId: string, ctoId: string, workstreamId: string, runContext: unknown,
  platform: SpsPlatformInvocationContext, toolName: string) {
  const authority = await resolveCtoPlanningAuthority(projectId, ctoId, workstreamId, runContext, platform, toolName);
  const check = async () => {
    await authority.check();
    const instruction = (await readWorkstreams(authority.context.companyId, projectId, platform))?.revision.workstreams
      .find(row => row.spec.id === workstreamId);
    if (!instruction || workstreamInstructionDigest(instruction) !== authority.source.sha256) {
      throw new Error("The Task Packet's delivered Workstream is no longer current. Read the revised specification before planning.");
    }
    await authority.check();
  };
  const state: RevisionState = {
    get: async key => { await check(); const result = await platform.state.get(key); await check(); return result; },
    compareAndSet: platform.state.compareAndSet ? async (...args) => {
      await check(); const result = await platform.state.compareAndSet!(...args); await check(); return result;
    } : undefined,
  };
  await check();
  return { ...authority, check, store: createTaskPacketStore(authority.context.companyId, projectId, ctoId, workstreamId, state) };
}

/** CTO-authored instructions, not a Worker, process, permission grant or completed task. */
export async function publishCtoTaskPacket(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "ctoId", "workstreamId", "expectedBaseRevisionId", "revisionId", "packet"], ["additionalPackets"]);
  const projectId = id(input.projectId), ctoId = id(input.ctoId), workstreamId = id(input.workstreamId);
  const expected = input.expectedBaseRevisionId === null ? null : id(input.expectedBaseRevisionId), revisionId = id(input.revisionId);
  const packet = parseTaskPacket(input.packet, projectId, ctoId, workstreamId);
  const packets = [packet];
  if (Object.hasOwn(input, "additionalPackets")) {
    const rows = input.additionalPackets;
    if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype || rows.length > 63
      || Reflect.ownKeys(rows).length !== rows.length + 1) throw new TypeError("Additional Task Packets must be a bounded dense array.");
    for (let index = 0; index < rows.length; index++) {
      const item = Object.getOwnPropertyDescriptor(rows, String(index));
      if (!item?.enumerable || !Object.hasOwn(item, "value")) throw new TypeError("Additional Task Packets must contain data.");
      packets.push(parseTaskPacket(item.value, projectId, ctoId, workstreamId));
    }
  }
  const changes = new Map(packets.map(item => [item.taskId, item]));
  if (changes.size !== packets.length) throw new TypeError("Task Packet IDs must be unique within one publication.");
  const authority = await resolveCtoTaskAuthority(projectId, ctoId, workstreamId, runContext, platform, "builder.publish-task-packet");
  if (packets.some(item => item.scopeNodeIds.some(node => !authority.delivery.instruction.spec.scopeNodeIds.includes(node)))) {
    throw new Error("A Task Packet may only include nodes assigned by this exact Workstream.");
  }
  const requirements = new Set(authority.sources.baseline.specification.requirements.map(row => row.id));
  if (packets.some(item => item.requirementIds.some(requirement => !requirements.has(requirement)))) throw new Error("Task requirements must refer to the pinned specification, not invented requirements.");
  const current = await authority.store.current();
  const existing = new Map(current?.revision.packets.map(item => [item.packet.taskId, item]));
  let exact = 0;
  for (const item of packets) {
    const prior = existing.get(item.taskId);
    if (prior?.packet.revision !== item.revision) continue;
    if (JSON.stringify(prior.packet) !== JSON.stringify(item) || prior.source.instructionSha256 !== authority.source.sha256
      || prior.source.specRevision !== authority.source.specRevision) {
      throw new Error("This immutable Task Packet revision already has different content or source. Existing history was not replaced.");
    }
    exact++;
  }
  if (exact === packets.length) {
    await authority.check();
    return { content: "This exact Task Packet revision is already stored. No Worker or provider run was created.",
      data: json({ status: "existing", taskId: packet.taskId, boardRevisionId: current!.revision.revisionId, executionStarted: false }) };
  }
  if ((current?.revision.revisionId ?? null) !== expected) return {
    content: "The Task Packet board changed. Read the published head before explicitly replanning; no automatic write retry.",
    data: json({ status: "conflict", taskId: packet.taskId, boardRevisionId: current?.revision.revisionId ?? null, executionStarted: false }),
  };
  if (packets.some(item => item.revision !== (existing.get(item.taskId)?.packet.revision ?? 0) + 1)) {
    throw new Error("A new task starts at revision 1; changes require the next exact Task Packet revision.");
  }
  const rebound = new Map<string, TaskPacketRecord>(), visiting = new Set<string>();
  const source = { requestId: authority.source.requestId, workstreamId,
    specRevision: authority.source.specRevision, instructionSha256: authority.source.sha256 };
  const author = { agentId: authority.context.agentId, sessionId: authority.context.sessionId, runId: authority.context.runId };
  const createdAtISO = new Date().toISOString();
  // Resolve companion pins against the final board, independent of input order.
  const resolve = (taskId: string): TaskPacketRecord | undefined => {
    const item = changes.get(taskId);
    if (!item) return existing.get(taskId);
    const ready = rebound.get(taskId);
    if (ready) return ready;
    if (visiting.has(taskId)) throw new TypeError("Task Packet dependencies must form a DAG without cycles.");
    visiting.add(taskId);
    const dependencyPins = item.dependencies.map(id => {
      const dependency = resolve(id);
      if (!dependency) throw new Error(`Task dependency ${id} is missing from the published board.`);
      return { taskId: id, revision: dependency.packet.revision,
        recordSha256: taskPacketRecordDigest(dependency, projectId, ctoId, workstreamId) };
    });
    const record = { packet: item, source, author, createdAtISO, dependencyPins };
    visiting.delete(taskId);
    rebound.set(taskId, record);
    return record;
  };
  const board: TaskPacketBoard = parseTaskPacketBoard({ projectId, ctoId, workstreamId, revisionId,
    packets: [...existing.values()].filter(row => !changes.has(row.packet.taskId)).concat(packets.map(item => resolve(item.taskId)!)) },
  projectId, ctoId, workstreamId);
  const result = await authority.store.publish({ expectedBaseRevisionId: expected, revision: board });
  await authority.check();
  const parallelReview = result.status === "published" ? reviewTaskParallelPlan(result.revision.packets
    .filter(record => record.source.instructionSha256 === authority.source.sha256).map(record => record.packet)) : null;
  return { content: "CTO Task Packet instructions stored with exact Workstream provenance. Reuse/license/compatibility claims are authored planning data, not independent verification. No Worker, code, QA run or completion was created.",
    data: json({ status: result.status, taskId: packet.taskId,
      boardRevisionId: result.status === "published" ? result.revision.revisionId : result.actualBaseRevisionId,
      ...(parallelReview?.tasks.length ? { parallelReview } : {}),
      executionStarted: false }) };
}

export async function readCtoTaskPackets(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "ctoId", "workstreamId"]);
  const projectId = id(input.projectId), ctoId = id(input.ctoId), workstreamId = id(input.workstreamId);
  const authority = await resolveCtoTaskAuthority(projectId, ctoId, workstreamId, runContext, platform, "builder.read-task-packets");
  const current = await authority.store.current();
  await authority.check();
  const records = current?.revision.packets ?? [];
  const taskStates = records.map(record => ({ taskId: record.packet.taskId,
    instruction: record.source.specRevision === authority.source.specRevision && record.source.instructionSha256 === authority.source.sha256
      ? "current" : "historical",
    dependencies: record.dependencyPins.every(pin => {
      const dependency = records.find(row => row.packet.taskId === pin.taskId);
      return dependency && dependency.packet.revision === pin.revision
        && taskPacketRecordDigest(dependency, projectId, ctoId, workstreamId) === pin.recordSha256;
    }) ? "current" : "changed" }));
  const parallelReview = reviewTaskParallelPlan(records.filter((_record, index) => taskStates[index]!.instruction === "current")
    .map(record => record.packet));
  return { content: "Only this CTO's Workstream Task Packets and their original source revisions. Resolve unordered write conflicts before dispatch. Similar goals are review hints; inspect requirements, deliverables and shared interfaces. Older instructions stay historical, not evidence of current execution, Worker creation or completion.",
    data: json({ projectId, ctoId, workstreamId, current, currentSource: authority.source, taskStates,
      ...(parallelReview.tasks.length ? { parallelReview } : {}) }) };
}
