import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { parseDesignBaseline } from "./domain/design-baseline.ts";
import { exactToolRecord, parseLeadToolContext, resolveLeadToolAuthority } from "./lead-tool-authority.ts";
import { createRevisionJournal, type RevisionState } from "./solution-revision-store.ts";
import { parseUiApproval, parseUiRevision, revisionDigest, type UiRevision } from "./ui-contracts/domain.ts";

const MAX_RECENT = 50;
const id = (value: unknown, label: string) => {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a bounded identifier.`);
  }
  return value;
};

type Published<T> = Readonly<{ sequence: number; revision: T }>;
type Baseline = ReturnType<typeof parseDesignBaseline>;
type Approval = ReturnType<typeof parseUiApproval>;
type ValidUiBinding = Readonly<{
  baselineRevisionId: string;
  formalUiRevisionId: string;
  formalUiSequence: number;
  proposalRevisionId: string;
  approvalRevisionId: string;
  formalUiDigest: string;
  approvalDigest: string;
  contractRevisionId: string;
  htmlSha256: string;
  approvedInteractionIds: readonly string[];
}>;
export type G5ComparisonPairsLeadRunContext = Readonly<{
  companyId: string;
  agentId: string;
  runId: string;
  sessionId: string;
  projectId?: string;
}>;
export type G5ComparisonPairsReadDTO = Readonly<{
  projectId: string;
  selectableBaselines: readonly Readonly<{
    baselineRevisionId: string;
    sequence: number;
    sourceSpecRevisionId: string;
    digest: string;
    approvedFormalUi: readonly ValidUiBinding[];
  }>[];
  comparisonPairs: readonly Readonly<Record<string, unknown>>[];
  coverage: Readonly<{
    limit: number;
    baselineHasMore: boolean;
    formalUiHasMore: boolean;
    complete: boolean;
    scope: string;
    excluded: Readonly<Record<string, number>>;
    currentPairInferred: false;
    writesPerformed: false;
  }>;
}>;

function journals(workspaceId: string, projectId: string, state: RevisionState) {
  const journal = <T>(prefix: string, parse: (value: unknown) => T, revisionId: (value: T) => string) =>
    createRevisionJournal(workspaceId, projectId, state, { prefix, parse, revisionId });
  return {
    baselines: journal("design-baseline", value => parseDesignBaseline(value, projectId), value => value.revisionId),
    formalUi: journal("ui-contracts", value => parseUiRevision(value, projectId), value => value.revisionId),
    proposals: journal("ui-proposals", value => parseUiRevision(value, projectId), value => value.revisionId),
    approvals: journal("ui-approvals", value => parseUiApproval(value, projectId), value => value.revisionId),
  };
}

function validFormalBinding(formal: UiRevision, formalUiSequence: number, baseline: Baseline, proposal: UiRevision | null,
  approval: Approval | null): ValidUiBinding | null {
  if (formal.publication !== "formal" || formal.source.kind !== "baseline"
    || formal.source.revisionId !== baseline.revisionId
    || formal.source.digest !== revisionDigest(baseline)
    || formal.source.specRevisionId !== baseline.specification.revisionId
    || !formal.sourceProposalRevisionId || !formal.approvalRevisionId || !proposal || !approval) return null;
  if (proposal.publication !== "proposal" || proposal.projectId !== formal.projectId
    || proposal.revisionId !== formal.sourceProposalRevisionId
    || approval.proposalRevisionId !== proposal.revisionId
    || approval.proposalDigest !== revisionDigest(proposal)
    || approval.htmlSha256 !== proposal.artifact.htmlSha256
    || approval.contractRevisionId !== proposal.contract.revisionId
    || formal.artifact.htmlSha256 !== proposal.artifact.htmlSha256
    || formal.contract.revisionId !== proposal.contract.revisionId
    || JSON.stringify(formal.artifact) !== JSON.stringify(proposal.artifact)
    || JSON.stringify(formal.contract) !== JSON.stringify(proposal.contract)
    || JSON.stringify(formal.source) !== JSON.stringify(proposal.source)) return null;
  return Object.freeze({ baselineRevisionId: baseline.revisionId, formalUiRevisionId: formal.revisionId,
    formalUiSequence,
    proposalRevisionId: proposal.revisionId, approvalRevisionId: approval.revisionId,
    formalUiDigest: revisionDigest(formal), approvalDigest: revisionDigest(approval),
    contractRevisionId: formal.contract.revisionId, htmlSha256: formal.artifact.htmlSha256,
    approvedInteractionIds: approval.approvedInteractionIds });
}

/**
 * Read-only selector source for a Lead tool/action wrapper. It only exposes
 * published recent() journal entries and exact approval-bound formal UI pairs.
 */
export async function readG5ComparisonPairs(params: unknown,
  runContext: G5ComparisonPairsLeadRunContext, platform: SpsPlatformInvocationContext) {
  const input = comparisonPairInput(params);
  const context = parseLeadToolContext(runContext);
  if (input.projectId !== context.companyId) throw new Error("Comparison pair project does not match the authenticated Workspace.");
  if (context.projectId !== undefined && context.projectId !== input.projectId) throw new Error("Comparison pair project does not match the authenticated Lead context.");
  const authority = await resolveLeadToolAuthority(context, platform);
  if (authority.channel !== "main" && authority.channel !== "integration-review") {
    throw new Error("Only Main or Integration Review may read G5 comparison pair options.");
  }
  return readComparisonPairs(input, context.companyId, platform.state as RevisionState, authority.check);
}

function comparisonPairInput(params: unknown) {
  const input = exactToolRecord(params, ["projectId"], ["limit"]);
  const projectId = id(input.projectId, "projectId");
  const limit = input.limit === undefined ? 20 : input.limit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECENT) {
    throw new TypeError(`limit must be an integer from 1 to ${MAX_RECENT}.`);
  }
  return { projectId, limit };
}

async function readComparisonPairs(input: ReturnType<typeof comparisonPairInput>, workspaceId: string,
  state: RevisionState, check: () => Promise<void>) {
  const { projectId, limit } = input;
  await check();
  const store = journals(workspaceId, projectId, state);
  const [baselineHistory, formalHistory] = await Promise.all([store.baselines.recent(limit), store.formalUi.recent(limit)]);
  const baselineById = new Map(baselineHistory.revisions.map(entry => [entry.revision.revisionId, entry]));
  const validByBaseline = new Map<string, ValidUiBinding[]>();
  const exclusions = { formalNotBaselineSourced: 0, missingApprovalOrProposal: 0,
    mismatchedApprovalProposalOrArtifact: 0, baselineOutsideRecentWindow: 0, baselineWithoutApprovedFormalUi: 0 };

  for (const formalEntry of formalHistory.revisions) {
    const formal = formalEntry.revision;
    if (formal.publication !== "formal" || formal.source.kind !== "baseline") {
      exclusions.formalNotBaselineSourced += 1;
      continue;
    }
    const baselineEntry = baselineById.get(formal.source.revisionId);
    if (!baselineEntry) {
      const exactBaseline = await store.baselines.publishedRevision(formal.source.revisionId);
      if (!exactBaseline) exclusions.formalNotBaselineSourced += 1;
      else exclusions.baselineOutsideRecentWindow += 1;
      continue;
    }
    const proposalId = formal.sourceProposalRevisionId;
    const approvalId = formal.approvalRevisionId;
    if (!proposalId || !approvalId) {
      exclusions.missingApprovalOrProposal += 1;
      continue;
    }
    const [proposal, approval] = await Promise.all([
      store.proposals.publishedRevision(proposalId), store.approvals.publishedRevision(approvalId),
    ]);
    if (!proposal || !approval) {
      exclusions.missingApprovalOrProposal += 1;
      continue;
    }
    const binding = validFormalBinding(formal, formalEntry.sequence, baselineEntry.revision, proposal.revision, approval.revision);
    if (!binding) {
      exclusions.mismatchedApprovalProposalOrArtifact += 1;
      continue;
    }
    const rows = validByBaseline.get(binding.baselineRevisionId) ?? [];
    rows.push(binding);
    validByBaseline.set(binding.baselineRevisionId, rows);
  }

  for (const baseline of baselineHistory.revisions) {
    if (!validByBaseline.has(baseline.revision.revisionId)) exclusions.baselineWithoutApprovedFormalUi += 1;
  }
  const selectableBaselines = baselineHistory.revisions.map((entry: Published<Baseline>) => Object.freeze({
    baselineRevisionId: entry.revision.revisionId, sequence: entry.sequence,
    sourceSpecRevisionId: entry.revision.specification.revisionId,
    digest: revisionDigest(entry.revision),
    approvedFormalUi: Object.freeze([...(validByBaseline.get(entry.revision.revisionId) ?? [])]
      .sort((a, b) => b.formalUiSequence - a.formalUiSequence)),
  }));
  const comparisonPairs: Array<Readonly<Record<string, unknown>>> = [];
  const byPublicationOrder = [...selectableBaselines].sort((a, b) => a.sequence - b.sequence);
  for (let oldIndex = 0; oldIndex < byPublicationOrder.length; oldIndex += 1) {
    for (let newIndex = oldIndex + 1; newIndex < byPublicationOrder.length; newIndex += 1) {
      const older = byPublicationOrder[oldIndex]!;
      const newer = byPublicationOrder[newIndex]!;
      if (older.sequence >= newer.sequence || older.approvedFormalUi.length === 0 || newer.approvedFormalUi.length === 0) continue;
      comparisonPairs.push(Object.freeze({ oldBaselineRevisionId: older.baselineRevisionId,
        oldSequence: older.sequence, newBaselineRevisionId: newer.baselineRevisionId, newSequence: newer.sequence,
        oldFormalUiRevisionIds: Object.freeze(older.approvedFormalUi.map(ui => ui.formalUiRevisionId)),
        newFormalUiRevisionIds: Object.freeze(newer.approvedFormalUi.map(ui => ui.formalUiRevisionId)), selected: false,
        selectionRule: "Choose one exact formal UI revision from each Baseline option; no current pair is inferred." }));
    }
  }
  await check();
  return {
    content: "Published Baseline and user-approved formal UI selector options only. Coverage is limited to recent() pages; no current pair is inferred, and excluded records are not repaired or substituted.",
    data: {
      projectId, selectableBaselines: Object.freeze(selectableBaselines), comparisonPairs: Object.freeze(comparisonPairs),
      coverage: { limit, baselineHasMore: baselineHistory.hasMore, formalUiHasMore: formalHistory.hasMore,
        complete: !baselineHistory.hasMore && !formalHistory.hasMore,
        scope: "exact recent() pages from scoped published journals; source/proposal/approval records resolved by exact publishedRevision IDs",
        excluded: Object.freeze(exclusions), currentPairInferred: false, writesPerformed: false },
    },
  };
}

/** User-action version of the same read-only published journal selector. */
export async function readUserG5ComparisonPairs(params: unknown,
  context: Readonly<{ actor: Readonly<{ type: string; companyId: string; userId?: string | null }>; companyId: string; state: RevisionState }>) {
  const check = async () => {
    if (context.actor.type !== "user" || context.actor.companyId !== context.companyId || !context.actor.userId) {
      throw new Error("G5 comparison options require an authenticated Workspace user.");
    }
  };
  await check();
  const input = comparisonPairInput(params);
  const workspaceId = id(context.companyId, "workspaceId");
  if (input.projectId !== workspaceId) throw new Error("Comparison pair project does not match the authenticated Workspace.");
  return (await readComparisonPairs(input, workspaceId, context.state, check)).data as G5ComparisonPairsReadDTO;
}

/** Registration-ready Lead tool handler; sessionId must come from the Host run context, never tool params. */
export const g5ComparisonPairsLeadHandler = (params: Parameters<typeof readG5ComparisonPairs>[0],
  runContext: G5ComparisonPairsLeadRunContext, platform: SpsPlatformInvocationContext) =>
  readG5ComparisonPairs(params, runContext, platform);
