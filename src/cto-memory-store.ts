import { createHash } from "node:crypto";
import type { RevisionState } from "./solution-revision-store.ts";
import { createRevisionJournal } from "./solution-revision-store.ts";
import { parseCtoMemoryRevision, type CtoMemoryRevision } from "./domain/cto-memory.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const MAX_ID_LENGTH = 160;
const MAX_SOURCE_DIGESTS = 128;
const MAX_AUTHORED_BYTES = 192 * 1_024;
const encoder = new TextEncoder();

export type AuthoredCtoMemory = Readonly<{
  memory: CtoMemoryRevision;
  author: Readonly<{ agentId: string; sessionId: string; runId: string }>;
  createdAt: string;
  sourceDigests: readonly Readonly<{
    requestId: string;
    workstreamId: string;
    specRevision: number;
    sha256: string;
  }>[];
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
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`${label}.${key} must be an enumerable data field.`);
    result[key] = descriptor.value;
  }
  return result;
}

function list(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${label} must be a standard array.`);
  const keys = Reflect.ownKeys(value);
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (typeof length !== "number" || !Number.isInteger(length) || length > maximum) {
    throw new TypeError(`${label} must have at most ${maximum} entries.`);
  }
  if (keys.length !== length + 1 || !keys.includes("length")) throw new TypeError(`${label} must be dense and have no extra properties.`);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`${label} must contain dense data fields.`);
    result.push(descriptor.value);
  }
  return result;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${label} must be a canonical lowercase UUID.`);
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_ID_LENGTH || /\p{Cc}/u.test(value)
    || value.includes("\ufffd")) throw new TypeError(`${label} must be a nonblank identifier of at most ${MAX_ID_LENGTH} characters without controls.`);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`${label} contains an unpaired surrogate.`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError(`${label} contains an unpaired surrogate.`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer.`);
  return value;
}

function canonicalIso(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("createdAt must be a canonical ISO timestamp.");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new TypeError("createdAt must be a canonical ISO timestamp.");
  return value;
}

function parseAuthoredCtoMemory(value: unknown, projectId: string, ctoId: string): AuthoredCtoMemory {
  const row = record(value, ["memory", "author", "createdAt", "sourceDigests"], "authoredCtoMemory");
  const memory = parseCtoMemoryRevision(row.memory, projectId, ctoId);
  const authorRow = record(row.author, ["agentId", "sessionId", "runId"], "authoredCtoMemory.author");
  const author = Object.freeze({
    agentId: uuid(authorRow.agentId, "author.agentId"),
    sessionId: uuid(authorRow.sessionId, "author.sessionId"),
    runId: uuid(authorRow.runId, "author.runId"),
  });
  const createdAt = canonicalIso(row.createdAt);
  const expectedRequestIds = new Set(memory.entries.flatMap(entry => entry.sourceRequestIds));
  if (expectedRequestIds.size > MAX_SOURCE_DIGESTS) {
    throw new TypeError(`A CTO memory revision may cite at most ${MAX_SOURCE_DIGESTS} unique source requests.`);
  }
  const sourceRows = list(row.sourceDigests, MAX_SOURCE_DIGESTS, "sourceDigests");
  if (sourceRows.length !== expectedRequestIds.size) throw new TypeError("sourceDigests must exactly cover unique memory source request IDs.");
  const seenRequestIds = new Set<string>();
  const sourceDigests = sourceRows.map((item, index) => {
    const label = `sourceDigests[${index}]`;
    const source = record(item, ["requestId", "workstreamId", "specRevision", "sha256"], label);
    const requestId = uuid(source.requestId, `${label}.requestId`);
    if (seenRequestIds.has(requestId)) throw new TypeError(`${label}.requestId is duplicated.`);
    seenRequestIds.add(requestId);
    if (!expectedRequestIds.has(requestId)) throw new TypeError(`${label}.requestId is not cited by memory entries.`);
    const workstreamId = identifier(source.workstreamId, `${label}.workstreamId`);
    const specRevision = positiveSafeInteger(source.specRevision, `${label}.specRevision`);
    if (typeof source.sha256 !== "string" || !DIGEST.test(source.sha256)) throw new TypeError(`${label}.sha256 must be 64 lowercase hexadecimal characters.`);
    return Object.freeze({ requestId, workstreamId, specRevision, sha256: source.sha256 });
  });
  for (const requestId of expectedRequestIds) {
    if (!seenRequestIds.has(requestId)) throw new TypeError("sourceDigests is missing a cited source request ID.");
  }
  const authored: AuthoredCtoMemory = Object.freeze({ memory, author, createdAt, sourceDigests: Object.freeze(sourceDigests) });
  if (encoder.encode(JSON.stringify(authored)).byteLength > MAX_AUTHORED_BYTES) {
    throw new TypeError(`authoredCtoMemory exceeds the ${MAX_AUTHORED_BYTES}-byte JSON limit.`);
  }
  return authored;
}

export function createCtoMemoryStore(workspaceId: string, projectId: string, ctoId: string, state: RevisionState) {
  const lane = createHash("sha256").update(JSON.stringify([projectId, ctoId]), "utf8").digest("hex");
  return createRevisionJournal(workspaceId, `cto:${lane}`, state, {
    prefix: "cto-memory",
    parse: value => parseAuthoredCtoMemory(value, projectId, ctoId),
    revisionId: value => value.memory.revisionId,
  });
}
