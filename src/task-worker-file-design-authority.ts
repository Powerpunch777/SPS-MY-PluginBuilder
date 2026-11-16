import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { readDesignBaseline } from "./design-baseline-tools.ts";
import { parseTaskPacketRecord, taskPacketRecordDigest, type TaskPacketRecord } from "./domain/task-packets.ts";
import { parseLeadAgentBinding } from "./domain/lead-agent.ts";
import { parseLeadSessions } from "./domain/lead-sessions.ts";
import { createTaskPacketStore } from "./task-packet-tools.ts";
import { readPinnedWorkstreamSources, readWorkstreams } from "./workstream-tools.ts";
import { workstreamInstructionDigest } from "./cto-delivery-store.ts";
import { createCurrentBaselineAssuranceProvider } from "./spec-assurance/current-baseline-provider.ts";
import { hasUndecidedTaskRequirement } from "./builder-gates/task-decision-scope.ts";
import { assertCurrentCtoTaskG5Effect } from "./g5-change-impact-tools.ts";
import type { RevisionState } from "./solution-revision-store.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

/** Server-only design preflight alongside the caller's existing Run/registry/dependency checks.
 * Pass its observed platform so these mutable heads join the Core file-effect guards; no approval or Run authority is created. */
export async function assertTaskWorkerFileDesignAuthority(input: Readonly<{
  workspaceId: string; projectId: string; ctoId: string; workstreamId: string;
  taskRecord: TaskPacketRecord; platform: SpsPlatformInvocationContext;
}>) {
  const { workspaceId, projectId, ctoId, workstreamId, platform } = input;
  const task = parseTaskPacketRecord(input.taskRecord, projectId, ctoId, workstreamId);
  const taskId = task.packet.taskId;
  const taskDigest = taskPacketRecordDigest(task, projectId, ctoId, workstreamId);
  const tasks = createTaskPacketStore(workspaceId, projectId, ctoId, workstreamId, platform.state);
  const [baseline, workstreams, board] = await Promise.all([
    readDesignBaseline(workspaceId, projectId, platform), readWorkstreams(workspaceId, projectId, platform), tasks.current(),
  ]);
  const workstream = workstreams?.revision.workstreams.find(row => row.spec.id === workstreamId);
  const currentTask = board?.revision.packets.find(row => row.packet.taskId === taskId);
  if (!baseline || !workstreams || !board || !workstream || !currentTask
    || workstream.spec.assignedCtoId !== ctoId || taskPacketRecordDigest(currentTask, projectId, ctoId, workstreamId) !== taskDigest
    || task.source.workstreamId !== workstreamId || task.source.specRevision !== workstream.spec.revision
    || task.source.instructionSha256 !== workstreamInstructionDigest(workstream)) {
    throw new Error("Task file design authority requires the exact current Workstream and Task source pins.");
  }
  if (workstream.sourceBaselineRevisionId !== baseline.revision.revisionId || workstream.baselineDigest !== hash(baseline.revision)
    || workstream.spec.sourceSpecRevisionId !== baseline.revision.specification.revisionId) {
    throw new Error("Task file design scope is stale; no exact current Baseline or unaffected carry-forward proof is available.");
  }
  if (task.packet.requirementIds.some(id => !baseline.revision.specification.requirements.some(row => row.id === id))) {
    throw new Error("Task file requirements are outside the exact current approved Baseline.");
  }
  const pinned = await readPinnedWorkstreamSources(workspaceId, projectId, workstream, platform);
  if (hash(pinned.baseline) !== hash(baseline.revision)
    || pinned.technology.register.sourceBaselineRevisionId !== baseline.revision.revisionId
    || pinned.technology.register.sourceSpecRevisionId !== baseline.revision.specification.revisionId
    || pinned.technology.register.sourceGraphRevisionId !== baseline.revision.graph.graphRevisionId) {
    throw new Error("Task file Workstream technology does not bind its exact approved Baseline.");
  }
  const stateKey = (stateKey: string) => ({ scopeKind: "company" as const, scopeId: workspaceId, namespace: "sonpark.my-builder", stateKey });
  const rawLead = await platform.state.get(stateKey("lead-agent.v1"));
  const lead = parseLeadAgentBinding(rawLead, workspaceId);
  if (!lead.selectedAgentId || lead.revision < 1) throw new Error("Task file design authority requires the current Lead selection.");
  const rawSessions = await platform.state.get(stateKey(`lead-sessions.v1.${lead.revision}`));
  const sessions = parseLeadSessions(rawSessions, workspaceId);
  if (sessions.agentId !== lead.selectedAgentId || sessions.selectionRevision !== lead.revision || !sessions.sessions.main) {
    throw new Error("Task file design authority requires the current Main session binding.");
  }
  const assertSameHeads = async () => {
    const [nextBaseline, nextWorkstreams, nextTasks, nextLead, nextSessions] = await Promise.all([
      readDesignBaseline(workspaceId, projectId, platform), readWorkstreams(workspaceId, projectId, platform), tasks.current(),
      platform.state.get(stateKey("lead-agent.v1")), platform.state.get(stateKey(`lead-sessions.v1.${lead.revision}`)),
    ]);
    if (!nextBaseline || !nextWorkstreams || !nextTasks || nextBaseline.sequence !== baseline.sequence
      || hash(nextBaseline.revision) !== hash(baseline.revision) || nextWorkstreams.sequence !== workstreams.sequence
      || hash(nextWorkstreams.revision) !== hash(workstreams.revision) || nextTasks.sequence !== board.sequence
      || hash(nextTasks.revision) !== hash(board.revision) || hash(nextLead) !== hash(rawLead) || hash(nextSessions) !== hash(rawSessions)) {
      throw new Error("Task file design/G5 heads changed during validation; no file effect is authorized by this observation.");
    }
  };
  await assertSameHeads();
  const material = await createCurrentBaselineAssuranceProvider({ workspaceId, projectId, sessions, platform })({
    identity: { workspaceId, projectId, specRevisionId: baseline.revision.specification.revisionId,
      specDigest: hash(baseline.revision.specification) }, requirementIds: task.packet.requirementIds,
  });
  if (!material) throw new Error("Current approved Task design material is unavailable.");
  if (hasUndecidedTaskRequirement(task.packet.requirementIds, material.itemDecisions)) {
    throw new Error("Task file scope is blocked by an explicitly UNDECIDED approved requirement.");
  }
  const g5 = await assertCurrentCtoTaskG5Effect({ workspaceId, projectId, ctoId, workstreamId, taskId,
    workstream, taskRecord: task, assertCurrent: assertSameHeads, state: platform.state as RevisionState });
  if (g5.status === "unknown") throw new Error("Task file G5 impact is UNKNOWN; absence of a candidate is not unaffected authority.");
  await assertSameHeads();
  return Object.freeze({ baselineRevisionId: baseline.revision.revisionId, specRevisionId: baseline.revision.specification.revisionId,
    workstreamRevision: workstream.spec.revision, taskRecordSha256: taskDigest, g5 });
}
