import { createHash } from "node:crypto";
import { parseCtoQuestionBoard, type CtoQuestionRecord } from "./cto-questions.ts";

const encoder = new TextEncoder();
const MAX_ID_LENGTH = 160;
const MAX_REPLY_BYTES = 96 * 1_024;
const MAX_ANSWER_BYTES = 8_192;
const MAX_UNDERSTANDING_BYTES = 4_096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REPLY_TOOL_NAMES = ["builder.acknowledge-cto-question-answer", "builder.read-cto-question-answer"] as const;
const FIELDS = ["schemaVersion", "workspaceId", "projectId", "questionId", "revisionId", "requestId", "question", "answer",
  "createdAtISO", "executionPolicy", "phase", "runId", "cancellationRequested", "termination", "acknowledgement"] as const;
const PHASES = ["prepared", "dispatching", "uncertain", "superseded", "submitted", "succeeded", "failed", "cancelled", "interrupted", "timed_out"] as const;
const EARLY_PHASES = new Set<string>(["prepared", "dispatching", "uncertain", "superseded"]);
const REPLY_DISPOSITIONS = new Set(["existing-specification", "delegated-choice"]);

export type CtoQuestionReplyAnswer = Readonly<{
  text: string;
  selectedOptionId: string | null;
  evidenceRefs: readonly string[];
}>;
export type CtoQuestionReplyExecutionPolicy = Readonly<{
  mode: "plugin-tools-only-v1";
  toolNames: typeof REPLY_TOOL_NAMES;
}>;
export const CTO_QUESTION_REPLY_EXECUTION_POLICY: CtoQuestionReplyExecutionPolicy = Object.freeze({
  mode: "plugin-tools-only-v1",
  toolNames: Object.freeze([...REPLY_TOOL_NAMES]) as unknown as typeof REPLY_TOOL_NAMES,
});

export type CtoQuestionReply = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  projectId: string;
  questionId: string;
  revisionId: string;
  requestId: string;
  question: CtoQuestionRecord;
  answer: CtoQuestionReplyAnswer;
  createdAtISO: string;
  executionPolicy: CtoQuestionReplyExecutionPolicy;
  phase: typeof PHASES[number];
  runId: string | null;
  cancellationRequested: boolean;
  termination: "not_applicable" | "pending" | "confirmed";
  acknowledgement: null | Readonly<{
    agentId: string;
    sessionId: string;
    runId: string;
    requestId: string;
    createdAtISO: string;
    understanding: string;
  }>;
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

function list(value: unknown, minimum: number, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${label} must be a standard array.`);
  const keys = Reflect.ownKeys(value);
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (typeof length !== "number" || !Number.isInteger(length) || length < minimum || length > maximum) {
    throw new TypeError(`${label} must contain ${minimum} through ${maximum} entries.`);
  }
  if (keys.length !== length + 1 || !keys.includes("length")) throw new TypeError(`${label} must be dense and have no extra properties.`);
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`${label} must contain dense data fields.`);
    values.push(descriptor.value);
  }
  return values;
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

function boundedText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be nonblank text of at most ${maximum} UTF-8 bytes.`);
  safeUnicode(value, label);
  if (!value.trim() || encoder.encode(value).byteLength > maximum || /\p{Cc}/u.test(value.replace(/[\t\r\n]/gu, ""))) {
    throw new TypeError(`${label} must be nonblank, control-safe text of at most ${maximum} UTF-8 bytes.`);
  }
  return value;
}

function canonicalIso(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  safeUnicode(value, label);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  return value;
}

function questionRecord(value: unknown, projectId: string, expectedQuestionId?: string): CtoQuestionRecord {
  const parsed = parseCtoQuestionBoard({ projectId, revisionId: "cto-question-reply-question", questions: [value] }, projectId).questions[0];
  if (!parsed) throw new TypeError("question must contain one CtoQuestionRecord.");
  if (expectedQuestionId !== undefined && parsed.proposal.id !== expectedQuestionId) {
    throw new TypeError("question.proposal.id does not match questionId.");
  }
  if (!parsed.review || !REPLY_DISPOSITIONS.has(parsed.review.disposition)) {
    throw new TypeError("question.review must be Lead-reviewed as existing-specification or delegated-choice.");
  }
  return parsed;
}

function answerRecord(value: unknown, question: CtoQuestionRecord): CtoQuestionReplyAnswer {
  const row = record(value, ["text", "selectedOptionId", "evidenceRefs"], "answer");
  const text = boundedText(row.text, MAX_ANSWER_BYTES, "answer.text");
  const selectedOptionId = row.selectedOptionId === null ? null : identifier(row.selectedOptionId, "answer.selectedOptionId");
  if (selectedOptionId !== null && !question.proposal.options.some(option => option.id === selectedOptionId)) {
    throw new TypeError("answer.selectedOptionId must match a question option ID or be null.");
  }
  const evidenceRefs = list(row.evidenceRefs, 1, 32, "answer.evidenceRefs").map((item, index) => identifier(item, `answer.evidenceRefs[${index}]`));
  if (new Set(evidenceRefs).size !== evidenceRefs.length) throw new TypeError("answer.evidenceRefs must contain unique identifiers.");
  return Object.freeze({ text, selectedOptionId, evidenceRefs: Object.freeze(evidenceRefs) });
}

function parseExecutionPolicy(value: unknown): CtoQuestionReplyExecutionPolicy {
  const row = record(value, ["mode", "toolNames"], "executionPolicy");
  if (row.mode !== "plugin-tools-only-v1") throw new TypeError("executionPolicy.mode is unsupported.");
  const names = list(row.toolNames, REPLY_TOOL_NAMES.length, REPLY_TOOL_NAMES.length, "executionPolicy.toolNames");
  if (names.some((name, index) => name !== REPLY_TOOL_NAMES[index])) throw new TypeError("executionPolicy.toolNames must exactly match the canonical reply policy.");
  return Object.freeze({ mode: "plugin-tools-only-v1", toolNames: Object.freeze([...REPLY_TOOL_NAMES]) as unknown as typeof REPLY_TOOL_NAMES });
}

function parseQuestionAndAnswer(projectId: string, question: unknown, answer: unknown): Readonly<{ question: CtoQuestionRecord; answer: CtoQuestionReplyAnswer }> {
  const canonicalQuestion = questionRecord(question, projectId);
  return Object.freeze({ question: canonicalQuestion, answer: answerRecord(answer, canonicalQuestion) });
}

function requestIdFor(workspaceId: string, projectId: string, question: CtoQuestionRecord, answer: CtoQuestionReplyAnswer): string {
  const tuple = JSON.stringify(["sps-builder-cto-question-reply-v1", workspaceId, projectId, question, answer]);
  const hash = createHash("sha256").update(tuple, "utf8").digest("hex").slice(0, 32).split("");
  hash[12] = "8";
  hash[16] = ((Number.parseInt(hash[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const hex = hash.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function ctoQuestionReplyRequestId(workspaceId: string, projectId: string, question: CtoQuestionRecord, answer: unknown): string {
  const scopeWorkspaceId = uuid(workspaceId, "workspaceId");
  const scopeProjectId = identifier(projectId, "projectId");
  const canonical = parseQuestionAndAnswer(scopeProjectId, question, answer);
  return requestIdFor(scopeWorkspaceId, scopeProjectId, canonical.question, canonical.answer);
}

export function parseCtoQuestionReply(value: unknown, workspaceId: string, projectId: string, questionId: string): CtoQuestionReply {
  const expectedWorkspaceId = uuid(workspaceId, "workspaceId");
  const expectedProjectId = identifier(projectId, "projectId");
  const expectedQuestionId = identifier(questionId, "questionId");
  const row = record(value, FIELDS, "ctoQuestionReply");
  if (row.schemaVersion !== 1) throw new TypeError("schemaVersion must be 1.");
  const actualWorkspaceId = uuid(row.workspaceId, "workspaceId");
  const actualProjectId = identifier(row.projectId, "projectId");
  const actualQuestionId = identifier(row.questionId, "questionId");
  if (actualWorkspaceId !== expectedWorkspaceId || actualProjectId !== expectedProjectId || actualQuestionId !== expectedQuestionId) {
    throw new TypeError("reply workspace, project, and question must match the expected scope.");
  }
  const revisionId = identifier(row.revisionId, "revisionId");
  const question = questionRecord(row.question, actualProjectId, actualQuestionId);
  const answer = answerRecord(row.answer, question);
  const createdAtISO = canonicalIso(row.createdAtISO, "createdAtISO");
  const executionPolicy = parseExecutionPolicy(row.executionPolicy);
  if (typeof row.phase !== "string" || !(PHASES as readonly string[]).includes(row.phase)) throw new TypeError("phase is unsupported.");
  const phase = row.phase as CtoQuestionReply["phase"];
  const runId = row.runId === null ? null : uuid(row.runId, "runId");
  if (EARLY_PHASES.has(phase) ? runId !== null : runId === null) throw new TypeError("runId does not match phase.");
  if (typeof row.cancellationRequested !== "boolean") throw new TypeError("cancellationRequested must be a boolean.");
  if (row.termination !== "not_applicable" && row.termination !== "pending" && row.termination !== "confirmed") {
    throw new TypeError("termination is unsupported.");
  }
  if (EARLY_PHASES.has(phase)) {
    if (row.cancellationRequested || row.termination !== "not_applicable") {
      throw new TypeError("early reply phases require cancellation=false and termination=not_applicable.");
    }
  } else if (!row.cancellationRequested ? row.termination !== "not_applicable" : row.termination === "not_applicable") {
    throw new TypeError("termination does not match cancellationRequested.");
  }
  let acknowledgement: CtoQuestionReply["acknowledgement"] = null;
  if (row.acknowledgement !== null) {
    if (EARLY_PHASES.has(phase)) throw new TypeError("early reply phases cannot contain an acknowledgement.");
    const ack = record(row.acknowledgement, ["agentId", "sessionId", "runId", "requestId", "createdAtISO", "understanding"], "acknowledgement");
    const agentId = uuid(ack.agentId, "acknowledgement.agentId");
    const sessionId = uuid(ack.sessionId, "acknowledgement.sessionId");
    const acknowledgementRunId = uuid(ack.runId, "acknowledgement.runId");
    const acknowledgementRequestId = uuid(ack.requestId, "acknowledgement.requestId");
    if (agentId !== question.reporter.agentId || sessionId !== question.reporter.sessionId
      || acknowledgementRunId !== runId || acknowledgementRequestId !== row.requestId) {
      throw new TypeError("acknowledgement identity must match the reporting CTO and exact reply run/request.");
    }
    acknowledgement = Object.freeze({ agentId, sessionId, runId: acknowledgementRunId, requestId: acknowledgementRequestId,
      createdAtISO: canonicalIso(ack.createdAtISO, "acknowledgement.createdAtISO"),
      understanding: boundedText(ack.understanding, MAX_UNDERSTANDING_BYTES, "acknowledgement.understanding") });
  }
  const reply: CtoQuestionReply = Object.freeze({ schemaVersion: 1, workspaceId: actualWorkspaceId, projectId: actualProjectId,
    questionId: actualQuestionId, revisionId, requestId: uuid(row.requestId, "requestId"), question, answer, createdAtISO,
    executionPolicy, phase, runId, cancellationRequested: row.cancellationRequested, termination: row.termination, acknowledgement });
  if (reply.requestId !== requestIdFor(expectedWorkspaceId, expectedProjectId, question, answer)) {
    throw new TypeError("requestId does not match the deterministic question and answer identity.");
  }
  if (encoder.encode(JSON.stringify(reply)).byteLength > MAX_REPLY_BYTES) throw new TypeError(`ctoQuestionReply exceeds the ${MAX_REPLY_BYTES}-byte JSON limit.`);
  return reply;
}
