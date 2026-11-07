import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { readDesignBaseline } from "../design-baseline-tools.ts";
import { exactToolRecord, parseLeadToolContext, requireLeadFormalPublicationAuthority, resolveLeadToolAuthority } from "../lead-tool-authority.ts";
import { readCurrentIntegrationPlan } from "../builder-gates/integration-plan.ts";
import { parseUiRevision, revisionDigest } from "../ui-contracts/domain.ts";
import { createRevisionJournal, type RevisionState } from "../solution-revision-store.ts";

const SHA = /^[a-f0-9]{64}$/u;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_BODY_BYTES = 192 * 1024;
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const json = (value: unknown) => JSON.stringify(value);
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) freeze(item);
    Object.freeze(value);
  }
  return value;
};

export type DeliveryDocumentKind = "installation-guide" | "user-guide" | "other";
export type DeliveryDocumentDraft = Readonly<{ kind: DeliveryDocumentKind; path: string; classification: string; scope: string; body: string }>;
export type DeliverySourcePin = Readonly<{ sourceId: string; revisionId: string; sha256: string }>;
export type PublishedDeliveryDocuments = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  projectId: string;
  revisionId: string;
  createdAt: string;
  status: "draft";
  approvalStatus: "unapproved";
  author: Readonly<{ agentId: string; sessionId: string; runId: string; selectionRevision: number }>;
  baseline: DeliverySourcePin & Readonly<{ sequence: number }>;
  ui: DeliverySourcePin;
  integrationPlan: DeliverySourcePin;
  source: Readonly<{ sourceId: string; folderKey: string; branch: string; commitSha: string; treeSha: string; sha256: string }>;
  documents: readonly Readonly<DeliveryDocumentDraft & { bodySha256: string }>[];
  completeness: Readonly<{ status: "unknown"; reason: string }>;
}>;

export type DeliveryDocumentsRead = Readonly<{
  status: "available" | "unavailable";
  reason: string | null;
  document: PublishedDeliveryDocuments | null;
  source: "current" | "stale" | "unknown";
  currentRevisionId: string | null;
  confirmed: false;
  completeness: "unknown";
}>;

export function deliveryDocumentPin(bundle: PublishedDeliveryDocuments, index: number): DeliverySourcePin {
  const document = bundle.documents[index];
  const suffix = /^delivery-documents-v1:([a-f0-9]{64})$/u.exec(bundle.revisionId)?.[1];
  if (!document || !suffix) throw new TypeError("Invalid delivery document reference.");
  return { sourceId: `delivery-document:${bundle.workspaceId}/${bundle.projectId}:${index + 1}:${document.kind}`,
    revisionId: `delivery-document-rev:${suffix}:${index + 1}`, sha256: document.bodySha256 };
}

function record(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Invalid delivery document record.");
  const keys = Reflect.ownKeys(value);
  if (required.some(key => !Object.hasOwn(value, key))
    || keys.length !== required.length + optional.filter(key => Object.hasOwn(value, key)).length
    || keys.some(key => typeof key !== "string" || ![...required, ...optional].includes(key))) throw new TypeError("Invalid delivery document fields.");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Delivery document fields must be own data properties.");
    result[key] = descriptor.value;
  }
  return result;
}

function text(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/u.test(value)
    || [...value].some(char => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff)) {
    throw new TypeError(`${label} must be non-empty valid bounded text.`);
  }
  return value;
}

function parseDrafts(value: unknown): readonly DeliveryDocumentDraft[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 2 || value.length > 32
    || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError("Delivery draft must include the installation and user guides.");
  const documents = value.map(item => {
    const row = record(item, ["kind", "path", "classification", "scope", "body"]);
    if (row.kind !== "installation-guide" && row.kind !== "user-guide" && row.kind !== "other") throw new TypeError("Unsupported delivery document kind.");
    const path = text(row.path, "Document path", 512);
    const segments = path.split("/");
    if (path.startsWith("/") || segments.length > 64 || /[\\\p{Cc}\p{Cf}<>:"|?*]/u.test(path)
      || segments.some(part => !part || part === "." || part === ".." || /[. ]$/u.test(part)
        || /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu.test(part))) {
      throw new TypeError("Document path must be a normalized relative delivery path.");
    }
    return Object.freeze({ kind: row.kind, path, classification: text(row.classification, "Classification", 160),
      scope: text(row.scope, "Scope", 2048), body: text(row.body, "Document body", MAX_BODY_BYTES) });
  });
  if (documents.filter(item => item.kind === "installation-guide").length !== 1
    || documents.filter(item => item.kind === "user-guide").length !== 1
    || new Set(documents.map(item => item.path.toLocaleLowerCase("en-US"))).size !== documents.length
    || documents.reduce((total, item) => total + Buffer.byteLength(item.body, "utf8"), 0) > MAX_BODY_BYTES) {
    throw new TypeError("Delivery documents require unique paths/kinds, both substantive guides, and at most 192 KiB of text.");
  }
  return Object.freeze(documents);
}

function parsePin(value: unknown, label: string): DeliverySourcePin {
  const row = record(value, ["sourceId", "revisionId", "sha256"]);
  if (typeof row.sourceId !== "string" || !row.sourceId.trim() || row.sourceId.length > 512
    || typeof row.revisionId !== "string" || !row.revisionId.trim() || row.revisionId.length > 512
    || typeof row.sha256 !== "string" || !SHA.test(row.sha256)) throw new TypeError(`Invalid ${label} pin.`);
  return Object.freeze({ sourceId: row.sourceId, revisionId: row.revisionId, sha256: row.sha256 });
}

function parsePublished(value: unknown, workspaceId: string, projectId: string): PublishedDeliveryDocuments {
  const row = record(value, ["schemaVersion", "workspaceId", "projectId", "revisionId", "createdAt", "status", "approvalStatus",
    "author", "baseline", "ui", "integrationPlan", "source", "documents", "completeness"]);
  const author = record(row.author, ["agentId", "sessionId", "runId", "selectionRevision"]);
  const baselineRow = record(row.baseline, ["sourceId", "revisionId", "sha256", "sequence"]);
  const sourceRow = record(row.source, ["sourceId", "folderKey", "branch", "commitSha", "treeSha", "sha256"]);
  const completeness = record(row.completeness, ["status", "reason"]);
  const documents = parseDrafts(Array.isArray(row.documents) ? row.documents.map(value => {
    const item = record(value, ["kind", "path", "classification", "scope", "body", "bodySha256"]);
    if (typeof item.bodySha256 !== "string" || !SHA.test(item.bodySha256) || hash(String(item.body)) !== item.bodySha256) {
      throw new TypeError("Delivery document body digest mismatch.");
    }
    const { bodySha256: _bodySha256, ...draft } = item;
    return draft;
  }) : row.documents);
  const docs = documents.map((document, index) => {
    const original = row.documents as unknown[];
    const item = record(original[index], ["kind", "path", "classification", "scope", "body", "bodySha256"]);
    return Object.freeze({ ...document, bodySha256: item.bodySha256 as string });
  });
  const createdAt = row.createdAt;
  if (row.schemaVersion !== 1 || row.workspaceId !== workspaceId || row.projectId !== projectId
    || typeof row.revisionId !== "string" || !row.revisionId.startsWith("delivery-documents-v1:")
    || typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt
    || row.status !== "draft" || row.approvalStatus !== "unapproved"
    || [author.agentId, author.sessionId, author.runId].some(item => typeof item !== "string" || !UUID.test(item))
    || !Number.isSafeInteger(author.selectionRevision) || (author.selectionRevision as number) < 0
    || !Number.isSafeInteger(baselineRow.sequence) || (baselineRow.sequence as number) < 1
    || typeof sourceRow.sourceId !== "string" || typeof sourceRow.folderKey !== "string" || typeof sourceRow.branch !== "string"
    || typeof sourceRow.commitSha !== "string" || !OID.test(sourceRow.commitSha)
    || typeof sourceRow.treeSha !== "string" || !OID.test(sourceRow.treeSha)
    || typeof sourceRow.sha256 !== "string" || !SHA.test(sourceRow.sha256)
    || completeness.status !== "unknown" || typeof completeness.reason !== "string" || !completeness.reason.trim()) {
    throw new TypeError("Invalid or corrupt delivery document revision.");
  }
  const baseline = Object.freeze({ ...parsePin({ sourceId: baselineRow.sourceId, revisionId: baselineRow.revisionId,
    sha256: baselineRow.sha256 }, "Baseline"), sequence: baselineRow.sequence as number });
  const ui = parsePin(row.ui, "formal UI");
  const integrationPlan = parsePin(row.integrationPlan, "integration plan");
  const sourceContent = { sourceId: sourceRow.sourceId, folderKey: sourceRow.folderKey, branch: sourceRow.branch,
    commitSha: sourceRow.commitSha, treeSha: sourceRow.treeSha };
  if (sourceRow.sha256 !== hash(json(sourceContent))) throw new TypeError("Delivery source commit/tree digest mismatch.");
  const source = Object.freeze({ ...sourceContent, sha256: sourceRow.sha256 as string });
  const authorValue = Object.freeze({ agentId: author.agentId as string, sessionId: author.sessionId as string,
    runId: author.runId as string, selectionRevision: author.selectionRevision as number });
  const pinsAndDocs = { baseline, ui, integrationPlan, source, documents: docs };
  const expectedId = `delivery-documents-v1:${hash(json(pinsAndDocs))}`;
  if (row.revisionId !== expectedId) throw new TypeError("Delivery document revision identity mismatch.");
  return freeze({ schemaVersion: 1, workspaceId, projectId, revisionId: expectedId, createdAt, status: "draft",
    approvalStatus: "unapproved", author: authorValue, ...pinsAndDocs,
    completeness: Object.freeze({ status: "unknown", reason: completeness.reason }) });
}

type CurrentPins = Readonly<{ baseline: PublishedDeliveryDocuments["baseline"]; ui: DeliverySourcePin;
  integrationPlan: DeliverySourcePin; source: PublishedDeliveryDocuments["source"] }>;
type Resolution = Readonly<{ status: "current"; pins: CurrentPins }>
  | Readonly<{ status: "stale"; pins: CurrentPins | null; reason: string }>
  | Readonly<{ status: "unknown"; reason: string }>
  | Readonly<{ status: "unsupported"; reason: string }>;

async function resolveCurrentPins(workspaceId: string, projectId: string, platform: SpsPlatformInvocationContext): Promise<Resolution> {
  try {
    const baseline = await readDesignBaseline(workspaceId, projectId, platform);
    const ui = await createRevisionJournal(workspaceId, projectId, platform.state as RevisionState, { prefix: "ui-contracts",
      parse: value => parseUiRevision(value, projectId), revisionId: value => value.revisionId }).current();
    const plan = await readCurrentIntegrationPlan(workspaceId, platform);
    if (!baseline || !ui || !plan) return { status: "unknown", reason: "Current Baseline, formal UI or Main integration plan is unavailable." };
    const baselineDigest = hash(json(baseline.revision)), uiDigest = revisionDigest(ui.revision), planDigest = hash(json(plan.revision));
    const designPins = {
      baseline: Object.freeze({ sourceId: `${workspaceId}/${projectId}`, revisionId: baseline.revision.revisionId,
        sha256: baselineDigest, sequence: baseline.sequence }),
      ui: Object.freeze({ sourceId: `${workspaceId}/${projectId}`, revisionId: ui.revision.revisionId, sha256: uiDigest }),
      integrationPlan: Object.freeze({ sourceId: `${workspaceId}/${projectId}`, revisionId: plan.revision.revisionId, sha256: planDigest }),
    };
    if (ui.revision.publication !== "formal" || ui.revision.approvalRevisionId === null
      || ui.revision.source.kind !== "baseline" || ui.revision.source.revisionId !== baseline.revision.revisionId
      || ui.revision.source.digest !== baselineDigest || plan.revision.baselineRevisionId !== baseline.revision.revisionId
      || plan.revision.baselineDigest !== baselineDigest || plan.revision.uiRevisionId !== ui.revision.revisionId
      || plan.revision.uiDigest !== uiDigest) return { status: "stale", pins: null,
        reason: "Current Baseline, formal UI and Main integration plan do not share exact source pins." };
    const api = (platform as SpsPlatformInvocationContext & { localFolders?: {
      matchWorkspaceSourceV1?: (folderKey: string, sourceId: string) => Promise<unknown>;
      readWorkspaceSourceGitTipV1?: (sourceId: string, folderKey: string, branch: string) => Promise<unknown>;
    } }).localFolders;
    if (typeof api?.matchWorkspaceSourceV1 !== "function" || typeof api.readWorkspaceSourceGitTipV1 !== "function") {
      return { status: "unsupported", reason: "Host Workspace Source/Git tip reader is unavailable." };
    }
    const root = exactToolRecord(await api.matchWorkspaceSourceV1(plan.revision.folderKey, plan.revision.sourceId),
      ["folderKey", "workspaceSourceId", "match"]);
    if (root.folderKey !== plan.revision.folderKey || root.workspaceSourceId !== plan.revision.sourceId || root.match !== "same_root") {
      return { status: "stale", pins: null, reason: "The current integration plan Source no longer resolves to its authorized Workspace root." };
    }
    const readTip = async (branch: string) => exactToolRecord(await api.readWorkspaceSourceGitTipV1!(plan.revision.sourceId,
      plan.revision.folderKey, branch), ["status"], ["sourceId", "folderKey", "branch", "commitSha", "treeSha", "observedAt", "reason"]);
    const baseTip = await readTip(plan.revision.baseBranch);
    if (baseTip.status !== "current") return { status: "unknown", reason: "The current Main integration-plan base Source tip is unavailable." };
    if (baseTip.sourceId !== plan.revision.sourceId || baseTip.folderKey !== plan.revision.folderKey
      || baseTip.branch !== plan.revision.baseBranch || baseTip.commitSha !== plan.revision.baseCommit || baseTip.treeSha !== plan.revision.baseTree) {
      return { status: "stale", pins: null, reason: "The exact current Main integration-plan base Source tip could not be confirmed." };
    }
    const candidate = await readTip(plan.revision.candidateBranch);
    let selected: PublishedDeliveryDocuments["source"];
    if (candidate.status === "denied" && candidate.reason === "branch_unavailable"
      && [candidate.sourceId, candidate.folderKey, candidate.branch].every(value => value === undefined)
      || candidate.status === "denied" && candidate.reason === "branch_unavailable"
        && candidate.sourceId === plan.revision.sourceId && candidate.folderKey === plan.revision.folderKey
        && candidate.branch === plan.revision.candidateBranch) {
      selected = Object.freeze({ sourceId: plan.revision.sourceId, folderKey: plan.revision.folderKey, branch: plan.revision.baseBranch,
        commitSha: plan.revision.baseCommit, treeSha: plan.revision.baseTree,
        sha256: hash(json({ sourceId: plan.revision.sourceId, folderKey: plan.revision.folderKey, branch: plan.revision.baseBranch,
          commitSha: plan.revision.baseCommit, treeSha: plan.revision.baseTree })) });
    } else if (candidate.status === "current" && candidate.sourceId === plan.revision.sourceId
      && candidate.folderKey === plan.revision.folderKey && candidate.branch === plan.revision.candidateBranch
      && typeof candidate.commitSha === "string" && OID.test(candidate.commitSha)
      && typeof candidate.treeSha === "string" && OID.test(candidate.treeSha)
      && typeof candidate.observedAt === "string" && Number.isFinite(Date.parse(candidate.observedAt))) {
      selected = Object.freeze({ sourceId: plan.revision.sourceId, folderKey: plan.revision.folderKey, branch: plan.revision.candidateBranch,
        commitSha: candidate.commitSha, treeSha: candidate.treeSha,
        sha256: hash(json({ sourceId: plan.revision.sourceId, folderKey: plan.revision.folderKey, branch: plan.revision.candidateBranch,
          commitSha: candidate.commitSha, treeSha: candidate.treeSha })) });
    } else {
      return { status: "unknown", reason: "The candidate Source tip is neither current nor authoritatively unavailable." };
    }
    return { status: "current", pins: Object.freeze({ ...designPins, source: selected }) };
  } catch {
    return { status: "unknown", reason: "Current delivery source pins could not be verified." };
  }
}

function samePins(left: CurrentPins, right: PublishedDeliveryDocuments) {
  return json(left) === json({ baseline: right.baseline, ui: right.ui, integrationPlan: right.integrationPlan, source: right.source });
}

function journal(workspaceId: string, projectId: string, state: RevisionState) {
  return createRevisionJournal(workspaceId, projectId, state, { prefix: "project-document-delivery",
    parse: value => parsePublished(value, workspaceId, projectId), revisionId: value => value.revisionId });
}

export async function proposeDeliveryDocuments(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "expectedBaseRevisionId", "documents"]);
  const context = parseLeadToolContext(runContext);
  const projectId = input.projectId;
  if (typeof projectId !== "string" || projectId !== context.companyId
    || context.projectId !== undefined && context.projectId !== projectId) throw new Error("Delivery documents are scoped to the current Workspace project.");
  const authority = await resolveLeadToolAuthority(context, platform);
  requireLeadFormalPublicationAuthority(authority);
  const documents = parseDrafts(input.documents);
  const resolution = await resolveCurrentPins(context.companyId, projectId, platform);
  if (resolution.status === "unsupported") return Object.freeze({ status: "unsupported" as const, reason: resolution.reason });
  if (resolution.status === "unknown") return Object.freeze({ status: "unknown" as const, reason: resolution.reason });
  if (resolution.status === "stale") return Object.freeze({ status: "conflict" as const, reason: resolution.reason });
  const documentRows = Object.freeze(documents.map(document => Object.freeze({ ...document, bodySha256: hash(document.body) })));
  const identity = { baseline: resolution.pins.baseline, ui: resolution.pins.ui,
    integrationPlan: resolution.pins.integrationPlan, source: resolution.pins.source, documents: documentRows };
  const revisionId = `delivery-documents-v1:${hash(json(identity))}`;
  const store = journal(context.companyId, projectId, platform.state as RevisionState);
  const expectedBaseRevisionId = input.expectedBaseRevisionId === null ? null : input.expectedBaseRevisionId;
  if (expectedBaseRevisionId !== null && (typeof expectedBaseRevisionId !== "string" || !expectedBaseRevisionId.trim())) {
    throw new TypeError("An exact expected delivery-document head or null is required.");
  }
  const existing = await store.publishedRevision(revisionId);
  if (existing) {
    const verified = await resolveCurrentPins(context.companyId, projectId, platform);
    await authority.check();
    const current = verified.status === "current" && samePins(verified.pins, existing.revision);
    return Object.freeze({ status: "published" as const, revision: existing.revision, sequence: existing.sequence,
      replayed: true, source: current ? "current" as const : verified.status === "unknown" || verified.status === "unsupported"
        ? "unknown" as const : "stale" as const });
  }
  const currentHead = await store.current();
  if ((currentHead?.revision.revisionId ?? null) !== expectedBaseRevisionId) return Object.freeze({ status: "conflict" as const,
    actualBaseRevisionId: currentHead?.revision.revisionId ?? null, reason: "The delivery-document head changed; read it before retrying." });
  const revision = parsePublished({ schemaVersion: 1, workspaceId: context.companyId, projectId, revisionId,
    createdAt: new Date().toISOString(), status: "draft", approvalStatus: "unapproved",
    author: { agentId: context.agentId, sessionId: context.sessionId, runId: context.runId, selectionRevision: authority.selectionRevision },
    ...identity, completeness: { status: "unknown", reason: "Target-specific supplementary materials, support environment/dependencies, known limitations and change references have not been independently verified; this draft is not a final packet or QA result." } },
  context.companyId, projectId);
  await authority.check();
  const beforePublish = await resolveCurrentPins(context.companyId, projectId, platform);
  if (beforePublish.status !== "current" || !samePins(beforePublish.pins, revision)) return Object.freeze({ status: "conflict" as const,
    reason: beforePublish.status === "current" ? "Delivery source pins changed before publication." : beforePublish.reason });
  const result = await store.publish({ expectedBaseRevisionId, revision });
  if (result.status !== "published") {
    const committed = await store.publishedRevision(revisionId);
    if (committed) {
      await authority.check();
      const afterReplay = await resolveCurrentPins(context.companyId, projectId, platform);
      return Object.freeze({ status: "published" as const, revision: committed.revision, sequence: committed.sequence,
        replayed: true, source: afterReplay.status === "current" && samePins(afterReplay.pins, committed.revision) ? "current" as const
          : afterReplay.status === "unknown" || afterReplay.status === "unsupported" ? "unknown" as const : "stale" as const });
    }
    return Object.freeze({ status: "conflict" as const, actualBaseRevisionId: result.actualBaseRevisionId,
      reason: "The delivery-document journal head changed; read it before retrying." });
  }
  await authority.check();
  const after = await resolveCurrentPins(context.companyId, projectId, platform);
  return Object.freeze({ status: "published" as const, revision: result.revision, sequence: result.sequence, replayed: false,
    source: after.status === "current" && samePins(after.pins, result.revision) ? "current" as const
      : after.status === "unknown" || after.status === "unsupported" ? "unknown" as const : "stale" as const });
}

export async function readCurrentDeliveryDocuments(workspaceId: string, platform: SpsPlatformInvocationContext): Promise<DeliveryDocumentsRead> {
  try {
    const store = journal(workspaceId, workspaceId, platform.state as RevisionState);
    const current = await store.current();
    if (!current) return Object.freeze({ status: "unavailable", reason: "No Main delivery-document draft is published.", document: null,
      source: "unknown", currentRevisionId: null, confirmed: false, completeness: "unknown" });
    const document = parsePublished(current.revision, workspaceId, workspaceId);
    const resolution = await resolveCurrentPins(workspaceId, workspaceId, platform);
    const latest = await store.current();
    const latestPins = resolution.status === "current"
      ? await resolveCurrentPins(workspaceId, workspaceId, platform) : resolution;
    if (!latest || latest.sequence !== current.sequence || latest.revision.revisionId !== document.revisionId
      || JSON.stringify(latest.revision) !== JSON.stringify(document)) return Object.freeze({ status: "available",
      reason: "The delivery-document head changed during the read; refresh before relying on this view.", document,
      source: "unknown", currentRevisionId: document.revisionId, confirmed: false, completeness: "unknown" });
    if (resolution.status === "current" && latestPins.status === "current" && samePins(resolution.pins, document)
      && samePins(latestPins.pins, document)) return Object.freeze({ status: "available", reason: null,
      document, source: "current", currentRevisionId: document.revisionId, confirmed: false, completeness: "unknown" });
    if (resolution.status === "current" && latestPins.status === "current"
      && json(resolution.pins) !== json(latestPins.pins)) return Object.freeze({ status: "available",
      reason: "Current source pins changed during the read; refresh before relying on this view.", document,
      source: "unknown", currentRevisionId: document.revisionId, confirmed: false, completeness: "unknown" });
    return Object.freeze({ status: "available", reason: resolution.status === "unknown" || resolution.status === "unsupported"
      ? resolution.reason : "The current Baseline, UI, plan or Source tip differs from the draft pins.", document,
      source: resolution.status === "unknown" || resolution.status === "unsupported" ? "unknown" : "stale",
      currentRevisionId: document.revisionId, confirmed: false, completeness: "unknown" });
  } catch {
    return Object.freeze({ status: "unavailable", reason: "The current delivery-document revision could not be verified.", document: null,
      source: "unknown", currentRevisionId: null, confirmed: false, completeness: "unknown" });
  }
}
