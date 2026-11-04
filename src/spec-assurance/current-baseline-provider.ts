import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { createDesignBaselineStore } from "../design-baseline-tools.ts";
import type { BuilderLeadContexts } from "../domain/lead-contexts.ts";
import type { BuilderLeadSessions } from "../domain/model.ts";
import { readLeadUserSource, readLeadUserTurn } from "../lead-conversations.ts";
import type { RevisionState } from "../solution-revision-store.ts";
import type { CoverageMaterial, CoverageScope } from "../spec-coverage/evaluator.ts";
import type { AssuranceCoverageProvider, AssuranceCoverageQuery, SpecAssuranceAuthoritySnapshot } from "./evaluator.ts";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
type ConversationSessions = BuilderLeadSessions | BuilderLeadContexts;

/**
 * Bind assurance reads to the current Builder baseline and its actual Lead user turn.
 * This verifies record identity and source bytes only. It does not establish per-requirement
 * provenance or supply a Domain Pack/rule authority; those stay absent and coverage stays UNKNOWN.
 * Construct this in server-owned code with current Host/session records, never from client data.
 */
export function createCurrentBaselineAssuranceProvider(input: Readonly<{
  workspaceId: string;
  projectId: string;
  sessions: ConversationSessions;
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
    if (specification.approvalEvidenceRef !== sourceRef || !sourceRef.startsWith("lead-turn:")) {
      throw new Error("Current baseline source reference is unsupported.");
    }
    const requestId = sourceRef.slice("lead-turn:".length);
    const sourceTurn = await readLeadUserTurn(requestId, sessions, platform);
    const source = await readLeadUserSource(requestId, sessions, platform);
    const sourceDigest = sha256(source.text);
    if (sourceTurn.workspaceId !== workspaceId || sourceTurn.channel !== "main" && sourceTurn.channel !== "user_conversation"
      || sourceTurn.sessionId !== baseline.author.sessionId || sourceTurn.runId !== baseline.author.runId
      || sourceTurn.selectionRevision !== baseline.author.selectionRevision
      || source.id !== sourceRef || sourceDigest !== baseline.userDecision.sourceSha256) {
      throw new Error("Current baseline source bytes do not match the stored source digest.");
    }

    // Re-read both records after the async source lookup so a concurrent baseline/source
    // change cannot be reported as the snapshot that was just checked.
    const latest = await store.current();
    const latestTurn = await readLeadUserTurn(requestId, sessions, platform);
    const latestSource = await readLeadUserSource(requestId, sessions, platform);
    if (!latest || latest.sequence !== first.sequence || JSON.stringify(latest.revision) !== JSON.stringify(baseline)
      || latestTurn.workspaceId !== sourceTurn.workspaceId || latestTurn.sessionId !== sourceTurn.sessionId
      || latestTurn.runId !== sourceTurn.runId || latestTurn.selectionRevision !== sourceTurn.selectionRevision
      || latestSource.id !== source.id || sha256(latestSource.text) !== sourceDigest) {
      throw new Error("Current baseline or cited source changed during assurance lookup.");
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
