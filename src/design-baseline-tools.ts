import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { firstDesignReviewApprovalRevision, parseDesignBaseline } from "./domain/design-baseline.ts";
import { createDesignDraftStore } from "./design-draft-store.ts";
import { createRevisionJournal, type RevisionState } from "./solution-revision-store.ts";
import { exactToolRecord, parseLeadToolContext, requireLeadFormalPublicationAuthority, resolveLeadToolAuthority } from "./lead-tool-authority.ts";
import { assertCurrentFirstDesignApproval } from "./spec-assurance/review-first-design.ts";

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
class BaselineSourceConflict extends Error {}
function id(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("A bounded design baseline identifier is required.");
  }
  return value;
}
export function createDesignBaselineStore(workspaceId: string, projectId: string, state: RevisionState) {
  return createRevisionJournal(workspaceId, projectId, state, {
    prefix: "design-baseline", parse: value => parseDesignBaseline(value, projectId), revisionId: value => value.revisionId,
  });
}
export async function readDesignBaseline(workspaceId: string, projectId: string, platform: SpsPlatformInvocationContext) {
  return createDesignBaselineStore(workspaceId, projectId, platform.state).current();
}

/** The Lead interprets the user's design decision; this is not legal or execution authority. */
export async function publishDesignBaseline(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "expectedBaseRevisionId", "sourceDraftRevisionId", "revisionId", "userSourceId", "interpretation"]);
  const projectId = id(input.projectId), sourceDraftRevisionId = id(input.sourceDraftRevisionId), revisionId = id(input.revisionId);
  // The immutable baseline ID owns the paired IDs; callers cannot alias the same
  // specification/Graph revision across different baseline content.
  const suffix = hash(`${projectId}\0${revisionId}`);
  const specificationRevisionId = `baseline-spec-${suffix}`, graphRevisionId = `baseline-graph-${suffix}`;
  const expectedBaseRevisionId = input.expectedBaseRevisionId === null ? null : id(input.expectedBaseRevisionId);
  if (typeof input.userSourceId !== "string" || !input.userSourceId.trim()
    || typeof input.interpretation !== "string" || !input.interpretation.trim()
    || Buffer.byteLength(input.interpretation, "utf8") > 8192) throw new TypeError("A current user decision and bounded Lead interpretation are required.");
  const userSourceId = input.userSourceId, interpretation = input.interpretation;
  const context = parseLeadToolContext(runContext);
  const authority = await resolveLeadToolAuthority(context, platform);
  requireLeadFormalPublicationAuthority(authority);
  if (context.projectId !== undefined && context.projectId !== projectId) throw new Error("Baseline project does not match the authenticated Lead context.");
  await authority.check();
  const draftStore = createDesignDraftStore(context.companyId, projectId,
    { selectionRevision: authority.selectionRevision, agentId: context.agentId }, platform.state);
  const current = await draftStore.current();
  if (!current || current.revision.draft.revisionId !== sourceDraftRevisionId) return changed("draft");
  const existing = await readDesignBaseline(context.companyId, projectId, platform);
  if ((existing?.revision.revisionId ?? null) !== expectedBaseRevisionId) return changed("baseline");
  const approvalRevisionId = firstDesignReviewApprovalRevision(userSourceId);
  if (!approvalRevisionId) throw new Error(existing === null
    ? "The first Baseline requires an authenticated first-design review approval."
    : "A current approved design-review bundle covering the exact previous Baseline is required for Baseline publication.");
  const readApproval = () => assertCurrentFirstDesignApproval({ projectId, approvedRevisionId: approvalRevisionId }, context, platform);
  const approved = await readApproval();
  if (!approved || approved.bundle.draftRevisionId !== sourceDraftRevisionId
    || JSON.stringify(approved.bundle.draft) !== JSON.stringify(current.revision.draft)
    || (existing === null ? approved.bundle.priorBaseline !== null : !approved.bundle.priorBaseline
      || approved.bundle.priorBaseline.revisionId !== existing.revision.revisionId
      || approved.bundle.priorBaseline.sequence !== existing.sequence
      || approved.bundle.priorBaseline.digest !== hash(JSON.stringify(existing.revision)))) return changed("approved design-review bundle or previous Baseline");
  const sourceSha256 = approved.bundleDigest;
  const draft = current.revision.draft;
  if (revisionId === draft.revisionId || specificationRevisionId === draft.specification.revisionId
    || graphRevisionId === draft.graph.graphRevisionId) throw new TypeError("New baseline, specification and Graph revision IDs are required.");
  const baseline = parseDesignBaseline({ projectId, revisionId, sourceDraftRevisionId,
    draftDigest: hash(JSON.stringify(current.revision)), createdAt: new Date().toISOString(),
    author: { agentId: context.agentId, sessionId: context.sessionId, runId: context.runId, selectionRevision: authority.selectionRevision },
    userDecision: { sourceId: userSourceId, sourceSha256, interpretation },
    specification: { ...draft.specification, projectId, revisionId: specificationRevisionId, approvalEvidenceRef: userSourceId },
    graph: { ...draft.graph, graphRevisionId, approvedSpecRevisionId: specificationRevisionId },
  }, projectId);
  const state = platform.state as typeof platform.state & RevisionState;
  const check = async () => {
    await authority.check();
    const latest = await draftStore.current();
    if (!latest || hash(JSON.stringify(latest.revision)) !== baseline.draftDigest) {
      throw new Error("The source design changed. Read and reconcile before recording a decision; do not automatically retry.");
    }
    const latestBaseline = await readDesignBaseline(context.companyId, projectId, platform);
    const matchesPrior = (latestBaseline?.revision.revisionId ?? null) === expectedBaseRevisionId
      && (latestBaseline === null ? approved.bundle.priorBaseline === null : Boolean(approved.bundle.priorBaseline
        && approved.bundle.priorBaseline.revisionId === latestBaseline.revision.revisionId
        && approved.bundle.priorBaseline.sequence === latestBaseline.sequence
        && approved.bundle.priorBaseline.digest === hash(JSON.stringify(latestBaseline.revision))));
    const matchesPublished = Boolean(latestBaseline && latestBaseline.revision.revisionId === baseline.revisionId
      && latestBaseline.sequence === (existing?.sequence ?? 0) + 1
      && JSON.stringify(latestBaseline.revision) === JSON.stringify(baseline));
    if (!matchesPrior && !matchesPublished) {
      throw new BaselineSourceConflict("The previous Baseline changed. Read and reconcile before publication; do not automatically retry.");
    }
    await authority.check();
  };
  const guarded: RevisionState = { get: async key => { await check(); const value = await state.get(key); await check(); return value; },
    compareAndSet: state.compareAndSet ? async (...args) => {
      await check();
      if (args[0].stateKey.startsWith("design-baseline-head.v1.")) {
        const approved = await readApproval().catch(async error => {
          if (await readDesignBaseline(context.companyId, projectId, platform)) return null;
          throw error;
        });
        if (!approved && await readDesignBaseline(context.companyId, projectId, platform)) return { swapped: false };
        if (!approved || approved.bundleDigest !== sourceSha256) throw new Error("Design-review approval changed before Baseline publication.");
      }
      const receipt = await state.compareAndSet!(...args);
      await check();
      return receipt;
    } : undefined };
  try {
    const result = await createDesignBaselineStore(context.companyId, projectId, guarded).publish({ expectedBaseRevisionId, revision: baseline });
    await check();
    return { content: result.status === "published"
      ? "Design baseline stored with its exact user decision reference and the Lead's interpretation. This is an internal planning record, not independently verified legal approval, a signature, code execution, deployment, data deletion or delivery authority. Technical decisions and workstream permissions remain separate."
      : "The baseline changed. Read the current record; do not automatically retry.", data: result as unknown as JsonValue };
  } catch (error) {
    if (!(error instanceof BaselineSourceConflict)) throw error;
    await authority.check();
    return changed("baseline");
  }
}
function changed(kind: string) {
  return { content: `The ${kind} changed. Read the current record without automatically retrying.`, data: { status: "conflict" } as JsonValue };
}
export async function readLeadDesignBaseline(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId"]), projectId = id(input.projectId);
  const context = parseLeadToolContext(runContext);
  const authority = await resolveLeadToolAuthority(context, platform);
  const current = await readDesignBaseline(context.companyId, projectId, platform);
  await authority.check();
  return { content: "Lead-recorded internal design baseline and user-source interpretation, not legal or execution authorization. Private transcripts and credentials are not included.",
    data: { projectId, current } as unknown as JsonValue };
}
