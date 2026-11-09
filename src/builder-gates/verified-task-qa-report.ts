import { createHash } from "node:crypto";
import type { EvidencePin, VerifiedWorkstreamSnapshot } from "./workstream-verification-consumer.ts";
import { parseQaCarryForward, qaCarryForwardPin } from "./qa-carry-forward.ts";
import type { TaskPacketRecord } from "../domain/task-packets.ts";
import type { TaskQaReport } from "../task-qa-reports.ts";
import type { WorkstreamRecord } from "../domain/workstreams.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const samePin = (a: EvidencePin, b: EvidencePin) => a.sourceId === b.sourceId && a.revisionId === b.revisionId && a.sha256 === b.sha256;

export type VerifiedTaskQaReportInput = Readonly<{
  snapshot: VerifiedWorkstreamSnapshot;
  task: TaskPacketRecord;
  taskDigest: string;
  qaTask: TaskPacketRecord;
  qaDigest: string;
  taskBoardRevisionId: string;
  workstream: WorkstreamRecord;
  report: TaskQaReport;
  reportPin: EvidencePin;
}>;

/** Validates carried provenance as historical evidence, never as a current QA authoring result. */
export function verifyTaskQaReportForSnapshot(input: VerifiedTaskQaReportInput): boolean {
  try {
    const { snapshot, task, qaTask, report, reportPin } = input;
    const source = task.packet.sourceAccess;
    if (!source?.branch) return false;
    const qaRows = snapshot.qaEvidence.filter(row => row.report.sourceId === reportPin.sourceId);
    if (qaRows.length !== 1 || qaRows[0]!.result !== "passed" || !samePin(qaRows[0]!.report, reportPin)
      || reportPin.sourceId !== `builder-v1:task-qa-report:${qaTask.packet.taskId}`
      || reportPin.revisionId !== report.revisionId || reportPin.sha256 !== hash(report)
      || !snapshot.sourcePins.some(pin => samePin(pin, reportPin))
      || report.verdict !== "passed" || report.coreStatus !== "succeeded") return false;
    const binding = report.reference.binding;
    const referencePin = snapshot.sourcePins.find(pin => pin.sourceId === `builder-v1:task-qa-run:${qaTask.packet.taskId}`);
    const taskPin = snapshot.sourcePins.find(pin => pin.sourceId === `builder-v1:task-packet:${task.packet.taskId}`);
    const qaPin = snapshot.sourcePins.find(pin => pin.sourceId === `builder-v1:task-packet:${qaTask.packet.taskId}`);
    const workstreamPin = snapshot.sourcePins.find(pin => pin.sourceId === `builder-v1:workstream:${task.packet.workstreamId}`);
    if (!referencePin || referencePin.revisionId !== report.reference.revisionId || referencePin.sha256 !== hash(report.reference)
      || !taskPin || !qaPin || !workstreamPin || taskPin.sha256 !== input.taskDigest || qaPin.sha256 !== input.qaDigest
      || taskPin.revisionId !== `${task.packet.taskId}:${task.packet.revision}`
      || qaPin.revisionId !== `${qaTask.packet.taskId}:${qaTask.packet.revision}`
      || workstreamPin.sha256 !== hash(input.workstream) || workstreamPin.revisionId !== String(input.workstream.spec.revision)) return false;
    const carryValue = qaRows[0]!.carryForward;
    if (carryValue === undefined) {
      return binding.implementationTaskId === task.packet.taskId && binding.implementationRevision === task.packet.revision
        && binding.implementationDigest === input.taskDigest && binding.qaRevision === qaTask.packet.revision
        && binding.qaDigest === input.qaDigest && binding.sourceId === source.sourceId
        && binding.folderKey === source.folderKey && binding.branch === source.branch;
    }
    const proof = parseQaCarryForward(carryValue);
    const handoff = input.workstream.change.g5Handoff;
    if (!handoff || input.workstream.receipt?.readiness !== "ready"
      || input.workstream.receipt.revision !== input.workstream.spec.revision
      || proof.taskId !== task.packet.taskId || proof.qaTaskId !== qaTask.packet.taskId
      || proof.currentTaskBoardRevisionId !== input.taskBoardRevisionId
      || proof.task.current !== input.taskDigest || proof.qa.current !== input.qaDigest
      || proof.handoffSha256 !== hash(handoff)
      || handoff.tasks.oldRevisionId !== proof.priorTaskBoardRevisionId
      || handoff.tasks.newRevisionId !== proof.comparedTaskBoardRevisionId
      || binding.implementationTaskId !== task.packet.taskId || binding.implementationDigest !== proof.task.prior
      || binding.implementationRevision >= task.packet.revision || binding.qaRevision >= qaTask.packet.revision
      || binding.qaDigest !== proof.qa.prior || binding.sourceId !== source.sourceId
      || binding.folderKey !== source.folderKey || binding.branch !== source.branch) return false;
    return snapshot.sourcePins.some(pin => samePin(pin, qaCarryForwardPin(proof, reportPin)));
  } catch { return false; }
}
