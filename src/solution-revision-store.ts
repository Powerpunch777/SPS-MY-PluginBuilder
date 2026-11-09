import { createHash } from "node:crypto";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { applyLeadGraphPatch, type SolutionRevision } from "./domain/graph-revisions.ts";

export type RevisionState = {
  get(key: SpsStateKey): Promise<JsonValue | null>;
  compareAndSet?(key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue },
    value: JsonValue): Promise<{ swapped: boolean }>;
  guardedCompareAndSet?(key: SpsStateKey & { scopeKind: "company"; scopeId: string;
    guards: readonly { stateKey: string; namespace?: string; expectedValue: JsonValue }[] },
  expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue): Promise<
    { status: "committed" | "conflict" } | { status: "unsupported"; reason: "missing-guard" }
  >;
  guardedCompareAndSetWithJobWakeV1?(key: SpsStateKey & { scopeKind: "company"; scopeId: string;
    guards: readonly { stateKey: string; namespace?: string; expectedValue: JsonValue }[] },
  expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue,
  wake: Readonly<{ name: string; eventId: string; jobKey: string; payload: JsonValue }>): Promise<
    { status: "committed" | "conflict" } | { status: "unsupported"; reason: "missing-guard" }
  >;
};
export type RevisionPublicationGuard = Readonly<{ stateKey: string; namespace?: string; expectedValue: JsonValue }>;
export type RevisionJobWake = Readonly<{ name: string; eventId: string; jobKey: string; payload: JsonValue }>;
type Pointer = Readonly<{ revisionId: string; sequence: number; digest: string }>;
type Entry<T> = Readonly<{
  schemaVersion: 1 | 2;
  workspaceId: string;
  projectId: string;
  sequence: number;
  parent: Pointer | null;
  revision: T;
  revisionOrder?: readonly (readonly string[])[];
  digest: string;
}>;
type HistoryCursor = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  projectId: string;
  prefix: string;
  head: Pointer;
  afterSequence: number;
}>;
export type PublishedSolutionRevision = Readonly<{ sequence: number; revision: SolutionRevision }>;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_ENTRY_BYTES = 192 * 1024;
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const json = (value: unknown) => JSON.stringify(value);
const asJson = (value: unknown) => value as JsonValue;

// JSONB preserves values and array order, but not object key order. Keep only
// ordering metadata so existing revision IDs, bytes and Core proof paths survive.
function captureRevisionOrder(value: unknown): readonly (readonly string[])[] {
  const result: string[][] = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) { for (const child of item) visit(child); }
    else if (item !== null && typeof item === "object") {
      const keys = Object.keys(item);
      result.push(keys);
      for (const key of keys) visit((item as Record<string, unknown>)[key]);
    }
  };
  visit(JSON.parse(json(value)));
  return Object.freeze(result.map(keys => Object.freeze(keys)));
}

function restoreRevisionOrder(value: unknown, rawOrder: unknown): unknown {
  if (!Array.isArray(rawOrder) || Object.getPrototypeOf(rawOrder) !== Array.prototype || rawOrder.length > 32768
    || Reflect.ownKeys(rawOrder).length !== rawOrder.length + 1) throw new TypeError("Invalid solution revision ordering metadata.");
  let cursor = 0, visits = 0;
  const ancestors = new Set<object>();
  const restore = (item: unknown, depth: number): unknown => {
    if (depth > 64 || ++visits > 100000) throw new TypeError("Solution revision JSON exceeds its structural bound.");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || ancestors.has(item)) throw new TypeError("Invalid solution revision JSON value.");
    ancestors.add(item);
    let restored: unknown;
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || Reflect.ownKeys(item).length !== item.length + 1) throw new TypeError("Invalid solution revision JSON array.");
      restored = Array.from({ length: item.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Invalid solution revision JSON item.");
        return restore(descriptor.value, depth + 1);
      });
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new TypeError("Invalid solution revision JSON object.");
      const orderDescriptor = Object.getOwnPropertyDescriptor(rawOrder, String(cursor++));
      const keys: unknown = orderDescriptor?.enumerable && Object.hasOwn(orderDescriptor, "value") ? orderDescriptor.value : null;
      const ownKeys = Reflect.ownKeys(item);
      if (!Array.isArray(keys) || Object.getPrototypeOf(keys) !== Array.prototype || keys.length !== ownKeys.length
        || Reflect.ownKeys(keys).length !== keys.length + 1) throw new TypeError("Solution revision key order does not match its data.");
      const result: Record<string, unknown> = {};
      const seen = new Set<string>();
      for (let index = 0; index < keys.length; index++) {
        const keyDescriptor = Object.getOwnPropertyDescriptor(keys, String(index));
        const key: unknown = keyDescriptor?.enumerable && Object.hasOwn(keyDescriptor, "value") ? keyDescriptor.value : null;
        if (typeof key !== "string" || seen.has(key)) throw new TypeError("Invalid solution revision key order.");
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Invalid solution revision JSON field.");
        seen.add(key);
        Object.defineProperty(result, key, { enumerable: true, configurable: true, writable: true,
          value: restore(descriptor.value, depth + 1) });
      }
      restored = result;
    }
    ancestors.delete(item);
    return restored;
  };
  const restored = restore(value, 0);
  if (cursor !== rawOrder.length) throw new TypeError("Unused solution revision ordering metadata.");
  return restored;
}

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
export function createSolutionRevisionStore(workspaceId: string, projectId: string, state: RevisionState) {
  return createRevisionJournal(workspaceId, projectId, state, {
    prefix: "solution", parse: validatedRevision, revisionId: revision => revision.graphRevisionId,
  });
}

/** Internal Builder journal shared by solution and explicitly unapproved drafts.
 * Existing solution key names and serialized entries remain unchanged. */
export function createRevisionJournal<T>(workspaceId: string, projectId: string, state: RevisionState,
  codec: { prefix: string; parse(value: unknown): T; revisionId(value: T): string }) {
  if (typeof workspaceId !== "string" || !UUID.test(workspaceId)) throw new TypeError("A canonical Workspace ID is required.");
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(codec.prefix)) throw new TypeError("Invalid Builder revision journal prefix.");
  identifier(projectId);
  const projectKey = hash(projectId);
  const key = (stateKey: string): SpsStateKey => ({ scopeKind: "company", scopeId: workspaceId,
    namespace: "sonpark.my-builder", stateKey });
  const headKey = key(`${codec.prefix}-head.v1.${projectKey}`);
  const entryKey = (id: string) => key(`${codec.prefix}-revision.v1.${projectKey}.${hash(id)}`);

  function entryFields(value: unknown, label: string) {
    const version = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "schemaVersion") : undefined;
    return fields(value, ["schemaVersion", "workspaceId", "projectId", "sequence", "parent", "revision", "digest",
      ...(version && Object.hasOwn(version, "value") && version.value === 2 ? ["revisionOrder"] : [])], label);
  }

  function decodeRevision(row: Record<string, unknown>): T {
    return codec.parse(row.schemaVersion === 2 ? restoreRevisionOrder(row.revision, row.revisionOrder) : row.revision);
  }

  function encodeEntry(sequence: number, parent: Pointer | null, revision: T): Entry<T> {
    const body = { schemaVersion: 2 as const, workspaceId, projectId, sequence, parent, revision,
      revisionOrder: captureRevisionOrder(revision) };
    const entry = Object.freeze({ ...body, digest: hash(json(body)) });
    if (Buffer.byteLength(json(entry), "utf8") > MAX_ENTRY_BYTES) throw new TypeError("Solution revision exceeds 192 KiB; no state was changed.");
    return entry;
  }

  function parseEntry(value: unknown, expected: Pointer): Entry<T> {
    const row = entryFields(value, "solution entry");
    if (row.schemaVersion !== 1 && row.schemaVersion !== 2 || row.workspaceId !== workspaceId || row.projectId !== projectId || row.sequence !== expected.sequence
      || row.digest !== expected.digest) throw new Error("Solution revision identity mismatch.");
    const parent = row.parent === null ? null : pointer(row.parent);
    if (parent === null ? row.sequence !== 1 : parent.sequence !== expected.sequence - 1) {
      throw new Error("Solution revision history is inconsistent.");
    }
    const revision = decodeRevision(row);
    if (identifier(codec.revisionId(revision)) !== expected.revisionId) throw new Error("Solution revision ID mismatch.");
    const body = { schemaVersion: row.schemaVersion as 1 | 2, workspaceId, projectId, sequence: expected.sequence, parent, revision,
      ...(row.schemaVersion === 2 ? { revisionOrder: row.revisionOrder as readonly (readonly string[])[] } : {}) };
    if (hash(json(body)) !== row.digest) throw new Error("Solution revision digest mismatch.");
    return Object.freeze({ ...body, digest: expected.digest });
  }

  async function entryAt(ref: Pointer): Promise<Entry<T>> {
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

  function encodeHistoryCursor(cursor: HistoryCursor): string {
    const body = { schemaVersion: cursor.schemaVersion, workspaceId: cursor.workspaceId, projectId: cursor.projectId,
      prefix: cursor.prefix, head: cursor.head, afterSequence: cursor.afterSequence };
    return Buffer.from(json({ ...body, digest: hash(json(body)) }), "utf8").toString("base64url");
  }

  function decodeHistoryCursor(value: string): HistoryCursor {
    if (typeof value !== "string" || !value || value.length > 4_096) throw new TypeError("Invalid published history cursor.");
    let row: Record<string, unknown>;
    try {
      const decoded = Buffer.from(value, "base64url");
      if (decoded.toString("base64url") !== value) throw new Error("Noncanonical cursor encoding.");
      row = fields(JSON.parse(decoded.toString("utf8")),
        ["schemaVersion", "workspaceId", "projectId", "prefix", "head", "afterSequence", "digest"], "published history cursor");
    } catch {
      throw new TypeError("Invalid published history cursor.");
    }
    if (row.schemaVersion !== 1 || row.workspaceId !== workspaceId || row.projectId !== projectId || row.prefix !== codec.prefix
      || !Number.isSafeInteger(row.afterSequence) || (row.afterSequence as number) < 0) {
      throw new TypeError("Published history cursor scope or sequence is invalid.");
    }
    const ref = pointer(row.head);
    if ((row.afterSequence as number) >= ref.sequence) throw new TypeError("Published history cursor does not advance within its snapshot.");
    const body = { schemaVersion: 1 as const, workspaceId, projectId, prefix: codec.prefix, head: ref,
      afterSequence: row.afterSequence as number };
    if (row.digest !== hash(json(body))) throw new TypeError("Published history cursor digest mismatch.");
    return Object.freeze(body);
  }

  function samePointer(entry: Entry<T>, ref: Pointer): boolean {
    return entry.sequence === ref.sequence && entry.digest === ref.digest && codec.revisionId(entry.revision) === ref.revisionId;
  }

  function validatePublicationGuards(guards: readonly RevisionPublicationGuard[]): RevisionPublicationGuard[] {
    if (!Array.isArray(guards) || Object.getPrototypeOf(guards) !== Array.prototype
      || guards.length < 1 || guards.length > 64 || Reflect.ownKeys(guards).length !== guards.length + 1) {
      throw new TypeError("Guarded publication requires between 1 and 64 dense guard keys.");
    }
    const seen = new Set<string>();
    return guards.map((value, index) => {
      const hasNamespace = Boolean(value && typeof value === "object" && Object.hasOwn(value, "namespace"));
      const guard = fields(value, hasNamespace ? ["stateKey", "namespace", "expectedValue"]
        : ["stateKey", "expectedValue"], `publication guard ${index}`);
      if (typeof guard.stateKey !== "string" || !guard.stateKey || guard.stateKey.length > 200
        || guard.namespace !== undefined && (typeof guard.namespace !== "string" || !guard.namespace || guard.namespace.length > 200)
        || !Object.hasOwn(guard, "expectedValue")) throw new TypeError(`Invalid publication guard ${index}.`);
      const namespace = (guard.namespace as string | undefined) ?? "default";
      const identity = `${namespace}\0${guard.stateKey}`;
      if (seen.has(identity)) throw new TypeError("Guarded publication keys must be unique.");
      seen.add(identity);
      if (namespace === (headKey.namespace ?? "default") && guard.stateKey === headKey.stateKey) {
        throw new TypeError("Revision head cannot also be a publication guard.");
      }
      return Object.freeze({ stateKey: guard.stateKey,
        ...(guard.namespace === undefined ? {} : { namespace: guard.namespace as string }),
        expectedValue: guard.expectedValue as JsonValue });
    });
  }

  async function cas(input: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
    if (typeof state.compareAndSet !== "function") throw new Error("Unsupported Host: atomic state.compareAndSet is required.");
    const receipt = fields(await state.compareAndSet(input, expected, value), ["swapped"], "conditional state receipt");
    if (typeof receipt.swapped !== "boolean") throw new TypeError("Invalid conditional state receipt.");
    return receipt.swapped;
  }

  async function stageEntry(candidate: Entry<T>): Promise<Entry<T>> {
    const revisionId = identifier(codec.revisionId(candidate.revision));
    const storageKey = entryKey(revisionId);
    if (await cas(storageKey, { exists: false }, asJson(candidate))) return candidate;
    const raw = await state.get(storageKey);
    if (raw === null) throw new Error("Published solution revision is missing; existing state has not been repaired or replaced.");
    const row = entryFields(raw, "existing solution entry");
    const existingRevision = decodeRevision(row);
    const existing = parseEntry(raw, pointer({ revisionId: codec.revisionId(existingRevision), sequence: row.sequence, digest: row.digest }));
    if (codec.revisionId(existing.revision) !== revisionId || existing.sequence !== candidate.sequence
      || json(existing.parent) !== json(candidate.parent) || json(existing.revision) !== json(candidate.revision)) {
      throw new Error("Solution revision ID already contains different immutable content.");
    }
    // Reuse a valid v1 orphan without rewriting it or replacing its digest with v2.
    return existing;
  }

  function validateJobWake(value: unknown): RevisionJobWake {
    const row = fields(value, ["name", "eventId", "jobKey", "payload"], "revision job wake");
    for (const key of ["name", "eventId", "jobKey"] as const) {
      if (typeof row[key] !== "string" || !row[key].trim() || (row[key] as string).length > 256) {
        throw new TypeError(`Invalid revision job wake ${key}.`);
      }
    }
    return Object.freeze({ name: row.name as string, eventId: row.eventId as string,
      jobKey: row.jobKey as string, payload: row.payload as JsonValue });
  }

  async function publishGuarded(patchValue: unknown, rawGuards: readonly RevisionPublicationGuard[], wake?: RevisionJobWake) {
    const guardedWithWake = state.guardedCompareAndSetWithJobWakeV1;
    const guarded = state.guardedCompareAndSet;
    if (wake ? typeof guardedWithWake !== "function" : typeof guarded !== "function") {
      return Object.freeze({ status: "unsupported" as const,
        reason: wake ? "guarded-cas-job-wake-unavailable" as const : "guarded-cas-unavailable" as const });
    }
    const guards = validatePublicationGuards(rawGuards);
    const patch = fields(patchValue, ["expectedBaseRevisionId", "revision"], "solution patch");
    const expectedId = patch.expectedBaseRevisionId === null ? null : identifier(patch.expectedBaseRevisionId);
    const proposed = codec.parse(patch.revision);
    const proposedId = identifier(codec.revisionId(proposed));
    const current = await head();
    const actualId = current.ref?.revisionId ?? null;
    if (expectedId !== actualId) return Object.freeze({ status: "conflict" as const, actualBaseRevisionId: actualId });
    if (proposedId === actualId) throw new TypeError("A new solution revision ID is required.");
    const sequence = (current.ref?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error("Solution revision sequence is exhausted.");
    const entry = await stageEntry(encodeEntry(sequence, current.ref, proposed));
    const next = Object.freeze({ revisionId: proposedId, sequence, digest: entry.digest });
    // A rejected atomic call may have committed. Preserve the staged entry and never retry or split the wake from its head CAS.
    const guardedKey = { ...headKey, scopeKind: "company" as const, scopeId: workspaceId, guards };
    const expectedHead = current.raw === null ? { exists: false as const } : { exists: true as const, value: current.raw };
    const receiptValue = wake
      ? await guardedWithWake!.call(state, guardedKey, expectedHead, asJson(next), wake)
      : await guarded!.call(state, guardedKey, expectedHead, asJson(next));
    const statusField = receiptValue && typeof receiptValue === "object"
      ? Object.getOwnPropertyDescriptor(receiptValue, "status") : undefined;
    if (!statusField?.enumerable || !Object.hasOwn(statusField, "value")) {
      throw new TypeError("Invalid guarded publication receipt.");
    }
    const receipt = fields(receiptValue, statusField.value === "unsupported" ? ["status", "reason"] : ["status"],
      "guarded publication receipt");
    if (receipt.status === "unsupported") {
      if (receipt.reason !== "missing-guard") throw new TypeError("Invalid guarded publication receipt.");
      return Object.freeze({ status: "unsupported" as const, reason: "missing-guard" as const,
        stagedRevisionId: proposedId, expectedBaseRevisionId: actualId });
    }
    if (receipt.status === "conflict") {
      const latest = await head();
      return Object.freeze({ status: "conflict" as const,
        actualBaseRevisionId: latest.ref?.revisionId ?? null, stagedRevisionId: proposedId });
    }
    if (receipt.status !== "committed") throw new TypeError("Invalid guarded publication receipt.");
    return Object.freeze({ status: "published" as const, sequence, revision: proposed });
  }

  return Object.freeze({
    async current(): Promise<Readonly<{ sequence: number; revision: T }> | null> {
      const { entry } = await head();
      return entry && Object.freeze({ sequence: entry.sequence, revision: entry.revision });
    },

    /** Atomic point-in-time observation, not a lease or permission for a later effect. */
    async currentGuarded(rawGuards: readonly RevisionPublicationGuard[]) {
      const guarded = state.guardedCompareAndSet;
      if (typeof guarded !== "function") return Object.freeze({ status: "unsupported" as const });
      const guards = validatePublicationGuards(rawGuards);
      const captured = await head();
      if (!captured.entry || captured.raw === null) return Object.freeze({ status: "absent" as const });
      const raw = await guarded.call(state, { ...headKey, scopeKind: "company", scopeId: workspaceId, guards },
        { exists: true, value: captured.raw }, captured.raw);
      const receipt = fields(raw, raw?.status === "unsupported" ? ["status", "reason"] : ["status"], "guarded current receipt");
      if (receipt.status === "unsupported" && receipt.reason === "missing-guard") return Object.freeze({ status: "unsupported" as const });
      if (receipt.status === "conflict") return Object.freeze({ status: "stale" as const });
      if (receipt.status !== "committed") throw new TypeError("Invalid guarded current receipt.");
      return Object.freeze({ status: "current" as const, sequence: captured.entry.sequence, revision: captured.entry.revision,
        headGuard: Object.freeze({ stateKey: headKey.stateKey, namespace: headKey.namespace, expectedValue: structuredClone(captured.raw) }) });
    },

    // Follow the published chain, not a raw revision key: failed head writes can
    // leave staged entries that must never be represented as published history.
    async publishedRevision(revisionId: string, maximum = 1_000): Promise<Readonly<{ sequence: number; revision: T }> | null> {
      identifier(revisionId);
      if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_000) throw new TypeError("Published history lookup limit must be 1 through 1000.");
      let { entry } = await head();
      for (let count = 0; entry && count < maximum; count += 1) {
        if (codec.revisionId(entry.revision) === revisionId) return Object.freeze({ sequence: entry.sequence, revision: entry.revision });
        if (!entry.parent) return null;
        if (count + 1 === maximum) throw new Error("Published history lookup limit reached; absence is not established.");
        entry = await entryAt(entry.parent);
      }
      return null;
    },

    /** Snapshot-pinned published history, oldest first. New head writes do not change a cursor's result set. */
    async publishedPage(cursor: string | null = null, limit = 50) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new TypeError("Published history page size must be 1 through 50.");
      let snapshot: Entry<T> | null;
      let afterSequence = 0;
      if (cursor === null) {
        snapshot = (await head()).entry;
        if (snapshot === null) return Object.freeze({ revisions: Object.freeze([] as Readonly<{ sequence: number; revision: T }>[]), nextCursor: null });
      } else {
        const decoded = decodeHistoryCursor(cursor);
        afterSequence = decoded.afterSequence;
        const live = await head();
        snapshot = live.entry;
        while (snapshot && snapshot.sequence > decoded.head.sequence) {
          if (!snapshot.parent) { snapshot = null; break; }
          snapshot = await entryAt(snapshot.parent);
        }
        if (!snapshot || !samePointer(snapshot, decoded.head)) throw new Error("Published history cursor is not an ancestor of the current journal head.");
      }

      const snapshotPointer = Object.freeze({ revisionId: codec.revisionId(snapshot.revision),
        sequence: snapshot.sequence, digest: snapshot.digest });
      const endSequence = Math.min(snapshot.sequence, afterSequence + limit);
      const revisions: Readonly<{ sequence: number; revision: T }>[] = [];
      let entry: Entry<T> | null = snapshot;
      while (entry && entry.sequence > afterSequence) {
        if (entry.sequence <= endSequence) revisions.push(Object.freeze({ sequence: entry.sequence, revision: entry.revision }));
        if (!entry.parent) { entry = null; break; }
        entry = await entryAt(entry.parent);
      }
      if (afterSequence === 0 ? entry !== null : entry?.sequence !== afterSequence) {
        throw new Error("Published history chain does not reach the cursor sequence.");
      }
      revisions.reverse();
      if (revisions.length !== endSequence - afterSequence) throw new Error("Published history page is incomplete.");
      const nextCursor = endSequence < snapshot.sequence
        ? encodeHistoryCursor({ schemaVersion: 1, workspaceId, projectId, prefix: codec.prefix,
          head: snapshotPointer, afterSequence: endSequence })
        : null;
      return Object.freeze({ revisions: Object.freeze(revisions), nextCursor });
    },

    async recent(limit = 20) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new TypeError("History limit must be 1 through 50.");
      const current = await head();
      const revisions: Readonly<{ sequence: number; revision: T }>[] = [];
      let entry = current.entry;
      while (entry && revisions.length < limit) {
        revisions.push(Object.freeze({ sequence: entry.sequence, revision: entry.revision }));
        if (!entry.parent) { entry = null; break; }
        if (revisions.length === limit) break;
        entry = await entryAt(entry.parent);
      }
      return Object.freeze({ revisions: Object.freeze(revisions), hasMore: Boolean(entry?.parent) });
    },

    /** Inspect one unpublished immutable entry without advancing its journal head. */
    async stagedRevision(revisionId: string, expectedBaseRevisionId: string | null) {
      const wantedId = identifier(revisionId);
      const expectedId = expectedBaseRevisionId === null ? null : identifier(expectedBaseRevisionId);
      const current = await head();
      const actualId = current.ref?.revisionId ?? null;
      if (expectedId !== actualId) return Object.freeze({ status: "conflict" as const, actualBaseRevisionId: actualId });
      if (actualId === wantedId) return Object.freeze({ status: "not-staged" as const, actualBaseRevisionId: actualId });
      const raw = await state.get(entryKey(wantedId));
      if (raw === null) return Object.freeze({ status: "missing" as const, actualBaseRevisionId: actualId });
      const row = entryFields(raw, "staged solution entry");
      const revision = decodeRevision(row);
      const ref = pointer({ revisionId: codec.revisionId(revision), sequence: row.sequence, digest: row.digest });
      if (ref.revisionId !== wantedId) throw new Error("Staged solution revision ID does not match its requested key.");
      const entry = parseEntry(raw, ref);
      const expectedSequence = (current.ref?.sequence ?? 0) + 1;
      if (entry.sequence !== expectedSequence || json(entry.parent) !== json(current.ref)) {
        return Object.freeze({ status: "conflict" as const, actualBaseRevisionId: actualId });
      }
      return Object.freeze({ status: "staged" as const, sequence: entry.sequence,
        expectedBaseRevisionId: actualId, revision: entry.revision });
    },

    async publish(patchValue: unknown) {
      if (typeof state.compareAndSet !== "function") throw new Error("Unsupported Host: atomic state.compareAndSet is required.");
      // Snapshot untrusted input before awaiting Host calls; the pure validator
      // rejects accessors, mutable aliases, bad relations and dependency cycles.
      const patch = fields(patchValue, ["expectedBaseRevisionId", "revision"], "solution patch");
      const expectedId = patch.expectedBaseRevisionId === null ? null : identifier(patch.expectedBaseRevisionId);
      const proposed = codec.parse(patch.revision);
      const proposedId = identifier(codec.revisionId(proposed));
      const current = await head();
      const actualId = current.ref?.revisionId ?? null;
      if (expectedId !== actualId) return Object.freeze({ status: "conflict" as const, actualBaseRevisionId: actualId });
      if (proposedId === actualId) throw new TypeError("A new solution revision ID is required.");
      const sequence = (current.ref?.sequence ?? 0) + 1;
      if (!Number.isSafeInteger(sequence)) throw new Error("Solution revision sequence is exhausted.");
      const entry = await stageEntry(encodeEntry(sequence, current.ref, proposed));
      const next = Object.freeze({ revisionId: proposedId, sequence, digest: entry.digest });
      // A failed head CAS leaves only an unpublished staged entry. Do not erase
      // it or retry writes: a response may have been lost after a real commit.
      if (!await cas(headKey, current.raw === null ? { exists: false } : { exists: true, value: current.raw }, asJson(next))) {
        const latest = await head();
        return Object.freeze({ status: "conflict" as const, actualBaseRevisionId: latest.ref?.revisionId ?? null });
      }
      return Object.freeze({ status: "published" as const, sequence, revision: proposed });
    },

    /**
     * Server-caller-only publication guarded by authoritative source pointers.
     * The SDK validates invocation scope, guard values and bounded JSON atomically
     * with the head write. A rejected call can leave the immutable entry staged;
     * callers must inspect current state and must not delete or rewrite it.
     */
    async publishGuarded(patchValue: unknown, rawGuards: readonly RevisionPublicationGuard[]) {
      return publishGuarded(patchValue, rawGuards);
    },

    async publishGuardedWithJobWakeV1(patchValue: unknown, rawGuards: readonly RevisionPublicationGuard[], wakeValue: unknown) {
      if (typeof state.guardedCompareAndSetWithJobWakeV1 !== "function") {
        return Object.freeze({ status: "unsupported" as const, reason: "guarded-cas-job-wake-unavailable" as const });
      }
      const wake = validateJobWake(wakeValue);
      return publishGuarded(patchValue, rawGuards, wake);
    },
  });
}
