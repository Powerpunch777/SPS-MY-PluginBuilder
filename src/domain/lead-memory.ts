export type LeadMemoryRevision = Readonly<{
  projectId: string;
  revisionId: string;
  entries: readonly Readonly<{
    id: string;
    kind: "goal" | "constraint" | "decision" | "assumption" | "open-question";
    text: string;
    sourceIds: readonly string[];
  }>[];
}>;

const encoder = new TextEncoder();
const MAX_ID = 160;
const MAX_ENTRIES = 128;
const MAX_TEXT_BYTES = 4096;
const MAX_SOURCE_IDS = 32;
const MAX_TOTAL_BYTES = 128 * 1024;
const ENTRY_KINDS = new Set(["goal", "constraint", "decision", "assumption", "open-question"]);
const SOURCE_ID = /^(?:consultation-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|lead-turn:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

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
  if (typeof length !== "number" || !Number.isInteger(length) || length > maximum) throw new TypeError(`${label} must have at most ${maximum} entries.`);
  if (keys.length !== length + 1 || !keys.includes("length")) throw new TypeError(`${label} must be dense and have no extra properties.`);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`${label} must contain dense data.`);
    result.push(descriptor.value);
  }
  return result;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_ID || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a nonempty identifier of at most ${MAX_ID} characters without ASCII controls.`);
  }
  return value;
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || encoder.encode(value).byteLength > MAX_TEXT_BYTES) {
    throw new TypeError(`${label} must be nonempty and at most ${MAX_TEXT_BYTES} UTF-8 bytes.`);
  }
  return value;
}

/** Validates shape and clones an immutable revision; source references are not resolved here. */
export function parseLeadMemoryRevision(value: unknown, expectedProjectId: string): LeadMemoryRevision {
  const expectedId = identifier(expectedProjectId, "expectedProjectId");
  const row = record(value, ["projectId", "revisionId", "entries"], "leadMemoryRevision");
  const projectId = identifier(row.projectId, "leadMemoryRevision.projectId");
  if (projectId !== expectedId) throw new TypeError("leadMemoryRevision.projectId does not match the expected project.");
  const revisionId = identifier(row.revisionId, "leadMemoryRevision.revisionId");
  const seenIds = new Set<string>();
  const entries = list(row.entries, MAX_ENTRIES, "leadMemoryRevision.entries").map((item, index) => {
    const label = `leadMemoryRevision.entries[${index}]`;
    const entry = record(item, ["id", "kind", "text", "sourceIds"], label);
    const id = identifier(entry.id, `${label}.id`);
    if (seenIds.has(id)) throw new TypeError(`${label}.id is duplicated.`);
    seenIds.add(id);
    if (typeof entry.kind !== "string" || !ENTRY_KINDS.has(entry.kind)) throw new TypeError(`${label}.kind is unsupported.`);
    const text = boundedText(entry.text, `${label}.text`);
    const sourceIds = list(entry.sourceIds, MAX_SOURCE_IDS, `${label}.sourceIds`).map((source, sourceIndex) => {
      const sourceId = identifier(source, `${label}.sourceIds[${sourceIndex}]`);
      if (!SOURCE_ID.test(sourceId)) throw new TypeError(`${label}.sourceIds[${sourceIndex}] has an unsupported source ID format.`);
      return sourceId;
    });
    if (sourceIds.length === 0) throw new TypeError(`${label}.sourceIds must contain at least one source ID.`);
    if (new Set(sourceIds).size !== sourceIds.length) throw new TypeError(`${label}.sourceIds contains duplicate IDs.`);
    return { id, kind: entry.kind as LeadMemoryRevision["entries"][number]["kind"], text, sourceIds };
  });
  const snapshot = { projectId, revisionId, entries };
  if (encoder.encode(JSON.stringify(snapshot)).byteLength > MAX_TOTAL_BYTES) {
    throw new TypeError(`leadMemoryRevision exceeds the ${MAX_TOTAL_BYTES}-byte validated JSON limit.`);
  }
  for (const entry of entries) {
    Object.freeze(entry.sourceIds);
    Object.freeze(entry);
  }
  Object.freeze(entries);
  return Object.freeze(snapshot);
}
