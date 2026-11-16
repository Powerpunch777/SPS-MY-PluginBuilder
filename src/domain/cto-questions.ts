const encoder = new TextEncoder();
const MAX_ID_LENGTH = 160;
const MAX_TEXT_BYTES = 4_096;
const MAX_TITLE_BYTES = 512;
const MAX_PROPOSAL_BYTES = 32 * 1_024;
const MAX_BOARD_BYTES = 192 * 1_024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DISPOSITIONS = ["existing-specification", "delegated-choice", "user-decision-needed"] as const;

export type CtoQuestionProposal = Readonly<{
  id: string;
  title: string;
  context: string;
  reasonNeeded: string;
  options: readonly Readonly<{ id: string; label: string; tradeoff: string }>[];
  recommendation: string | null;
  delayImpact: string;
  scopeNodeIds: readonly string[];
  evidenceRefs: readonly string[];
}>;

export type CtoQuestionRecord = Readonly<{
  proposal: CtoQuestionProposal;
  reporter: Readonly<{
    ctoId: string;
    agentId: string;
    sessionId: string;
    runId: string;
    requestId: string;
    workstreamId: string;
    specRevision: number;
    instructionSha256: string;
  }>;
  createdAtISO: string;
  review: null | Readonly<{
    reviewId: string;
    reviewer: Readonly<{ agentId: string; sessionId: string; runId: string; selectionRevision: number }>;
    disposition: typeof DISPOSITIONS[number];
    rationale: string;
    evidenceRefs: readonly string[];
    createdAtISO: string;
  }>;
}>;

export type CtoQuestionBoard = Readonly<{
  projectId: string;
  revisionId: string;
  questions: readonly CtoQuestionRecord[];
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
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`${label} must contain dense data fields.`);
    items.push(descriptor.value);
  }
  return items;
}

function safeUnicode(value: string, label: string): void {
  if (value.includes("\ufffd")) throw new TypeError(`${label} must not contain the Unicode replacement character.`);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`${label} contains an unpaired surrogate.`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError(`${label} contains an unpaired surrogate.`);
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

function text(value: unknown, label: string, maximum = MAX_TEXT_BYTES): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be nonblank text of at most ${maximum} UTF-8 bytes.`);
  safeUnicode(value, label);
  if (!value.trim() || encoder.encode(value).byteLength > maximum || /\p{Cc}/u.test(value.replace(/[\t\r\n]/gu, ""))) {
    throw new TypeError(`${label} must be nonblank, control-safe text of at most ${maximum} UTF-8 bytes.`);
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

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  safeUnicode(value, label);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  return value;
}

function uniqueIdentifiers(value: unknown, minimum: number, maximum: number, label: string): readonly string[] {
  const values = list(value, minimum, maximum, label).map((item, index) => identifier(item, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new TypeError(`${label} must contain unique identifiers.`);
  return Object.freeze(values);
}

export function parseCtoQuestionProposal(value: unknown): CtoQuestionProposal {
  const row = record(value, ["id", "title", "context", "reasonNeeded", "options", "recommendation", "delayImpact", "scopeNodeIds", "evidenceRefs"], "ctoQuestionProposal");
  const id = identifier(row.id, "ctoQuestionProposal.id");
  const title = text(row.title, "ctoQuestionProposal.title", MAX_TITLE_BYTES);
  const context = text(row.context, "ctoQuestionProposal.context");
  const reasonNeeded = text(row.reasonNeeded, "ctoQuestionProposal.reasonNeeded");
  const optionIds = new Set<string>();
  const options = list(row.options, 2, 8, "ctoQuestionProposal.options").map((item, index) => {
    const label = `ctoQuestionProposal.options[${index}]`;
    const option = record(item, ["id", "label", "tradeoff"], label);
    const optionId = identifier(option.id, `${label}.id`);
    if (optionIds.has(optionId)) throw new TypeError(`${label}.id is duplicated.`);
    optionIds.add(optionId);
    return Object.freeze({ id: optionId, label: text(option.label, `${label}.label`), tradeoff: text(option.tradeoff, `${label}.tradeoff`) });
  });
  const recommendation = row.recommendation === null ? null : identifier(row.recommendation, "ctoQuestionProposal.recommendation");
  if (recommendation !== null && !optionIds.has(recommendation)) {
    throw new TypeError("ctoQuestionProposal.recommendation must match an option ID or be null.");
  }
  const delayImpact = text(row.delayImpact, "ctoQuestionProposal.delayImpact");
  const scopeNodeIds = uniqueIdentifiers(row.scopeNodeIds, 1, 64, "ctoQuestionProposal.scopeNodeIds");
  const evidenceRefs = uniqueIdentifiers(row.evidenceRefs, 0, 32, "ctoQuestionProposal.evidenceRefs");
  const proposal: CtoQuestionProposal = Object.freeze({ id, title, context, reasonNeeded, options: Object.freeze(options), recommendation,
    delayImpact, scopeNodeIds, evidenceRefs });
  if (encoder.encode(JSON.stringify(proposal)).byteLength > MAX_PROPOSAL_BYTES) {
    throw new TypeError(`ctoQuestionProposal exceeds the ${MAX_PROPOSAL_BYTES}-byte JSON limit.`);
  }
  return proposal;
}

function reviewer(value: unknown, label: string) {
  const row = record(value, ["agentId", "sessionId", "runId", "selectionRevision"], label);
  return Object.freeze({ agentId: uuid(row.agentId, `${label}.agentId`), sessionId: uuid(row.sessionId, `${label}.sessionId`),
    runId: uuid(row.runId, `${label}.runId`), selectionRevision: positiveInteger(row.selectionRevision, `${label}.selectionRevision`) });
}

function questionRecord(value: unknown, projectId: string, index: number): CtoQuestionRecord {
  const label = `ctoQuestionBoard.questions[${index}]`;
  const row = record(value, ["proposal", "reporter", "createdAtISO", "review"], label);
  const proposal = parseCtoQuestionProposal(row.proposal);
  const reporterRow = record(row.reporter,
    ["ctoId", "agentId", "sessionId", "runId", "requestId", "workstreamId", "specRevision", "instructionSha256"], `${label}.reporter`);
  const reporter = Object.freeze({ ctoId: identifier(reporterRow.ctoId, `${label}.reporter.ctoId`),
    agentId: uuid(reporterRow.agentId, `${label}.reporter.agentId`), sessionId: uuid(reporterRow.sessionId, `${label}.reporter.sessionId`),
    runId: uuid(reporterRow.runId, `${label}.reporter.runId`), requestId: uuid(reporterRow.requestId, `${label}.reporter.requestId`),
    workstreamId: identifier(reporterRow.workstreamId, `${label}.reporter.workstreamId`),
    specRevision: positiveInteger(reporterRow.specRevision, `${label}.reporter.specRevision`),
    instructionSha256: typeof reporterRow.instructionSha256 === "string" && /^[0-9a-f]{64}$/u.test(reporterRow.instructionSha256)
      ? reporterRow.instructionSha256 : (() => { throw new TypeError(`${label}.reporter.instructionSha256 must be 64 lowercase hexadecimal characters.`); })() });
  const createdAtISO = isoTimestamp(row.createdAtISO, `${label}.createdAtISO`);
  let review: CtoQuestionRecord["review"] = null;
  if (row.review !== null) {
    const reviewRow = record(row.review, ["reviewId", "reviewer", "disposition", "rationale", "evidenceRefs", "createdAtISO"], `${label}.review`);
    if (typeof reviewRow.disposition !== "string" || !(DISPOSITIONS as readonly string[]).includes(reviewRow.disposition)) {
      throw new TypeError(`${label}.review.disposition is unsupported.`);
    }
    review = Object.freeze({ reviewId: identifier(reviewRow.reviewId, `${label}.review.reviewId`),
      reviewer: reviewer(reviewRow.reviewer, `${label}.review.reviewer`), disposition: reviewRow.disposition as typeof DISPOSITIONS[number],
      rationale: text(reviewRow.rationale, `${label}.review.rationale`),
      evidenceRefs: uniqueIdentifiers(reviewRow.evidenceRefs, 0, 32, `${label}.review.evidenceRefs`),
      createdAtISO: isoTimestamp(reviewRow.createdAtISO, `${label}.review.createdAtISO`) });
  }
  return Object.freeze({ proposal, reporter, createdAtISO, review });
}

/** Reporter and reviewer identity/digest fields are shape checks, not authority attestations. */
export function parseCtoQuestionBoard(value: unknown, expectedProjectId: string): CtoQuestionBoard {
  const projectScope = identifier(expectedProjectId, "expectedProjectId");
  const row = record(value, ["projectId", "revisionId", "questions"], "ctoQuestionBoard");
  const projectId = identifier(row.projectId, "ctoQuestionBoard.projectId");
  if (projectId !== projectScope) throw new TypeError("ctoQuestionBoard.projectId does not match the expected project.");
  const revisionId = identifier(row.revisionId, "ctoQuestionBoard.revisionId");
  const seenIds = new Set<string>();
  const questions = list(row.questions, 0, 64, "ctoQuestionBoard.questions").map((item, index) => {
    const question = questionRecord(item, projectId, index);
    if (seenIds.has(question.proposal.id)) throw new TypeError(`ctoQuestionBoard.questions[${index}].proposal.id is duplicated.`);
    seenIds.add(question.proposal.id);
    return question;
  });
  const board: CtoQuestionBoard = Object.freeze({ projectId, revisionId, questions: Object.freeze(questions) });
  if (encoder.encode(JSON.stringify(board)).byteLength > MAX_BOARD_BYTES) {
    throw new TypeError(`ctoQuestionBoard exceeds the ${MAX_BOARD_BYTES}-byte JSON limit.`);
  }
  return board;
}
