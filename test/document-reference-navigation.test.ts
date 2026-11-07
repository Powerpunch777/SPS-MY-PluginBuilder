import assert from "node:assert/strict";
import test from "node:test";
import type { BuilderDocument } from "../src/domain/model.ts";
import { resolveDocumentReference } from "../src/domain/document-reference-navigation.ts";

const hash = "a".repeat(64);
const targetPin = { sourceId: "doc:target", revisionId: "target-r1", sha256: hash };
const owner: BuilderDocument = { id: "doc:owner", title: "Owner", revisionId: "owner-r1", createdAt: "2026-11-07T00:00:00.000Z",
  text: "", sourcePins: [targetPin, { sourceId: "doc:owner", revisionId: "owner-r1", sha256: "c".repeat(64) }] };
const target: BuilderDocument = { id: "doc:target", title: "Target", revisionId: "target-r1", createdAt: "2026-11-07T00:00:00.000Z",
  text: "", sourcePins: [targetPin] };

test("only exact unique other document IDs or complete source pins resolve", () => {
  const documents = [owner, target];
  assert.deepEqual(resolveDocumentReference(documents, owner.id, { kind: "document-id", documentId: "doc:target" }),
    { status: "linked", targetId: target.id, targetTitle: target.title });
  assert.deepEqual(resolveDocumentReference(documents, owner.id, { kind: "source-pin", ...targetPin }),
    { status: "linked", targetId: target.id, targetTitle: target.title });
  assert.deepEqual(resolveDocumentReference(documents, owner.id, { kind: "document-id", documentId: "REQ-1" }), { status: "unlinked" });
  assert.deepEqual(resolveDocumentReference(documents, owner.id, { kind: "document-id", documentId: "https://example.invalid/doc:target" }),
    { status: "unlinked" });
  assert.deepEqual(resolveDocumentReference(documents, owner.id, { kind: "source-pin", ...targetPin, sha256: hash.toUpperCase() }),
    { status: "unlinked" });
  assert.deepEqual(resolveDocumentReference(documents, owner.id, { kind: "source-pin", ...targetPin, revisionId: "TARGET-r1" }),
    { status: "unlinked" });
});

test("missing, self, and duplicate matches remain non-navigable", () => {
  assert.deepEqual(resolveDocumentReference([owner], owner.id, { kind: "document-id", documentId: "missing" }), { status: "unlinked" });
  assert.deepEqual(resolveDocumentReference([owner], owner.id, { kind: "source-pin", sourceId: owner.id,
    revisionId: "owner-r1", sha256: "c".repeat(64) }), { status: "unlinked" });
  const duplicate = { ...target, title: "Second copy" };
  assert.deepEqual(resolveDocumentReference([owner, target, duplicate], owner.id,
    { kind: "document-id", documentId: target.id }), { status: "ambiguous" });
  assert.deepEqual(resolveDocumentReference([owner, target, duplicate], owner.id, { kind: "source-pin", ...targetPin }),
    { status: "ambiguous" });
});

test("accessors and malformed snapshot members return unknown without invoking getters", () => {
  let invoked = 0;
  const accessorReference = Object.defineProperty({ kind: "document-id" }, "documentId", {
    enumerable: true, get() { invoked++; return target.id; },
  });
  assert.deepEqual(resolveDocumentReference([owner, target], owner.id, accessorReference), { status: "unknown" });
  const accessorDocument = Object.defineProperty({ title: "Accessor", revisionId: "x", sourcePins: [] }, "id", {
    enumerable: true, get() { invoked++; return target.id; },
  });
  assert.deepEqual(resolveDocumentReference([owner, accessorDocument as unknown as BuilderDocument], owner.id,
    { kind: "document-id", documentId: target.id }), { status: "unknown" });
  const accessorPin = Object.defineProperty({ sourceId: target.id, revisionId: target.revisionId }, "sha256", {
    enumerable: true, get() { invoked++; return hash; },
  });
  const malformedTarget = { ...target, sourcePins: [accessorPin] } as unknown as BuilderDocument;
  assert.deepEqual(resolveDocumentReference([owner, malformedTarget], owner.id, { kind: "source-pin", ...targetPin }), { status: "unknown" });
  assert.equal(invoked, 0);
});
