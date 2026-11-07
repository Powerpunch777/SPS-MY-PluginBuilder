import { createHash } from "node:crypto";
import { composeDomainPacks, SPEC_ASSURANCE_LIMITS, type DomainPack } from "./evaluator.ts";
import { coverageRulesManifestDigest, evaluateSpecCoverage, SPEC_COVERAGE_LIMITS,
  type CoverageRulesManifest, type CoverageSourceRef, type SpecCoverageInput } from "../spec-coverage/evaluator.ts";
import type { ApprovedSpecRevision } from "../domain/specification-revisions.ts";
import { exactToolRecord } from "../lead-tool-authority.ts";
import { createRevisionJournal, type RevisionState } from "../solution-revision-store.ts";
import { parseDesignModelMaterial, type DesignModelMaterial } from "./design-model-material.ts";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const ID = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 160
  && !/[\u0000-\u001f\u007f]/u.test(value);
const HEX = /^[a-f0-9]{64}$/u;
const utf8 = new TextEncoder();
export const specAssurancePackRevisionId = (packId: string, version: string,
  identity: { specRevisionId: string; specDigest: string }, designModelDigest?: string) =>
  `d3-pack-${sha256(JSON.stringify([packId, version, identity.specRevisionId, identity.specDigest,
    ...(designModelDigest ? [designModelDigest] : [])]))}`;
export const currentBaselineSpecAssurancePackRevisionId = (packId: string, version: string,
  identity: { specRevisionId: string; specDigest: string }, baselineRevisionId: string, baselineSequence: number,
  sourceRefs: readonly SpecAssurancePackSourceRef[], designModelDigest?: string) =>
  `d3-pack-${sha256(JSON.stringify([packId, version, identity.specRevisionId, identity.specDigest, "current-baseline-v2",
    baselineRevisionId, baselineSequence, sha256(JSON.stringify(sourceRefs)), ...(designModelDigest ? [designModelDigest] : [])]))}`;
export const specAssurancePackApprovalRevisionId = (approval: Omit<SpecAssurancePackApproval, "revisionId">) =>
  `d3-pack-approval-${sha256(JSON.stringify([approval.packId, approval.proposalRevisionId, approval.proposalDigest,
    approval.baselineRevisionId, approval.baselineSequence, approval.identity, approval.designModelDigest,
    approval.user.userId, approval.user.agentId, approval.user.sessionId, approval.user.selectionRevision]))}`;

export type SpecAssurancePackSourceRef = Readonly<{
  requirementId: string;
  acId: string | null;
  sourceId: string;
  sourceDigest: string;
  revisionId: string;
}>;

export type SpecAssurancePackProposal = Readonly<{
  status: "PROPOSED";
  revisionId: string;
  workspaceId: string;
  projectId: string;
  baselineRevisionId: string;
  baselineSequence: number;
  identity: Readonly<{ workspaceId: string; projectId: string; specRevisionId: string; specDigest: string }>;
  scopeBindings: readonly Readonly<{ requirementId: string; acIds: readonly string[] }>[];
  author: Readonly<{ agentId: string; sessionId: string; runId: string; selectionRevision: number }>;
  createdAt: string;
  pack: DomainPack;
  rulesManifest: CoverageRulesManifest;
  sourceRefs: readonly SpecAssurancePackSourceRef[];
  designModel?: DesignModelMaterial;
}>;

export type SpecAssurancePackApproval = Readonly<{
  status: "APPROVED";
  revisionId: string;
  workspaceId: string;
  projectId: string;
  packId: string;
  proposalRevisionId: string;
  proposalDigest: string;
  baselineRevisionId: string;
  baselineSequence: number;
  identity: SpecAssurancePackProposal["identity"];
  designModelDigest: string | null;
  user: Readonly<{ userId: string; approvedAt: string; agentId: string; sessionId: string; selectionRevision: number }>;
}>;

export type SpecAssurancePackGap = Readonly<{
  id: string;
  fingerprint: string;
  targetId: string;
  targetKind: "requirement" | "ac";
  reason: "source-link-missing" | "coverage-rule-missing";
  detectionMethod: "bounded-pack-structure-check";
  status: "candidate";
}>;

function freezeTree<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function parseScopeBindings(value: unknown, identity: SpecAssurancePackProposal["identity"]) {
  if (!Array.isArray(value) || value.length > SPEC_ASSURANCE_LIMITS.rules) throw new TypeError("Invalid pinned specification scope.");
  const bindings = value.map(item => {
    const row = exactToolRecord(item, ["requirementId", "acIds"]);
    if (!ID(row.requirementId) || !Array.isArray(row.acIds) || row.acIds.length > 100
      || row.acIds.some(id => !ID(id)) || new Set(row.acIds).size !== row.acIds.length) throw new TypeError("Invalid pinned requirement/AC binding.");
    return Object.freeze({ requirementId: row.requirementId, acIds: Object.freeze([...row.acIds] as string[]) });
  });
  if (new Set(bindings.map(row => row.requirementId)).size !== bindings.length) throw new TypeError("Duplicate pinned requirements.");
  return Object.freeze(bindings);
}

function parseSourceRefs(value: unknown, scopeBindings: SpecAssurancePackProposal["scopeBindings"], identity: SpecAssurancePackProposal["identity"]): readonly SpecAssurancePackSourceRef[] {
  if (!Array.isArray(value) || value.length > SPEC_COVERAGE_LIMITS.listEntries) throw new TypeError("Invalid pack source references.");
  const requirements = new Map(scopeBindings.map(item => [item.requirementId, new Set(item.acIds)]));
  const refs = value.map(item => {
    const row = exactToolRecord(item, ["requirementId", "acId", "sourceId", "sourceDigest", "revisionId"]);
    if (!ID(row.requirementId) || !requirements.has(row.requirementId) || row.acId !== null
      && (!ID(row.acId) || !requirements.get(row.requirementId)!.has(row.acId))
      || !ID(row.sourceId) || typeof row.sourceDigest !== "string" || !HEX.test(row.sourceDigest)
      || row.revisionId !== identity.specRevisionId) throw new TypeError("Pack source reference is outside the current specification identity or scope.");
    return Object.freeze({ requirementId: row.requirementId, acId: row.acId as string | null,
      sourceId: row.sourceId, sourceDigest: row.sourceDigest, revisionId: row.revisionId });
  });
  const keys = refs.map(ref => `${ref.requirementId}\0${ref.acId ?? ""}\0${ref.sourceId}`);
  if (new Set(keys).size !== keys.length) throw new TypeError("Duplicate pack source references are not allowed.");
  return Object.freeze(refs);
}

function validateProposal(value: unknown, workspaceId: string, projectId: string, packId: string): SpecAssurancePackProposal {
  const row = exactToolRecord(value, ["status", "revisionId", "workspaceId", "projectId", "baselineRevisionId", "baselineSequence",
    "identity", "scopeBindings", "author", "createdAt", "pack", "rulesManifest", "sourceRefs"], ["designModel"]);
  const identity = exactToolRecord(row.identity, ["workspaceId", "projectId", "specRevisionId", "specDigest"]);
  const author = exactToolRecord(row.author, ["agentId", "sessionId", "runId", "selectionRevision"]);
  if (row.status !== "PROPOSED" || !ID(row.revisionId) || row.workspaceId !== workspaceId || row.projectId !== projectId
    || !ID(row.baselineRevisionId) || !Number.isSafeInteger(row.baselineSequence) || (row.baselineSequence as number) < 1
    || identity.workspaceId !== workspaceId || identity.projectId !== projectId || !ID(identity.specRevisionId)
    || typeof identity.specDigest !== "string" || !HEX.test(identity.specDigest)
    || typeof author.agentId !== "string" || typeof author.sessionId !== "string" || typeof author.runId !== "string"
    || !Number.isSafeInteger(author.selectionRevision) || (author.selectionRevision as number) < 1
    || typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt))
    || new Date(row.createdAt).toISOString() !== row.createdAt) throw new TypeError("Invalid assurance pack proposal identity.");
  const boundIdentity = Object.freeze({ workspaceId, projectId, specRevisionId: identity.specRevisionId as string,
    specDigest: identity.specDigest as string });
  const scopeBindings = parseScopeBindings(row.scopeBindings, boundIdentity);
  const pack = row.pack as DomainPack;
  if (!pack || pack.packId !== packId || !Array.isArray(pack.rules) || pack.rules.length > SPEC_ASSURANCE_LIMITS.rules) {
    throw new TypeError("Invalid assurance Domain Pack.");
  }
  if (!ID(pack.version)) throw new TypeError("Invalid assurance pack version.");
  composeDomainPacks([pack], boundIdentity, []);
  const manifest = row.rulesManifest as CoverageRulesManifest;
  if (!manifest || manifest.digest !== coverageRulesManifestDigest(manifest)
    || JSON.stringify(manifest.identity) !== JSON.stringify(boundIdentity)) throw new TypeError("Invalid or unpinned coverage rules manifest.");
  const sourceRefs = parseSourceRefs(row.sourceRefs, scopeBindings, boundIdentity);
  const requirementIds: string[] = scopeBindings.map(item => item.requirementId).sort();
  const acIds: string[] = [...new Set(scopeBindings.flatMap(item => item.acIds))].sort();
  if (JSON.stringify([...manifest.scope.requirementIds].sort()) !== JSON.stringify(requirementIds)
    || JSON.stringify([...manifest.scope.acIds].sort()) !== JSON.stringify(acIds)) throw new TypeError("Coverage manifest scope must match the pinned current specification.");
  const knownTargets = new Set([...requirementIds.map(id => `requirement\0${id}`), ...acIds.map(id => `ac\0${id}`)]);
  if (manifest.targets.some(target => !knownTargets.has(`${target.targetKind}\0${target.targetId}`))) {
    throw new TypeError("Coverage manifest target is outside the pinned current specification.");
  }
  if (pack.rules.some(rule => rule.requirementIds.some((id: string) => !requirementIds.includes(id)))) {
    throw new TypeError("Domain Pack rule references a requirement outside the pinned current specification.");
  }
  const proposal = {
    status: "PROPOSED" as const, revisionId: row.revisionId, workspaceId, projectId,
    baselineRevisionId: row.baselineRevisionId, baselineSequence: row.baselineSequence as number,
    identity: boundIdentity,
    scopeBindings,
    author: Object.freeze({ agentId: author.agentId as string, sessionId: author.sessionId as string,
      runId: author.runId as string, selectionRevision: author.selectionRevision as number }),
    createdAt: row.createdAt, pack, rulesManifest: manifest, sourceRefs,
  };
  const designModel = Object.hasOwn(row, "designModel")
    ? parseDesignModelMaterial(row.designModel, boundIdentity, scopeBindings.map(binding => ({ id: binding.requirementId,
      acceptanceCriteriaIds: binding.acIds })), pack, sourceRefs, true) : undefined;
  const designModelDigest = designModel ? sha256(JSON.stringify(designModel)) : undefined;
  const legacyRevisionId = specAssurancePackRevisionId(packId, pack.version, boundIdentity, designModelDigest);
  const currentBaselineRevisionId = currentBaselineSpecAssurancePackRevisionId(packId, pack.version, boundIdentity,
    row.baselineRevisionId as string, row.baselineSequence as number, sourceRefs, designModelDigest);
  if (row.revisionId !== legacyRevisionId && row.revisionId !== currentBaselineRevisionId) {
    throw new TypeError("Pack revision ID must be stable for its exact pack, model, and specification pins.");
  }
  const fullProposal = { ...proposal, ...(designModel ? { designModel } : {}) };
  if (utf8.encode(JSON.stringify(fullProposal)).byteLength > 192 * 1024) throw new TypeError("Assurance pack proposal exceeds 192 KiB.");
  const coverageInput: SpecCoverageInput = { identity: boundIdentity, scope: manifest.scope, rulesVersion: manifest.rulesVersion,
    manifest, materials: [], sourceRefs: sourceRefs as readonly CoverageSourceRef[], checks: [] };
  evaluateSpecCoverage(coverageInput);
  return freezeTree(fullProposal);
}

function validateApproval(value: unknown, workspaceId: string, projectId: string, packId: string): SpecAssurancePackApproval {
  const row = exactToolRecord(value, ["status", "revisionId", "workspaceId", "projectId", "packId", "proposalRevisionId",
    "proposalDigest", "baselineRevisionId", "baselineSequence", "identity", "designModelDigest", "user"]);
  const identity = exactToolRecord(row.identity, ["workspaceId", "projectId", "specRevisionId", "specDigest"]);
  const user = exactToolRecord(row.user, ["userId", "approvedAt", "agentId", "sessionId", "selectionRevision"]);
  if (row.status !== "APPROVED" || row.workspaceId !== workspaceId || row.projectId !== projectId || row.packId !== packId
    || !ID(row.proposalRevisionId) || typeof row.proposalDigest !== "string" || !HEX.test(row.proposalDigest)
    || !ID(row.baselineRevisionId) || !Number.isSafeInteger(row.baselineSequence) || (row.baselineSequence as number) < 1
    || identity.workspaceId !== workspaceId || identity.projectId !== projectId || !ID(identity.specRevisionId)
    || typeof identity.specDigest !== "string" || !HEX.test(identity.specDigest)
    || row.designModelDigest !== null && (typeof row.designModelDigest !== "string" || !HEX.test(row.designModelDigest))
    || !ID(user.userId) || !ID(user.agentId) || !ID(user.sessionId) || !Number.isSafeInteger(user.selectionRevision)
    || (user.selectionRevision as number) < 1 || typeof user.approvedAt !== "string" || !Number.isFinite(Date.parse(user.approvedAt))
    || new Date(user.approvedAt).toISOString() !== user.approvedAt) throw new TypeError("Invalid assurance pack user approval.");
  const approval = { status: "APPROVED" as const, workspaceId, projectId, packId,
    proposalRevisionId: row.proposalRevisionId, proposalDigest: row.proposalDigest,
    baselineRevisionId: row.baselineRevisionId, baselineSequence: row.baselineSequence as number,
    identity: Object.freeze({ workspaceId, projectId, specRevisionId: identity.specRevisionId as string,
      specDigest: identity.specDigest as string }), designModelDigest: row.designModelDigest as string | null,
    user: Object.freeze({ userId: user.userId as string, approvedAt: user.approvedAt as string,
      agentId: user.agentId as string, sessionId: user.sessionId as string,
      selectionRevision: user.selectionRevision as number }) };
  if (row.revisionId !== specAssurancePackApprovalRevisionId(approval)) throw new TypeError("Pack approval revision ID is not stable for its exact pins.");
  return freezeTree({ ...approval, revisionId: row.revisionId as string });
}

/** Immutable per-pack project revisions; proposal records are never coverage or approval evidence. */
export function createSpecAssurancePackStore(workspaceId: string, projectId: string, state: RevisionState) {
  if (!ID(projectId)) throw new TypeError("A valid Builder project ID is required.");
  const journalFor = (packId: string) => {
    if (!ID(packId)) throw new TypeError("A valid Domain Pack ID is required.");
    const prefix = `spec-pack-${sha256(packId).slice(0, 32)}`;
    return createRevisionJournal(workspaceId, projectId, state, {
      prefix,
      parse: value => validateProposal(value, workspaceId, projectId, packId),
      revisionId: value => value.revisionId,
    });
  };
  const approvalJournalFor = (packId: string) => {
    if (!ID(packId)) throw new TypeError("A valid Domain Pack ID is required.");
    const prefix = `d3-approval-${sha256(packId).slice(0, 32)}`;
    return createRevisionJournal(workspaceId, projectId, state, {
      prefix,
      parse: value => validateApproval(value, workspaceId, projectId, packId),
      revisionId: value => value.revisionId,
    });
  };
  return Object.freeze({
    current(packId: string) { return journalFor(packId).current(); },
    get(packId: string, revisionId: string) { return journalFor(packId).publishedRevision(revisionId); },
    recent(packId: string, limit?: number) { return journalFor(packId).recent(limit); },
    currentApproval(packId: string) { return approvalJournalFor(packId).current(); },
    getApproval(packId: string, revisionId: string) { return approvalJournalFor(packId).publishedRevision(revisionId); },
    async publish(packId: string, patch: unknown) {
      const journal = journalFor(packId);
      const input = exactToolRecord(patch, ["expectedBaseRevisionId", "revision"]);
      const proposal = validateProposal(input.revision, workspaceId, projectId, packId);
      const prior = await journal.publishedRevision(proposal.revisionId);
      if (prior) {
        if (JSON.stringify(prior.revision) !== JSON.stringify(proposal)) throw new TypeError("Assurance pack revision ID already contains different immutable content.");
        return Object.freeze({ status: "replayed" as const, sequence: prior.sequence, revision: prior.revision });
      }
      return journal.publish({ expectedBaseRevisionId: input.expectedBaseRevisionId, revision: proposal });
    },
    async publishApproval(packId: string, patch: unknown) {
      const journal = approvalJournalFor(packId);
      const input = exactToolRecord(patch, ["expectedBaseRevisionId", "revision"]);
      const approval = validateApproval(input.revision, workspaceId, projectId, packId);
      const prior = await journal.publishedRevision(approval.revisionId);
      if (prior) {
        if (JSON.stringify(prior.revision) !== JSON.stringify(approval)) throw new TypeError("Pack approval revision ID already contains different immutable content.");
        return Object.freeze({ status: "replayed" as const, sequence: prior.sequence, revision: prior.revision });
      }
      return journal.publish({ expectedBaseRevisionId: input.expectedBaseRevisionId, revision: approval });
    },
  });
}

/** Bounded structural omissions only; absence is a candidate gap, never a pass/fail approval. */
export function discoverSpecAssurancePackGaps(spec: ApprovedSpecRevision, manifest: CoverageRulesManifest,
  sourceRefs: readonly SpecAssurancePackSourceRef[]): readonly SpecAssurancePackGap[] {
  const targets = new Map(manifest.targets.map(target => [`${target.targetKind}\0${target.targetId}`, target.ruleIds.length > 0]));
  const linkedRequirements = new Set(sourceRefs.map(ref => ref.requirementId));
  const subjects = [
    ...spec.requirements.map(requirement => ({ id: requirement.id, kind: "requirement" as const,
      sourceLinked: linkedRequirements.has(requirement.id) })),
    ...spec.requirements.flatMap(requirement => requirement.acceptanceCriteriaIds.map(id => ({ id, kind: "ac" as const,
      sourceLinked: sourceRefs.some(ref => ref.requirementId === requirement.id && ref.acId === id) }))),
  ];
  const gaps: SpecAssurancePackGap[] = [];
  for (const subject of subjects) {
    const targetKey = `${subject.kind}\0${subject.id}`;
    const reasons: SpecAssurancePackGap["reason"][] = [];
    if (!subject.sourceLinked) reasons.push("source-link-missing");
    if (!targets.get(targetKey)) reasons.push("coverage-rule-missing");
    for (const reason of reasons) {
      const fingerprint = sha256(JSON.stringify([spec.projectId, spec.revisionId, subject.kind, subject.id, reason]));
      gaps.push(Object.freeze({ id: `D3-PACK-GAP-${fingerprint.slice(0, 32)}`, fingerprint, targetId: subject.id,
        targetKind: subject.kind, reason, detectionMethod: "bounded-pack-structure-check", status: "candidate" }));
    }
  }
  return Object.freeze(gaps.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)));
}
