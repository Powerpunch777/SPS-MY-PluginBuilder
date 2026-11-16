/** Pure validation for the v15 conceptual ApprovedSpecRevision contract. */

export const PRODUCT_TIERS = ["S", "M", "L", "XL"] as const;
export const DELIVERY_TARGETS = [
  "sps-plugin",
  "desktop",
  "web-api",
  "cli-automation",
  "agent-workflow",
  "hybrid",
] as const;

export type ProductTier = typeof PRODUCT_TIERS[number];
export type DeliveryTarget = typeof DELIVERY_TARGETS[number];

export type ApprovedSpecRequirement = Readonly<{
  id: string;
  description: string;
  acceptanceCriteriaIds: readonly string[];
}>;

/** Mirrors the v15 conceptual schema; it is not an SPS SDK/Core data type. */
export type ApprovedSpecRevision = Readonly<{
  projectId: string;
  revisionId: string;
  productTier: ProductTier;
  requirements: readonly ApprovedSpecRequirement[];
  targets: readonly DeliveryTarget[];
  dataPolicyRef: string;
  approvalEvidenceRef: string;
}>;

// These are bounded Builder-side storage limits, not Core capacity guarantees.
const MAX_ID_LENGTH = 160;
const MAX_DESCRIPTION_BYTES = 8 * 1024;
const MAX_REVISION_JSON_BYTES = 192 * 1024;
const MAX_REQUIREMENTS = 1_000;
const MAX_ACCEPTANCE_CRITERIA_PER_REQUIREMENT = 100;
const MAX_TARGETS = 6;
const PRODUCT_TIER_SET: ReadonlySet<string> = new Set(PRODUCT_TIERS);
const DELIVERY_TARGET_SET: ReadonlySet<string> = new Set(DELIVERY_TARGETS);
const encoder = new TextEncoder();

function record(
  value: unknown,
  required: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain record.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain record.`);
  }

  const keys = Reflect.ownKeys(value);
  const allowed = new Set(required);
  if (required.some(key => !keys.includes(key))
    || keys.some(key => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError(`${label} has unknown or missing fields.`);
  }

  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
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
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor?.value;
  if (typeof length !== "number" || !Number.isInteger(length) || length > maximum) {
    throw new TypeError(`${label} must have at most ${maximum} entries.`);
  }
  if (keys.length !== length + 1 || !keys.includes("length")) {
    throw new TypeError(`${label} must be dense and have no extra properties.`);
  }

  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label} must be dense data.`);
    }
    values.push(descriptor.value);
  }
  return values;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_ID_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a nonempty identifier of at most ${MAX_ID_LENGTH} characters without ASCII controls.`);
  }
  return value;
}

function parseRequirement(value: unknown, index: number): ApprovedSpecRequirement {
  const label = `requirements[${index}]`;
  const row = record(value, ["id", "description", "acceptanceCriteriaIds"], label);
  const description = row.description;
  if (typeof description !== "string" || description.trim().length === 0
    || encoder.encode(description).byteLength > MAX_DESCRIPTION_BYTES) {
    throw new TypeError(`${label}.description must be nonempty and at most ${MAX_DESCRIPTION_BYTES} UTF-8 bytes.`);
  }

  const acceptanceCriteriaIds = list(
    row.acceptanceCriteriaIds,
    MAX_ACCEPTANCE_CRITERIA_PER_REQUIREMENT,
    `${label}.acceptanceCriteriaIds`,
  ).map((entry, criteriaIndex) => identifier(entry, `${label}.acceptanceCriteriaIds[${criteriaIndex}]`));
  if (new Set(acceptanceCriteriaIds).size !== acceptanceCriteriaIds.length) {
    throw new TypeError(`${label}.acceptanceCriteriaIds contains duplicate IDs.`);
  }

  return Object.freeze({
    id: identifier(row.id, `${label}.id`),
    description,
    acceptanceCriteriaIds: Object.freeze(acceptanceCriteriaIds),
  });
}

/**
 * Validates structure and reference presence only. An approvalEvidenceRef does
 * not prove user approval, license rights, signed evidence, Core capacity, or execution.
 */
export function parseApprovedSpecRevision(value: unknown, expectedProjectId: string): ApprovedSpecRevision {
  const expectedId = identifier(expectedProjectId, "expectedProjectId");
  const row = record(value, [
    "projectId", "revisionId", "productTier", "requirements", "targets", "dataPolicyRef", "approvalEvidenceRef",
  ], "approvedSpecRevision");
  const projectId = identifier(row.projectId, "approvedSpecRevision.projectId");
  if (projectId !== expectedId) throw new TypeError("approvedSpecRevision.projectId does not match the expected project.");

  if (typeof row.productTier !== "string" || !PRODUCT_TIER_SET.has(row.productTier)) {
    throw new TypeError("approvedSpecRevision.productTier is unsupported.");
  }

  const rawRequirements = list(row.requirements, MAX_REQUIREMENTS, "approvedSpecRevision.requirements");
  if (rawRequirements.length === 0) throw new TypeError("approvedSpecRevision.requirements must not be empty.");
  const requirements = rawRequirements.map(parseRequirement);
  if (new Set(requirements.map(requirement => requirement.id)).size !== requirements.length) {
    throw new TypeError("approvedSpecRevision.requirements contains duplicate IDs.");
  }

  const targets = list(row.targets, MAX_TARGETS, "approvedSpecRevision.targets").map((target, index) => {
    if (typeof target !== "string" || !DELIVERY_TARGET_SET.has(target)) {
      throw new TypeError(`approvedSpecRevision.targets[${index}] is unsupported.`);
    }
    return target as DeliveryTarget;
  });
  if (targets.length === 0) throw new TypeError("approvedSpecRevision.targets must not be empty.");
  if (new Set(targets).size !== targets.length) throw new TypeError("approvedSpecRevision.targets contains duplicates.");

  const snapshot: ApprovedSpecRevision = Object.freeze({
    projectId,
    revisionId: identifier(row.revisionId, "approvedSpecRevision.revisionId"),
    productTier: row.productTier as ProductTier,
    requirements: Object.freeze(requirements),
    targets: Object.freeze(targets),
    dataPolicyRef: identifier(row.dataPolicyRef, "approvedSpecRevision.dataPolicyRef"),
    approvalEvidenceRef: identifier(row.approvalEvidenceRef, "approvedSpecRevision.approvalEvidenceRef"),
  });

  // Serialize only the validated, getter-free clone, never the caller's object.
  if (encoder.encode(JSON.stringify(snapshot)).byteLength > MAX_REVISION_JSON_BYTES) {
    throw new TypeError(`approvedSpecRevision exceeds the ${MAX_REVISION_JSON_BYTES}-byte Builder storage limit.`);
  }
  return snapshot;
}
