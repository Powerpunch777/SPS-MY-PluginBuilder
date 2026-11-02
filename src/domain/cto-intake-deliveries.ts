import { createHash } from "node:crypto";
import { parseCtoQuestionBoard, type CtoQuestionRecord } from "./cto-questions.ts";

const encoder = new TextEncoder();
const MAX_ID_LENGTH = 160;
const MAX_DELIVERY_BYTES = 96 * 1_024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOOL_NAMES = [
  "builder.read-cto-intake",
  "builder.read-design-baseline",
  "builder.read-design-draft",
  "builder.read-design-sources",
  "builder.read-lead-memory",
  "builder.read-solution",
  "builder.read-technology-decisions",
  "builder.read-workstreams",
  "builder.review-cto-question",
] as const;
const FIELDS = ["schemaVersion", "workspaceId", "projectId", "questionId", "revisionId", "requestId", "question", "target",
  "executionPolicy", "createdAtISO", "phase", "runId", "cancellationRequested", "termination"] as const;
const PHASES = ["prepared", "dispatching", "uncertain", "superseded", "submitted", "succeeded", "failed", "cancelled", "interrupted", "timed_out"] as const;
const EARLY_PHASES = new Set<string>(["prepared", "dispatching", "uncertain", "superseded"]);

export type CtoIntakeTarget = Readonly<{ agentId: string; sessionId: string; selectionRevision: number }>;
export type CtoIntakeExecutionPolicy = Readonly<{ mode: "plugin-tools-only-v1"; toolNames: typeof TOOL_NAMES }>;
export const CTO_INTAKE_EXECUTION_POLICY: CtoIntakeExecutionPolicy = Object.freeze({
  mode: "plugin-tools-only-v1",
  toolNames: Object.freeze([...TOOL_NAMES]) as unknown as typeof TOOL_NAMES,
});

export type CtoIntakeDelivery = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  projectId: string;
  questionId: string;
  revisionId: string;
  requestId: string;
  question: CtoQuestionRecord;
  target: CtoIntakeTarget;
  executionPolicy: CtoIntakeExecutionPolicy;
  createdAtISO: string;
  phase: typeof PHASES[number];
  runId: string | null;
  cancellationRequested: boolean;
  termination: "not_applicable" | "pending" | "confirmed";
}>;

function record(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a plain record.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain record.`);
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(fields);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError(`${label} has unknown or missing fields.`);
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`${label}.${key} must be an enumerable data field.`);
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function safeUnicode(value: string, label: string): void {
  if (value.includes("\ufffd")) throw new TypeError(`${label} contains the Unicode replacement character.`);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`${label} contains invalid Unicode.`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError(`${label} contains invalid Unicode.`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a nonblank identifier of at most ${MAX_ID_LENGTH} characters.`);
  safeUnicode(value, label);
  if (!value.trim() || value.length > MAX_ID_LENGTH || /\p{Cc}/u.test(value)) {
    throw new TypeError(`${label} must be a nonblank identifier of at most ${MAX_ID_LENGTH} characters without controls.`);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${label} must be a canonical lowercase UUID.`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer.`);
  return value;
}

function canonicalIso(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("createdAtISO must be a canonical ISO timestamp.");
  safeUnicode(value, "createdAtISO");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new TypeError("createdAtISO must be a canonical ISO timestamp.");
  return value;
}

function parseQuestion(value: unknown, projectId: string, questionId: string): CtoQuestionRecord {
  const parsed = parseCtoQuestionBoard({ projectId, revisionId: "cto-intake-delivery-question", questions: [value] }, projectId).questions[0];
  if (!parsed) throw new TypeError("question must contain one CtoQuestionRecord.");
  if (parsed.proposal.id !== questionId) throw new TypeError("question.proposal.id does not match questionId.");
  if (parsed.review !== null) throw new TypeError("question.review must be null before Lead intake.");
  return parsed;
}

function parseTarget(value: unknown): CtoIntakeTarget {
  const row = record(value, ["agentId", "sessionId", "selectionRevision"], "target");
  return Object.freeze({ agentId: uuid(row.agentId, "target.agentId"), sessionId: uuid(row.sessionId, "target.sessionId"),
    selectionRevision: positiveInteger(row.selectionRevision, "target.selectionRevision") });
}

function parseExecutionPolicy(value: unknown): CtoIntakeExecutionPolicy {
  const row = record(value, ["mode", "toolNames"], "executionPolicy");
  if (row.mode !== "plugin-tools-only-v1") throw new TypeError("executionPolicy.mode is unsupported.");
  if (!Array.isArray(row.toolNames) || Object.getPrototypeOf(row.toolNames) !== Array.prototype) {
    throw new TypeError("executionPolicy.toolNames must be a standard array.");
  }
  const keys = Reflect.ownKeys(row.toolNames);
  if (keys.length !== TOOL_NAMES.length + 1 || !keys.includes("length") || row.toolNames.length !== TOOL_NAMES.length) {
    throw new TypeError(`executionPolicy.toolNames must contain exactly ${TOOL_NAMES.length} dense entries with no extra properties.`);
  }
  for (let index = 0; index < TOOL_NAMES.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(row.toolNames, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("executionPolicy.toolNames must contain enumerable data fields.");
    if (descriptor.value !== TOOL_NAMES[index]) throw new TypeError("executionPolicy.toolNames must be the exact canonical sorted intake policy.");
  }
  return Object.freeze({ mode: "plugin-tools-only-v1", toolNames: Object.freeze([...TOOL_NAMES]) as unknown as typeof TOOL_NAMES });
}

function canonicalQuestionAndTarget(workspaceId: string, projectId: string, questionId: string,
  question: unknown, target: unknown): Readonly<{ question: CtoQuestionRecord; target: CtoIntakeTarget }> {
  return Object.freeze({ question: parseQuestion(question, projectId, questionId), target: parseTarget(target) });
}

function requestIdFor(workspaceId: string, projectId: string, question: CtoQuestionRecord, target: CtoIntakeTarget): string {
  const tuple = JSON.stringify(["sps-builder-cto-intake-v1", workspaceId, projectId, question, target]);
  const hash = createHash("sha256").update(tuple, "utf8").digest("hex").slice(0, 32).split("");
  hash[12] = "8";
  hash[16] = ((Number.parseInt(hash[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const hex = hash.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function ctoIntakeRequestId(workspaceId: string, projectId: string, questionId: string,
  question: CtoQuestionRecord, target: CtoIntakeTarget): string {
  const scopeWorkspaceId = uuid(workspaceId, "workspaceId");
  const scopeProjectId = identifier(projectId, "projectId");
  const scopeQuestionId = identifier(questionId, "questionId");
  const canonical = canonicalQuestionAndTarget(scopeWorkspaceId, scopeProjectId, scopeQuestionId, question, target);
  return requestIdFor(scopeWorkspaceId, scopeProjectId, canonical.question, canonical.target);
}

export function parseCtoIntakeDelivery(value: unknown, workspaceId: string, projectId: string, questionId: string): CtoIntakeDelivery {
  const expectedWorkspaceId = uuid(workspaceId, "workspaceId");
  const expectedProjectId = identifier(projectId, "projectId");
  const expectedQuestionId = identifier(questionId, "questionId");
  const row = record(value, FIELDS, "ctoIntakeDelivery");
  if (row.schemaVersion !== 1) throw new TypeError("schemaVersion must be 1.");
  const actualWorkspaceId = uuid(row.workspaceId, "workspaceId");
  const actualProjectId = identifier(row.projectId, "projectId");
  const actualQuestionId = identifier(row.questionId, "questionId");
  if (actualWorkspaceId !== expectedWorkspaceId || actualProjectId !== expectedProjectId || actualQuestionId !== expectedQuestionId) {
    throw new TypeError("delivery workspace, project, and question must match the expected scope.");
  }
  const revisionId = identifier(row.revisionId, "revisionId");
  const canonical = canonicalQuestionAndTarget(actualWorkspaceId, actualProjectId, actualQuestionId, row.question, row.target);
  const executionPolicy = parseExecutionPolicy(row.executionPolicy);
  const createdAtISO = canonicalIso(row.createdAtISO);
  if (typeof row.phase !== "string" || !(PHASES as readonly string[]).includes(row.phase)) throw new TypeError("phase is unsupported.");
  const phase = row.phase as CtoIntakeDelivery["phase"];
  const runId = row.runId === null ? null : uuid(row.runId, "runId");
  if (EARLY_PHASES.has(phase) ? runId !== null : runId === null) throw new TypeError("runId does not match phase.");
  if (typeof row.cancellationRequested !== "boolean") throw new TypeError("cancellationRequested must be a boolean.");
  if (row.termination !== "not_applicable" && row.termination !== "pending" && row.termination !== "confirmed") {
    throw new TypeError("termination is unsupported.");
  }
  if (EARLY_PHASES.has(phase)) {
    if (row.cancellationRequested || row.termination !== "not_applicable") {
      throw new TypeError("prepared intake phases require cancellation=false and termination=not_applicable.");
    }
  } else if (!row.cancellationRequested ? row.termination !== "not_applicable" : row.termination === "not_applicable") {
    throw new TypeError("termination does not match cancellationRequested.");
  }
  const delivery: CtoIntakeDelivery = Object.freeze({ schemaVersion: 1, workspaceId: actualWorkspaceId, projectId: actualProjectId,
    questionId: actualQuestionId, revisionId, requestId: uuid(row.requestId, "requestId"), question: canonical.question,
    target: canonical.target, executionPolicy, createdAtISO, phase, runId, cancellationRequested: row.cancellationRequested,
    termination: row.termination });
  if (delivery.requestId !== requestIdFor(expectedWorkspaceId, expectedProjectId, canonical.question, canonical.target)) {
    throw new TypeError("requestId does not match the deterministic question and target identity.");
  }
  if (encoder.encode(JSON.stringify(delivery)).byteLength > MAX_DELIVERY_BYTES) {
    throw new TypeError(`ctoIntakeDelivery exceeds the ${MAX_DELIVERY_BYTES}-byte JSON limit.`);
  }
  return delivery;
}
