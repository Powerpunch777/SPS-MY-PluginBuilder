import { createHash } from "node:crypto";
import { exactToolRecord } from "../lead-tool-authority.ts";
import type { EvidencePin } from "./workstream-verification-consumer.ts";

const SHA = /^[a-f0-9]{64}$/u;
const ID = /^[^\u0000-\u001f\u007f]{1,160}$/u;
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export const QA_CARRY_FORWARD_SOURCE_PREFIX = "builder-v1:qa-carry:";

type ComparedTaskPins = Readonly<{ prior: string; compared: string; current: string; inputsSha256: string }>;
export type QaCarryForward = Readonly<{
  kind: "g5-task-qa-carry-forward-v1";
  taskId: string;
  qaTaskId: string;
  handoffSha256: string;
  priorTaskBoardRevisionId: string;
  comparedTaskBoardRevisionId: string;
  currentTaskBoardRevisionId: string;
  task: ComparedTaskPins;
  qa: ComparedTaskPins;
}>;

function id(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value) || !value.trim()) throw new TypeError("Invalid QA carry-forward identifier.");
  return value;
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA.test(value)) throw new TypeError("Invalid QA carry-forward digest.");
  return value;
}
function comparedPins(value: unknown): ComparedTaskPins {
  const row = exactToolRecord(value, ["prior", "compared", "current", "inputsSha256"]);
  const prior = sha(row.prior), compared = sha(row.compared), current = sha(row.current);
  if (new Set([prior, compared, current]).size !== 3) throw new TypeError("QA carry-forward must distinguish all three Task digests.");
  return Object.freeze({ prior, compared, current, inputsSha256: sha(row.inputsSha256) });
}

/** Canonical provenance only. Parsing these pins establishes no scope, approval or gate result. */
export function parseQaCarryForward(value: unknown): QaCarryForward {
  const row = exactToolRecord(value, ["kind", "taskId", "qaTaskId", "handoffSha256", "priorTaskBoardRevisionId",
    "comparedTaskBoardRevisionId", "currentTaskBoardRevisionId", "task", "qa"]);
  const taskId = id(row.taskId), qaTaskId = id(row.qaTaskId);
  const priorTaskBoardRevisionId = id(row.priorTaskBoardRevisionId), comparedTaskBoardRevisionId = id(row.comparedTaskBoardRevisionId);
  const currentTaskBoardRevisionId = id(row.currentTaskBoardRevisionId);
  if (row.kind !== "g5-task-qa-carry-forward-v1" || taskId === qaTaskId
    || new Set([priorTaskBoardRevisionId, comparedTaskBoardRevisionId, currentTaskBoardRevisionId]).size !== 3) {
    throw new TypeError("Invalid QA carry-forward roles or Task board identities.");
  }
  return Object.freeze({ kind: row.kind, taskId, qaTaskId, handoffSha256: sha(row.handoffSha256), priorTaskBoardRevisionId,
    comparedTaskBoardRevisionId, currentTaskBoardRevisionId, task: comparedPins(row.task), qa: comparedPins(row.qa) });
}

/** Binds the canonical ordered [proof, report pin] tuple, not a report ID alone. */
export function qaCarryForwardPin(proof: QaCarryForward, report: EvidencePin): EvidencePin {
  const canonical = parseQaCarryForward(proof);
  const row = exactToolRecord(report, ["sourceId", "revisionId", "sha256"]);
  const sourceId = id(row.sourceId), revisionId = id(row.revisionId), sha256 = sha(row.sha256);
  if (sourceId !== `builder-v1:task-qa-report:${canonical.qaTaskId}`) throw new TypeError("QA carry-forward report belongs to another Task.");
  return Object.freeze({ sourceId: `${QA_CARRY_FORWARD_SOURCE_PREFIX}${digest(canonical.taskId)}`,
    revisionId: canonical.currentTaskBoardRevisionId, sha256: digest(JSON.stringify([canonical, { sourceId, revisionId, sha256 }])) });
}
