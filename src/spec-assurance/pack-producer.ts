import { createHash } from "node:crypto";
import type { JsonValue, SpsActionContext, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { createDesignBaselineStore } from "../design-baseline-tools.ts";
import type { ApprovedSpecRevision } from "../domain/specification-revisions.ts";
import { readLeadUserSource, readLeadUserTurn } from "../lead-conversations.ts";
import { exactToolRecord, parseLeadToolContext, requireLeadFormalPublicationAuthority, resolveLeadToolAuthority } from "../lead-tool-authority.ts";
import { createSpecAssurancePackStore, discoverSpecAssurancePackGaps, type SpecAssurancePackProposal,
  currentBaselineSpecAssurancePackRevisionId, specAssurancePackApprovalRevisionId, specAssurancePackRevisionId,
  type SpecAssurancePackApproval,
  type SpecAssurancePackSourceRef } from "./pack-store.ts";
import { firstDesignReviewApprovalRevision } from "../domain/design-baseline.ts";
import { createCurrentBaselineAssuranceProvider } from "./current-baseline-provider.ts";
import { parseDesignModelMaterial, designModelMaterialDigest } from "./design-model-material.ts";
import type { CoverageRulesManifest } from "../spec-coverage/evaluator.ts";
import { coverageRulesManifestDigest, SPEC_COVERAGE_LIMITS } from "../spec-coverage/evaluator.ts";
import type { DomainPack } from "./evaluator.ts";
import type { RevisionState } from "../solution-revision-store.ts";

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const ID = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 160
  && !/[\u0000-\u001f\u007f]/u.test(value);

function safeSnapshot(value: unknown, ancestors = new WeakSet<object>(), depth = 0): unknown {
  if (depth > 64) throw new TypeError("Pack proposal nesting exceeds the bounded JSON limit.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value)) throw new TypeError("Pack proposal must be bounded JSON data.");
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError("Pack proposal arrays must be dense JSON arrays.");
    ancestors.add(value);
    const result = Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Pack proposal arrays must contain data values.");
      return safeSnapshot(descriptor.value, ancestors, depth + 1);
    });
    ancestors.delete(value);
    return result;
  }
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Pack proposal records must be plain JSON objects.");
  ancestors.add(value);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError("Pack proposal keys must be strings.");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Pack proposal records must contain data values.");
    result[key] = safeSnapshot(descriptor.value, ancestors, depth + 1);
  }
  ancestors.delete(value);
  return result;
}

function id(value: unknown, label: string): string {
  if (!ID(value)) throw new TypeError(`${label} must be a bounded nonempty identifier.`);
  return value;
}

function buildManifest(input: Record<string, unknown>, spec: ApprovedSpecRevision, identity: DomainPack["identity"]): CoverageRulesManifest {
  const rulesVersion = id(input.rulesVersion, "rulesVersion");
  if (!Array.isArray(input.coverageRules) || !Array.isArray(input.coverageTargets)) throw new TypeError("Coverage rules and targets are required.");
  const manifestBase = {
    identity,
    scope: { requirementIds: spec.requirements.map(item => item.id).sort(),
      acIds: [...new Set(spec.requirements.flatMap(item => item.acceptanceCriteriaIds))].sort() },
    rulesVersion,
    rules: input.coverageRules,
    targets: input.coverageTargets,
    digest: "0".repeat(64),
  };
  const manifest = { ...manifestBase, digest: coverageRulesManifestDigest(manifestBase) } as CoverageRulesManifest;
  return manifest;
}

export { SPEC_ASSURANCE_PACK_PROPOSAL_TOOL } from "./tool-declarations.mjs";

/** Main-only producer entry point; proposal writes are not approval evidence. */
export async function proposeSpecAssurancePack(params: unknown, runContext: unknown,
  platform: SpsPlatformInvocationContext) {
  const raw = exactToolRecord(params, ["projectId", "expectedBaseRevisionId", "packId", "version", "applicability", "rules",
    "transitions", "exceptions", "excludedCombinations", "rulesVersion", "coverageRules", "coverageTargets", "sourceRefs"], ["designModel"]);
  const snapshot = safeSnapshot(raw) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > SPEC_COVERAGE_LIMITS.serializedInputBytes) throw new TypeError("Pack proposal input exceeds the bounded JSON limit.");
  const context = parseLeadToolContext(runContext);
  const projectId = id(snapshot.projectId, "projectId");
  if (projectId !== context.companyId) throw new TypeError("Pack proposal requires the authenticated Workspace project.");
  const packId = id(snapshot.packId, "packId");
  const version = id(snapshot.version, "version");
  const expectedBaseRevisionId = snapshot.expectedBaseRevisionId === null ? null : id(snapshot.expectedBaseRevisionId, "expectedBaseRevisionId");
  const authority = await resolveLeadToolAuthority(context, platform);
  requireLeadFormalPublicationAuthority(authority);
  const state = platform.state as typeof platform.state & RevisionState;
  const baselineStore = createDesignBaselineStore(context.companyId, projectId, state);
  const baseline = await baselineStore.current();
  if (!baseline) throw new Error("A current approved design baseline is required before proposing a pack.");
  if (baseline.revision.author.agentId !== context.agentId || baseline.revision.author.selectionRevision !== authority.selectionRevision) {
    throw new Error("The current baseline author is not the active Lead selection.");
  }
  const spec = baseline.revision.specification;
  const identity = Object.freeze({ workspaceId: context.companyId, projectId,
    specRevisionId: spec.revisionId, specDigest: hash(JSON.stringify(spec)) });
  if (spec.approvalEvidenceRef !== baseline.revision.userDecision.sourceId) throw new Error("Current specification source binding is inconsistent.");
  const sourceId = baseline.revision.userDecision.sourceId;
  const firstReviewRevisionId = firstDesignReviewApprovalRevision(sourceId);
  if (firstReviewRevisionId === null && !sourceId.startsWith("lead-turn:")) {
    throw new Error("Current baseline source reference is unsupported.");
  }
  const currentProvider = firstReviewRevisionId === null ? null : createCurrentBaselineAssuranceProvider({
    workspaceId: context.companyId, projectId, sessions: authority.sessions, platform,
  });
  let verifiedFirstReviewRefs: readonly SpecAssurancePackSourceRef[] | null = null;
  let verifiedMainSourceText: string | null = null;
  const verifyCurrentBoundary = async () => {
    await authority.check();
    const currentBaseline = await baselineStore.current();
    if (!currentBaseline || currentBaseline.sequence !== baseline.sequence
      || JSON.stringify(currentBaseline.revision) !== JSON.stringify(baseline.revision)) {
      throw new Error("The current baseline changed during pack proposal. Refresh without automatically retrying.");
    }
    if (currentProvider) {
      const snapshot = await currentProvider({ identity, requirementIds: spec.requirements.map(requirement => requirement.id) });
      if (!snapshot || JSON.stringify(snapshot.coverageInput.identity) !== JSON.stringify(identity)
        || snapshot.coverageInput.sourceRefs.length === 0) {
        throw new Error("The exact approved first-review bundle and its original requirement source pins could not be verified.");
      }
      const refs = snapshot.coverageInput.sourceRefs.map(ref => {
        if (ref.revisionId !== spec.revisionId || ref.sourceId === sourceId) {
          throw new Error("First-review approval references are not original customer-source pins.");
        }
        return Object.freeze({ requirementId: ref.requirementId, acId: ref.acId, sourceId: ref.sourceId,
          sourceDigest: ref.sourceDigest, revisionId: ref.revisionId });
      });
      if (verifiedFirstReviewRefs && JSON.stringify(refs) !== JSON.stringify(verifiedFirstReviewRefs)) {
        throw new Error("Approved first-review source pins changed during pack proposal.");
      }
      verifiedFirstReviewRefs ??= Object.freeze(refs);
      return baseline.revision.userDecision.sourceSha256;
    }
    const sourceRequestId = sourceId.slice("lead-turn:".length);
    const sourceTurn = await readLeadUserTurn(sourceRequestId, authority.sessions, platform);
    const source = await readLeadUserSource(sourceRequestId, authority.sessions, platform);
    const sourceDigest = hash(source.text);
    if (sourceTurn.workspaceId !== context.companyId || sourceTurn.channel !== "main"
      || sourceTurn.sessionId !== baseline.revision.author.sessionId || sourceTurn.runId !== baseline.revision.author.runId
      || sourceTurn.selectionRevision !== baseline.revision.author.selectionRevision || source.id !== sourceId
      || sourceDigest !== baseline.revision.userDecision.sourceSha256) throw new Error("Baseline Main source bytes or author binding could not be verified.");
    verifiedMainSourceText = source.text;
    return sourceDigest;
  };
  const sourceDigest = await verifyCurrentBoundary();

  if (!Array.isArray(snapshot.sourceRefs)) throw new TypeError("Pack source references are required.");
  const sourceRefs = snapshot.sourceRefs.map(value => {
    const ref = exactToolRecord(value, ["requirementId", "acId", "sourceId"]);
    if (currentProvider) {
      const pinned = verifiedFirstReviewRefs?.find(candidate => candidate.requirementId === ref.requirementId
        && candidate.acId === ref.acId && candidate.sourceId === ref.sourceId);
      if (!pinned) throw new TypeError("First-review pack source references must match an exact approved requirement/AC-to-original-source pin.");
      return pinned;
    }
    if (ref.sourceId !== sourceId) throw new TypeError("Pack source references must point to the current baseline's actual Main user source.");
    return { requirementId: ref.requirementId, acId: ref.acId, sourceId, sourceDigest, revisionId: spec.revisionId };
  }) as readonly SpecAssurancePackSourceRef[];
  const pack = {
    packId, version, identity,
    applicability: snapshot.applicability,
    rules: snapshot.rules,
    transitions: snapshot.transitions,
    exceptions: snapshot.exceptions,
    excludedCombinations: snapshot.excludedCombinations,
  } as DomainPack;
  const rulesManifest = buildManifest(snapshot, spec, identity);
  if (Object.hasOwn(snapshot, "designModel") && currentProvider) {
    throw new TypeError("A first-design review already owns its optional static design model.");
  }
  const designModel = Object.hasOwn(snapshot, "designModel")
    ? parseDesignModelMaterial(snapshot.designModel, identity, spec.requirements, pack, sourceRefs, false,
      new Map(sourceRefs.map(ref => [ref.sourceId, verifiedMainSourceText ?? ""]))) : undefined;
  const modelDigest = designModel ? designModelMaterialDigest(designModel) : undefined;
  const revisionId = currentProvider
    ? specAssurancePackRevisionId(packId, version, identity, modelDigest)
    : currentBaselineSpecAssurancePackRevisionId(packId, version, identity, baseline.revision.revisionId,
      baseline.sequence, sourceRefs, modelDigest);
  const existing = await createSpecAssurancePackStore(context.companyId, projectId, state).get(packId, revisionId);
  const proposal: SpecAssurancePackProposal = Object.freeze({ status: "PROPOSED", revisionId,
    workspaceId: context.companyId, projectId, baselineRevisionId: baseline.revision.revisionId,
    baselineSequence: baseline.sequence, identity,
    scopeBindings: Object.freeze(spec.requirements.map(requirement => Object.freeze({ requirementId: requirement.id,
      acIds: Object.freeze([...requirement.acceptanceCriteriaIds]) }))),
    author: existing?.revision.author ?? Object.freeze({ agentId: context.agentId, sessionId: context.sessionId, runId: context.runId,
      selectionRevision: authority.selectionRevision }),
    createdAt: existing?.revision.createdAt ?? new Date().toISOString(), pack, rulesManifest, sourceRefs: Object.freeze(sourceRefs),
    ...(designModel ? { designModel } : {}) });

  await verifyCurrentBoundary();
  const guardedState: RevisionState = {
    get: async key => { await verifyCurrentBoundary(); const value = await state.get(key); await verifyCurrentBoundary(); return value; },
    compareAndSet: state.compareAndSet ? async (...args) => {
      await verifyCurrentBoundary(); const result = await state.compareAndSet!(...args); await verifyCurrentBoundary(); return result;
    } : undefined,
  };
  const store = createSpecAssurancePackStore(context.companyId, projectId, guardedState);
  const result = await store.publish(packId, { expectedBaseRevisionId, revision: proposal });
  await authority.check();
  const gaps = discoverSpecAssurancePackGaps(spec, rulesManifest, sourceRefs);
  return { content: "Versioned Domain Pack proposal stored. This proposal is not Baseline approval, source-coverage evidence, QA, or permission to execute.",
    data: { proposal: result, gaps } as unknown as JsonValue };
}

/** Authenticated user confirmation for one exact current-Baseline pack proposal; never publishes a Baseline. */
export async function confirmCurrentBaselineSpecAssurancePack(params: unknown,
  context: SpsActionContext & SpsPlatformInvocationContext) {
  if (context.actor.type !== "user" || context.actor.companyId !== context.companyId || !ID(context.actor.userId)) {
    throw new Error("An authenticated Builder user action is required.");
  }
  const input = exactToolRecord(params, ["projectId", "packId", "expectedProposalRevisionId", "expectedBaselineRevisionId",
    "expectedApprovalRevisionId"]);
  if (!ID(input.projectId) || input.projectId !== context.companyId || !ID(input.packId)
    || !ID(input.expectedProposalRevisionId) || !ID(input.expectedBaselineRevisionId)
    || input.expectedApprovalRevisionId !== null && !ID(input.expectedApprovalRevisionId)) {
    throw new TypeError("Exact project, proposal, current Baseline, and observed approval head are required.");
  }
  const projectId = input.projectId;
  const state = context.state as typeof context.state & RevisionState;
  const baselineStore = createDesignBaselineStore(context.companyId, projectId, state);
  const baseline = await baselineStore.current();
  if (!baseline || baseline.revision.revisionId !== input.expectedBaselineRevisionId) return { status: "stale" as const };
  if (!baseline.revision.userDecision.sourceId.startsWith("lead-turn:")) {
    throw new Error("Follow-up pack confirmation requires an exact current Main user-turn decision source.");
  }
  const store = createSpecAssurancePackStore(context.companyId, projectId, state);
  const current = await store.current(input.packId);
  if (!current || current.revision.revisionId !== input.expectedProposalRevisionId
    || current.revision.baselineRevisionId !== baseline.revision.revisionId
    || current.revision.baselineSequence !== baseline.sequence
    || JSON.stringify(current.revision.identity) !== JSON.stringify({ workspaceId: context.companyId, projectId,
      specRevisionId: baseline.revision.specification.revisionId, specDigest: hash(JSON.stringify(baseline.revision.specification)) })) {
    return { status: "stale" as const };
  }
  const proposal = current.revision;
  const leadContext = parseLeadToolContext({ companyId: context.companyId, agentId: proposal.author.agentId,
    runId: proposal.author.runId, sessionId: proposal.author.sessionId });
  const authority = await resolveLeadToolAuthority(leadContext, context);
  requireLeadFormalPublicationAuthority(authority);
  const sourceId = baseline.revision.userDecision.sourceId;
  const requestId = sourceId.slice("lead-turn:".length);
  const verifyBoundary = async () => {
    await authority.check();
    const latestBaseline = await baselineStore.current();
    const latestProposal = await store.current(input.packId as string);
    const sourceTurn = await readLeadUserTurn(requestId, authority.sessions, context);
    const source = await readLeadUserSource(requestId, authority.sessions, context);
    const sourceDigest = hash(source.text);
    if (!latestBaseline || latestBaseline.sequence !== baseline.sequence
      || JSON.stringify(latestBaseline.revision) !== JSON.stringify(baseline.revision)
      || !latestProposal || latestProposal.revision.revisionId !== proposal.revisionId
      || JSON.stringify(latestProposal.revision) !== JSON.stringify(proposal)
      || sourceTurn.workspaceId !== context.companyId || sourceTurn.channel !== "main"
      || sourceTurn.sessionId !== baseline.revision.author.sessionId || sourceTurn.runId !== baseline.revision.author.runId
      || sourceTurn.selectionRevision !== baseline.revision.author.selectionRevision || source.id !== sourceId
      || sourceDigest !== baseline.revision.userDecision.sourceSha256
      || proposal.author.agentId !== authority.context.agentId || proposal.author.sessionId !== authority.context.sessionId
      || proposal.author.selectionRevision !== authority.selectionRevision
      || proposal.sourceRefs.some(ref => ref.sourceId !== sourceId || ref.sourceDigest !== sourceDigest
        || ref.revisionId !== baseline.revision.specification.revisionId)) {
      throw new Error("Current Main source, Baseline, proposal pins, or Lead selection changed during pack confirmation.");
    }
    return sourceDigest;
  };
  await verifyBoundary();
  const approvals = await store.currentApproval(input.packId);
  const expectedApprovalRevisionId = input.expectedApprovalRevisionId as string | null;
  const currentApproval = approvals?.revision ?? null;
  if (currentApproval && currentApproval.proposalRevisionId === proposal.revisionId
    && currentApproval.proposalDigest === hash(JSON.stringify(proposal))
    && currentApproval.baselineRevisionId === baseline.revision.revisionId
    && currentApproval.baselineSequence === baseline.sequence
    && currentApproval.user.userId === context.actor.userId
    && currentApproval.user.selectionRevision === authority.selectionRevision) {
    return { status: "existing" as const, approval: approvals };
  }
  if ((currentApproval?.revisionId ?? null) !== expectedApprovalRevisionId) return { status: "conflict" as const,
    approvalRevisionId: currentApproval?.revisionId ?? null };
  const materialDigest = proposal.designModel ? designModelMaterialDigest(proposal.designModel) : null;
  const base = { status: "APPROVED" as const, workspaceId: context.companyId, projectId, packId: input.packId as string,
    proposalRevisionId: proposal.revisionId, proposalDigest: hash(JSON.stringify(proposal)),
    baselineRevisionId: baseline.revision.revisionId, baselineSequence: baseline.sequence,
    identity: proposal.identity, designModelDigest: materialDigest,
    user: Object.freeze({ userId: context.actor.userId, approvedAt: new Date().toISOString(), agentId: authority.context.agentId,
      sessionId: authority.context.sessionId, selectionRevision: authority.selectionRevision }) };
  const approval: SpecAssurancePackApproval = Object.freeze({ ...base, revisionId: specAssurancePackApprovalRevisionId(base) });
  const guardedState: RevisionState = {
    get: async key => { await verifyBoundary(); const value = await state.get(key); await verifyBoundary(); return value; },
    compareAndSet: state.compareAndSet ? async (...args) => {
      await verifyBoundary(); const result = await state.compareAndSet!(...args); await verifyBoundary(); return result;
    } : undefined,
  };
  const guardedStore = createSpecAssurancePackStore(context.companyId, projectId, guardedState);
  const result = await guardedStore.publishApproval(input.packId, { expectedBaseRevisionId: expectedApprovalRevisionId, revision: approval });
  await authority.check();
  return { status: result.status, approval: result };
}
