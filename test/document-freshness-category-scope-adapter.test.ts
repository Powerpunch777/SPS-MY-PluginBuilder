import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptCategoryScopeCandidateV1,
  type CategoryScopeDocumentReadV1,
  type CategoryScopeProofCandidateV1,
} from "../src/document-freshness/category-scope-adapter.ts";

// Representative of A's FreshnessDocumentRead / ProjectDocumentRecord shape
// at freeze b66afe1f. Extra canonical fields are deliberately irrelevant here.
const documentRead: CategoryScopeDocumentReadV1 = Object.freeze({
  workspaceId: "workspace-1",
  projectId: "project-1",
  sourceId: "journal:consultations",
  document: Object.freeze({
    workspaceId: "workspace-1", projectId: "project-1", id: "consultation:doc-1", category: "consultation",
    type: "consultation-message", revisionId: "doc-rev-7",
  }),
});

// Structural compatibility check for A's numeric mappingVersion/evidence shape.
const candidate: CategoryScopeProofCandidateV1 = Object.freeze({
  claim: Object.freeze({
    kind: "category-scope", workspaceId: "workspace-1", projectId: "project-1", documentId: "consultation:doc-1",
    documentRevisionId: "doc-rev-7", sourceId: "journal:consultations", categoryId: "consultation",
    documentTypeId: "consultation-message", mappingVersion: 1, evidenceRef: "builder:document-category-type-map:v1",
  }),
  evidenceRef: "builder:document-category-type-map:v1",
  mappingVersion: 1,
});

function adaptRuntime(read: unknown, proof: unknown) {
  return adaptCategoryScopeCandidateV1({
    documentRead: read as CategoryScopeDocumentReadV1,
    candidate: proof as CategoryScopeProofCandidateV1,
  });
}

function readWith(
  top: Record<string, unknown> = {},
  document: Record<string, unknown> = {},
): unknown {
  return { ...documentRead, ...top, document: { ...documentRead.document, ...document } };
}

function candidateWith(
  outer: Record<string, unknown> = {},
  claim: Record<string, unknown> = {},
): unknown {
  return { ...candidate, ...outer, claim: { ...candidate.claim, ...claim } };
}

test("converts the exact category-scope claim and preserves numeric version as B's string", () => {
  const result = adaptCategoryScopeCandidateV1({ documentRead, candidate });
  assert.deepEqual(result, {
    workspaceId: "workspace-1", projectId: "project-1", documentId: "consultation:doc-1",
    category: { id: "consultation", sourceId: "journal:consultations", mappingType: "consultation-message",
      mappingVersion: "1", mappingEvidenceRef: "builder:document-category-type-map:v1" },
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(result && Object.isFrozen(result.category));
});

test("accepts the minimal structural shape published by A's category-scope proof candidate", () => {
  assert.ok(adaptCategoryScopeCandidateV1({ documentRead, candidate }));
});

test("fails closed when source, document revision, or claim binding differs", () => {
  assert.equal(adaptCategoryScopeCandidateV1({ documentRead, candidate: {
    ...candidate, claim: { ...candidate.claim, sourceId: "journal:other" },
  } }), null);
  assert.equal(adaptCategoryScopeCandidateV1({ documentRead, candidate: {
    ...candidate, claim: { ...candidate.claim, documentRevisionId: "doc-rev-old" },
  } }), null);
  assert.equal(adaptCategoryScopeCandidateV1({ documentRead, candidate: {
    ...candidate, claim: { ...candidate.claim, documentId: "consultation:other" },
  } }), null);
  assert.equal(adaptCategoryScopeCandidateV1({ documentRead: readWith({}, { workspaceId: "workspace-other" }) as CategoryScopeDocumentReadV1, candidate }), null);
  assert.equal(adaptCategoryScopeCandidateV1({ documentRead: readWith({}, { projectId: "project-other" }) as CategoryScopeDocumentReadV1, candidate }), null);
  assert.equal(adaptCategoryScopeCandidateV1({ documentRead, candidate: {
    ...candidate, claim: { ...candidate.claim, workspaceId: "workspace-other" },
  } }), null);
  assert.equal(adaptCategoryScopeCandidateV1({ documentRead, candidate: {
    ...candidate, claim: { ...candidate.claim, projectId: "project-other" },
  } }), null);
  assert.equal(adaptCategoryScopeCandidateV1({ documentRead: readWith({}, { category: "decision" }) as CategoryScopeDocumentReadV1, candidate }), null);
  assert.equal(adaptCategoryScopeCandidateV1({ documentRead: readWith({}, { type: "other-type" }) as CategoryScopeDocumentReadV1, candidate }), null);
  assert.equal(adaptCategoryScopeCandidateV1({ documentRead: readWith({ sourceId: "journal:other" }) as CategoryScopeDocumentReadV1, candidate }), null);
  assert.equal(adaptCategoryScopeCandidateV1({ documentRead, candidate: {
    ...candidate, claim: { ...candidate.claim, categoryId: "decision" },
  } }), null);
  assert.equal(adaptCategoryScopeCandidateV1({ documentRead, candidate: {
    ...candidate, claim: { ...candidate.claim, documentTypeId: "other-type" },
  } }), null);
});

test("fails closed when matching required identifiers are absent or malformed", () => {
  const cases: Array<[string, unknown, unknown]> = [
    ["workspace", readWith({ workspaceId: undefined }, { workspaceId: undefined }), candidateWith({}, { workspaceId: undefined })],
    ["project", readWith({ projectId: undefined }, { projectId: undefined }), candidateWith({}, { projectId: undefined })],
    ["source", readWith({ sourceId: undefined }), candidateWith({}, { sourceId: undefined })],
    ["document", readWith({}, { id: undefined }), candidateWith({}, { documentId: undefined })],
    ["revision", readWith({}, { revisionId: undefined }), candidateWith({}, { documentRevisionId: undefined })],
    ["category", readWith({}, { category: undefined }), candidateWith({}, { categoryId: undefined })],
    ["type", readWith({}, { type: undefined }), candidateWith({}, { documentTypeId: undefined })],
  ];

  for (const [name, malformedRead, malformedCandidate] of cases) {
    assert.equal(adaptRuntime(malformedRead, malformedCandidate), null, `${name} identifiers must be present`);
  }

  assert.equal(adaptRuntime(readWith({ workspaceId: 7 }, { workspaceId: 7 }), candidateWith({}, { workspaceId: 7 })), null,
    "matching numeric workspace identifiers are malformed");
  assert.equal(adaptRuntime(readWith({}, { id: "   " }), candidateWith({}, { documentId: "   " })), null,
    "matching blank document identifiers are malformed");
  assert.equal(adaptRuntime(readWith(), candidateWith({}, { evidenceRef: undefined })), null,
    "missing claim evidence is malformed");
});

test("rejects ASCII controls in every identifier and both evidence references", () => {
  const identifierFields: Array<[string, "read" | "document" | "claim", string]> = [
    ["read workspace", "read", "workspaceId"],
    ["read project", "read", "projectId"],
    ["source", "read", "sourceId"],
    ["document workspace", "document", "workspaceId"],
    ["document project", "document", "projectId"],
    ["document id", "document", "id"],
    ["document revision", "document", "revisionId"],
    ["document category", "document", "category"],
    ["document type", "document", "type"],
    ["claim workspace", "claim", "workspaceId"],
    ["claim project", "claim", "projectId"],
    ["claim document", "claim", "documentId"],
    ["claim revision", "claim", "documentRevisionId"],
    ["claim source", "claim", "sourceId"],
    ["claim category", "claim", "categoryId"],
    ["claim type", "claim", "documentTypeId"],
  ];

  for (const [label, location, field] of identifierFields) {
    for (const control of ["\u0001", "\u007f"]) {
      const read = location === "read" ? readWith({ [field]: `value${control}` })
        : location === "document" ? readWith({}, { [field]: `value${control}` }) : readWith();
      const proof = location === "claim" ? candidateWith({}, { [field]: `value${control}` }) : candidate;
      assert.equal(adaptRuntime(read, proof), null, `${label} containing U+${control.charCodeAt(0).toString(16).padStart(4, "0")} must be rejected`);
    }
  }

  for (const control of ["\u0001", "\u007f"]) {
    assert.equal(adaptRuntime(readWith(), candidateWith({ evidenceRef: `evidence${control}` })), null,
      "candidate evidence reference containing an ASCII control must be rejected");
    assert.equal(adaptRuntime(readWith(), candidateWith({}, { evidenceRef: `evidence${control}` })), null,
      "claim evidence reference containing an ASCII control must be rejected");
  }
});

test("fails closed for an unsupported mapping version or inconsistent evidence reference", () => {
  assert.equal(adaptCategoryScopeCandidateV1({ documentRead, candidate: {
    ...candidate, mappingVersion: 2 as unknown as 1,
  } }), null);
  assert.equal(adaptCategoryScopeCandidateV1({ documentRead, candidate: {
    ...candidate, claim: { ...candidate.claim, mappingVersion: 2 },
  } }), null);
  assert.equal(adaptCategoryScopeCandidateV1({ documentRead, candidate: {
    ...candidate, evidenceRef: "different-ref",
  } }), null);
  assert.equal(adaptRuntime(readWith(), candidateWith({ evidenceRef: " " })), null);
  assert.equal(adaptRuntime(readWith(), candidateWith({}, { evidenceRef: " " })), null,
    "blank claim evidence is rejected even when the candidate evidence is present");
});
