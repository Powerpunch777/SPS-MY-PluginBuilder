const encoder = new TextEncoder();
const MAX_ID_BYTES = 160;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_RECORD_BYTES = 128 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type ProjectDeliverableReference = Readonly<{ sourceId: string; revisionId: string }>;
export type ProjectDeliverableRequirement = Readonly<{
  id: string;
  description: string;
  sourceReferences: readonly ProjectDeliverableReference[];
}>;
export type ProjectDeliverableDocumentation = Readonly<{
  installation: string | null;
  usage: string | null;
  knownLimits: readonly string[] | null;
  sourceReferences: readonly ProjectDeliverableReference[];
}>;
export type ProjectDeliverableSource = Readonly<{
  workspaceId: string;
  projectId: string;
  revisionId: string;
  sourceRevision: Readonly<{ kind: "git-commit" | "source-manifest" | "other"; value: string }>;
  authoringReference: ProjectDeliverableReference;
  requirements: readonly ProjectDeliverableRequirement[];
  /** References only. This record does not create or assert a catalog entry. */
  catalogReferences: readonly ProjectDeliverableReference[];
  documentation: ProjectDeliverableDocumentation;
}>;

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a plain record.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain record.`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError(`${label} has unknown or missing fields.`);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`${label}.${key} must be a data field.`);
    result[key] = descriptor.value;
  }
  return result;
}

function list(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${label} must be a standard array.`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length") || value.length > maximum) {
    throw new TypeError(`${label} must be dense and have at most ${maximum} entries.`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`${label} must contain data fields.`);
    result.push(descriptor.value);
  }
  return result;
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_ID_BYTES || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a nonblank identifier of at most ${MAX_ID_BYTES} characters.`);
  }
  return value;
}

function text(value: unknown, label: string, allowMissing = false): string | null {
  if (allowMissing && value === null) return null;
  if (typeof value !== "string" || !value.trim() || encoder.encode(value).byteLength > MAX_TEXT_BYTES) {
    throw new TypeError(`${label} must be nonblank text of at most ${MAX_TEXT_BYTES} UTF-8 bytes${allowMissing ? " or null" : ""}.`);
  }
  return value;
}

function parseReference(value: unknown, label: string): ProjectDeliverableReference {
  const row = record(value, ["sourceId", "revisionId"], label);
  return Object.freeze({ sourceId: id(row.sourceId, `${label}.sourceId`), revisionId: id(row.revisionId, `${label}.revisionId`) });
}

function parseReferences(value: unknown, label: string): readonly ProjectDeliverableReference[] {
  const references = list(value, 128, label).map((item, index) => parseReference(item, `${label}[${index}]`));
  const keys = references.map(reference => `${reference.sourceId}\u0000${reference.revisionId}`);
  if (new Set(keys).size !== keys.length) throw new TypeError(`${label} must not contain duplicate references.`);
  return Object.freeze(references);
}

/**
 * Strictly snapshots project-authored G7 source material. This is a draft
 * record: parsing it does not establish source existence, user approval,
 * contract authority, QA, execution permission, or customer acceptance.
 */
export function parseProjectDeliverableSource(value: unknown, expectedWorkspaceId: string,
  expectedProjectId: string): ProjectDeliverableSource {
  if (typeof expectedWorkspaceId !== "string" || !UUID.test(expectedWorkspaceId)) throw new TypeError("A canonical Workspace ID is required.");
  const workspaceId = id(expectedWorkspaceId, "expectedWorkspaceId");
  const projectId = id(expectedProjectId, "expectedProjectId");
  const row = record(value, ["workspaceId", "projectId", "revisionId", "sourceRevision", "authoringReference", "requirements", "catalogReferences", "documentation"], "projectDeliverableSource");
  if (id(row.workspaceId, "workspaceId") !== workspaceId || id(row.projectId, "projectId") !== projectId) {
    throw new TypeError("Project deliverable source is outside the expected Workspace/project.");
  }
  const sourceRevision = record(row.sourceRevision, ["kind", "value"], "sourceRevision");
  if (!["git-commit", "source-manifest", "other"].includes(sourceRevision.kind as string)) throw new TypeError("sourceRevision.kind is unsupported.");
  const parsedSourceRevision = Object.freeze({
    kind: sourceRevision.kind as ProjectDeliverableSource["sourceRevision"]["kind"],
    value: id(sourceRevision.value, "sourceRevision.value"),
  });
  const requirements = list(row.requirements, 256, "requirements").map((item, index) => {
    const label = `requirements[${index}]`;
    const requirement = record(item, ["id", "description", "sourceReferences"], label);
    return Object.freeze({ id: id(requirement.id, `${label}.id`), description: text(requirement.description, `${label}.description`)!,
      sourceReferences: parseReferences(requirement.sourceReferences, `${label}.sourceReferences`) });
  });
  if (new Set(requirements.map(requirement => requirement.id)).size !== requirements.length) throw new TypeError("requirements must not contain duplicate IDs.");
  const documentation = record(row.documentation, ["installation", "usage", "knownLimits", "sourceReferences"], "documentation");
  let knownLimits: readonly string[] | null = null;
  if (documentation.knownLimits !== null) {
    knownLimits = Object.freeze(list(documentation.knownLimits, 64, "documentation.knownLimits")
      .map((item, index) => text(item, `documentation.knownLimits[${index}]`)!));
  }
  const parsed: ProjectDeliverableSource = Object.freeze({
    workspaceId,
    projectId,
    revisionId: id(row.revisionId, "revisionId"),
    sourceRevision: parsedSourceRevision,
    authoringReference: parseReference(row.authoringReference, "authoringReference"),
    requirements: Object.freeze(requirements),
    catalogReferences: parseReferences(row.catalogReferences, "catalogReferences"),
    documentation: Object.freeze({
      installation: text(documentation.installation, "documentation.installation", true),
      usage: text(documentation.usage, "documentation.usage", true),
      knownLimits,
      sourceReferences: parseReferences(documentation.sourceReferences, "documentation.sourceReferences"),
    }),
  });
  if (encoder.encode(JSON.stringify(parsed)).byteLength > MAX_RECORD_BYTES) throw new TypeError(`projectDeliverableSource exceeds ${MAX_RECORD_BYTES} UTF-8 bytes.`);
  return parsed;
}
