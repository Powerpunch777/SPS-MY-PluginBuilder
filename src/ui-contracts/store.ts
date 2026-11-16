import type { SpsActionContext, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { createDesignDraftStore } from "../design-draft-store.ts";
import { parseDesignBaseline } from "../domain/design-baseline.ts";
import { createRevisionJournal, type RevisionState } from "../solution-revision-store.ts";
import { exactToolRecord, parseLeadToolContext, requireLeadFormalPublicationAuthority, resolveLeadToolAuthority } from "../lead-tool-authority.ts";
import { deriveUiReviewStatuses, parseUiApproval, parseUiContract, parseUiRevision, revisionDigest, sha256Utf8,
  type UiApproval, type UiRevision } from "./domain.ts";

type SourceSnapshot = Readonly<{
  source: UiRevision["source"];
  specification: Readonly<{ revisionId: string; requirements: readonly Readonly<{ id: string }>[] }>;
  graph: unknown;
}>;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a nonblank bounded identifier.`);
  }
  return value;
}

function idList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 2_000
    || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError(`${label} must be a dense bounded array.`);
  const result = Array.from({ length: value.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw new TypeError(`${label} must contain data values.`);
    return id(field.value, `${label}[${index}]`);
  });
  if (new Set(result).size !== result.length) throw new TypeError(`${label} contains duplicates.`);
  return Object.freeze(result);
}

function parseSourceSelection(value: unknown) {
  const row = exactToolRecord(value, ["kind", "revisionId"]);
  if (row.kind !== "draft" && row.kind !== "baseline") throw new TypeError("UI source kind must be draft or baseline.");
  return Object.freeze({ kind: row.kind, revisionId: id(row.revisionId, "source revisionId") }) as Readonly<{ kind: "draft" | "baseline"; revisionId: string }>;
}

function initialReview(contract: ReturnType<typeof parseUiContract>) {
  const result: Record<string, "UNKNOWN" | "UNCONNECTED"> = Object.create(null) as Record<string, "UNKNOWN" | "UNCONNECTED">;
  for (const item of contract.interactions) result[item.id] = item.status === "unconnected" ? "UNCONNECTED" : "UNKNOWN";
  return Object.freeze(result);
}

function diffSource(previous: SourceSnapshot | null, current: SourceSnapshot) {
  if (!previous) return { refs: [] as string[], unknown: false };
  const oldRequirements = new Map(previous.specification.requirements.map(item => [item.id, JSON.stringify(item)]));
  const newRequirements = new Map(current.specification.requirements.map(item => [item.id, JSON.stringify(item)]));
  const refs = new Set<string>();
  for (const key of new Set([...oldRequirements.keys(), ...newRequirements.keys()])) {
    if (oldRequirements.get(key) !== newRequirements.get(key)) refs.add(key);
  }
  const oldGraph = previous.graph as { entities?: readonly Record<string, unknown>[]; relations?: readonly Record<string, unknown>[]; viewLayoutRef?: string };
  const newGraph = current.graph as { entities?: readonly Record<string, unknown>[]; relations?: readonly Record<string, unknown>[]; viewLayoutRef?: string };
  const oldEntities = new Map((oldGraph.entities ?? []).map(entity => [String(entity.id), JSON.stringify(entity)]));
  const newEntities = new Map((newGraph.entities ?? []).map(entity => [String(entity.id), JSON.stringify(entity)]));
  for (const entityId of new Set([...oldEntities.keys(), ...newEntities.keys()])) {
    if (oldEntities.get(entityId) === newEntities.get(entityId)) continue;
    refs.add(entityId);
    for (const entity of [...(oldGraph.entities ?? []), ...(newGraph.entities ?? [])].filter(item => item.id === entityId)) {
      if (typeof entity.specRef === "string") refs.add(entity.specRef);
      if (Array.isArray(entity.contractRefs)) for (const reference of entity.contractRefs) if (typeof reference === "string") refs.add(reference);
    }
  }
  const oldRelations = new Map((oldGraph.relations ?? []).map(relation => [String(relation.id), JSON.stringify(relation)]));
  const newRelations = new Map((newGraph.relations ?? []).map(relation => [String(relation.id), JSON.stringify(relation)]));
  for (const relationId of new Set([...oldRelations.keys(), ...newRelations.keys()])) {
    if (oldRelations.get(relationId) === newRelations.get(relationId)) continue;
    refs.add(relationId);
    for (const relation of [...(oldGraph.relations ?? []), ...(newGraph.relations ?? [])].filter(item => item.id === relationId)) {
      for (const key of ["sourceId", "targetId", "contractRef"]) if (typeof relation[key] === "string") refs.add(relation[key] as string);
    }
  }
  const graphChangeUnknown = oldGraph.viewLayoutRef !== newGraph.viewLayoutRef;
  const unknown = previous.source.specRevisionId !== current.source.specRevisionId && refs.size === 0
    || graphChangeUnknown || previous.source.kind !== current.source.kind;
  return { refs: [...refs], unknown };
}

/** Builder UI design contracts, user-action approvals, and Main-only formal revisions. */
export function createUiContractStore(workspaceId: string, projectId: string, state: RevisionState) {
  if (!UUID.test(workspaceId)) throw new TypeError("A canonical Workspace ID is required.");
  id(projectId, "projectId");
  const journal = <T>(prefix: string, parse: (value: unknown) => T, revisionId: (value: T) => string, source = state) =>
    createRevisionJournal(workspaceId, projectId, source, { prefix, parse, revisionId });
  const proposalJournal = (source = state) => journal("ui-proposals", value => parseUiRevision(value, projectId), revision => revision.revisionId, source);
  const formalJournal = (source = state) => journal("ui-contracts", value => parseUiRevision(value, projectId), revision => revision.revisionId, source);
  const approvalJournal = (source = state) => journal("ui-approvals", value => parseUiApproval(value, projectId), approval => approval.revisionId, source);
  const baselineJournal = () => journal("design-baseline", value => parseDesignBaseline(value, projectId), baseline => baseline.revisionId);
  const sameApprovalRequest = (stored: UiApproval, request: { revisionId: string; expectedBaseRevisionId: string | null;
    proposalRevisionId: string; proposalDigest: string; htmlSha256: string; contractRevisionId: string;
    approvedInteractionIds: readonly string[]; actorUserId: string }) => stored.revisionId === request.revisionId
      && stored.expectedBaseRevisionId === request.expectedBaseRevisionId
      && stored.proposalRevisionId === request.proposalRevisionId
      && stored.proposalDigest === request.proposalDigest
      && stored.htmlSha256 === request.htmlSha256
      && stored.contractRevisionId === request.contractRevisionId
      && JSON.stringify(stored.approvedInteractionIds) === JSON.stringify(request.approvedInteractionIds)
      && stored.actorUserId === request.actorUserId;

  async function resolveAuthority(runContext: unknown, platform: SpsPlatformInvocationContext) {
    const raw = exactToolRecord(runContext, ["companyId", "agentId", "runId", "sessionId"], ["projectId"]);
    const context = parseLeadToolContext(raw);
    if (context.companyId !== workspaceId || (context.projectId !== undefined && context.projectId !== projectId)) {
      throw new Error("UI Contract Workspace or project scope does not match the current context.");
    }
    return resolveLeadToolAuthority(context, platform);
  }

  async function sourceRevision(selection: ReturnType<typeof parseSourceSelection> | UiRevision["source"], authority: Awaited<ReturnType<typeof resolveAuthority>>,
    platform: SpsPlatformInvocationContext, requireCurrent = true): Promise<SourceSnapshot | null> {
    if (selection.kind === "baseline") {
      const store = baselineJournal();
      const result = requireCurrent ? await store.current() : await store.publishedRevision(selection.revisionId);
      if (!result || result.revision.revisionId !== selection.revisionId) return null;
      if (requireCurrent) {
        const current = await store.current();
        if (!current || current.revision.revisionId !== selection.revisionId) return null;
      }
      const revision = result.revision;
      return Object.freeze({ source: Object.freeze({ kind: "baseline", revisionId: revision.revisionId,
        digest: revisionDigest(revision), specRevisionId: revision.specification.revisionId, selectionRevision: null, agentId: null }),
        specification: revision.specification, graph: revision.graph });
    }
    const historicalOwner = requireCurrent ? { selectionRevision: authority.selectionRevision, agentId: authority.context.agentId }
      : { selectionRevision: Number((selection as { selectionRevision?: number }).selectionRevision), agentId: String((selection as { agentId?: string }).agentId) };
    if (!Number.isSafeInteger(historicalOwner.selectionRevision) || !UUID.test(historicalOwner.agentId)) return null;
    const store = createDesignDraftStore(workspaceId, projectId, historicalOwner, platform.state as unknown as RevisionState);
    const result = requireCurrent ? await store.current() : await store.publishedRevision(selection.revisionId);
    if (!result || result.revision.draft.revisionId !== selection.revisionId) return null;
    if (requireCurrent) {
      const current = await store.current();
      if (!current || current.revision.draft.revisionId !== selection.revisionId) return null;
    }
    const revision = result.revision.draft;
    const fullSource = Object.freeze({ kind: "draft" as const, revisionId: revision.revisionId,
      digest: revisionDigest(result.revision), specRevisionId: revision.specification.revisionId,
      selectionRevision: historicalOwner.selectionRevision, agentId: historicalOwner.agentId });
    return Object.freeze({ source: fullSource, specification: revision.specification, graph: revision.graph });
  }

  async function currentSourceForRevision(revision: UiRevision, authority: Awaited<ReturnType<typeof resolveAuthority>>,
    platform: SpsPlatformInvocationContext) {
    const source = revision.source;
    const selection = { kind: source.kind, revisionId: source.revisionId } as const;
    if (source.kind === "draft" && (source.selectionRevision !== authority.selectionRevision || source.agentId !== authority.context.agentId)) return null;
    const current = await sourceRevision(selection, authority, platform, true);
    return current && JSON.stringify(current.source) === JSON.stringify(source) ? current : null;
  }

  function assertRequirements(contract: ReturnType<typeof parseUiContract>, source: SourceSnapshot) {
    const known = new Set(source.specification.requirements.map(requirement => requirement.id));
    for (const item of contract.interactions) for (const reference of item.requirementRefs) {
      if (!known.has(reference)) throw new TypeError(`UI interaction ${item.id} references unknown requirement ${reference}.`);
    }
  }

  function parseProposalDraft(input: Record<string, unknown>, authority: Awaited<ReturnType<typeof resolveAuthority>>,
    source: SourceSnapshot, publication: "proposal" | "formal", revisionId: string, previousRevisionId: string | null,
    sourceProposalRevisionId: string | null, approvalRevisionId: string | null, review: Readonly<Record<string, string>>) {
    const contract = parseUiContract(input.contract, projectId);
    const artifact = input.artifact;
    const revision = parseUiRevision({ projectId, revisionId, source: source.source, previousRevisionId,
      sourceProposalRevisionId, approvalRevisionId, artifact, contract, publication, reviewByInteractionId: review }, projectId);
    assertRequirements(contract, source);
    if (revision.artifact.sourceSessionId !== authority.sessions.sessions[authority.channel]
      || revision.artifact.sourceSpecRevisionId !== source.source.specRevisionId) {
      throw new Error("UI HTML must come from this exact Lead context session and source Spec revision.");
    }
    return revision;
  }

  return Object.freeze({
    async propose(input: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
      const patch = exactToolRecord(input, ["revisionId", "expectedBaseRevisionId", "source", "artifact", "contract"]);
      const revisionId = id(patch.revisionId, "revisionId");
      const expectedBaseRevisionId = patch.expectedBaseRevisionId === null ? null : id(patch.expectedBaseRevisionId, "expectedBaseRevisionId");
      const selection = parseSourceSelection(patch.source);
      const authority = await resolveAuthority(runContext, platform);
      if (authority.channel !== "ui-design" && authority.channel !== "background") throw new Error("Only UI Design or Background can save a UI proposal.");
      const source = await sourceRevision(selection, authority, platform, true);
      if (!source) return Object.freeze({ status: "conflict" as const, reason: "The selected current design source is unavailable or changed." });
      const store = proposalJournal();
      const current = await store.current();
      const actual = current?.revision.revisionId ?? null;
      if (actual !== expectedBaseRevisionId) return Object.freeze({ status: "conflict" as const, actualBaseRevisionId: actual });
      const contract = parseUiContract(patch.contract, projectId);
      const review = initialReview(contract);
      const draftInput = { artifact: patch.artifact, contract: patch.contract };
      const revision = parseProposalDraft(draftInput, authority, source, "proposal", revisionId, actual, null, null, review);
      await authority.check();
      const result = await proposalJournal(guardedState(authority, revision, platform)).publish({ expectedBaseRevisionId, revision });
      await authority.check();
      return result.status === "published" ? Object.freeze({ status: "published" as const, revision: result.revision })
        : Object.freeze({ status: "conflict" as const, actualBaseRevisionId: result.actualBaseRevisionId });
    },

    async approveProposalAction(input: unknown, context: Pick<SpsActionContext, "companyId" | "actor">
      & { state: SpsPlatformInvocationContext["state"] }, assertCurrent?: (proposal: UiRevision) => Promise<void>) {
      if (context.actor.type !== "user" || context.actor.companyId !== context.companyId || !context.actor.userId?.trim()
        || context.companyId !== workspaceId) throw new Error("UI proposal approval requires an authenticated Workspace user action.");
      const patch = exactToolRecord(input, ["revisionId", "expectedBaseRevisionId", "proposalRevisionId", "htmlSha256", "approvedInteractionIds"]);
      const actionState = context.state as unknown as RevisionState;
      const revisionId = id(patch.revisionId, "approval revisionId");
      const proposalRevisionId = id(patch.proposalRevisionId, "proposalRevisionId");
      const expectedBaseRevisionId = patch.expectedBaseRevisionId === null ? null : id(patch.expectedBaseRevisionId, "expectedBaseRevisionId");
      const approvedIds = idList(patch.approvedInteractionIds, "approvedInteractionIds");
      const actorUserId = id(context.actor.userId, "authenticated actorUserId");
      if (typeof patch.htmlSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(patch.htmlSha256)) throw new TypeError("Exact proposal HTML hash is required.");
      const requestedHtmlSha256 = patch.htmlSha256;
      const proposal = await proposalJournal(actionState).publishedRevision(proposalRevisionId);
      if (!proposal || proposal.revision.publication !== "proposal") throw new Error("Only an immutable published UI proposal can be approved.");
      if (proposal.revision.artifact.htmlSha256 !== requestedHtmlSha256) throw new Error("The proposal HTML changed; reopen the exact revision before approving.");
      if (approvedIds.some(value => !proposal.revision.contract.interactions.some(item => item.id === value))) {
        throw new TypeError("Approval interaction IDs must be unique members of this exact proposal.");
      }
      const approvals = approvalJournal(actionState);
      const publishedRequest = await approvals.publishedRevision(revisionId);
      if (publishedRequest) {
        const stored = publishedRequest.revision;
        const exactReplay = stored.expectedBaseRevisionId === expectedBaseRevisionId
          && stored.proposalRevisionId === proposalRevisionId
          && stored.proposalDigest === revisionDigest(proposal.revision)
          && stored.htmlSha256 === proposal.revision.artifact.htmlSha256
          && stored.contractRevisionId === proposal.revision.contract.revisionId
          && JSON.stringify(stored.approvedInteractionIds) === JSON.stringify(approvedIds)
          && stored.actorUserId === actorUserId;
        if (!exactReplay) throw new Error("Approval revision ID already belongs to a different request or user.");
        return Object.freeze({ status: "replayed" as const, sequence: publishedRequest.sequence, approval: stored });
      }
      await assertCurrent?.(proposal.revision);
      const current = await approvals.current();
      const actual = current?.revision.revisionId ?? null;
      if (actual !== expectedBaseRevisionId) return Object.freeze({ status: "conflict" as const, actualBaseRevisionId: actual });
      const approval: UiApproval = parseUiApproval({ projectId, revisionId, expectedBaseRevisionId, proposalRevisionId,
        proposalDigest: revisionDigest(proposal.revision), htmlSha256: proposal.revision.artifact.htmlSha256,
        contractRevisionId: proposal.revision.contract.revisionId, approvedInteractionIds: approvedIds,
        actorUserId, approvedAt: new Date().toISOString() }, projectId);
      const request = { revisionId, expectedBaseRevisionId, proposalRevisionId, proposalDigest: approval.proposalDigest,
        htmlSha256: approval.htmlSha256, contractRevisionId: approval.contractRevisionId,
        approvedInteractionIds: approvedIds, actorUserId };
      let result: Awaited<ReturnType<typeof approvals.publish>>;
      try {
        result = await approvals.publish({ expectedBaseRevisionId, revision: approval });
      } catch (writeError) {
        const committed = await approvals.publishedRevision(revisionId);
        if (committed) {
          if (!sameApprovalRequest(committed.revision, request)) throw new Error("Approval revision ID already belongs to a different request or user.");
          return Object.freeze({ status: "replayed" as const, sequence: committed.sequence, approval: committed.revision });
        }
        const staged = await approvals.stagedRevision(revisionId, expectedBaseRevisionId);
        if (staged.status !== "staged") throw writeError;
        if (!sameApprovalRequest(staged.revision, request)) throw new Error("Staged approval revision belongs to a different request or user.");
        await assertCurrent?.(proposal.revision);
        const recovered = await approvals.publish({ expectedBaseRevisionId, revision: staged.revision });
        if (recovered.status !== "published") return Object.freeze({ status: "conflict" as const,
          actualBaseRevisionId: recovered.actualBaseRevisionId });
        return Object.freeze({ status: "replayed" as const, sequence: recovered.sequence, approval: recovered.revision });
      }
      return result.status === "published" ? Object.freeze({ status: "published" as const, sequence: result.sequence, approval: result.revision })
        : Object.freeze({ status: "conflict" as const, actualBaseRevisionId: result.actualBaseRevisionId });
    },

    async publishFormal(input: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
      const patch = exactToolRecord(input, ["revisionId", "expectedBaseRevisionId", "proposalRevisionId", "approvalRevisionId"]);
      const revisionId = id(patch.revisionId, "revisionId"), proposalRevisionId = id(patch.proposalRevisionId, "proposalRevisionId");
      const approvalRevisionId = id(patch.approvalRevisionId, "approvalRevisionId");
      const expectedBaseRevisionId = patch.expectedBaseRevisionId === null ? null : id(patch.expectedBaseRevisionId, "expectedBaseRevisionId");
      const authority = await resolveAuthority(runContext, platform);
      requireLeadFormalPublicationAuthority(authority);
      const proposal = await proposalJournal().publishedRevision(proposalRevisionId);
      const approval = await approvalJournal().publishedRevision(approvalRevisionId);
      if (!proposal || !approval || proposal.revision.publication !== "proposal"
        || approval.revision.proposalRevisionId !== proposalRevisionId
        || approval.revision.proposalDigest !== revisionDigest(proposal.revision)
        || approval.revision.htmlSha256 !== proposal.revision.artifact.htmlSha256
        || approval.revision.contractRevisionId !== proposal.revision.contract.revisionId) {
        throw new Error("An authenticated user approval of this exact immutable proposal and HTML is required.");
      }
      const source = await currentSourceForRevision(proposal.revision, authority, platform);
      if (!source) return Object.freeze({ status: "conflict" as const, reason: "The approved proposal source is stale or unavailable." });
      const formal = formalJournal();
      const current = await formal.current();
      const actual = current?.revision.revisionId ?? null;
      if (actual !== expectedBaseRevisionId) return Object.freeze({ status: "conflict" as const, actualBaseRevisionId: actual });
      const previousSource = current ? await sourceRevision(current.revision.source, authority, platform, false) : null;
      const sourceDiff = diffSource(previousSource, source);
      const htmlDiffUnknown = Boolean(current && current.revision.artifact.htmlSha256 !== proposal.revision.artifact.htmlSha256);
      const review = deriveUiReviewStatuses(proposal.revision.contract, approval.revision, current?.revision ?? null,
        sourceDiff.refs, sourceDiff.unknown || htmlDiffUnknown);
      const revision = parseUiRevision({ ...proposal.revision, revisionId, previousRevisionId: actual,
        sourceProposalRevisionId: proposalRevisionId, approvalRevisionId, publication: "formal",
        reviewByInteractionId: review }, projectId);
      const published = await formalJournal(guardedState(authority, revision, platform)).publish({ expectedBaseRevisionId, revision });
      await authority.check();
      return published.status === "published" ? Object.freeze({ status: "published" as const, revision: published.revision })
        : Object.freeze({ status: "conflict" as const, actualBaseRevisionId: published.actualBaseRevisionId });
    },

    async currentFormal(runContext: unknown, platform: SpsPlatformInvocationContext) {
      const authority = await resolveAuthority(runContext, platform);
      const result = await formalJournal().current();
      await authority.check();
      return result;
    },
    async publishedFormal(revisionId: string, runContext: unknown, platform: SpsPlatformInvocationContext) {
      const authority = await resolveAuthority(runContext, platform);
      const result = await formalJournal().publishedRevision(revisionId);
      await authority.check();
      return result;
    },
    async publishedProposal(revisionId: string, runContext: unknown, platform: SpsPlatformInvocationContext) {
      const authority = await resolveAuthority(runContext, platform);
      const result = await proposalJournal().publishedRevision(revisionId);
      await authority.check();
      return result;
    },
  });

  function guardedState(authority: Awaited<ReturnType<typeof resolveAuthority>>, revision: UiRevision,
    platform: SpsPlatformInvocationContext): RevisionState {
    const assertCurrent = async () => {
      await authority.check();
      const source = await currentSourceForRevision(revision, authority, platform);
      if (!source) throw new Error("The current design source changed during UI publication; refresh without retrying.");
      await authority.check();
    };
    const hostState = platform.state as unknown as RevisionState;
    return { get: async key => { await assertCurrent(); const value = await hostState.get(key); await assertCurrent(); return value; },
      compareAndSet: hostState.compareAndSet ? async (...args) => {
        await assertCurrent(); const receipt = await hostState.compareAndSet!(...args); await assertCurrent(); return receipt;
      } : undefined };
  }
}
