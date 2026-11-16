import { createHash } from "node:crypto";

const encoder = new TextEncoder();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_REVISION_BYTES = 768 * 1024;
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
export type UiArtifact = Readonly<{
  artifactId: string;
  html: string;
  htmlSha256: string;
  screenIds: readonly string[];
  viewport: Readonly<{ width: number; height: number }>;
  sourceSessionId: string;
  sourceSpecRevisionId: string;
}>;
export type UiSource = Readonly<{
  kind: "draft" | "baseline";
  revisionId: string;
  digest: string;
  specRevisionId: string;
  selectionRevision: number | null;
  agentId: string | null;
}>;
export type UiRevision = Readonly<{
  projectId: string;
  revisionId: string;
  source: UiSource;
  previousRevisionId: string | null;
  sourceProposalRevisionId: string | null;
  approvalRevisionId: string | null;
  artifact: UiArtifact;
  contract: UiContract;
  publication: "proposal" | "formal";
  reviewByInteractionId: Readonly<Record<string, UiReviewStatus>>;
}>;
export type UiApproval = Readonly<{
  projectId: string;
  revisionId: string;
  expectedBaseRevisionId: string | null;
  proposalRevisionId: string;
  proposalDigest: string;
  htmlSha256: string;
  contractRevisionId: string;
  approvedInteractionIds: readonly string[];
  actorUserId: string;
  approvedAt: string;
}>;

export const sha256Utf8 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export const revisionDigest = (value: unknown) => sha256Utf8(JSON.stringify(value));

function record(value: unknown, required: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a plain record.`);
  const keys = Reflect.ownKeys(value);
  if (required.some(key => !Object.hasOwn(value, key)) || keys.length !== required.length
    || keys.some(key => typeof key !== "string" || !required.includes(key))) throw new TypeError(`${label} has unknown or missing fields.`);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw new TypeError(`${label}.${key} must be a data field.`);
    result[key] = field.value;
  }
  return result;
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_ID || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a nonblank bounded identifier.`);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${label} must be a canonical UUID.`);
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${label} must be a SHA-256 digest.`);
  return value;
}

function list(value: unknown, label: string, maximum = MAX_REFS): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError(`${label} must be a dense bounded array.`);
  return Array.from({ length: value.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw new TypeError(`${label} must contain data values.`);
    return field.value;
  });
}

function strings(value: unknown, label: string, maximum = MAX_REFS): readonly string[] {
  const result = list(value, label, maximum).map((entry, index) => id(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new TypeError(`${label} contains duplicate identifiers.`);
  return Object.freeze(result);
}

export function parseUiContract(value: unknown, expectedProjectId: string): UiContract {
  const projectId = id(expectedProjectId, "expectedProjectId");
  const row = record(value, ["projectId", "revisionId", "screenIds", "interactions"], "uiContract");
  if (id(row.projectId, "uiContract.projectId") !== projectId) throw new TypeError("uiContract belongs to another project.");
  const screenIds = strings(row.screenIds, "uiContract.screenIds");
  if (!screenIds.length) throw new TypeError("uiContract.screenIds must not be empty.");
  const interactions = list(row.interactions, "uiContract.interactions", MAX_ROWS).map((raw, index): UiInteraction => {
    const label = `uiContract.interactions[${index}]`;
    const item = record(raw, ["id", "screenId", "requirementRefs", "behaviorRefs", "stateRefs", "apiRefs", "preconditions",
      "outcomes", "prohibited", "validationCriteria", "status"], label);
    if (item.status !== "specified" && item.status !== "unknown" && item.status !== "unconnected") throw new TypeError(`${label}.status is unsupported.`);
    const result = Object.freeze({
      id: id(item.id, `${label}.id`), screenId: id(item.screenId, `${label}.screenId`),
      requirementRefs: strings(item.requirementRefs, `${label}.requirementRefs`),
      behaviorRefs: strings(item.behaviorRefs, `${label}.behaviorRefs`), stateRefs: strings(item.stateRefs, `${label}.stateRefs`),
      apiRefs: strings(item.apiRefs, `${label}.apiRefs`), preconditions: strings(item.preconditions, `${label}.preconditions`),
      outcomes: strings(item.outcomes, `${label}.outcomes`), prohibited: strings(item.prohibited, `${label}.prohibited`),
      validationCriteria: strings(item.validationCriteria, `${label}.validationCriteria`), status: item.status,
    }) as UiInteraction;
    if (!screenIds.includes(result.screenId)) throw new TypeError(`${label}.screenId is not declared.`);
    const linked = result.requirementRefs.length + result.behaviorRefs.length + result.stateRefs.length + result.apiRefs.length > 0;
    if (result.status === "specified" && (!linked || !result.validationCriteria.length)) throw new TypeError(`${label} needs links and validation criteria.`);
    if (result.status === "unconnected" && linked) throw new TypeError(`${label} marked unconnected has reference links.`);
    return result;
  });
  if (new Set(interactions.map(item => item.id)).size !== interactions.length) throw new TypeError("uiContract has duplicate interaction IDs.");
  const contract = Object.freeze({ projectId, revisionId: id(row.revisionId, "uiContract.revisionId"), screenIds, interactions });
  if (encoder.encode(JSON.stringify(contract)).byteLength > 192 * 1024) throw new TypeError("uiContract exceeds 192 KiB.");
  return contract;
}

function parseSource(value: unknown): UiSource {
  const row = record(value, ["kind", "revisionId", "digest", "specRevisionId", "selectionRevision", "agentId"], "uiSource");
  if (row.kind !== "draft" && row.kind !== "baseline") throw new TypeError("uiSource.kind is unsupported.");
  const selectionRevision = row.selectionRevision;
  const agentId = row.agentId;
  if (row.kind === "draft" ? !Number.isSafeInteger(selectionRevision) || (selectionRevision as number) < 1
    || typeof agentId !== "string" || !UUID.test(agentId)
    : selectionRevision !== null || agentId !== null) throw new TypeError("uiSource ownership metadata does not match its kind.");
  return Object.freeze({ kind: row.kind, revisionId: id(row.revisionId, "uiSource.revisionId"), digest: digest(row.digest, "uiSource.digest"),
    specRevisionId: id(row.specRevisionId, "uiSource.specRevisionId"), selectionRevision: selectionRevision as number | null,
    agentId: agentId as string | null });
}

function parseArtifact(value: unknown): UiArtifact {
  const row = record(value, ["artifactId", "html", "htmlSha256", "screenIds", "viewport", "sourceSessionId", "sourceSpecRevisionId"], "uiArtifact");
  if (typeof row.html !== "string" || encoder.encode(row.html).byteLength > MAX_HTML_BYTES
    || [...row.html].some(char => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff)) {
    throw new TypeError("uiArtifact.html must be valid UTF-8 text no larger than 512 KiB.");
  }
  const htmlSha256 = sha256Utf8(row.html);
  if (digest(row.htmlSha256, "uiArtifact.htmlSha256") !== htmlSha256) throw new TypeError("uiArtifact hash does not match exact HTML bytes.");
  const screenIds = strings(row.screenIds, "uiArtifact.screenIds");
  if (!screenIds.length) throw new TypeError("uiArtifact.screenIds must not be empty.");
  const viewport = record(row.viewport, ["width", "height"], "uiArtifact.viewport");
  if (!Number.isSafeInteger(viewport.width) || (viewport.width as number) < 1 || (viewport.width as number) > 20_000
    || !Number.isSafeInteger(viewport.height) || (viewport.height as number) < 1 || (viewport.height as number) > 20_000) {
    throw new TypeError("uiArtifact.viewport is invalid.");
  }
  return Object.freeze({ artifactId: id(row.artifactId, "uiArtifact.artifactId"), html: row.html, htmlSha256, screenIds,
    viewport: Object.freeze({ width: viewport.width as number, height: viewport.height as number }),
    sourceSessionId: uuid(row.sourceSessionId, "uiArtifact.sourceSessionId"), sourceSpecRevisionId: id(row.sourceSpecRevisionId, "uiArtifact.sourceSpecRevisionId") });
}

function parseReviewMap(value: unknown, contract: UiContract): Readonly<Record<string, UiReviewStatus>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("review map must be a plain record.");
  }
  const row = record(value, Reflect.ownKeys(value).map(key => String(key)), "review map");
  const interactionIds = new Set(contract.interactions.map(item => item.id));
  const result: Record<string, UiReviewStatus> = Object.create(null) as Record<string, UiReviewStatus>;
  for (const [interactionId, status] of Object.entries(row)) {
    if (!interactionIds.has(interactionId) || !["APPROVED", "REVIEW_REQUIRED", "UNKNOWN", "UNCONNECTED"].includes(status as string)) {
      throw new TypeError("review map contains an unknown interaction or status.");
    }
    result[interactionId] = status as UiReviewStatus;
  }
  if (Object.keys(result).length !== interactionIds.size) throw new TypeError("review map must cover every interaction.");
  return Object.freeze(result);
}

export function parseUiRevision(value: unknown, expectedProjectId: string): UiRevision {
  const projectId = id(expectedProjectId, "expectedProjectId");
  const row = record(value, ["projectId", "revisionId", "source", "previousRevisionId", "sourceProposalRevisionId", "approvalRevisionId",
    "artifact", "contract", "publication", "reviewByInteractionId"], "uiRevision");
  if (id(row.projectId, "uiRevision.projectId") !== projectId) throw new TypeError("uiRevision belongs to another project.");
  if (row.publication !== "proposal" && row.publication !== "formal") throw new TypeError("uiRevision.publication is unsupported.");
  const source = parseSource(row.source), artifact = parseArtifact(row.artifact), contract = parseUiContract(row.contract, projectId);
  if (artifact.sourceSpecRevisionId !== source.specRevisionId || artifact.screenIds.some(screen => !contract.screenIds.includes(screen))) {
    throw new TypeError("Artifact source Spec or screen list does not match the UI Contract.");
  }
  const sourceProposalRevisionId = row.sourceProposalRevisionId === null ? null : id(row.sourceProposalRevisionId, "sourceProposalRevisionId");
  const approvalRevisionId = row.approvalRevisionId === null ? null : id(row.approvalRevisionId, "approvalRevisionId");
  if (row.publication === "proposal" && (sourceProposalRevisionId !== null || approvalRevisionId !== null)
    || row.publication === "formal" && (sourceProposalRevisionId === null || approvalRevisionId === null)) {
    throw new TypeError("Proposal/formal approval provenance is inconsistent.");
  }
  const previousRevisionId = row.previousRevisionId === null ? null : id(row.previousRevisionId, "previousRevisionId");
  const revisionId = id(row.revisionId, "revisionId");
  if (previousRevisionId === revisionId) throw new TypeError("A UI revision cannot parent itself.");
  const reviewByInteractionId = parseReviewMap(row.reviewByInteractionId, contract);
  const revision: UiRevision = Object.freeze({ projectId, revisionId, source, previousRevisionId, sourceProposalRevisionId,
    approvalRevisionId, artifact, contract, publication: row.publication, reviewByInteractionId });
  if (encoder.encode(JSON.stringify(revision)).byteLength > MAX_REVISION_BYTES) throw new TypeError("UI revision exceeds 768 KiB.");
  return revision;
}

export function parseUiApproval(value: unknown, expectedProjectId: string): UiApproval {
  const projectId = id(expectedProjectId, "expectedProjectId");
  const row = record(value, ["projectId", "revisionId", "expectedBaseRevisionId", "proposalRevisionId", "proposalDigest", "htmlSha256", "contractRevisionId",
    "approvedInteractionIds", "actorUserId", "approvedAt"], "uiApproval");
  if (id(row.projectId, "uiApproval.projectId") !== projectId) throw new TypeError("uiApproval belongs to another project.");
  const approvedAt = row.approvedAt;
  if (typeof approvedAt !== "string" || !Number.isFinite(Date.parse(approvedAt)) || new Date(approvedAt).toISOString() !== approvedAt) {
    throw new TypeError("uiApproval.approvedAt must be canonical ISO time.");
  }
  return Object.freeze({ projectId, revisionId: id(row.revisionId, "uiApproval.revisionId"),
    expectedBaseRevisionId: row.expectedBaseRevisionId === null ? null : id(row.expectedBaseRevisionId, "expectedBaseRevisionId"),
    proposalRevisionId: id(row.proposalRevisionId, "uiApproval.proposalRevisionId"), proposalDigest: digest(row.proposalDigest, "proposalDigest"),
    htmlSha256: digest(row.htmlSha256, "htmlSha256"), contractRevisionId: id(row.contractRevisionId, "contractRevisionId"),
    approvedInteractionIds: strings(row.approvedInteractionIds, "approvedInteractionIds", MAX_ROWS),
    actorUserId: id(row.actorUserId, "actorUserId"), approvedAt });
}

export function deriveUiReviewStatuses(contract: UiContract, approval: UiApproval, previous?: UiRevision | null,
  changedReferences: readonly string[] = [], impactUnknown = false): Readonly<Record<string, UiReviewStatus>> {
  const changed = new Set(changedReferences);
  const approved = new Set(approval.approvedInteractionIds);
  const oldById = new Map(previous?.contract.interactions.map(item => [item.id, item]) ?? []);
  const mapped = new Set([...contract.interactions, ...(previous?.contract.interactions ?? [])].flatMap(item => [
    ...item.requirementRefs, ...item.behaviorRefs, ...item.stateRefs, ...item.apiRefs,
  ]));
  const unmapped = [...changed].some(reference => !mapped.has(reference));
  const result: Record<string, UiReviewStatus> = Object.create(null) as Record<string, UiReviewStatus>;
  for (const item of contract.interactions) {
    const linked = item.requirementRefs.length + item.behaviorRefs.length + item.stateRefs.length + item.apiRefs.length > 0;
    if (!linked || item.status === "unconnected") { result[item.id] = "UNCONNECTED"; continue; }
    if (item.status === "unknown") { result[item.id] = "UNKNOWN"; continue; }
    if (approved.has(item.id)) { result[item.id] = "APPROVED"; continue; }
    const old = oldById.get(item.id);
    const contentChanged = old !== undefined && JSON.stringify(old) !== JSON.stringify(item);
    const affected = contentChanged || [...changed].some(reference => old?.requirementRefs.includes(reference)
      || old?.behaviorRefs.includes(reference) || old?.stateRefs.includes(reference) || old?.apiRefs.includes(reference)
      || item.requirementRefs.includes(reference) || item.behaviorRefs.includes(reference) || item.stateRefs.includes(reference) || item.apiRefs.includes(reference));
    if (impactUnknown || unmapped) result[item.id] = "UNKNOWN";
    else if (affected) result[item.id] = "REVIEW_REQUIRED";
    else if (previous && old && previous.reviewByInteractionId[item.id] === "APPROVED") result[item.id] = "APPROVED";
    else if (previous && old && previous.reviewByInteractionId[item.id] === "REVIEW_REQUIRED") result[item.id] = "REVIEW_REQUIRED";
    else result[item.id] = "UNKNOWN";
  }
  return Object.freeze(result);
}
