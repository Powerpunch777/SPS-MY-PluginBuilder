import type { BuilderDocument } from "./model.ts";

export type DocumentReference = Readonly<{ kind: "document-id"; documentId: string }>
  | Readonly<{ kind: "source-pin"; sourceId: string; revisionId: string; sha256: string }>;
export type DocumentReferenceResolution = Readonly<{ status: "linked"; targetId: string; targetTitle: string }>
  | Readonly<{ status: "unlinked" | "ambiguous" | "unknown" }>;

type Identity = Readonly<{ id: string; title: string; revisionId: string;
  pins: readonly Readonly<{ sourceId: string; revisionId: string; sha256: string }>[] }>;
type ReadResult = Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }>;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}

function ownData(value: Record<string, unknown>, key: string): ReadResult {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return { ok: false };
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return { ok: false };
  return { ok: true, value: descriptor.value };
}

function optionalData(value: Record<string, unknown>, key: string): ReadResult {
  return Object.hasOwn(value, key) ? ownData(value, key) : { ok: true, value: undefined };
}

function identity(value: unknown): Identity | null {
  if (!plainRecord(value)) return null;
  const id = ownData(value, "id"), title = ownData(value, "title"), revisionId = ownData(value, "revisionId");
  const pinsValue = optionalData(value, "sourcePins");
  if (!id.ok || !title.ok || !revisionId.ok || !pinsValue.ok || typeof id.value !== "string" || !id.value.trim()
    || typeof title.value !== "string" || typeof revisionId.value !== "string" || !revisionId.value.trim()) return null;
  const rawPins = pinsValue.value ?? [];
  if (!Array.isArray(rawPins)
    || Object.getPrototypeOf(rawPins) !== Array.prototype
    || Reflect.ownKeys(rawPins).length !== rawPins.length + 1) return null;
  const pins: Array<{ sourceId: string; revisionId: string; sha256: string }> = [];
  for (let index = 0; index < rawPins.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(rawPins, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || !plainRecord(descriptor.value)) return null;
    const pin = descriptor.value;
    const sourceId = ownData(pin, "sourceId"), revisionId = ownData(pin, "revisionId"), sha256 = ownData(pin, "sha256");
    if (!sourceId.ok || !revisionId.ok || !sha256.ok
      || typeof sourceId.value !== "string" || !sourceId.value.trim()
      || typeof revisionId.value !== "string" || !revisionId.value.trim()
      || typeof sha256.value !== "string" || !/^[a-f0-9]{64}$/iu.test(sha256.value)) return null;
    pins.push({ sourceId: sourceId.value, revisionId: revisionId.value, sha256: sha256.value });
  }
  return { id: id.value, title: title.value, revisionId: revisionId.value, pins };
}

function validReference(value: unknown): DocumentReference | null {
  if (!plainRecord(value)) return null;
  const kind = ownData(value, "kind");
  if (!kind.ok) return null;
  if (kind.value === "document-id") {
    const keys = Reflect.ownKeys(value);
    const documentId = ownData(value, "documentId");
    return keys.length === 2 && keys.every(key => key === "kind" || key === "documentId")
      && documentId.ok && typeof documentId.value === "string" && documentId.value.trim()
      ? { kind: "document-id", documentId: documentId.value } : null;
  }
  if (kind.value === "source-pin") {
    const keys = Reflect.ownKeys(value);
    const sourceId = ownData(value, "sourceId"), revisionId = ownData(value, "revisionId"), sha256 = ownData(value, "sha256");
    return keys.length === 4 && keys.every(key => ["kind", "sourceId", "revisionId", "sha256"].includes(String(key)))
      && sourceId.ok && revisionId.ok && sha256.ok
      && typeof sourceId.value === "string" && sourceId.value.trim()
      && typeof revisionId.value === "string" && revisionId.value.trim()
      && typeof sha256.value === "string" && /^[a-f0-9]{64}$/iu.test(sha256.value)
      ? { kind: "source-pin", sourceId: sourceId.value, revisionId: revisionId.value, sha256: sha256.value } : null;
  }
  return null;
}

/** Resolve only exact references inside the supplied snapshot; no network or external URL resolution. */
export function resolveDocumentReference(documents: readonly BuilderDocument[], currentDocumentId: string,
  rawReference: unknown): DocumentReferenceResolution {
  if (!Array.isArray(documents) || Object.getPrototypeOf(documents) !== Array.prototype
    || Reflect.ownKeys(documents).length !== documents.length + 1 || typeof currentDocumentId !== "string") {
    return { status: "unknown" };
  }
  const reference = validReference(rawReference);
  if (!reference) return { status: "unknown" };
  const identities: Identity[] = [];
  for (let index = 0; index < documents.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(documents, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return { status: "unknown" };
    const parsed = identity(descriptor.value);
    if (!parsed) return { status: "unknown" };
    identities.push(parsed);
  }
  if (identities.filter(item => item.id === currentDocumentId).length !== 1) return { status: "unknown" };
  if (reference.kind === "document-id") {
    const matches = identities.filter(item => item.id === reference.documentId && item.id !== currentDocumentId);
    if (matches.length > 1) return { status: "ambiguous" };
    if (!matches.length) return { status: "unlinked" };
    return { status: "linked", targetId: matches[0]!.id, targetTitle: matches[0]!.title };
  }
  const idMatches = identities.filter(item => item.id === reference.sourceId);
  if (idMatches.length > 1) return { status: "ambiguous" };
  const target = idMatches[0];
  if (!target || target.id === currentDocumentId || target.revisionId !== reference.revisionId
    || !target.pins.some(pin => pin.sourceId === target.id && pin.revisionId === target.revisionId
      && pin.sha256 === reference.sha256)) return { status: "unlinked" };
  return { status: "linked", targetId: target.id, targetTitle: target.title };
}
