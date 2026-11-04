import type { DocumentIdentity } from "./index.ts";

/**
 * Minimal structural view of A's freshness-source-port.ts at freeze b66afe1f.
 * Kept local so B's build does not depend on a sibling checkout. If A changes
 * this boundary, compare its published FreshnessDocumentRead and
 * FreshnessEvidenceProofCandidateV1 declarations with these fields.
 */
export type CategoryScopeDocumentReadV1 = Readonly<{
  workspaceId: string;
  projectId: string;
  sourceId: string;
  document: Readonly<{
    workspaceId: string;
    projectId: string;
    id: string;
    revisionId: string;
    category: string;
    type: string;
  }>;
}>;

export type CategoryScopeProofCandidateV1 = Readonly<{
  claim: Readonly<{
    kind: "category-scope";
    workspaceId: string;
    projectId: string;
    documentId: string;
    documentRevisionId: string;
    sourceId: string;
    categoryId: string;
    documentTypeId: string;
    mappingVersion: number;
    evidenceRef: string;
  }>;
  evidenceRef: string;
  mappingVersion: number;
}>;

function isNonEmptyIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

/**
 * Converts A's per-document category mapping claim to B's identity shape.
 * This is only a lossless boundary conversion: it does not authenticate the
 * candidate, its invocation, or its evidence reference. A trusted verifier
 * must still re-read and validate the authoritative source before use.
 */
export function adaptCategoryScopeCandidateV1(input: Readonly<{
  documentRead: CategoryScopeDocumentReadV1;
  candidate: CategoryScopeProofCandidateV1;
}>): DocumentIdentity | null {
  const { documentRead, candidate } = input;
  const claim = candidate?.claim;
  const document = documentRead?.document;
  if (!claim || claim.kind !== "category-scope" || !document) return null;

  // Equality alone is insufficient at this runtime boundary: two absent or
  // otherwise malformed identifiers can compare equal. Require every scope,
  // document, source, category, type, and revision identifier to be present.
  const identifiers: unknown[] = [
    documentRead.workspaceId,
    documentRead.projectId,
    documentRead.sourceId,
    document.workspaceId,
    document.projectId,
    document.id,
    document.revisionId,
    document.category,
    document.type,
    claim.workspaceId,
    claim.projectId,
    claim.documentId,
    claim.documentRevisionId,
    claim.sourceId,
    claim.categoryId,
    claim.documentTypeId,
  ];
  if (!identifiers.every(isNonEmptyIdentifier)) return null;

  // A currently publishes numeric mappingVersion 1. Do not coerce other
  // numeric values or accept B-shaped strings from an unrecognized contract.
  if (candidate.mappingVersion !== 1 || claim.mappingVersion !== 1) return null;
  if (!isNonEmptyIdentifier(candidate.evidenceRef) || !isNonEmptyIdentifier(claim.evidenceRef)
    || candidate.evidenceRef !== claim.evidenceRef) return null;

  if (documentRead.workspaceId !== document.workspaceId || documentRead.projectId !== document.projectId
    || claim.workspaceId !== documentRead.workspaceId || claim.projectId !== documentRead.projectId
    || claim.documentId !== document.id || claim.documentRevisionId !== document.revisionId
    || claim.sourceId !== documentRead.sourceId || claim.categoryId !== document.category
    || claim.documentTypeId !== document.type) return null;

  return Object.freeze({
    workspaceId: documentRead.workspaceId,
    projectId: documentRead.projectId,
    documentId: document.id,
    category: Object.freeze({
      id: claim.categoryId,
      sourceId: claim.sourceId,
      mappingType: claim.documentTypeId,
      mappingVersion: String(claim.mappingVersion),
      mappingEvidenceRef: candidate.evidenceRef,
    }),
  });
}
