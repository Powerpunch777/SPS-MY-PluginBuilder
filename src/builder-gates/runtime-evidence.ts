import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { createTaskPacketStore } from "../task-packet-tools.ts";
import { workstreamInstructionDigest } from "../cto-delivery-store.ts";
import { readWorkstreams } from "../workstream-tools.ts";
import { parseLeadToolContext, requireLeadFormalPublicationAuthority, resolveLeadToolAuthority } from "../lead-tool-authority.ts";
import type { RevisionState } from "../solution-revision-store.ts";
import type { GateProofScope, GateReader, GateRuntimeProof } from "./workstream-verification.ts";

export type RuntimeEvidenceObservation = Readonly<{
  status: "observed";
  scope: GateProofScope;
  task: Readonly<{
    taskId: string;
    taskRevision: number;
    taskKind: "development" | "qa";
    boardRevisionId: string;
    recordSha256: string;
    sourceSpecRevision: number;
    instructionSha256: string;
  }>;
  taskAuthorRun: Readonly<{
    runId: string;
    status: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "interrupted" | "timed_out";
    termination: "not_applicable" | "pending" | "confirmed";
    outputState: "available" | "not_ready" | "withheld" | "unsupported";
  }>;
  artifactEvidence: Readonly<{ status: "unavailable"; reason: string }>;
  independentQa: Readonly<{ status: "not-established"; reason: string }>;
  gateProof: Readonly<{ status: "unknown"; reason: string }>;
}>;

export type RuntimeEvidenceRead =
  | RuntimeEvidenceObservation
  | Readonly<{ status: "unknown"; reason: string }>;

const HASH = /^[a-f0-9]{64}$/u;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const RUN_STATES = new Set(["queued", "running", "cancelling", "succeeded", "failed", "cancelled", "interrupted", "timed_out"]);
const unknown = (reason: string): RuntimeEvidenceRead => Object.freeze({ status: "unknown", reason });

/**
 * Read-only narrow adapter. The public Platform SDK exposes current Builder
 * Task Packet state and agent-session getRun, but no artifact reader or
 * independent QA verifier. Accordingly runtimeProof always fails closed.
 */
export function createRuntimeEvidenceAdapter(input: Readonly<{
  ctoId: string;
  runContext: unknown;
  platform: SpsPlatformInvocationContext;
}>) {
  if (!input || typeof input.ctoId !== "string" || !input.ctoId.trim() || input.ctoId.length > 160) {
    throw new TypeError("A bounded registered CTO identity is required.");
  }
  const context = parseLeadToolContext(input.runContext);
  const { platform, ctoId } = input;

  async function observe(scope: GateProofScope): Promise<RuntimeEvidenceRead> {
    try {
      if (!scope || scope.workspaceId !== context.companyId
        || context.projectId !== undefined && context.projectId !== scope.projectId
        || ![scope.projectId, scope.workstreamId, scope.taskId].every(value => typeof value === "string" && !!value.trim())) {
        return unknown("authenticated-run-scope-mismatch");
      }
      const authority = await resolveLeadToolAuthority(context, platform);
      requireLeadFormalPublicationAuthority(authority);
      const { companyId } = context;
      const board = await createTaskPacketStore(companyId, scope.projectId, ctoId, scope.workstreamId,
        platform.state as RevisionState).current();
      const task = board?.revision.packets.find(item => item.packet.taskId === scope.taskId);
      if (!board || !task || task.packet.taskId !== scope.taskId
        || task.packet.projectId !== scope.projectId || task.packet.ctoId !== ctoId
        || task.packet.workstreamId !== scope.workstreamId) return unknown("current-task-packet-unavailable-or-mismatched");

      const currentBoard = await readWorkstreams(companyId, scope.projectId, platform);
      const workstream = currentBoard?.revision.workstreams.find(item => item.spec.id === scope.workstreamId);
      if (!workstream || workstream.spec.projectId !== scope.projectId || workstream.spec.assignedCtoId !== ctoId
        || workstream.spec.revision !== task.source.specRevision
        || workstreamInstructionDigest(workstream) !== task.source.instructionSha256) {
        return unknown("task-packet-workstream-source-is-not-current");
      }

      const taskDigest = hash(task);
      if (!HASH.test(taskDigest)) return unknown("current-task-record-digest-unavailable");
      const run = await platform.agents.sessions.getRun(task.author.sessionId, companyId, task.author.runId);
      await authority.check();
      if (!run || run.runId !== task.author.runId || !RUN_STATES.has(run.status)) {
        return unknown("exact-task-author-run-unavailable-or-invalid");
      }
      if (run.termination !== "not_applicable" && run.termination !== "pending" && run.termination !== "confirmed") {
        return unknown("exact-task-author-run-termination-state-invalid");
      }
      const outputState = run.output === undefined ? "unsupported" : run.output.state;
      if (outputState !== "unsupported" && outputState !== "available" && outputState !== "not_ready" && outputState !== "withheld") {
        return unknown("exact-task-author-run-output-state-invalid");
      }
      const currentAgain = await createTaskPacketStore(companyId, scope.projectId, ctoId, scope.workstreamId,
        platform.state as RevisionState).current();
      if (!currentAgain || currentAgain.revision.revisionId !== board.revision.revisionId
        || hash(currentAgain.revision.packets.find(item => item.packet.taskId === scope.taskId)) !== taskDigest) {
        return unknown("task-packet-changed-during-runtime-evidence-read");
      }
      await authority.check();
      return Object.freeze({
        status: "observed" as const,
        scope: Object.freeze({ ...scope }),
        task: Object.freeze({ taskId: task.packet.taskId, taskRevision: task.packet.revision, taskKind: task.packet.kind,
          boardRevisionId: board.revision.revisionId, recordSha256: taskDigest,
          sourceSpecRevision: task.source.specRevision, instructionSha256: task.source.instructionSha256 }),
        taskAuthorRun: Object.freeze({ runId: run.runId, status: run.status as RuntimeEvidenceObservation["taskAuthorRun"]["status"],
          termination: run.termination, outputState }),
        artifactEvidence: Object.freeze({ status: "unavailable" as const,
          reason: "SpsPlatformInvocationContext exposes no Artifact reader." }),
        independentQa: Object.freeze({ status: "not-established" as const,
          reason: "A QA Task Packet and its author run are instructions/provenance, not an independent QA result." }),
        gateProof: Object.freeze({ status: "unknown" as const,
          reason: "No authoritative runtime artifact and independent verifier are available through the public Platform SDK." }),
      });
    } catch {
      return unknown("runtime-evidence-read-failed-or-authority-unavailable");
    }
  }

  const runtimeProof: GateReader<GateRuntimeProof> = async scope => {
    const observation = await observe(scope);
    return Object.freeze({ status: "unknown" as const, reason: observation.status === "observed"
      ? observation.gateProof.reason : observation.reason });
  };

  return Object.freeze({ observe, runtimeProof });
}
