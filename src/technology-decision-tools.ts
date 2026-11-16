import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { parseAuthoredTechnologyDecisions } from "./domain/authored-technology-decisions.ts";
import { parseTechnologyDecisionRegister } from "./domain/technology-decisions.ts";
import { readDesignBaseline } from "./design-baseline-tools.ts";
import { exactToolRecord, parseLeadToolContext, requireLeadFormalPublicationAuthority, resolveLeadToolAuthority } from "./lead-tool-authority.ts";
import { createRevisionJournal, type RevisionState } from "./solution-revision-store.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("A bounded technology register identifier is required.");
  }
  return value;
}
export function createTechnologyDecisionStore(workspaceId: string, projectId: string, state: RevisionState) {
  return createRevisionJournal(workspaceId, projectId, state, { prefix: "technology-decisions",
    parse: value => parseAuthoredTechnologyDecisions(value, projectId), revisionId: value => value.register.revisionId });
}
export async function readTechnologyDecisions(workspaceId: string, projectId: string, platform: SpsPlatformInvocationContext) {
  return createTechnologyDecisionStore(workspaceId, projectId, platform.state).current();
}

export async function publishTechnologyDecisions(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "expectedBaseRevisionId", "register"]);
  const projectId = identifier(input.projectId);
  const register = parseTechnologyDecisionRegister(input.register, projectId);
  const expectedBaseRevisionId = input.expectedBaseRevisionId === null ? null : identifier(input.expectedBaseRevisionId);
  const context = parseLeadToolContext(runContext);
  const authority = await resolveLeadToolAuthority(context, platform);
  requireLeadFormalPublicationAuthority(authority);
  const baseline = await readDesignBaseline(context.companyId, projectId, platform);
  if (!baseline || register.sourceBaselineRevisionId !== baseline.revision.revisionId
    || register.sourceSpecRevisionId !== baseline.revision.specification.revisionId
    || register.sourceGraphRevisionId !== baseline.revision.graph.graphRevisionId) {
    throw new Error("Read the exact current design baseline, specification and Graph before recording technology choices.");
  }
  const nodeIds = new Set(baseline.revision.graph.entities.map(node => node.id));
  if (register.entries.some(entry => entry.scopeNodeIds.some(nodeId => !nodeIds.has(nodeId)))) {
    throw new TypeError("A technology scope references a node outside the pinned baseline Graph.");
  }
  const authored = parseAuthoredTechnologyDecisions({ register, author: { agentId: context.agentId, sessionId: context.sessionId,
    runId: context.runId, selectionRevision: authority.selectionRevision }, createdAt: new Date().toISOString(),
    baselineDigest: digest(baseline.revision) }, projectId);
  const check = async () => {
    await authority.check();
    const latest = await readDesignBaseline(context.companyId, projectId, platform);
    if (!latest || digest(latest.revision) !== authored.baselineDigest) {
      throw new Error("The design baseline changed. Read and reconcile; do not automatically retry technology writes.");
    }
    await authority.check();
  };
  const state = platform.state as typeof platform.state & RevisionState;
  const guarded: RevisionState = {
    get: async key => { await check(); const value = await state.get(key); await check(); return value; },
    compareAndSet: state.compareAndSet ? async (...args) => {
      await check(); const receipt = await state.compareAndSet!(...args); await check(); return receipt;
    } : undefined,
  };
  const result = await createTechnologyDecisionStore(context.companyId, projectId, guarded).publish({ expectedBaseRevisionId, revision: authored });
  await check();
  return { content: result.status === "published"
    ? "Lead technology choices stored against an exact design baseline. Omitted technologies are unspecified, not prohibited. Research and test claims remain authored reports, not independent license/security/test verification, legal approval or execution permission."
    : "The technology register changed. Read the current record; do not automatically retry.", data: result as unknown as JsonValue };
}
export async function readLeadTechnologyDecisions(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId"]), projectId = identifier(input.projectId);
  const context = parseLeadToolContext(runContext);
  const authority = await resolveLeadToolAuthority(context, platform);
  const current = await readTechnologyDecisions(context.companyId, projectId, platform);
  await authority.check();
  return { content: "Versioned Lead technology choices with pinned design references. Unmentioned technology is unspecified. Reported research is not independently verified; the stored baseline may be historical. No code, CTO or tool execution is authorized by this read.",
    data: { projectId, current } as unknown as JsonValue };
}
