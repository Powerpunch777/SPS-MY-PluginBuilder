import { createHash } from "node:crypto";
import { parseWorkstreamBoard, type WorkstreamRecord } from "./workstreams.ts";

const encoder = new TextEncoder();
const MAX_ID_LENGTH = 160;
const MAX_ANSWER_BYTES = 8_192;
const MAX_DELIVERY_BYTES = 96 * 1_024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FIELDS = [
  "schemaVersion", "workspaceId", "projectId", "ctoId", "revisionId", "requestId", "boardRevisionId",
  "instruction", "requestedBy", "createdAt", "phase", "runId", "cancellationRequested", "termination",
  "outputState", "answer", "executionPolicy",
] as const;
const LEGACY_POLICY_TOOLS = ["builder.acknowledge-workstream", "builder.read-cto-workstream"] as const;
const MEMORY_POLICY_TOOLS = ["builder.acknowledge-workstream", "builder.read-cto-memory", "builder.read-cto-workstream", "builder.update-cto-memory"] as const;
const POLICY_TOOLS = ["builder.acknowledge-workstream", "builder.read-cto-memory", "builder.read-cto-workstream", "builder.read-own-cto-question", "builder.submit-cto-question", "builder.update-cto-memory"] as const;
const TASK_PACKET_POLICY_TOOLS = ["builder.acknowledge-workstream", "builder.publish-task-packet", "builder.read-cto-memory", "builder.read-cto-workstream", "builder.read-own-cto-question", "builder.read-task-packets", "builder.submit-cto-question", "builder.update-cto-memory"] as const;
const PHASES = ["prepared", "dispatching", "uncertain", "superseded", "submitted", "succeeded", "failed", "cancelled", "interrupted", "timed_out"] as const;
const EARLY_PHASES = new Set<string>(["prepared", "dispatching", "uncertain", "superseded"]);

export type CtoDelivery = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  projectId: string;
  ctoId: string;
  revisionId: string;
  requestId: string;
  boardRevisionId: string;
  instruction: WorkstreamRecord;
  requestedBy: Readonly<{
    agentId: string;
    sessionId: string;
    runId: string;
    selectionRevision: number;
  }>;
  executionPolicy: Readonly<{
    mode: "plugin-tools-only-v1";
    toolNames: readonly (typeof POLICY_TOOLS[number] | typeof TASK_PACKET_POLICY_TOOLS[number])[];
  }>;
  createdAt: string;
  phase: typeof PHASES[number];
  runId: string | null;
  cancellationRequested: boolean;
  termination: "not_applicable" | "pending" | "confirmed";
  outputState: "not_ready" | "available" | "withheld" | "unsupported";
  answer: string | null;
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

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a nonblank identifier of at most ${MAX_ID_LENGTH} characters without ASCII controls.`);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${label} must be a canonical UUID.`);
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer.`);
  return value;
}

function canonicalIso(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  return value;
}

function answerText(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || encoder.encode(value).byteLength > MAX_ANSWER_BYTES) {
    throw new TypeError(`answer must be nonblank and at most ${MAX_ANSWER_BYTES} UTF-8 bytes.`);
  }
  return value;
}

function parseExecutionPolicy(value: unknown): CtoDelivery["executionPolicy"] {
  const row = record(value, ["mode", "toolNames"], "executionPolicy");
  if (row.mode !== "plugin-tools-only-v1") throw new TypeError("executionPolicy.mode is unsupported.");
  if (!Array.isArray(row.toolNames) || Object.getPrototypeOf(row.toolNames) !== Array.prototype) {
    throw new TypeError("executionPolicy.toolNames must be a standard array.");
  }
  const keys = Reflect.ownKeys(row.toolNames);
  const length = Object.getOwnPropertyDescriptor(row.toolNames, "length")?.value;
  if ((length !== 2 && length !== 4 && length !== 6 && length !== 8) || keys.length !== length + 1 || !keys.includes("length")) {
    throw new TypeError("executionPolicy.toolNames must contain exactly two, four, six or eight dense entries with no extra properties.");
  }
  const names: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(row.toolNames, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("executionPolicy.toolNames must contain enumerable data fields.");
    }
    names.push(descriptor.value);
  }
  const expected = length === 2 ? LEGACY_POLICY_TOOLS : length === 4 ? MEMORY_POLICY_TOOLS
    : length === 6 ? POLICY_TOOLS : TASK_PACKET_POLICY_TOOLS;
  if (names.some((name, index) => name !== expected[index])) {
    throw new TypeError("executionPolicy.toolNames must be a canonical sorted CTO planning profile.");
  }
  // Historical intents retain their original policy, never an upgrade.
  return Object.freeze({ mode: "plugin-tools-only-v1", toolNames: Object.freeze([...expected]) });
}

function assertSafeStrings(value: unknown, label: string): void {
  if (typeof value === "string") {
    if (/\p{Cc}/u.test(value.replace(/[\t\r\n]/gu, ""))) throw new TypeError(`${label} must not contain control characters.`);
    if (value.includes("\ufffd")) throw new TypeError(`${label} contains the Unicode replacement character.`);
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`${label} contains invalid Unicode.`);
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError(`${label} contains invalid Unicode.`);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) assertSafeStrings(item, label);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) assertSafeStrings(item, label);
  }
}

function parseInstruction(value: unknown, projectId: string, ctoId: string): WorkstreamRecord {
  const parsed = parseWorkstreamBoard({ projectId, revisionId: "delivery-instruction", workstreams: [value] }, projectId).workstreams[0];
  if (!parsed) throw new TypeError("instruction must contain one WorkstreamRecord.");
  if (parsed.receipt !== null) throw new TypeError("instruction.receipt must be null.");
  if (parsed.spec.assignedCtoId !== ctoId) throw new TypeError("instruction.spec.assignedCtoId does not match the expected CTO.");
  return parsed;
}

function requestIdForInstruction(workspaceId: string, projectId: string, ctoId: string, instruction: WorkstreamRecord): string {
  const tuple = JSON.stringify(["sps-builder-cto-delivery-v1", workspaceId, projectId, ctoId, instruction]);
  const hash = createHash("sha256").update(tuple, "utf8").digest("hex").slice(0, 32).split("");
  hash[12] = "8";
  hash[16] = ((Number.parseInt(hash[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const hex = hash.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function ctoDeliveryRequestId(workspaceId: string, projectId: string, ctoId: string, instruction: WorkstreamRecord): string {
  const scopeWorkspaceId = uuid(workspaceId, "workspaceId");
  const scopeProjectId = identifier(projectId, "projectId");
  const scopeCtoId = identifier(ctoId, "ctoId");
  const canonicalInstruction = parseInstruction(instruction, scopeProjectId, scopeCtoId);
  assertSafeStrings(canonicalInstruction, "instruction");
  return requestIdForInstruction(scopeWorkspaceId, scopeProjectId, scopeCtoId, canonicalInstruction);
}

export function parseCtoDelivery(value: unknown, workspaceId: string, projectId: string, ctoId: string): CtoDelivery {
  const expectedWorkspaceId = uuid(workspaceId, "workspaceId");
  const expectedProjectId = identifier(projectId, "projectId");
  const expectedCtoId = identifier(ctoId, "ctoId");
  const row = record(value, FIELDS, "ctoDelivery");
  if (row.schemaVersion !== 1) throw new TypeError("schemaVersion must be 1.");
  const actualWorkspaceId = uuid(row.workspaceId, "workspaceId");
  const actualProjectId = identifier(row.projectId, "projectId");
  const actualCtoId = identifier(row.ctoId, "ctoId");
  if (actualWorkspaceId !== expectedWorkspaceId || actualProjectId !== expectedProjectId || actualCtoId !== expectedCtoId) {
    throw new TypeError("delivery workspace, project, and CTO must match the expected scope.");
  }
  const revisionId = identifier(row.revisionId, "revisionId");
  const boardRevisionId = identifier(row.boardRevisionId, "boardRevisionId");
  const instruction = parseInstruction(row.instruction, expectedProjectId, expectedCtoId);
  const requestedByRow = record(row.requestedBy, ["agentId", "sessionId", "runId", "selectionRevision"], "requestedBy");
  const requestedBy = Object.freeze({
    agentId: uuid(requestedByRow.agentId, "requestedBy.agentId"),
    sessionId: uuid(requestedByRow.sessionId, "requestedBy.sessionId"),
    runId: uuid(requestedByRow.runId, "requestedBy.runId"),
    selectionRevision: positiveSafeInteger(requestedByRow.selectionRevision, "requestedBy.selectionRevision"),
  });
  const executionPolicy = parseExecutionPolicy(row.executionPolicy);
  const createdAt = canonicalIso(row.createdAt, "createdAt");
  if (typeof row.phase !== "string" || !(PHASES as readonly string[]).includes(row.phase)) throw new TypeError("phase is unsupported.");
  const phase = row.phase as CtoDelivery["phase"];
  const runId = row.runId === null ? null : uuid(row.runId, "runId");
  if (EARLY_PHASES.has(phase) ? runId !== null : runId === null) throw new TypeError("runId does not match phase.");
  if (typeof row.cancellationRequested !== "boolean") throw new TypeError("cancellationRequested must be a boolean.");
  if (row.termination !== "not_applicable" && row.termination !== "pending" && row.termination !== "confirmed") {
    throw new TypeError("termination is unsupported.");
  }
  if (!row.cancellationRequested ? row.termination !== "not_applicable" : row.termination === "not_applicable") {
    throw new TypeError("termination does not match cancellationRequested.");
  }
  if (row.outputState !== "not_ready" && row.outputState !== "available" && row.outputState !== "withheld" && row.outputState !== "unsupported") {
    throw new TypeError("outputState is unsupported.");
  }
  const outputState = row.outputState;
  const answer = row.answer === null ? null : answerText(row.answer);
  if ((outputState === "available") !== (answer !== null) || (answer !== null && phase !== "succeeded")) {
    throw new TypeError("answer must be present exactly when outputState is available and phase is succeeded.");
  }
  if (EARLY_PHASES.has(phase) && (row.cancellationRequested || row.termination !== "not_applicable"
    || outputState !== "not_ready" || answer !== null)) {
    throw new TypeError("prepared delivery phases require cancellation=false, termination=not_applicable, outputState=not_ready, and no answer.");
  }
  const delivery: CtoDelivery = Object.freeze({
    schemaVersion: 1,
    workspaceId: actualWorkspaceId,
    projectId: actualProjectId,
    ctoId: actualCtoId,
    revisionId,
    requestId: uuid(row.requestId, "requestId"),
    boardRevisionId,
    instruction,
    requestedBy,
    executionPolicy,
    createdAt,
    phase,
    runId,
    cancellationRequested: row.cancellationRequested,
    termination: row.termination,
    outputState,
    answer,
  });
  assertSafeStrings(delivery, "delivery");
  if (delivery.requestId !== requestIdForInstruction(expectedWorkspaceId, expectedProjectId, expectedCtoId, instruction)) {
    throw new TypeError("requestId does not match the deterministic instruction identity.");
  }
  if (encoder.encode(JSON.stringify(delivery)).byteLength > MAX_DELIVERY_BYTES) throw new TypeError(`ctoDelivery exceeds the ${MAX_DELIVERY_BYTES}-byte limit.`);
  return delivery;
}
