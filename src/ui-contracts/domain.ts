import { createHash } from "node:crypto";

const encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_CONTRACT_BYTES = 192 * 1024;
const MAX_ROWS = 2_000;
const MAX_REFS = 256;
const MAX_ID = 160;

export type UiReviewStatus = "APPROVED" | "REVIEW_REQUIRED" | "UNKNOWN" | "UNCONNECTED";
export type UiInteraction = Readonly<{
  id: string;
  screenId: string;
  requirementRefs: readonly string[];
  behaviorRefs: readonly string[];
  stateRefs: readonly string[];
  apiRefs: readonly string[];
  preconditions: readonly string[];
  outcomes: readonly string[];
  prohibited: readonly string[];
  validationCriteria: readonly string[];
  status: "specified" | "unknown" | "unconnected";
}>;
export type UiContract = Readonly<{
  projectId: string;
  revisionId: string;
  screenIds: readonly string[];
  interactions: readonly UiInteraction[];
}>;
export type UiHtmlArtifact = Readonly<{
  artifactId: string;
  html: string;
  htmlSha256: string;
  screenIds: readonly string[];
  viewport: Readonly<{ width: number; height: number }>;
  sourceSessionId: string;
  sourceSpecRevisionId: string;
}>;
export type UiUserApprovalSource = Readonly<{
  sourceId: string;
  sourceSha256: string;
}>;
export type UiRevision = Readonly<{
  projectId: string;
  revisionId: string;
  sourceBaselineRevisionId: string;
  sourceBaselineDigest: string;
  sourceSpecRevisionId: string;
  sourceProposalRevisionId: string | null;
  previousRevisionId: string | null;
  artifact: UiHtmlArtifact;
  contract: UiContract;
  approvalSource: UiUserApprovalSource;
  publication: "proposal" | "formal";
  reviewByInteractionId: Readonly<Record<string, UiReviewStatus>>;
}>;

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a plain record.`);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError(`${label} has unknown or missing fields.`);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw new TypeError(`${label}.${key} must be a data field.`);
    result[key] = field.value;
  }
  return result;
}

function list(value: unknown, label: string, maximum = MAX_REFS): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    throw new TypeError(`${label} must be a standard array with at most ${maximum} values.`);
  }
  const own = Reflect.ownKeys(value);
  if (own.length !== value.length + 1 || !own.includes("length")) throw new TypeError(`${label} must be dense.`);
  return Array.from({ length: value.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw new TypeError(`${label} must contain data values.`);
    return field.value;
  });
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_ID || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a nonblank identifier of at most ${MAX_ID} characters.`);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${label} must be a canonical UUID.`);
  return value;
}

function strings(value: unknown, label: string, maximum = MAX_REFS): readonly string[] {
  const result = list(value, label, maximum).map((entry, index) => id(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new TypeError(`${label} contains duplicate IDs.`);
  return Object.freeze(result);
}

function status(value: unknown, label: string): UiReviewStatus {
  if (value !== "APPROVED" && value !== "REVIEW_REQUIRED" && value !== "UNKNOWN" && value !== "UNCONNECTED") {
    throw new TypeError(`${label} has an unsupported review status.`);
  }
  return value;
}

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

export function parseUiContract(value: unknown, expectedProjectId: string): UiContract {
  const projectId = id(expectedProjectId, "expectedProjectId");
  const row = record(value, ["projectId", "revisionId", "screenIds", "interactions"], "uiContract");
  if (id(row.projectId, "uiContract.projectId") !== projectId) throw new TypeError("uiContract belongs to another project.");
  const screenIds = strings(row.screenIds, "uiContract.screenIds");
  if (screenIds.length === 0) throw new TypeError("uiContract.screenIds must not be empty.");
  const raw = list(row.interactions, "uiContract.interactions", MAX_ROWS);
  const interactions = raw.map((entry, index): UiInteraction => {
    const label = `uiContract.interactions[${index}]`;
    const item = record(entry, ["id", "screenId", "requirementRefs", "behaviorRefs", "stateRefs", "apiRefs", "preconditions",
      "outcomes", "prohibited", "validationCriteria", "status"], label);
    const itemStatus = item.status;
    if (itemStatus !== "specified" && itemStatus !== "unknown" && itemStatus !== "unconnected") {
      throw new TypeError(`${label}.status is unsupported.`);
    }
    const result: UiInteraction = Object.freeze({
      id: id(item.id, `${label}.id`),
      screenId: id(item.screenId, `${label}.screenId`),
      requirementRefs: strings(item.requirementRefs, `${label}.requirementRefs`),
      behaviorRefs: strings(item.behaviorRefs, `${label}.behaviorRefs`),
      stateRefs: strings(item.stateRefs, `${label}.stateRefs`),
      apiRefs: strings(item.apiRefs, `${label}.apiRefs`),
      preconditions: strings(item.preconditions, `${label}.preconditions`),
      outcomes: strings(item.outcomes, `${label}.outcomes`),
      prohibited: strings(item.prohibited, `${label}.prohibited`),
      validationCriteria: strings(item.validationCriteria, `${label}.validationCriteria`),
      status: itemStatus,
    });
    if (!screenIds.includes(result.screenId)) throw new TypeError(`${label}.screenId is not declared by the UI Contract.`);
    const connected = result.requirementRefs.length + result.behaviorRefs.length + result.stateRefs.length
      + result.apiRefs.length > 0;
    if (result.status === "specified" && (!connected || result.validationCriteria.length === 0)) {
      throw new TypeError(`${label} needs reference links and validation criteria, or an explicit unknown/unconnected status.`);
    }
    if (result.status === "unconnected" && connected) throw new TypeError(`${label} marked unconnected has reference links.`);
    return result;
  });
  if (new Set(interactions.map(item => item.id)).size !== interactions.length) throw new TypeError("uiContract has duplicate interaction IDs.");
  const result = Object.freeze({ projectId, revisionId: id(row.revisionId, "uiContract.revisionId"), screenIds, interactions });
  if (encoder.encode(JSON.stringify(result)).byteLength > MAX_CONTRACT_BYTES) throw new TypeError("uiContract exceeds the 192 KiB validation limit.");
  return result;
}

function parseArtifact(value: unknown, projectId: string, sourceSpecRevisionId: string): UiHtmlArtifact {
  const row = record(value, ["artifactId", "html", "htmlSha256", "screenIds", "viewport", "sourceSessionId", "sourceSpecRevisionId"], "uiArtifact");
  if (typeof row.html !== "string" || hasUnpairedSurrogate(row.html) || encoder.encode(row.html).byteLength > MAX_HTML_BYTES) {
    throw new TypeError("uiArtifact.html must be text no larger than 512 KiB.");
  }
  const htmlSha256 = sha256Utf8(row.html);
  if (typeof row.htmlSha256 !== "string" || !SHA256.test(row.htmlSha256) || row.htmlSha256 !== htmlSha256) {
    throw new TypeError("uiArtifact.htmlSha256 does not match its exact UTF-8 HTML bytes.");
  }
  const screenIds = strings(row.screenIds, "uiArtifact.screenIds");
  if (screenIds.length === 0) throw new TypeError("uiArtifact.screenIds must not be empty.");
  const viewport = record(row.viewport, ["width", "height"], "uiArtifact.viewport");
  if (!Number.isSafeInteger(viewport.width) || (viewport.width as number) < 1 || (viewport.width as number) > 20_000
    || !Number.isSafeInteger(viewport.height) || (viewport.height as number) < 1 || (viewport.height as number) > 20_000) {
    throw new TypeError("uiArtifact.viewport dimensions are invalid.");
  }
  const result = Object.freeze({ artifactId: id(row.artifactId, "uiArtifact.artifactId"), html: row.html,
    htmlSha256, screenIds, viewport: Object.freeze({ width: viewport.width as number, height: viewport.height as number }),
    sourceSessionId: uuid(row.sourceSessionId, "uiArtifact.sourceSessionId"),
    sourceSpecRevisionId: id(row.sourceSpecRevisionId, "uiArtifact.sourceSpecRevisionId") });
  if (result.sourceSpecRevisionId !== sourceSpecRevisionId) throw new TypeError("uiArtifact references another Spec revision.");
  void projectId;
  return result;
}

export function parseUiRevision(value: unknown, expectedProjectId: string): UiRevision {
  const projectId = id(expectedProjectId, "expectedProjectId");
  const row = record(value, ["projectId", "revisionId", "sourceBaselineRevisionId", "sourceBaselineDigest", "sourceSpecRevisionId", "sourceProposalRevisionId", "previousRevisionId", "artifact", "contract",
    "approvalSource", "publication", "reviewByInteractionId"], "uiRevision");
  if (id(row.projectId, "uiRevision.projectId") !== projectId) throw new TypeError("uiRevision belongs to another project.");
  const sourceBaselineRevisionId = id(row.sourceBaselineRevisionId, "uiRevision.sourceBaselineRevisionId");
  if (typeof row.sourceBaselineDigest !== "string" || !SHA256.test(row.sourceBaselineDigest)) {
    throw new TypeError("uiRevision.sourceBaselineDigest must be a SHA-256 digest.");
  }
  const sourceSpecRevisionId = id(row.sourceSpecRevisionId, "uiRevision.sourceSpecRevisionId");
  const sourceProposalRevisionId = row.sourceProposalRevisionId === null ? null : id(row.sourceProposalRevisionId, "uiRevision.sourceProposalRevisionId");
  if (row.publication === "proposal" && sourceProposalRevisionId !== null) {
    throw new TypeError("uiRevision proposal provenance does not match its publication kind.");
  }
  const artifact = parseArtifact(row.artifact, projectId, sourceSpecRevisionId);
  const contract = parseUiContract(row.contract, projectId);
  if (artifact.screenIds.some(screen => !contract.screenIds.includes(screen))) {
    throw new TypeError("uiArtifact screen IDs must be represented by the UI Contract.");
  }
  const approval = record(row.approvalSource, ["sourceId", "sourceSha256"], "uiRevision.approvalSource");
  if (typeof approval.sourceId !== "string" || !/^lead-turn:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(approval.sourceId)
    || typeof approval.sourceSha256 !== "string" || !SHA256.test(approval.sourceSha256)) {
    throw new TypeError("uiRevision.approvalSource must reference a canonical user Lead turn and text hash.");
  }
  if (row.publication !== "proposal" && row.publication !== "formal") throw new TypeError("uiRevision.publication is unsupported.");
  const revisionId = id(row.revisionId, "uiRevision.revisionId");
  const previousRevisionId = row.previousRevisionId === null ? null : id(row.previousRevisionId, "uiRevision.previousRevisionId");
  if (previousRevisionId === revisionId) throw new TypeError("A UI revision cannot be its own parent.");
  const reviewRow = record(row.reviewByInteractionId,
    Object.keys(row.reviewByInteractionId as object), "uiRevision.reviewByInteractionId");
  const interactionIds = new Set(contract.interactions.map(item => item.id));
  const reviewByInteractionId: Record<string, UiReviewStatus> = Object.create(null) as Record<string, UiReviewStatus>;
  for (const [interactionId, reviewStatus] of Object.entries(reviewRow)) {
    if (!interactionIds.has(interactionId)) throw new TypeError("uiRevision review references an unknown interaction.");
    reviewByInteractionId[interactionId] = status(reviewStatus, `reviewByInteractionId.${interactionId}`);
  }
  if (Object.keys(reviewByInteractionId).length !== interactionIds.size) throw new TypeError("uiRevision needs a review status for each interaction.");
  const result: UiRevision = Object.freeze({ projectId, revisionId, sourceBaselineRevisionId, sourceBaselineDigest: row.sourceBaselineDigest,
    sourceSpecRevisionId, sourceProposalRevisionId, previousRevisionId, artifact, contract,
    approvalSource: Object.freeze({ sourceId: approval.sourceId, sourceSha256: approval.sourceSha256 }),
    publication: row.publication, reviewByInteractionId: Object.freeze(reviewByInteractionId) });
  if (encoder.encode(JSON.stringify(result)).byteLength > MAX_HTML_BYTES + MAX_CONTRACT_BYTES + 64 * 1024) {
    throw new TypeError("uiRevision exceeds the bounded storage limit.");
  }
  return result;
}

/** Build conservative element-level review marks from explicit relationship IDs. */
export function deriveUiReviewStatuses(contract: UiContract, changedReferenceIds: readonly string[],
  previous?: Readonly<Record<string, UiReviewStatus>>, previousContract?: UiContract,
  htmlChangedScreens: readonly string[] = []): Readonly<Record<string, UiReviewStatus>> {
  const changed = new Set(changedReferenceIds.map((value, index) => id(value, `changedReferenceIds[${index}]`)));
  const changedScreens = new Set(htmlChangedScreens.map((value, index) => id(value, `htmlChangedScreens[${index}]`)));
  const oldInteractions = new Map(previousContract?.interactions.map(item => [item.id, JSON.stringify(item)]) ?? []);
  const modeledReferences = new Set(contract.interactions.flatMap(item => [
    ...item.requirementRefs, ...item.behaviorRefs, ...item.stateRefs, ...item.apiRefs,
  ]));
  const hasUnmappedChanges = [...changed].some(reference => !modeledReferences.has(reference));
  const result: Record<string, UiReviewStatus> = Object.create(null) as Record<string, UiReviewStatus>;
  for (const interaction of contract.interactions) {
    const refs = [...interaction.requirementRefs, ...interaction.behaviorRefs, ...interaction.stateRefs, ...interaction.apiRefs];
    const linked = refs.length > 0;
    const intersects = refs.some(reference => changed.has(reference))
      || changedScreens.has(interaction.screenId)
      || oldInteractions.has(interaction.id) && oldInteractions.get(interaction.id) !== JSON.stringify(interaction);
    result[interaction.id] = !linked ? "UNCONNECTED"
      : intersects ? "REVIEW_REQUIRED"
        : previous?.[interaction.id] === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED"
          : hasUnmappedChanges ? "UNKNOWN"
            : previous?.[interaction.id] === "APPROVED" ? "APPROVED"
          : interaction.status === "unknown" ? "UNKNOWN"
            : interaction.status === "unconnected" ? "UNCONNECTED" : "UNKNOWN";
  }
  return Object.freeze(result);
}
