import { createHash } from "node:crypto";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createRevisionJournal } from "../solution-revision-store.ts";
import type { DeliveryTarget, ProductTier } from "../domain/specification-revisions.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_CANDIDATES = 200;
const MAX_ENTRY_BYTES = 192 * 1024;
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const json = (value: unknown) => JSON.stringify(value);

export type ReuseFirstScope = Readonly<{ workspaceId: string; projectId: string }>;
export type ReuseFirstRoute = "FAST" | "ASSEMBLY" | "CUSTOM";
export type ReuseSourceExcerpt = Readonly<{
  workspaceId: string;
  projectId: string;
  sourceId: string;
  fromLine: number;
  throughLine: number;
  sha256: string;
  text: string;
}>;
export type ReuseFirstSourceReader = Readonly<{
  currentScope(): Promise<ReuseFirstScope>;
  readCurrentExcerpt(input: { sourceId: string; fromLine: number; throughLine: number }): Promise<ReuseSourceExcerpt | null>;
}>;
export type ReuseFirstCandidateInput = Readonly<{
  candidateId: string;
  name: string;
  kind: "blueprint" | "code" | "external-product" | "new-code-gap";
  originUrl: string;
  originVersion: string | null;
  source: Readonly<{ sourceId: string; fromLine: number; throughLine: number }>;
  productTier: ProductTier;
  route: ReuseFirstRoute;
  deliveryTargets: readonly DeliveryTarget[];
}>;
export type ReuseFirstCandidate = Readonly<{
  candidateId: string;
  name: string;
  kind: ReuseFirstCandidateInput["kind"];
  scope: ReuseFirstScope;
  origin: Readonly<{ url: string; version: string | null }>;
  source: Readonly<{ sourceId: string; fromLine: number; throughLine: number; sha256: string; quote: string }>;
  license: Readonly<{ status: "unknown"; evidenceRefs: readonly [] }>;
  reuse: Readonly<{ status: "blocked-unverified"; reusableAcrossProjects: false }>;
  product: Readonly<{ tier: ProductTier; route: ReuseFirstRoute; deliveryTargets: readonly DeliveryTarget[] }>;
  createdAt: string;
}>;
export type ReuseFirstRevision = Readonly<{ revisionId: string; candidates: readonly ReuseFirstCandidate[] }>;
export type ReuseFirstState = {
  get(key: SpsStateKey): Promise<JsonValue | null>;
  compareAndSet?(key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue): Promise<{ swapped: boolean }>;
};

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError(`Invalid ${label}.`);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) throw new TypeError(`Invalid ${label} fields.`);
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`Invalid ${label}.${key}.`);
    out[key] = descriptor.value;
  }
  return out;
}

function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function denseList(value: unknown, minimum: number, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError(`Invalid ${label}.`);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`Invalid ${label}[${index}].`);
    return descriptor.value;
  });
}

function scopeOf(value: unknown): ReuseFirstScope {
  const row = exact(value, ["workspaceId", "projectId"], "reuse project scope");
  const workspaceId = text(row.workspaceId, "Workspace ID", 64);
  const projectId = text(row.projectId, "project ID", 160);
  if (!UUID.test(workspaceId)) throw new TypeError("A canonical Workspace ID is required.");
  return Object.freeze({ workspaceId: workspaceId.toLowerCase(), projectId });
}

function parseInput(value: unknown): ReuseFirstCandidateInput {
  const row = exact(value, ["candidateId", "name", "kind", "originUrl", "originVersion", "source", "productTier", "route", "deliveryTargets"], "reuse candidate");
  const candidateId = text(row.candidateId, "candidate ID", 160);
  const name = text(row.name, "candidate name", 240);
  if (!["blueprint", "code", "external-product", "new-code-gap"].includes(row.kind as string)) throw new TypeError("Invalid candidate kind.");
  const originUrl = text(row.originUrl, "origin URL", 2048);
  let url: URL;
  try { url = new URL(originUrl); } catch { throw new TypeError("Candidate origin must be an HTTPS URL."); }
  if (url.protocol !== "https:" || url.username || url.password) throw new TypeError("Candidate origin must be an HTTPS URL without credentials.");
  const originVersion = row.originVersion === null ? null : text(row.originVersion, "origin version", 256);
  const sourceRow = exact(row.source, ["sourceId", "fromLine", "throughLine"], "reuse source reference");
  const sourceId = text(sourceRow.sourceId, "source ID", 160);
  const fromLine = sourceRow.fromLine, throughLine = sourceRow.throughLine;
  if (!Number.isSafeInteger(fromLine) || !Number.isSafeInteger(throughLine) || (fromLine as number) < 1
    || (throughLine as number) < (fromLine as number) || (throughLine as number) - (fromLine as number) > 199) {
    throw new TypeError("Invalid source line range.");
  }
  if (!["S", "M", "L", "XL"].includes(row.productTier as string)) throw new TypeError("Invalid product tier.");
  if (!["FAST", "ASSEMBLY", "CUSTOM"].includes(row.route as string)) throw new TypeError("Invalid implementation route.");
  const deliveryTargets = denseList(row.deliveryTargets, 1, 6, "delivery targets").map(target => {
    if (typeof target !== "string" || !["sps-plugin", "desktop", "web-api", "cli-automation", "agent-workflow", "hybrid"].includes(target)) {
      throw new TypeError("Invalid delivery target.");
    }
    return target as DeliveryTarget;
  });
  if (new Set(deliveryTargets).size !== deliveryTargets.length) throw new TypeError("Duplicate delivery target.");
  return Object.freeze({ candidateId, name, kind: row.kind as ReuseFirstCandidateInput["kind"], originUrl, originVersion,
    source: Object.freeze({ sourceId, fromLine: fromLine as number, throughLine: throughLine as number }),
    productTier: row.productTier as ProductTier, route: row.route as ReuseFirstRoute,
    deliveryTargets: Object.freeze(deliveryTargets) });
}

function parseCandidate(value: unknown, scope: ReuseFirstScope): ReuseFirstCandidate {
  const row = exact(value, ["candidateId", "name", "kind", "scope", "origin", "source", "license", "reuse", "product", "createdAt"], "reuse candidate record");
  const recordScope = scopeOf(row.scope);
  if (json(recordScope) !== json(scope)) throw new Error("Reuse candidate project scope mismatch.");
  const origin = exact(row.origin, ["url", "version"], "candidate origin");
  const parsedOrigin = new URL(text(origin.url, "origin URL", 2048));
  if (parsedOrigin.protocol !== "https:" || parsedOrigin.username || parsedOrigin.password
    || origin.version !== null && (typeof origin.version !== "string" || !origin.version.trim() || origin.version.length > 256)) throw new Error("Reuse candidate origin is invalid.");
  const source = exact(row.source, ["sourceId", "fromLine", "throughLine", "sha256", "quote"], "candidate source evidence");
  if (!HASH.test(String(source.sha256)) || typeof source.fromLine !== "number" || typeof source.throughLine !== "number"
    || !Number.isSafeInteger(source.fromLine) || !Number.isSafeInteger(source.throughLine) || source.fromLine < 1
    || source.throughLine < source.fromLine || source.throughLine - source.fromLine > 199
    || typeof source.quote !== "string" || !source.quote.trim() || Buffer.byteLength(source.quote, "utf8") > 32 * 1024) throw new Error("Reuse source evidence is invalid.");
  const license = exact(row.license, ["status", "evidenceRefs"], "license evidence");
  const reuse = exact(row.reuse, ["status", "reusableAcrossProjects"], "reuse decision");
  if (license.status !== "unknown" || !Array.isArray(license.evidenceRefs) || license.evidenceRefs.length !== 0
    || reuse.status !== "blocked-unverified" || reuse.reusableAcrossProjects !== false) throw new Error("Unverified reuse evidence cannot grant reuse.");
  const product = exact(row.product, ["tier", "route", "deliveryTargets"], "product mapping");
  const input = parseInput({ candidateId: row.candidateId, name: row.name, kind: row.kind, originUrl: origin.url,
    originVersion: origin.version, source: { sourceId: source.sourceId, fromLine: source.fromLine, throughLine: source.throughLine },
    productTier: product.tier, route: product.route, deliveryTargets: product.deliveryTargets });
  if (typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt)) || new Date(row.createdAt).toISOString() !== row.createdAt) {
    throw new Error("Reuse candidate timestamp is invalid.");
  }
  return Object.freeze({ candidateId: input.candidateId, name: input.name, kind: input.kind, scope,
    origin: Object.freeze({ url: input.originUrl, version: input.originVersion }),
    source: Object.freeze({ sourceId: text(source.sourceId, "source ID", 160), fromLine: source.fromLine,
      throughLine: source.throughLine, sha256: source.sha256 as string, quote: source.quote }),
    license: Object.freeze({ status: "unknown", evidenceRefs: Object.freeze([] as const) }),
    reuse: Object.freeze({ status: "blocked-unverified", reusableAcrossProjects: false }),
    product: Object.freeze({ tier: input.productTier, route: input.route, deliveryTargets: input.deliveryTargets }), createdAt: row.createdAt });
}

function parseRevision(value: unknown, scope: ReuseFirstScope): ReuseFirstRevision {
  const row = exact(value, ["revisionId", "candidates"], "reuse first revision");
  const revisionId = text(row.revisionId, "revision ID", 160);
  const candidates = denseList(row.candidates, 0, MAX_CANDIDATES, "reuse candidate list").map(candidate => parseCandidate(candidate, scope));
  if (new Set(candidates.map(candidate => candidate.candidateId)).size !== candidates.length) throw new TypeError("Duplicate reuse candidate ID.");
  return Object.freeze({ revisionId, candidates: Object.freeze(candidates) });
}

/** Project-bound evidence journal. Candidate claims are recorded as reports, never as verified rights. */
export function createReuseFirstStore(scopeValue: unknown, state: ReuseFirstState, sourceReader: ReuseFirstSourceReader) {
  const scope = scopeOf(scopeValue);
  if (!state || typeof state.get !== "function" || typeof state.compareAndSet !== "function") {
    throw new Error("Unsupported Host: atomic state.compareAndSet is required.");
  }
  if (!sourceReader || typeof sourceReader.currentScope !== "function" || typeof sourceReader.readCurrentExcerpt !== "function") {
    throw new Error("A current project source reader is required.");
  }
  const journal = createRevisionJournal(scope.workspaceId, scope.projectId, state, {
    prefix: "reuse-first", parse: value => parseRevision(value, scope), revisionId: revision => revision.revisionId,
  });
  return Object.freeze({
    async current() {
      const value = await journal.current();
      return value && Object.freeze({ sequence: value.sequence, revision: parseRevision(value.revision, scope) });
    },
    async publish(input: { expectedRevisionId: string | null; revisionId: string; candidate: unknown }) {
      const candidateInput = parseInput(input.candidate);
      const current = await journal.current();
      const actualRevisionId = current?.revision.revisionId ?? null;
      if (actualRevisionId !== input.expectedRevisionId) return Object.freeze({ status: "conflict" as const, actualRevisionId });
      if (current?.revision.candidates.some(candidate => candidate.candidateId === candidateInput.candidateId)) {
        return Object.freeze({ status: "conflict" as const, actualRevisionId });
      }
      if ((current?.revision.candidates.length ?? 0) >= MAX_CANDIDATES) throw new Error("Reuse candidate limit reached.");
      const entryBytes = Buffer.byteLength(json(candidateInput), "utf8");
      if (entryBytes > MAX_ENTRY_BYTES) throw new TypeError("Reuse candidate exceeds the state limit.");
      const readerScope = scopeOf(await sourceReader.currentScope());
      if (json(readerScope) !== json(scope)) return Object.freeze({ status: "unverified" as const, reason: "source-scope-mismatch" as const });
      const rawExcerpt = await sourceReader.readCurrentExcerpt(candidateInput.source);
      const currentScope = scopeOf(await sourceReader.currentScope());
      const excerpt = rawExcerpt === null ? null : exact(rawExcerpt,
        ["workspaceId", "projectId", "sourceId", "fromLine", "throughLine", "sha256", "text"], "current source excerpt");
      if (json(currentScope) !== json(scope) || !excerpt || excerpt.workspaceId !== scope.workspaceId
        || excerpt.projectId !== scope.projectId || excerpt.sourceId !== candidateInput.source.sourceId
        || excerpt.fromLine !== candidateInput.source.fromLine || excerpt.throughLine !== candidateInput.source.throughLine
        || typeof excerpt.sha256 !== "string" || !HASH.test(excerpt.sha256) || typeof excerpt.text !== "string" || !excerpt.text.trim()
        || Buffer.byteLength(excerpt.text, "utf8") > 32 * 1024 || excerpt.sourceId.startsWith("consultation-")) {
        return Object.freeze({ status: "unverified" as const, reason: "current-project-source-evidence-required" as const });
      }
      const candidate = parseCandidate({ candidateId: candidateInput.candidateId, name: candidateInput.name, kind: candidateInput.kind,
        scope, origin: { url: candidateInput.originUrl, version: candidateInput.originVersion },
        source: { ...candidateInput.source, sha256: excerpt.sha256, quote: excerpt.text },
        license: { status: "unknown", evidenceRefs: [] },
        reuse: { status: "blocked-unverified", reusableAcrossProjects: false },
        product: { tier: candidateInput.productTier, route: candidateInput.route, deliveryTargets: candidateInput.deliveryTargets },
        createdAt: new Date().toISOString() }, scope);
      const revision = parseRevision({ revisionId: input.revisionId,
        candidates: [...(current?.revision.candidates ?? []), candidate] }, scope);
      const result = await journal.publish({ expectedBaseRevisionId: input.expectedRevisionId, revision });
      if (result.status === "conflict") return Object.freeze({ status: "conflict" as const, actualRevisionId: result.actualBaseRevisionId });
      return Object.freeze({ status: "published" as const, sequence: result.sequence, revision: result.revision });
    },
  });
}

export function reuseFirstStateKey(scopeValue: unknown): SpsStateKey {
  const scope = scopeOf(scopeValue);
  return Object.freeze({ scopeKind: "company", scopeId: scope.workspaceId, namespace: "sonpark.my-builder",
    stateKey: `reuse-first-head.v1.${hash(scope.projectId)}` });
}
