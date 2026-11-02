import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { parseTaskPacket, parseTaskPacketBoard, taskPacketRecordDigest, type TaskPacketBoard } from "./domain/task-packets.ts";
import { createRevisionJournal, type RevisionState } from "./solution-revision-store.ts";
import { exactToolRecord } from "./lead-tool-authority.ts";
import { resolveCtoPlanningAuthority } from "./cto-planning-authority.ts";
import { workstreamInstructionDigest } from "./cto-delivery-store.ts";
import { readWorkstreams } from "./workstream-tools.ts";

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

async function taskAuthority(projectId: string, ctoId: string, workstreamId: string, runContext: unknown,
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
  const input = exactToolRecord(params, ["projectId", "ctoId", "workstreamId", "expectedBaseRevisionId", "revisionId", "packet"]);
  const projectId = id(input.projectId), ctoId = id(input.ctoId), workstreamId = id(input.workstreamId);
  const expected = input.expectedBaseRevisionId === null ? null : id(input.expectedBaseRevisionId), revisionId = id(input.revisionId);
  const packet = parseTaskPacket(input.packet, projectId, ctoId, workstreamId);
  const authority = await taskAuthority(projectId, ctoId, workstreamId, runContext, platform, "builder.publish-task-packet");
  if (packet.scopeNodeIds.some(node => !authority.delivery.instruction.spec.scopeNodeIds.includes(node))) {
    throw new Error("A Task Packet may only include nodes assigned by this exact Workstream.");
  }
  const requirements = new Set(authority.sources.baseline.specification.requirements.map(row => row.id));
  if (packet.requirementIds.some(requirement => !requirements.has(requirement))) throw new Error("Task requirements must refer to the pinned specification, not invented requirements.");
  const current = await authority.store.current();
  const prior = current?.revision.packets.find(row => row.packet.taskId === packet.taskId);
  if (prior && prior.packet.revision === packet.revision) {
    if (JSON.stringify(prior.packet) !== JSON.stringify(packet) || prior.source.instructionSha256 !== authority.source.sha256
      || prior.source.specRevision !== authority.source.specRevision) {
      throw new Error("This immutable Task Packet revision already has different content or source. Existing history was not replaced.");
    }
    await authority.check();
    return { content: "This exact Task Packet revision is already stored. No Worker or provider run was created.",
      data: json({ status: "existing", taskId: packet.taskId, boardRevisionId: current!.revision.revisionId, executionStarted: false }) };
  }
  if ((current?.revision.revisionId ?? null) !== expected) return {
    content: "The Task Packet board changed. Read the published head before explicitly replanning; no automatic write retry.",
    data: json({ status: "conflict", taskId: packet.taskId, boardRevisionId: current?.revision.revisionId ?? null, executionStarted: false }),
  };
  if (packet.revision !== (prior?.packet.revision ?? 0) + 1) throw new Error("A new task starts at revision 1; changes require the next exact Task Packet revision.");
  const record = { packet, source: { requestId: authority.source.requestId, workstreamId,
    specRevision: authority.source.specRevision, instructionSha256: authority.source.sha256 },
    author: { agentId: authority.context.agentId, sessionId: authority.context.sessionId, runId: authority.context.runId },
    createdAtISO: new Date().toISOString(), dependencyPins: packet.dependencies.map(taskId => {
      const dependency = current?.revision.packets.find(row => row.packet.taskId === taskId);
      if (!dependency) throw new Error(`Task dependency ${taskId} is missing from the published board.`);
      return { taskId, revision: dependency.packet.revision,
        recordSha256: taskPacketRecordDigest(dependency, projectId, ctoId, workstreamId) };
    }) };
  const board: TaskPacketBoard = parseTaskPacketBoard({ projectId, ctoId, workstreamId, revisionId,
    packets: [...(current?.revision.packets.filter(row => row.packet.taskId !== packet.taskId) ?? []), record] },
  projectId, ctoId, workstreamId);
  const result = await authority.store.publish({ expectedBaseRevisionId: expected, revision: board });
  await authority.check();
  return { content: "CTO Task Packet instructions stored with exact Workstream provenance. Reuse/license/compatibility claims are authored planning data, not independent verification. No Worker, code, QA run or completion was created.",
    data: json({ status: result.status, taskId: packet.taskId,
      boardRevisionId: result.status === "published" ? result.revision.revisionId : result.actualBaseRevisionId,
      executionStarted: false }) };
}

export async function readCtoTaskPackets(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "ctoId", "workstreamId"]);
  const projectId = id(input.projectId), ctoId = id(input.ctoId), workstreamId = id(input.workstreamId);
  const authority = await taskAuthority(projectId, ctoId, workstreamId, runContext, platform, "builder.read-task-packets");
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
  return { content: "Only this CTO's Workstream Task Packets and their original source revisions. Older instructions stay historical, not evidence of current execution, Worker creation or completion.",
    data: json({ projectId, ctoId, workstreamId, current, currentSource: authority.source, taskStates }) };
}
