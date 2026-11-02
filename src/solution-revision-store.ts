import { createHash } from "node:crypto";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { applyLeadGraphPatch, type SolutionRevision } from "./domain/graph-revisions.ts";

type State = {
  get(key: SpsStateKey): Promise<JsonValue | null>;
  compareAndSet?(key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue },
    value: JsonValue): Promise<{ swapped: boolean }>;
};
type Pointer = Readonly<{ revisionId: string; sequence: number; digest: string }>;
type Entry = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  projectId: string;
  sequence: number;
  parent: Pointer | null;
  revision: SolutionRevision;
  digest: string;
}>;
export type PublishedSolutionRevision = Readonly<{ sequence: number; revision: SolutionRevision }>;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_ENTRY_BYTES = 192 * 1024;
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const json = (value: unknown) => JSON.stringify(value);
const asJson = (value: unknown) => value as JsonValue;

function fields(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`Invalid ${label}.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError(`Invalid ${label} fields.`);
  }
  const row: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`Invalid ${label}.${key}.`);
    row[key] = descriptor.value;
  }
  return row;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("Invalid solution revision ID.");
  }
  return value;
}

function pointer(value: unknown): Pointer {
  const row = fields(value, ["revisionId", "sequence", "digest"], "revision pointer");
  if (!Number.isSafeInteger(row.sequence) || (row.sequence as number) < 1
    || typeof row.digest !== "string" || !/^[a-f0-9]{64}$/.test(row.digest)) throw new TypeError("Invalid revision pointer.");
  return Object.freeze({ revisionId: identifier(row.revisionId), sequence: row.sequence as number, digest: row.digest });
}

function validatedRevision(value: unknown): SolutionRevision {
  const result = applyLeadGraphPatch(null, { expectedBaseRevisionId: null, revision: value });
  if (result.status !== "applied") throw new Error("Invalid solution revision.");
  identifier(result.revision.graphRevisionId);
  return result.revision;
}

/**
 * Builder-owned storage, not an authorization API or AI tool. A trusted caller
 * must verify Lead/Workspace/current-run authority before exposing publication.
 * Immutable entries are staged first; only the CAS head makes one published.
 */
export function createSolutionRevisionStore(workspaceId: string, projectId: string, state: State) {
  if (typeof workspaceId !== "string" || !UUID.test(workspaceId)) throw new TypeError("A canonical Workspace ID is required.");
  identifier(projectId);
  const projectKey = hash(projectId);
  const key = (stateKey: string): SpsStateKey => ({ scopeKind: "company", scopeId: workspaceId,
    namespace: "sonpark.my-builder", stateKey });
  const headKey = key(`solution-head.v1.${projectKey}`);
  const entryKey = (id: string) => key(`solution-revision.v1.${projectKey}.${hash(id)}`);

  function parseEntry(value: unknown, expected: Pointer): Entry {
    const row = fields(value, ["schemaVersion", "workspaceId", "projectId", "sequence", "parent", "revision", "digest"], "solution entry");
    if (row.schemaVersion !== 1 || row.workspaceId !== workspaceId || row.projectId !== projectId || row.sequence !== expected.sequence
      || row.digest !== expected.digest) throw new Error("Solution revision identity mismatch.");
    const parent = row.parent === null ? null : pointer(row.parent);
    if (parent === null ? row.sequence !== 1 : parent.sequence !== expected.sequence - 1) {
      throw new Error("Solution revision history is inconsistent.");
    }
    const revision = validatedRevision(row.revision);
    if (revision.graphRevisionId !== expected.revisionId) throw new Error("Solution revision ID mismatch.");
    const body = { schemaVersion: 1 as const, workspaceId, projectId, sequence: expected.sequence, parent, revision };
    if (hash(json(body)) !== row.digest) throw new Error("Solution revision digest mismatch.");
    return Object.freeze({ ...body, digest: expected.digest });
  }

  async function entryAt(ref: Pointer): Promise<Entry> {
    const raw = await state.get(entryKey(ref.revisionId));
    if (raw === null) throw new Error("Published solution revision is missing; existing state has not been repaired or replaced.");
    return parseEntry(raw, ref);
  }

  async function head() {
    const raw = await state.get(headKey);
    if (raw === null) return { raw, ref: null, entry: null };
    const ref = pointer(raw);
    return { raw, ref, entry: await entryAt(ref) };
  }

  async function cas(input: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
    if (typeof state.compareAndSet !== "function") throw new Error("Unsupported Host: atomic state.compareAndSet is required.");
    const receipt = fields(await state.compareAndSet(input, expected, value), ["swapped"], "conditional state receipt");
    if (typeof receipt.swapped !== "boolean") throw new TypeError("Invalid conditional state receipt.");
    return receipt.swapped;
  }

  return Object.freeze({
    async current(): Promise<PublishedSolutionRevision | null> {
      const { entry } = await head();
      return entry && Object.freeze({ sequence: entry.sequence, revision: entry.revision });
    },

    async recent(limit = 20) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new TypeError("History limit must be 1 through 50.");
      const current = await head();
      const revisions: PublishedSolutionRevision[] = [];
      let entry = current.entry;
      while (entry && revisions.length < limit) {
        revisions.push(Object.freeze({ sequence: entry.sequence, revision: entry.revision }));
        if (!entry.parent) { entry = null; break; }
        if (revisions.length === limit) break;
        entry = await entryAt(entry.parent);
      }
      return Object.freeze({ revisions: Object.freeze(revisions), hasMore: Boolean(entry?.parent) });
    },

    async publish(patchValue: unknown) {
      if (typeof state.compareAndSet !== "function") throw new Error("Unsupported Host: atomic state.compareAndSet is required.");
      // Snapshot untrusted input before awaiting Host calls; the pure validator
      // rejects accessors, mutable aliases, bad relations and dependency cycles.
      const patch = fields(patchValue, ["expectedBaseRevisionId", "revision"], "solution patch");
      const expectedId = patch.expectedBaseRevisionId === null ? null : identifier(patch.expectedBaseRevisionId);
      const proposed = validatedRevision(patch.revision);
      const current = await head();
      const actualId = current.ref?.revisionId ?? null;
      if (expectedId !== actualId) return Object.freeze({ status: "conflict" as const, actualBaseRevisionId: actualId });
      if (proposed.graphRevisionId === actualId) throw new TypeError("A new solution revision ID is required.");
      const sequence = (current.ref?.sequence ?? 0) + 1;
      if (!Number.isSafeInteger(sequence)) throw new Error("Solution revision sequence is exhausted.");
      const body = { schemaVersion: 1 as const, workspaceId, projectId, sequence, parent: current.ref, revision: proposed };
      const entry: Entry = Object.freeze({ ...body, digest: hash(json(body)) });
      if (Buffer.byteLength(json(entry), "utf8") > MAX_ENTRY_BYTES) throw new TypeError("Solution revision exceeds 192 KiB; no state was changed.");
      const next = Object.freeze({ revisionId: proposed.graphRevisionId, sequence, digest: entry.digest });
      if (!await cas(entryKey(next.revisionId), { exists: false }, asJson(entry))) {
        const existing = await entryAt(next);
        if (json(existing) !== json(entry)) throw new Error("Solution revision ID already contains different immutable content.");
      }
      // A failed head CAS leaves only an unpublished staged entry. Do not erase
      // it or retry writes: a response may have been lost after a real commit.
      if (!await cas(headKey, current.raw === null ? { exists: false } : { exists: true, value: current.raw }, asJson(next))) {
        const latest = await head();
        return Object.freeze({ status: "conflict" as const, actualBaseRevisionId: latest.ref?.revisionId ?? null });
      }
      return Object.freeze({ status: "published" as const, sequence, revision: proposed });
    },
  });
}
