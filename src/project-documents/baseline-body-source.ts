import { createHash } from "node:crypto";
import { parseDesignBaseline, type DesignBaseline } from "../domain/design-baseline.ts";
import { createRevisionJournal, type RevisionState } from "../solution-revision-store.ts";

const MAX_DOCUMENT_BYTES = 192 * 1024;
const ID = /^[^\u0000-\u001f\u007f]{1,160}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const json = (value: unknown) => JSON.stringify(value);

export type BaselineSourcePin = Readonly<{
  kind: "baseline" | "specification" | "graph" | "draft" | "user-source";
  id: string;
  revisionId: string;
  sha256: string;
}>;

export type PublishedBaselineBody = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  projectId: string;
  documentId: string;
  documentRevisionId: string;
  createdAt: string;
  sourceBaselineRevisionId: string;
  sourceBaselineSequence: number;
  sourceBaselineSha256: string;
  body: string;
  bodySha256: string;
  sourcePins: readonly BaselineSourcePin[];
  inventory: Readonly<{ status: "partial"; reason: string }>;
  historicalApproval: Readonly<{ status: "unknown"; reason: string }>;
}>;

export type BaselineBodyRead = Readonly<{
  status: "available" | "unavailable";
  reason: string | null;
  document: PublishedBaselineBody | null;
  source: "current" | "stale" | "unknown";
  currentBaselineRevisionId: string | null;
  bodyAvailable: boolean;
  historicalApproval: PublishedBaselineBody["historicalApproval"] | null;
}>;

function record(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Invalid Baseline document record.");
  const keys = Reflect.ownKeys(value);
  if (required.some(key => !Object.hasOwn(value, key))
    || keys.length !== required.length + optional.filter(key => Object.hasOwn(value, key)).length
    || keys.some(key => typeof key !== "string" || ![...required, ...optional].includes(key))) throw new TypeError("Invalid Baseline document fields.");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Baseline document fields must be own data properties.");
    result[key] = descriptor.value;
  }
  return result;
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value) || !value.trim()) throw new TypeError(`${label} must be a bounded identifier.`);
  return value;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function safeMarkdown(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/<\/?[A-Za-z][^>]*>/gu, match => match.replace(/</gu, "&lt;").replace(/>/gu, "&gt;"))
    .replace(/\]\(\s*(?:javascript|data|vbscript):[^)]*\)/giu, "](about:blank#blocked)");
}

function renderBaseline(baseline: DesignBaseline): string {
  const spec = baseline.specification;
  const graph = baseline.graph;
  const requirements = spec.requirements.map(requirement => [
    `### ${safeMarkdown(requirement.id)}`, "", safeMarkdown(requirement.description), "",
    ...requirement.acceptanceCriteriaIds.map(ac => `- ${safeMarkdown(ac)}`), "",
  ].join("\n")).join("\n");
  const entities = graph.entities.map(entity => `- ${safeMarkdown(entity.id)} (${safeMarkdown(entity.kind)})`
    + (entity.specRef ? `; requirement ${safeMarkdown(entity.specRef)}` : "")
    + (entity.contractRefs?.length ? `; contracts ${entity.contractRefs.map(safeMarkdown).join(", ")}` : ""))
    .join("\n") || "- No entities recorded.";
  const relations = graph.relations.map(relation => `- ${safeMarkdown(relation.sourceId)} ${safeMarkdown(relation.kind)} ${safeMarkdown(relation.targetId)}`
    + (relation.contractRef ? `; contract ${safeMarkdown(relation.contractRef)}` : "")).join("\n") || "- No relations recorded.";
  const body = [
    "# Integrated Design Baseline", "",
    `- Baseline revision: ${baseline.revisionId}`,
    `- Specification revision: ${spec.revisionId}`,
    `- Graph revision: ${graph.graphRevisionId}`,
    `- Source draft revision: ${baseline.sourceDraftRevisionId}`,
    `- Baseline recorded at: ${baseline.createdAt}`,
    `- User source: ${baseline.userDecision.sourceId} (SHA-256 ${baseline.userDecision.sourceSha256})`, "",
    "## Lead interpretation", "", safeMarkdown(baseline.userDecision.interpretation), "",
    "## Product scope", "", `Tier: ${spec.productTier}`, `Targets: ${spec.targets.map(safeMarkdown).join(", ")}`,
    `Data policy reference: ${safeMarkdown(spec.dataPolicyRef)}`, "",
    "## Requirements and acceptance criteria", "", requirements,
    "## Graph entities", "", entities, "",
    "## Graph relations", "", relations, "",
    "> This is a read projection of the immutable Builder Baseline. It is not legal approval, delivery evidence, or execution authority.", "",
  ].join("\n");
  if (Buffer.byteLength(body, "utf8") > MAX_DOCUMENT_BYTES) throw new TypeError("Rendered Baseline document exceeds 192 KiB.");
  return body;
}

function sourcePins(workspaceId: string, projectId: string, baseline: DesignBaseline): readonly BaselineSourcePin[] {
  const specDigest = hash(json(baseline.specification));
  const graphDigest = hash(json(baseline.graph));
  const baselineDigest = hash(json(baseline));
  return Object.freeze([
    Object.freeze({ kind: "baseline", id: `${workspaceId}/${projectId}`, revisionId: baseline.revisionId, sha256: baselineDigest }),
    Object.freeze({ kind: "specification", id: `${workspaceId}/${projectId}`, revisionId: baseline.specification.revisionId, sha256: specDigest }),
    Object.freeze({ kind: "graph", id: `${workspaceId}/${projectId}`, revisionId: baseline.graph.graphRevisionId, sha256: graphDigest }),
    Object.freeze({ kind: "draft", id: `${workspaceId}/${projectId}`, revisionId: baseline.sourceDraftRevisionId, sha256: baseline.draftDigest }),
    Object.freeze({ kind: "user-source", id: baseline.userDecision.sourceId, revisionId: baseline.userDecision.sourceId,
      sha256: baseline.userDecision.sourceSha256 }),
  ]);
}

function parsePublished(value: unknown, workspaceId: string, projectId: string): PublishedBaselineBody {
  const row = record(value, ["schemaVersion", "workspaceId", "projectId", "documentId", "documentRevisionId",
    "createdAt", "sourceBaselineRevisionId", "sourceBaselineSequence", "sourceBaselineSha256", "body", "bodySha256", "sourcePins",
    "inventory", "historicalApproval"]);
  if (row.schemaVersion !== 1 || row.workspaceId !== workspaceId || row.projectId !== projectId
    || !Number.isSafeInteger(row.sourceBaselineSequence) || (row.sourceBaselineSequence as number) < 1
    || typeof row.body !== "string" || Buffer.byteLength(row.body, "utf8") > MAX_DOCUMENT_BYTES
    || typeof row.bodySha256 !== "string" || !SHA256.test(row.bodySha256) || hash(row.body) !== row.bodySha256
    || typeof row.sourceBaselineSha256 !== "string" || !SHA256.test(row.sourceBaselineSha256)) {
    throw new TypeError("Invalid or corrupt published Baseline document.");
  }
  const pins = row.sourcePins;
  if (!Array.isArray(pins) || pins.length !== 5 || Object.getPrototypeOf(pins) !== Array.prototype
    || Reflect.ownKeys(pins).length !== pins.length + 1) throw new TypeError("Baseline source pins must be a complete bounded list.");
  const normalizedPins = pins.map((pin, index) => {
    const item = record(pin, ["kind", "id", "revisionId", "sha256"]);
    const expectedKinds = ["baseline", "specification", "graph", "draft", "user-source"];
    if (item.kind !== expectedKinds[index] || typeof item.sha256 !== "string" || !SHA256.test(item.sha256)) throw new TypeError("Invalid Baseline source pin.");
    return Object.freeze({ kind: item.kind as BaselineSourcePin["kind"], id: id(item.id, "source pin id"),
      revisionId: id(item.revisionId, "source pin revisionId"), sha256: item.sha256 });
  });
  const inventory = record(row.inventory, ["status", "reason"]);
  const historicalApproval = record(row.historicalApproval, ["status", "reason"]);
  if (inventory.status !== "partial" || typeof inventory.reason !== "string" || !inventory.reason.trim()
    || historicalApproval.status !== "unknown" || typeof historicalApproval.reason !== "string" || !historicalApproval.reason.trim()) {
    throw new TypeError("Baseline inventory and approval authority must remain explicit.");
  }
  return Object.freeze({ schemaVersion: 1, workspaceId, projectId,
    documentId: id(row.documentId, "documentId"), documentRevisionId: id(row.documentRevisionId, "documentRevisionId"),
    createdAt: iso(row.createdAt, "createdAt"),
    sourceBaselineRevisionId: id(row.sourceBaselineRevisionId, "sourceBaselineRevisionId"),
    sourceBaselineSequence: row.sourceBaselineSequence as number, sourceBaselineSha256: row.sourceBaselineSha256,
    body: row.body, bodySha256: row.bodySha256, sourcePins: Object.freeze(normalizedPins),
    inventory: Object.freeze({ status: "partial", reason: inventory.reason }),
    historicalApproval: Object.freeze({ status: "unknown", reason: historicalApproval.reason }) });
}

/**
 * Snapshot the actual current immutable Baseline into its own CAS journal.
 * Callers supply only revision/CAS identifiers; body, pins and authority labels
 * are derived from the server-owned Baseline record.
 */
export function createBaselineBodySource(workspaceId: string, projectId: string, state: RevisionState) {
  const baselines = createRevisionJournal(workspaceId, projectId, state, {
    prefix: "design-baseline", parse: value => parseDesignBaseline(value, projectId), revisionId: value => value.revisionId,
  });
  const documents = createRevisionJournal(workspaceId, projectId, state, {
    prefix: "project-document-baseline",
    parse: value => parsePublished(value, workspaceId, projectId),
    revisionId: value => value.documentRevisionId,
  });

  async function validateAgainstBaseline(document: PublishedBaselineBody) {
    try {
      const source = await baselines.publishedRevision(document.sourceBaselineRevisionId);
      return Boolean(source && source.sequence === document.sourceBaselineSequence
        && hash(json(source.revision)) === document.sourceBaselineSha256
        && renderBaseline(source.revision) === document.body
        && samePins(document.sourcePins, sourcePins(workspaceId, projectId, source.revision)));
    } catch {
      return false;
    }
  }

  async function publish(input: unknown) {
    const row = record(input, ["documentRevisionId", "expectedDocumentRevisionId", "expectedBaselineRevisionId"]);
    const documentRevisionId = id(row.documentRevisionId, "documentRevisionId");
    const expectedDocumentRevisionId = row.expectedDocumentRevisionId === null ? null : id(row.expectedDocumentRevisionId, "expectedDocumentRevisionId");
    const expectedBaselineRevisionId = id(row.expectedBaselineRevisionId, "expectedBaselineRevisionId");
    const currentBaseline = await baselines.current();
    if (!currentBaseline) return Object.freeze({ status: "unavailable" as const, reason: "No current immutable design Baseline exists." });
    if (currentBaseline.revision.revisionId !== expectedBaselineRevisionId) {
      return Object.freeze({ status: "conflict" as const, reason: "The current Baseline changed; refresh before publishing." });
    }
    const prior = await documents.publishedRevision(documentRevisionId);
    if (prior) {
      if (prior.revision.sourceBaselineRevisionId !== expectedBaselineRevisionId
        || !await validateAgainstBaseline(prior.revision)) throw new Error("The document revision already belongs to different or unavailable source bytes.");
      const latest = await baselines.current();
      const current = Boolean(latest && latest.sequence === prior.revision.sourceBaselineSequence
        && hash(json(latest.revision)) === prior.revision.sourceBaselineSha256);
      return Object.freeze({ status: "published" as const, document: prior.revision, replayed: true,
        source: current ? "current" as const : "stale" as const });
    }
    const body = renderBaseline(currentBaseline.revision);
    const revision = parsePublished({ schemaVersion: 1, workspaceId, projectId,
      documentId: `baseline-body:${hash(currentBaseline.revision.revisionId)}`, documentRevisionId,
      createdAt: currentBaseline.revision.createdAt, sourceBaselineRevisionId: currentBaseline.revision.revisionId,
      sourceBaselineSequence: currentBaseline.sequence, sourceBaselineSha256: hash(json(currentBaseline.revision)),
      body, bodySha256: hash(body), sourcePins: sourcePins(workspaceId, projectId, currentBaseline.revision),
      inventory: { status: "partial", reason: "Host-authoritative complete package/file inventory and byte reader are not available in the public Builder source contract." },
      historicalApproval: { status: "unknown", reason: "Builder Baseline recording is not independent human/legal approval." } }, workspaceId, projectId);
    const result = await documents.publish({ expectedBaseRevisionId: expectedDocumentRevisionId, revision });
    if (result.status !== "published") return Object.freeze({ status: "conflict" as const, reason: "The document journal head changed; read it before retrying." });
    const after = await baselines.current();
    const sourceCurrent = Boolean(after && after.sequence === currentBaseline.sequence
      && after.revision.revisionId === currentBaseline.revision.revisionId
      && hash(json(after.revision)) === revision.sourceBaselineSha256);
    return Object.freeze({ status: "published" as const, document: result.revision,
      replayed: false, source: sourceCurrent ? "current" as const : "stale" as const });
  }

  async function read(documentRevisionId: string): Promise<BaselineBodyRead> {
    id(documentRevisionId, "documentRevisionId");
    let currentBaselineRevisionId: string | null = null;
    try {
    const currentBaseline = await baselines.current();
    if (!currentBaseline) return Object.freeze({ status: "unavailable", reason: "Current Baseline is unavailable.",
      document: null, source: "unknown", currentBaselineRevisionId: null, bodyAvailable: false, historicalApproval: null });
    currentBaselineRevisionId = currentBaseline.revision.revisionId;
    const published = await documents.publishedRevision(documentRevisionId);
    if (!published) return Object.freeze({ status: "unavailable", reason: "Published document revision is unavailable.",
      document: null, source: "unknown", currentBaselineRevisionId: currentBaseline.revision.revisionId,
      bodyAvailable: false, historicalApproval: null });
    const document = parsePublished(published.revision, workspaceId, projectId);
    if (!await validateAgainstBaseline(document)) {
      return Object.freeze({ status: "unavailable", reason: "Pinned immutable Baseline body source is missing or changed.",
        document: null, source: "unknown", currentBaselineRevisionId: currentBaseline.revision.revisionId,
        bodyAvailable: false, historicalApproval: document.historicalApproval });
    }
    const isCurrent = currentBaseline.sequence === document.sourceBaselineSequence
      && currentBaseline.revision.revisionId === document.sourceBaselineRevisionId
      && hash(json(currentBaseline.revision)) === document.sourceBaselineSha256;
    return Object.freeze({ status: "available", reason: null, document, source: isCurrent ? "current" : "stale",
      currentBaselineRevisionId: currentBaseline.revision.revisionId, bodyAvailable: true,
      historicalApproval: document.historicalApproval });
    } catch {
      return Object.freeze({ status: "unavailable", reason: "Baseline or published document bytes could not be verified.",
        document: null, source: "unknown", currentBaselineRevisionId, bodyAvailable: false, historicalApproval: null });
    }
  }

  return Object.freeze({ publish, read, current: () => documents.current(), recent: (limit?: number) => documents.recent(limit) });
}

function samePins(left: readonly BaselineSourcePin[], right: readonly BaselineSourcePin[]) {
  return json(left) === json(right);
}
