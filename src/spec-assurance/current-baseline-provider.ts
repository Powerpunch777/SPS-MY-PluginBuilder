import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { createDesignBaselineStore } from "../design-baseline-tools.ts";
import { firstDesignReviewApprovalRevision, type DesignBaseline } from "../domain/design-baseline.ts";
import type { DesignDraft } from "../domain/design-drafts.ts";
import type { BuilderLeadSessions } from "../domain/model.ts";
import { createEmptyBuilderSnapshot, parseBuilderSnapshot } from "../domain/snapshot.ts";
import { readLeadUserSource, readLeadUserTurn } from "../lead-conversations.ts";
import type { RevisionState } from "../solution-revision-store.ts";
import type { CoverageMaterial, CoverageScope } from "../spec-coverage/evaluator.ts";
import { readFirstDesignReviewRevision } from "./review-first-design.ts";
import { evaluateSpecAssurance, type AssuranceCoverageProvider, type AssuranceCoverageQuery, type DomainPack, type SpecAssuranceAuthoritySnapshot } from "./evaluator.ts";
import { rebindDesignModelMaterial } from "./design-model-material.ts";
import { coverageRulesManifestDigest, type CoverageCheck } from "../spec-coverage/evaluator.ts";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export type CurrentBaselineSourceFailureReason = "original-source-unavailable" | "original-source-digest-mismatch"
  | "original-source-changed-during-read";

export class CurrentBaselineSourceError extends Error {
  readonly code = "CURRENT_BASELINE_SOURCE_UNAVAILABLE";
  readonly reason: CurrentBaselineSourceFailureReason;

  constructor(reason: CurrentBaselineSourceFailureReason, cause?: unknown) {
    super(`Current baseline source verification failed: ${reason}`);
    this.name = "CurrentBaselineSourceError";
    this.reason = reason;
    if (cause !== undefined) Object.defineProperty(this, "cause", { value: cause, configurable: true });
  }
}

function sourceFailure(reason: CurrentBaselineSourceFailureReason, cause?: unknown): CurrentBaselineSourceError {
  return new CurrentBaselineSourceError(reason, cause);
}

function matchesPublishedDraft(draft: DesignDraft, baseline: DesignBaseline): boolean {
  const specContent = (spec: DesignDraft["specification"]) =>
    [spec.productTier, spec.requirements, spec.targets, spec.dataPolicyRef];
  const graphContent = (graph: DesignDraft["graph"]) => [graph.entities, graph.relations, graph.viewLayoutRef];
  return JSON.stringify(specContent(draft.specification)) === JSON.stringify(specContent(baseline.specification))
    && JSON.stringify(graphContent(draft.graph)) === JSON.stringify(graphContent(baseline.graph));
}

async function readFirstReviewSource(sourceId: string, workspaceId: string, sessions: BuilderLeadSessions,
  platform: SpsPlatformInvocationContext) {
  if (sourceId.startsWith("lead-turn:")) {
    let source;
    try { source = await readLeadUserSource(sourceId.slice("lead-turn:".length), sessions, platform); }
    catch (error) { throw sourceFailure("original-source-unavailable", error); }
    if (source.id !== sourceId) throw new Error("Initial review source ID does not match the authenticated original turn.");
    return source;
  }
  if (sourceId.startsWith("consultation-")) {
    const raw = await platform.state.get({ scopeKind: "company", scopeId: workspaceId,
      namespace: "sonpark.my-builder", stateKey: "snapshot.v1" });
    const snapshot = parseBuilderSnapshot(raw ?? createEmptyBuilderSnapshot(workspaceId), workspaceId);
    const message = snapshot.messages.find(item => item.id === sourceId && item.role === "user"
      && item.channel === "main" && item.actorId === null);
    if (!message || !message.text.trim()) throw sourceFailure("original-source-unavailable");
    return Object.freeze({ id: message.id, text: message.text });
  }
  throw new Error("Initial review contains an unsupported original source identity.");
}

function rebindApprovedPack(bundle: NonNullable<Awaited<ReturnType<typeof readFirstDesignReviewRevision>>>,
  identity: DomainPack["identity"]): DomainPack {
  const pack = bundle.pack;
  const draftIdentityDigest = sha256(JSON.stringify(bundle.draft.specification));
  if (bundle.status !== "APPROVED" || !bundle.approval
    || bundle.approval.attestedBundleRevisionId === bundle.revisionId
    || bundle.workspaceId !== identity.workspaceId || bundle.projectId !== identity.projectId
    || pack.identity.specRevisionId !== bundle.draft.specification.revisionId || pack.identity.specDigest !== draftIdentityDigest) {
    throw new Error("Approved first-design binding does not match its exact immutable bundle, pack, or approval pins.");
  }
  return Object.freeze({ ...pack, identity });
}
/**
 * Bind assurance reads to the current Builder Baseline and its actual approval source.
 * This verifies the approved relations and source bytes. It does not establish per-requirement
 * provenance or supply a Domain Pack/rule authority; those stay absent and coverage stays UNKNOWN.
 * Construct this in server-owned code with current Host/session records, never from client data.
 */
export function createCurrentBaselineAssuranceProvider(input: Readonly<{
  workspaceId: string;
  projectId: string;
  sessions: BuilderLeadSessions;
  platform: SpsPlatformInvocationContext;
}>): AssuranceCoverageProvider {
  if (!input || input.sessions.workspaceId !== input.workspaceId) throw new TypeError("Lead sessions must match the bound Workspace.");
  const { workspaceId, projectId, sessions, platform } = input;
  const store = createDesignBaselineStore(workspaceId, projectId, platform.state as typeof platform.state & RevisionState);

  return async (query: AssuranceCoverageQuery): Promise<SpecAssuranceAuthoritySnapshot | null> => {
    const first = await store.current();
    if (!first) return null;
    const baseline = first.revision;
    const specification = baseline.specification;
    const specificationDigest = sha256(JSON.stringify(specification));
    const identity = Object.freeze({ workspaceId, projectId, specRevisionId: specification.revisionId, specDigest: specificationDigest });

    // Always look up under the server-bound Workspace/Project. A foreign or stale request
    // receives the actual current identity, which the consumer rejects as an identity mismatch.
    const requirementIds = [...query.requirementIds];
    const requirementById = new Map(specification.requirements.map(requirement => [requirement.id, requirement]));
    const scopedRequirements = requirementIds.flatMap(id => {
      const requirement = requirementById.get(id);
      return requirement ? [requirement] : [];
    });
    const completeRequirementLookup = scopedRequirements.length === requirementIds.length;
    const scope: CoverageScope = Object.freeze({
      requirementIds: Object.freeze(requirementIds),
      acIds: Object.freeze([...new Set(scopedRequirements.flatMap(requirement => requirement.acceptanceCriteriaIds))].sort()),
    });

    const sourceRef = baseline.userDecision.sourceId;
    if (specification.approvalEvidenceRef !== sourceRef) {
      throw new Error("Current baseline source reference is unsupported.");
    }
    const firstReviewRevisionId = firstDesignReviewApprovalRevision(sourceRef);
    if (firstReviewRevisionId !== null) {
      const reviewBundle = await readFirstDesignReviewRevision(workspaceId, projectId, firstReviewRevisionId,
        platform.state as unknown as RevisionState);
      const bundleDigest = reviewBundle ? sha256(JSON.stringify(reviewBundle)) : null;
      if (!reviewBundle || reviewBundle.revisionId !== firstReviewRevisionId || reviewBundle.status !== "APPROVED"
        || !reviewBundle.approval || reviewBundle.approval.attestedBundleRevisionId === reviewBundle.revisionId
        || reviewBundle.workspaceId !== workspaceId || reviewBundle.projectId !== projectId
        || baseline.sourceDraftRevisionId !== reviewBundle.draftRevisionId
        || baseline.userDecision.sourceSha256 !== bundleDigest
        || !matchesPublishedDraft(reviewBundle.draft, baseline)) {
        throw new Error("Current Baseline does not match the exact approved first-design bundle, digest, Spec or Graph.");
      }

      const approvedPack = rebindApprovedPack(reviewBundle, identity);
      const pinsByRequirement = new Map<string, typeof reviewBundle.sourcePins>();
      for (const pin of reviewBundle.sourcePins) {
        const requirement = requirementById.get(pin.requirementId);
        if (!requirement || pin.acId !== null && !requirement.acceptanceCriteriaIds.includes(pin.acId)) {
          throw new Error("Approved first-design source relationship does not match the current Baseline requirement/AC IDs.");
        }
        pinsByRequirement.set(requirement.id, [...(pinsByRequirement.get(requirement.id) ?? []), pin]);
      }
      if (reviewBundle.sourcePins.length === 0 || reviewBundle.draft.sourceIds.some(sourceId =>
        !reviewBundle.sourcePins.some(pin => pin.sourceId === sourceId))) {
        throw new Error("The approved first-design bundle does not pin every original DesignDraft source.");
      }
      const sourceIds = [...new Set(reviewBundle.draft.sourceIds)];
      const sourceById = new Map<string, Readonly<{ id: string; text: string; digest: string }>>();
      for (const sourceId of sourceIds) {
        const source = await readFirstReviewSource(sourceId, workspaceId, sessions, platform);
        const digest = sha256(source.text);
        const pins = reviewBundle.sourcePins.filter(pin => pin.sourceId === sourceId);
        if (pins.some(pin => pin.sourceDigest !== digest)) throw sourceFailure("original-source-digest-mismatch");
        sourceById.set(sourceId, Object.freeze({ id: sourceId, text: source.text, digest }));
      }
      const sourceRefs = Object.freeze(scopedRequirements.flatMap(requirement =>
        (pinsByRequirement.get(requirement.id) ?? []).map(pin => Object.freeze({ requirementId: pin.requirementId,
          acId: pin.acId, sourceId: pin.sourceId, sourceDigest: pin.sourceDigest, revisionId: specification.revisionId }))));
      const sourceEntities = Object.freeze([...sourceById.values()].map(source => Object.freeze({ kind: "source" as const,
        id: source.id, bodyDigest: source.digest, relationIds: Object.freeze([...new Set(sourceRefs.filter(ref => ref.sourceId === source.id)
          .flatMap(ref => [ref.requirementId, ...(ref.acId === null ? [] : [ref.acId])]))].sort()) })));

      const assertCurrentSnapshot = async () => {
        const latest = await store.current();
        const latestBundle = await readFirstDesignReviewRevision(workspaceId, projectId, firstReviewRevisionId,
          platform.state as unknown as RevisionState);
        for (const sourceId of sourceIds) {
          const reread = await readFirstReviewSource(sourceId, workspaceId, sessions, platform);
          if (reread.id !== sourceId || sha256(reread.text) !== sourceById.get(sourceId)?.digest) {
            throw sourceFailure("original-source-changed-during-read");
          }
        }
        if (!latest || latest.sequence !== first.sequence || JSON.stringify(latest.revision) !== JSON.stringify(baseline)
          || !latestBundle || latestBundle.revisionId !== reviewBundle.revisionId
          || sha256(JSON.stringify(latestBundle)) !== bundleDigest) {
          throw new Error("Current Baseline or first-design approval binding changed during assurance lookup.");
        }
      };
      await assertCurrentSnapshot();

      const model = reviewBundle.designModel ? rebindDesignModelMaterial(reviewBundle.designModel, identity) : null;
      for (const ac of model?.acceptanceCriteria ?? []) {
        const source = sourceById.get(ac.sourceId);
        if (!source || source.digest !== ac.sourceDigest || !source.text.includes(ac.text) || sha256(ac.text) !== ac.textSha256) {
          throw sourceFailure("original-source-digest-mismatch");
        }
      }

      const materials: CoverageMaterial[] = [
        Object.freeze({ kind: "specification", identity, presence: completeRequirementLookup ? "present" : "partial",
          verification: completeRequirementLookup ? "validated" : "unknown",
          entities: Object.freeze([...scopedRequirements.map(requirement => Object.freeze({ kind: "requirement" as const,
            id: requirement.id, bodyDigest: sha256(JSON.stringify(requirement)),
            relationIds: Object.freeze([...requirement.acceptanceCriteriaIds]) })),
          ...[...new Map((model?.acceptanceCriteria ?? []).filter(ac => scope.acIds.includes(ac.acId))
            .map(ac => [ac.acId, Object.freeze({ kind: "ac" as const, id: ac.acId, bodyDigest: ac.textSha256,
              relationIds: Object.freeze([ac.requirementId, ac.sourceId]) })])).values()]]) }),
        Object.freeze({ kind: "source", identity, presence: sourceRefs.length > 0 ? "present" : "partial",
          verification: sourceRefs.length > 0 ? "validated" : "unknown", entities: sourceEntities }),
      ];
      if (model) {
        const factSet = new Set(model.facts);
        const matches = (predicate: DomainPack["applicability"]) => (predicate.all ?? []).every(fact => factSet.has(fact))
          && (!predicate.any?.length || predicate.any.some(fact => factSet.has(fact)))
          && !(predicate.none ?? []).some(fact => factSet.has(fact));
        const analysis = await evaluateSpecAssurance({ identity, scope: { requirementIds }, facts: model.facts,
          packs: [approvedPack], scenarios: model.scenarios });
        const ruleById = new Map(approvedPack.rules.map(rule => [rule.id, rule]));
        const manifestBase = { ...model.rulesManifest, scope,
          targets: model.rulesManifest.targets.filter(target => (target.targetKind === "requirement" ? scope.requirementIds : scope.acIds).includes(target.targetId)),
          rules: model.rulesManifest.rules.map(rule => {
            const domainRule = ruleById.get(rule.id)!;
            return matches(approvedPack.applicability) && matches(domainRule.appliesWhen) ? rule
              : { ...rule, requiresCheck: false, requiredEvidenceKinds: [] };
          }), digest: "0".repeat(64) };
        const manifest = Object.freeze({ ...manifestBase, digest: coverageRulesManifestDigest(manifestBase) });
        const checks: CoverageCheck[] = [];
        for (const target of manifest.targets) for (const ruleId of target.ruleIds) {
          if (!manifest.rules.find(rule => rule.id === ruleId)?.requiresCheck) continue;
          const linked = target.targetKind === "requirement" ? [target.targetId]
            : scopedRequirements.filter(requirement => requirement.acceptanceCriteriaIds.includes(target.targetId)).map(requirement => requirement.id);
          const results = analysis.checkerResults.filter(result => result.ruleId === ruleId && linked.includes(result.requirementId));
          const status = results.some(result => result.status === "FAIL") ? "failed"
            : linked.length > 0 && linked.every(id => results.some(result => result.requirementId === id && result.status === "PASS")) ? "passed" : "not-run";
          const refs = sourceRefs.filter(ref => target.targetKind === "requirement"
            ? ref.requirementId === target.targetId && ref.acId === null : ref.acId === target.targetId);
          checks.push(Object.freeze({ targetId: target.targetId, targetKind: target.targetKind, ruleId, status,
            evidenceRefs: Object.freeze(status === "not-run" ? [] : [...new Set([target.targetId, ...refs.map(ref => ref.sourceId)])]) }));
        }
        await assertCurrentSnapshot();
        return Object.freeze({ coverageInput: Object.freeze({ identity, scope, rulesVersion: manifest.rulesVersion, manifest,
          materials: Object.freeze(materials), sourceRefs, checks: Object.freeze(checks) }),
          domainPacks: Object.freeze([approvedPack]), facts: model.facts, scenarios: model.scenarios,
          designModelEvidence: Object.freeze({ kind: "design-model-v1" as const, approvalRevisionId: firstReviewRevisionId,
            materialSha256: sha256(JSON.stringify(reviewBundle.designModel)) }),
          itemDecisions: Object.freeze(model.itemDecisions.filter(item => requirementIds.includes(item.requirementId))
            .map(item => Object.freeze({ requirementId: item.requirementId, status: item.status, reason: item.reason }))) });
      }
      return Object.freeze({
        coverageInput: Object.freeze({ identity, scope, rulesVersion: "not-provided", manifest: null,
          materials: Object.freeze(materials), sourceRefs, checks: Object.freeze([]) }),
        domainPacks: Object.freeze([approvedPack]),
        facts: Object.freeze([]),
      });
    }
    if (!sourceRef.startsWith("lead-turn:")) throw new Error("Current baseline source reference is unsupported.");
    const requestId = sourceRef.slice("lead-turn:".length);
    let sourceTurn, source;
    try {
      sourceTurn = await readLeadUserTurn(requestId, sessions, platform);
      source = await readLeadUserSource(requestId, sessions, platform);
    } catch (error) { throw sourceFailure("original-source-unavailable", error); }
    const sourceDigest = sha256(source.text);
    if (sourceTurn.workspaceId !== workspaceId || sourceTurn.channel !== "main"
      || sourceTurn.sessionId !== baseline.author.sessionId || sourceTurn.runId !== baseline.author.runId
      || sourceTurn.selectionRevision !== baseline.author.selectionRevision
      || source.id !== sourceRef || sourceDigest !== baseline.userDecision.sourceSha256) {
      throw sourceFailure("original-source-digest-mismatch");
    }

    // Re-read both records after the async source lookup so a concurrent baseline/source
    // change cannot be reported as the snapshot that was just checked.
    const latest = await store.current();
    let latestTurn, latestSource;
    try {
      latestTurn = await readLeadUserTurn(requestId, sessions, platform);
      latestSource = await readLeadUserSource(requestId, sessions, platform);
    } catch (error) { throw sourceFailure("original-source-unavailable", error); }
    if (!latest || latest.sequence !== first.sequence || JSON.stringify(latest.revision) !== JSON.stringify(baseline)) {
      throw new Error("Current baseline changed during assurance lookup.");
    }
    if (latestTurn.workspaceId !== sourceTurn.workspaceId || latestTurn.sessionId !== sourceTurn.sessionId
      || latestTurn.runId !== sourceTurn.runId || latestTurn.selectionRevision !== sourceTurn.selectionRevision
      || latestSource.id !== source.id || sha256(latestSource.text) !== sourceDigest) {
      throw sourceFailure("original-source-changed-during-read");
    }

    const materials: CoverageMaterial[] = [
      Object.freeze({ kind: "specification", identity, presence: completeRequirementLookup ? "present" : "partial",
        verification: completeRequirementLookup ? "validated" : "unknown",
        entities: Object.freeze(scopedRequirements.map(requirement => Object.freeze({ kind: "requirement" as const,
          id: requirement.id, bodyDigest: sha256(JSON.stringify(requirement)),
          relationIds: Object.freeze([...requirement.acceptanceCriteriaIds]) }))) }),
      Object.freeze({ kind: "source", identity, presence: "present", verification: "validated",
        entities: Object.freeze([Object.freeze({ kind: "source" as const, id: source.id,
          bodyDigest: sourceDigest, relationIds: Object.freeze([] as string[]) })]) }),
    ];
    return Object.freeze({
      coverageInput: Object.freeze({ identity, scope, rulesVersion: "not-provided", manifest: null,
        materials: Object.freeze(materials), sourceRefs: Object.freeze([]), checks: Object.freeze([]) }),
      // No registry or approved pack record exists in this source set. Empty is an explicit
      // absence; caller-supplied facts/packs are never substituted.
      domainPacks: Object.freeze([]),
      facts: Object.freeze([]),
    });
  };
}
