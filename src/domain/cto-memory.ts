const encoder = new TextEncoder();
const MAX_ID_LENGTH = 160;
const MAX_ENTRIES = 128;
const MAX_TEXT_BYTES = 4_096;
const MAX_SOURCE_REQUESTS_PER_ENTRY = 32;
const MAX_MEMORY_BYTES = 128 * 1_024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ENTRY_KINDS = ["context", "decision", "assumption", "open-question"] as const;

export type CtoMemoryRevision = Readonly<{
  projectId: string;
  ctoId: string;
  revisionId: string;
  entries: readonly Readonly<{
    id: string;
    kind: typeof ENTRY_KINDS[number];
    text: string;
    sourceRequestIds: readonly string[];
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

function list(value: unknown, maximum: number, label: string, minimum = 0): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${label} must be a standard array.`);
  const keys = Reflect.ownKeys(value);
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (typeof length !== "number" || !Number.isInteger(length) || length < minimum || length > maximum) {
    throw new TypeError(`${label} must contain ${minimum} through ${maximum} entries.`);
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

function validUnicode(value: string, label: string): void {
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
  validUnicode(value, label);
  if (!value.trim() || value.length > MAX_ID_LENGTH || /\p{Cc}/u.test(value)) {
    throw new TypeError(`${label} must be a nonblank identifier of at most ${MAX_ID_LENGTH} characters without controls.`);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${label} must be a canonical lowercase UUID.`);
  return value;
}

function memoryText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be nonblank text of at most ${MAX_TEXT_BYTES} UTF-8 bytes.`);
  validUnicode(value, label);
  if (!value.trim() || encoder.encode(value).byteLength > MAX_TEXT_BYTES
    || /\p{Cc}/u.test(value.replace(/[\t\r\n]/gu, ""))) {
    throw new TypeError(`${label} must be nonblank, control-safe text of at most ${MAX_TEXT_BYTES} UTF-8 bytes.`);
  }
  return value;
}

export function parseCtoMemoryRevision(value: unknown, expectedProjectId: string, expectedCtoId: string): CtoMemoryRevision {
  const projectScope = identifier(expectedProjectId, "expectedProjectId");
  const ctoScope = identifier(expectedCtoId, "expectedCtoId");
  const row = record(value, ["projectId", "ctoId", "revisionId", "entries"], "ctoMemoryRevision");
  const projectId = identifier(row.projectId, "ctoMemoryRevision.projectId");
  const ctoId = identifier(row.ctoId, "ctoMemoryRevision.ctoId");
  if (projectId !== projectScope) throw new TypeError("ctoMemoryRevision.projectId does not match the expected project.");
  if (ctoId !== ctoScope) throw new TypeError("ctoMemoryRevision.ctoId does not match the expected CTO.");
  const revisionId = identifier(row.revisionId, "ctoMemoryRevision.revisionId");
  const seenIds = new Set<string>();
  const entries = list(row.entries, MAX_ENTRIES, "ctoMemoryRevision.entries").map((item, index) => {
    const label = `ctoMemoryRevision.entries[${index}]`;
    const entry = record(item, ["id", "kind", "text", "sourceRequestIds"], label);
    const id = identifier(entry.id, `${label}.id`);
    if (seenIds.has(id)) throw new TypeError(`${label}.id is duplicated.`);
    seenIds.add(id);
    if (typeof entry.kind !== "string" || !(ENTRY_KINDS as readonly string[]).includes(entry.kind)) {
      throw new TypeError(`${label}.kind is unsupported.`);
    }
    const text = memoryText(entry.text, `${label}.text`);
    const sourceRequestIds = list(entry.sourceRequestIds, MAX_SOURCE_REQUESTS_PER_ENTRY,
      `${label}.sourceRequestIds`, 1).map((sourceId, sourceIndex) => uuid(sourceId, `${label}.sourceRequestIds[${sourceIndex}]`));
    if (new Set(sourceRequestIds).size !== sourceRequestIds.length) throw new TypeError(`${label}.sourceRequestIds contains duplicate UUIDs.`);
    return Object.freeze({ id, kind: entry.kind as CtoMemoryRevision["entries"][number]["kind"], text,
      sourceRequestIds: Object.freeze(sourceRequestIds) });
  });
  const snapshot: CtoMemoryRevision = Object.freeze({ projectId, ctoId, revisionId, entries: Object.freeze(entries) });
  if (encoder.encode(JSON.stringify(snapshot)).byteLength > MAX_MEMORY_BYTES) {
    throw new TypeError(`ctoMemoryRevision exceeds the ${MAX_MEMORY_BYTES}-byte JSON limit.`);
  }
  return snapshot;
}
