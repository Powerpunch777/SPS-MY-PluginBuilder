import type { ReuseFirstCandidate, ReuseFirstRevision } from "./index.ts";

export type ReuseFirstView = Readonly<{
  workspaceId: string;
  projectId: string;
  sequence: number;
  revision: ReuseFirstRevision;
}>;

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const encoder = new TextEncoder();

function record(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`Invalid ${label}.`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) {
    throw new TypeError(`Invalid ${label} fields.`);
  }
  const row: Record<string, unknown> = Object.create(null);
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`Invalid ${label}.${key}.`);
    row[key] = descriptor.value;
  }
  return row;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function denseList(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError(`Invalid ${label}.`);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`Invalid ${label}[${index}].`);
    return descriptor.value;
  });
}

function workspace(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`Invalid ${label}.`);
  return value.toLowerCase();
}

function project(value: unknown, label: string): string {
  return text(value, label, 160);
}

function parseCandidate(value: unknown, workspaceId: string, projectId: string): ReuseFirstCandidate {
  const row = record(value, ["candidateId", "name", "kind", "scope", "origin", "source", "license", "reuse", "product", "createdAt"],
    "Reuse-First candidate");
  const candidateId = text(row.candidateId, "candidate ID", 160);
  const name = text(row.name, "candidate name", 240);
  if (!["blueprint", "code", "external-product", "new-code-gap"].includes(row.kind as string)) {
    throw new TypeError("Invalid Reuse-First candidate kind.");
  }
  const scope = record(row.scope, ["workspaceId", "projectId"], "candidate scope");
  if (workspace(scope.workspaceId, "candidate Workspace ID") !== workspaceId
    || project(scope.projectId, "candidate project ID") !== projectId) throw new TypeError("Reuse candidate project scope mismatch.");

  const origin = record(row.origin, ["url", "version"], "candidate origin");
  const originUrl = text(origin.url, "origin URL", 2048);
  let parsedUrl: URL;
  try { parsedUrl = new URL(originUrl); } catch { throw new TypeError("Candidate origin must be an HTTPS URL."); }
  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password
    || origin.version !== null && (typeof origin.version !== "string" || !origin.version.trim() || origin.version.length > 256)) {
    throw new TypeError("Candidate origin is invalid.");
  }

  const source = record(row.source, ["sourceId", "fromLine", "throughLine", "sha256", "quote"], "candidate source");
  if (typeof source.sourceId !== "string" || !/^lead-turn:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(source.sourceId)
    || !Number.isSafeInteger(source.fromLine) || !Number.isSafeInteger(source.throughLine)
    || (source.fromLine as number) < 1 || (source.throughLine as number) < (source.fromLine as number)
    || (source.throughLine as number) - (source.fromLine as number) > 199
    || typeof source.sha256 !== "string" || !SHA256.test(source.sha256)
    || typeof source.quote !== "string" || !source.quote.trim() || encoder.encode(source.quote).byteLength > 32 * 1024) {
    throw new TypeError("Reuse source evidence is malformed.");
  }

  const license = record(row.license, ["status", "evidenceRefs"], "license evidence");
  if (license.status !== "unknown" || denseList(license.evidenceRefs, 0, "license evidence references").length !== 0) {
    throw new TypeError("Reuse license evidence must remain unknown.");
  }
  const reuse = record(row.reuse, ["status", "reusableAcrossProjects"], "reuse rights");
  if (reuse.status !== "blocked-unverified" || reuse.reusableAcrossProjects !== false) {
    throw new TypeError("Unverified reuse rights cannot be authorized.");
  }

  const product = record(row.product, ["tier", "route", "deliveryTargets"], "candidate product mapping");
  if (!["S", "M", "L", "XL"].includes(product.tier as string)
    || !["FAST", "ASSEMBLY", "CUSTOM"].includes(product.route as string)) throw new TypeError("Invalid product tier or route.");
  const deliveryTargets = denseList(product.deliveryTargets, 6, "delivery targets");
  if (deliveryTargets.length < 1 || deliveryTargets.some(target => typeof target !== "string"
    || !["sps-plugin", "desktop", "web-api", "cli-automation", "agent-workflow", "hybrid"].includes(target))
    || new Set(deliveryTargets).size !== deliveryTargets.length) throw new TypeError("Invalid delivery targets.");
  if (typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt))
    || new Date(row.createdAt).toISOString() !== row.createdAt) throw new TypeError("Invalid candidate timestamp.");

  return Object.freeze({ candidateId, name, kind: row.kind as ReuseFirstCandidate["kind"],
    scope: Object.freeze({ workspaceId, projectId }), origin: Object.freeze({ url: originUrl, version: origin.version as string | null }),
    source: Object.freeze({ sourceId: source.sourceId, fromLine: source.fromLine as number, throughLine: source.throughLine as number,
      sha256: source.sha256, quote: source.quote }),
    license: Object.freeze({ status: "unknown", evidenceRefs: Object.freeze([] as const) }),
    reuse: Object.freeze({ status: "blocked-unverified", reusableAcrossProjects: false }),
    product: Object.freeze({ tier: product.tier as ReuseFirstCandidate["product"]["tier"],
      route: product.route as ReuseFirstCandidate["product"]["route"], deliveryTargets: Object.freeze(deliveryTargets as ReuseFirstCandidate["product"]["deliveryTargets"]) }),
    createdAt: row.createdAt });
}

function parseRevision(value: unknown, workspaceId: string, projectId: string): ReuseFirstRevision {
  const row = record(value, ["revisionId", "candidates"], "Reuse-First revision");
  const revisionId = text(row.revisionId, "Reuse-First revision ID", 160);
  const candidates = denseList(row.candidates, 200, "Reuse-First candidates")
    .map(candidate => parseCandidate(candidate, workspaceId, projectId));
  if (new Set(candidates.map(candidate => candidate.candidateId)).size !== candidates.length) {
    throw new TypeError("Duplicate Reuse-First candidate ID.");
  }
  return Object.freeze({ revisionId, candidates: Object.freeze(candidates) });
}

/** Browser-safe validation for the scoped current-journal DTO; hash verification remains server-side. */
export function parseReuseFirstView(value: unknown, expectedWorkspaceId: string, expectedProjectId: string): ReuseFirstView {
  const workspaceId = workspace(expectedWorkspaceId, "expected Workspace ID");
  const projectId = project(expectedProjectId, "expected project ID");
  if (projectId !== workspaceId) throw new TypeError("Reuse-First view requires its authenticated single-Workspace project scope.");
  const row = record(value, ["workspaceId", "projectId", "sequence", "revision"], "Reuse-First view");
  if (workspace(row.workspaceId, "view Workspace ID") !== workspaceId || project(row.projectId, "view project ID") !== projectId
    || !Number.isSafeInteger(row.sequence) || (row.sequence as number) < 1) throw new TypeError("Stale or cross-scope Reuse-First view.");
  return Object.freeze({ workspaceId, projectId, sequence: row.sequence as number,
    revision: parseRevision(row.revision, workspaceId, projectId) });
}
