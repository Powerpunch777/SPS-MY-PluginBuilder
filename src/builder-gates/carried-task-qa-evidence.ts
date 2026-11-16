import { createHash } from "node:crypto";
import { taskPacketRecordDigest } from "../domain/task-packets.ts";
import { readCurrentG5TaskInputProof } from "../g5-change-impact-tools.ts";
import { resolveCtoTaskAuthority } from "../task-packet-tools.ts";
import { readWorkstreams } from "../workstream-tools.ts";
import type { RevisionState } from "../solution-revision-store.ts";
import { readHistoricalTaskQaEvidence } from "./historical-task-qa-evidence.ts";
import { parseQaCarryForward, type QaCarryForward } from "./qa-carry-forward.ts";
import type { CurrentProtectedTaskQaEvidence, CurrentProtectedTaskQaEvidenceInput } from "./protected-task-qa-evidence.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
type CarriedTaskQaEvidence = CurrentProtectedTaskQaEvidence & Readonly<{
  carryForward: Readonly<{ proof: QaCarryForward;
    implementationRecord: CurrentProtectedTaskQaEvidence["implementationRecord"];
    qaRecord: CurrentProtectedTaskQaEvidence["qaRecord"] }>;
}>;
type Result = Readonly<{ status: "available"; value: CarriedTaskQaEvidence; check(): Promise<void> }>
  | Readonly<{ status: "unknown"; reason: string }>;

/** Server composition only: a current G5 input proof and the exact historical
 * assessment are both required. The report and original receipt stay unchanged. */
export async function readCarriedTaskQaEvidence(input: CurrentProtectedTaskQaEvidenceInput): Promise<Result> {
  const unknown = (reason: string): Result => Object.freeze({ status: "unknown", reason });
  try {
    const { scope, platform } = input;
    const authority = await resolveCtoTaskAuthority(scope.projectId, input.ctoId, scope.workstreamId,
      input.runContext, platform, "builder.verify-workstream");
    if (authority.context.companyId !== scope.workspaceId || scope.workspaceId !== scope.projectId) {
      return unknown("carried-qa-current-cto-scope-mismatch");
    }
    const board = await authority.store.current();
    const workstreamBoard = await readWorkstreams(scope.workspaceId, scope.projectId, platform);
    const workstream = workstreamBoard?.revision.workstreams.find(row => row.spec.id === scope.workstreamId);
    const implementations = board?.revision.packets.filter(row => row.packet.taskId === scope.taskId && row.packet.kind === "development");
    if (!board || !workstream?.change.g5Handoff || implementations?.length !== 1) {
      return unknown("carried-qa-current-g5-task-unavailable");
    }
    const implementation = implementations[0]!;
    const implementationDigest = taskPacketRecordDigest(implementation, scope.projectId, input.ctoId, scope.workstreamId);
    const candidates = board.revision.packets.filter(row => row.packet.kind === "qa"
      && row.packet.dependencies.includes(scope.taskId)
      && row.dependencyPins.some(pin => pin.taskId === scope.taskId && pin.revision === implementation.packet.revision
        && pin.recordSha256 === implementationDigest));
    if (candidates.length !== 1 || !candidates[0]!.packet.testPlan) return unknown("carried-qa-current-dependent-task-unavailable");
    const qa = candidates[0]!;
    const current = await readCurrentG5TaskInputProof({ ...scope, ctoId: input.ctoId, workstream, taskRecord: implementation,
      qaTaskId: qa.packet.taskId, currentRequestId: authority.source.requestId, assertCurrent: authority.check,
      state: platform.state as typeof platform.state & RevisionState });
    if (current.status !== "available") return unknown(current.reason);
    const proof = parseQaCarryForward(current.value);
    if (proof.currentTaskBoardRevisionId !== board.revision.revisionId || proof.task.current !== implementationDigest
      || proof.qa.current !== taskPacketRecordDigest(qa, scope.projectId, input.ctoId, scope.workstreamId)) {
      return unknown("carried-qa-current-task-proof-mismatch");
    }
    const historical = await readHistoricalTaskQaEvidence({ ...input, taskBoardRevisionId: proof.priorTaskBoardRevisionId,
      implementationDigest: proof.task.prior, qaTaskId: qa.packet.taskId, qaDigest: proof.qa.prior });
    if (historical.status !== "available") return unknown(historical.reason);
    const check = async () => {
      await authority.check();
      await current.check();
      await historical.check();
      const boardNow = await authority.store.current();
      const workstreamsNow = await readWorkstreams(scope.workspaceId, scope.projectId, platform);
      if (digest(boardNow) !== digest(board) || digest(workstreamsNow) !== digest(workstreamBoard)) {
        throw new Error("Carried QA current Task or Workstream head changed.");
      }
      await authority.check();
    };
    await check();
    return Object.freeze({ status: "available", value: Object.freeze({ implementationRecord: implementation, qaRecord: qa,
      report: historical.value.report, coreRun: historical.value.coreRun,
      carryForward: Object.freeze({ proof, implementationRecord: historical.value.implementationRecord,
        qaRecord: historical.value.qaRecord }) }), check });
  } catch { return unknown("carried-qa-current-authority-or-evidence-unavailable"); }
}
