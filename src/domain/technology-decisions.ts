export type TechnologyDecisionEntry = Readonly<{
  id: string;
  technology: string;
  disposition: "required" | "allowed" | "prohibited" | "undecided";
  selectionReason: string;
  nonSelectionReason: string;
  scopeNodeIds: readonly string[];
  interoperability: readonly string[];
  constraints: readonly string[];
  cost: string;
  versionCompatibility: string;
  changeApprovalOwner: string;
  licenseReview: Readonly<{
    status: "unreviewed" | "reported-reviewed";
    licenseExpression: string | null;
    evidenceRefs: readonly string[];
  }>;
  verification: Readonly<{
    level: "not-verified" | "documentation-only" | "reported-integration-test";
    evidenceRefs: readonly string[];
    limitations: string;
    nextReviewCondition: string;
  }>;
}>;

export type TechnologyDecisionRegister = Readonly<{
  projectId: string;
  revisionId: string;
  sourceBaselineRevisionId: string;
  sourceSpecRevisionId: string;
  sourceGraphRevisionId: string;
  entries: readonly TechnologyDecisionEntry[];
}>;

const encoder = new TextEncoder();
const MAX_ID_BYTES = 160;
const MAX_TEXT_BYTES = 4096;
const MAX_REGISTER_BYTES = 128 * 1024;
const DISPOSITIONS = new Set(["required", "allowed", "prohibited", "undecided"]);
const LICENSE_STATUSES = new Set(["unreviewed", "reported-reviewed"]);
const VERIFICATION_LEVELS = new Set(["not-verified", "documentation-only", "reported-integration-test"]);

function record(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain record.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain record.`);

  const keys = Reflect.ownKeys(value);
  const allowed = new Set(fields);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError(`${label} has unknown or missing fields.`);
  }

  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data field.`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function list(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be a standard array.`);
  }
  const keys = Reflect.ownKeys(value);
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (typeof length !== "number" || !Number.isInteger(length) || length > maximum
    || keys.length !== length + 1 || !keys.includes("length")) {
    throw new TypeError(`${label} must be a dense array with at most ${maximum} entries.`);
  }

  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label} must contain only dense data fields.`);
    }
    items.push(descriptor.value);
  }
  return items;
}

function text(value: unknown, label: string, maximum = MAX_TEXT_BYTES, allowBlank = false): string {
  if (typeof value !== "string" || (!allowBlank && value.trim().length === 0)
    || encoder.encode(value).byteLength > maximum) {
    throw new TypeError(`${label} must be ${allowBlank ? "text" : "nonblank text"} of at most ${maximum} UTF-8 bytes.`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_ID_BYTES
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a nonblank ID of at most ${MAX_ID_BYTES} characters without ASCII control characters.`);
  }
  return value;
}

function textList(value: unknown, label: string): readonly string[] {
  const items = list(value, 32, label).map((item, index) => text(item, `${label}[${index}]`));
  if (new Set(items).size !== items.length) throw new TypeError(`${label} must not contain duplicates.`);
  return Object.freeze(items);
}

function identifierList(value: unknown, maximum: number, label: string): readonly string[] {
  const items = list(value, maximum, label).map((item, index) => identifier(item, `${label}[${index}]`));
  if (new Set(items).size !== items.length) throw new TypeError(`${label} must not contain duplicates.`);
  return Object.freeze(items);
}

function parseEntry(value: unknown, index: number): TechnologyDecisionEntry {
  const label = `entries[${index}]`;
  const row = record(value, [
    "id", "technology", "disposition", "selectionReason", "nonSelectionReason", "scopeNodeIds",
    "interoperability", "constraints", "cost", "versionCompatibility", "changeApprovalOwner",
    "licenseReview", "verification",
  ], label);
  const id = identifier(row.id, `${label}.id`);
  const technology = text(row.technology, `${label}.technology`, 512);
  if (typeof row.disposition !== "string" || !DISPOSITIONS.has(row.disposition)) {
    throw new TypeError(`${label}.disposition is unsupported.`);
  }
  const selectionReason = text(row.selectionReason, `${label}.selectionReason`, MAX_TEXT_BYTES, true);
  const nonSelectionReason = text(row.nonSelectionReason, `${label}.nonSelectionReason`, MAX_TEXT_BYTES, true);
  if (!selectionReason.trim() && !nonSelectionReason.trim()) {
    throw new TypeError(`${label} must include a selection or non-selection reason.`);
  }

  const license = record(row.licenseReview, ["status", "licenseExpression", "evidenceRefs"], `${label}.licenseReview`);
  if (typeof license.status !== "string" || !LICENSE_STATUSES.has(license.status)) {
    throw new TypeError(`${label}.licenseReview.status is unsupported.`);
  }
  const licenseEvidence = identifierList(license.evidenceRefs, 32, `${label}.licenseReview.evidenceRefs`);
  let licenseExpression: string | null;
  if (license.status === "unreviewed") {
    if (license.licenseExpression !== null) throw new TypeError(`${label}.licenseReview must not report an expression as reviewed.`);
    licenseExpression = null;
  } else {
    licenseExpression = text(license.licenseExpression, `${label}.licenseReview.licenseExpression`);
    if (licenseEvidence.length === 0) throw new TypeError(`${label}.licenseReview requires evidence for a reported review.`);
  }

  const verification = record(row.verification, ["level", "evidenceRefs", "limitations", "nextReviewCondition"], `${label}.verification`);
  if (typeof verification.level !== "string" || !VERIFICATION_LEVELS.has(verification.level)) {
    throw new TypeError(`${label}.verification.level is unsupported.`);
  }
  const verificationEvidence = identifierList(verification.evidenceRefs, 32, `${label}.verification.evidenceRefs`);
  if ((verification.level === "not-verified" && verificationEvidence.length !== 0)
    || (verification.level !== "not-verified" && verificationEvidence.length === 0)) {
    throw new TypeError(`${label}.verification evidence does not match its reported level.`);
  }

  return Object.freeze({
    id,
    technology,
    disposition: row.disposition as TechnologyDecisionEntry["disposition"],
    selectionReason,
    nonSelectionReason,
    scopeNodeIds: identifierList(row.scopeNodeIds, 128, `${label}.scopeNodeIds`),
    interoperability: textList(row.interoperability, `${label}.interoperability`),
    constraints: textList(row.constraints, `${label}.constraints`),
    cost: text(row.cost, `${label}.cost`),
    versionCompatibility: text(row.versionCompatibility, `${label}.versionCompatibility`),
    changeApprovalOwner: text(row.changeApprovalOwner, `${label}.changeApprovalOwner`),
    licenseReview: Object.freeze({
      status: license.status as TechnologyDecisionEntry["licenseReview"]["status"],
      licenseExpression,
      evidenceRefs: licenseEvidence,
    }),
    verification: Object.freeze({
      level: verification.level as TechnologyDecisionEntry["verification"]["level"],
      evidenceRefs: verificationEvidence,
      limitations: text(verification.limitations, `${label}.verification.limitations`),
      nextReviewCondition: text(verification.nextReviewCondition, `${label}.verification.nextReviewCondition`),
    }),
  });
}

/**
 * Validates and snapshots model-reported decisions only. Reported license and
 * verification evidence is not independently checked and grants no execution permission.
 */
export function parseTechnologyDecisionRegister(value: unknown, expectedProjectId: string): TechnologyDecisionRegister {
  const expectedId = identifier(expectedProjectId, "expectedProjectId");
  const row = record(value, [
    "projectId", "revisionId", "sourceBaselineRevisionId", "sourceSpecRevisionId", "sourceGraphRevisionId", "entries",
  ], "technologyDecisionRegister");
  const projectId = identifier(row.projectId, "technologyDecisionRegister.projectId");
  if (projectId !== expectedId) throw new TypeError("technologyDecisionRegister.projectId does not match the expected project.");

  const entries = list(row.entries, 128, "technologyDecisionRegister.entries").map(parseEntry);
  if (new Set(entries.map(entry => entry.id)).size !== entries.length
    || new Set(entries.map(entry => entry.technology)).size !== entries.length) {
    throw new TypeError("technologyDecisionRegister.entries contains duplicate IDs or technology labels.");
  }

  const result: TechnologyDecisionRegister = Object.freeze({
    projectId,
    revisionId: identifier(row.revisionId, "technologyDecisionRegister.revisionId"),
    sourceBaselineRevisionId: identifier(row.sourceBaselineRevisionId, "technologyDecisionRegister.sourceBaselineRevisionId"),
    sourceSpecRevisionId: identifier(row.sourceSpecRevisionId, "technologyDecisionRegister.sourceSpecRevisionId"),
    sourceGraphRevisionId: identifier(row.sourceGraphRevisionId, "technologyDecisionRegister.sourceGraphRevisionId"),
    entries: Object.freeze(entries),
  });
  if (encoder.encode(JSON.stringify(result)).byteLength > MAX_REGISTER_BYTES) {
    throw new TypeError(`technologyDecisionRegister exceeds the ${MAX_REGISTER_BYTES}-byte limit.`);
  }
  return result;
}
