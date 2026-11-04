import type { JsonValue, SpsPlatformInvocationContext, ToolRunContext } from "@sonparkserver/plugin-sdk/platform";
import { deriveUiReviewStatuses, parseUiContract, parseUiRevision, sha256Utf8, type UiRevision, type UiReviewStatus } from "./domain.ts";
import { readLeadUserSource, readLeadUserTurn } from "../lead-conversations.ts";
import { resolveLogicalLeadContext, requireFormalRevisionAuthority } from "../lead-context-authority.ts";
import { readLeadContexts } from "../lead-context-store.ts";
import { createRevisionJournal, type RevisionState } from "../solution-revision-store.ts";
import { readDesignBaseline } from "../design-baseline-tools.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function inputRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a plain record.`);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError(`${label} has unknown or missing fields.`);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw new TypeError(`${label}.${key} must be a data field.`);
    result[key] = field.value;
  }
  return result;
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function referenceIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 256
    || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError("changedReferenceIds must be a dense bounded array.");
  const values = Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("changedReferenceIds must contain data values.");
    return id(descriptor.value, `changedReferenceIds[${index}]`);
  });
  if (new Set(values).size !== values.length) throw new TypeError("changedReferenceIds contains duplicates.");
  return Object.freeze(values);
}

function createDraft(value: unknown, projectId: string, publication: UiRevision["publication"],
  approvalSource: UiRevision["approvalSource"], reviewByInteractionId: Readonly<Record<string, UiReviewStatus>>): UiRevision {
  const draft = inputRecord(value, ["revisionId", "sourceBaselineRevisionId", "sourceBaselineDigest", "sourceSpecRevisionId",
    "sourceProposalRevisionId", "previousRevisionId", "artifact", "contract"], "uiRevisionDraft");
  const result = parseUiRevision({ projectId, revisionId: draft.revisionId, sourceBaselineRevisionId: draft.sourceBaselineRevisionId,
    sourceBaselineDigest: draft.sourceBaselineDigest, sourceSpecRevisionId: draft.sourceSpecRevisionId,
    sourceProposalRevisionId: draft.sourceProposalRevisionId,
    previousRevisionId: draft.previousRevisionId, artifact: draft.artifact, contract: draft.contract, approvalSource,
    publication, reviewByInteractionId }, projectId);
  return result;
}

function initialReview(contract: ReturnType<typeof parseUiContract>): Readonly<Record<string, UiReviewStatus>> {
  const result: Record<string, UiReviewStatus> = Object.create(null) as Record<string, UiReviewStatus>;
  for (const interaction of contract.interactions) result[interaction.id] = interaction.status === "unconnected" ? "UNCONNECTED" : "UNKNOWN";
  return Object.freeze(result);
}

function revisionWithDerivedReview(draft: UiRevision, publication: UiRevision["publication"],
  approvalSource: UiRevision["approvalSource"], previous: UiRevision | null, changedReferenceIds: readonly string[]): UiRevision {
  let review = initialReview(draft.contract);
  if (previous && previous.sourceSpecRevisionId === draft.sourceSpecRevisionId) {
    const changedScreens = previous.artifact.htmlSha256 === draft.artifact.htmlSha256
      ? [] : draft.artifact.screenIds;
    review = deriveUiReviewStatuses(draft.contract, changedReferenceIds, previous.reviewByInteractionId,
      previous.contract, changedScreens);
  } else if (previous && changedReferenceIds.length > 0) {
    review = deriveUiReviewStatuses(draft.contract, changedReferenceIds, previous.reviewByInteractionId,
      previous.contract, previous.artifact.htmlSha256 === draft.artifact.htmlSha256 ? [] : draft.artifact.screenIds);
  }
  // This store has no historical Spec relationship snapshot to prove that an
  // omitted reference was unaffected. Keep explicit impacts and prior review,
  // but do not carry APPROVED across a Spec revision on an incomplete diff.
  if (previous && previous.sourceSpecRevisionId !== draft.sourceSpecRevisionId) {
    const conservative: Record<string, UiReviewStatus> = Object.create(null) as Record<string, UiReviewStatus>;
    for (const interaction of draft.contract.interactions) {
      const derived = review[interaction.id];
      const prior = previous.reviewByInteractionId[interaction.id];
      conservative[interaction.id] = derived === "UNCONNECTED" ? "UNCONNECTED"
        : prior === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED"
        : derived === "APPROVED" ? "UNKNOWN" : derived;
    }
    review = Object.freeze(conservative);
  }
  return parseUiRevision({ ...draft, publication, approvalSource, reviewByInteractionId: review }, draft.projectId);
}

/**
 * Workspace-scoped Builder record journals. This module records references and
 * CAS history; it does not prove that a Spec revision exists or that approval
 * semantics were satisfied by the referenced user text.
 */
export function createUiContractStore(workspaceId: string, projectId: string, state: RevisionState) {
  if (!UUID.test(workspaceId)) throw new TypeError("A canonical Workspace ID is required.");
  id(projectId, "projectId");
  const proposalJournal = (source: RevisionState) => createRevisionJournal(workspaceId, projectId, source, {
    prefix: "ui-proposals", parse: value => parseUiRevision(value, projectId), revisionId: revision => revision.revisionId,
  });
  const formalJournal = (source: RevisionState) => createRevisionJournal(workspaceId, projectId, source, {
    prefix: "ui-contracts", parse: value => parseUiRevision(value, projectId), revisionId: revision => revision.revisionId,
  });

async function resolveAuthority(runContext: ToolRunContext, platform: SpsPlatformInvocationContext) {
    if (runContext.companyId !== workspaceId || !UUID.test(runContext.agentId) || !UUID.test(runContext.runId)
      || typeof runContext.sessionId !== "string" || !UUID.test(runContext.sessionId)) {
      throw new Error("A current Host Workspace, Agent, Run, and session context is required.");
    }
    const authority = await resolveLogicalLeadContext(runContext, platform);
    const contexts = await readLeadContexts(workspaceId, platform);
    if (!contexts || contexts.status !== "ready" || contexts.contexts[authority.context] !== runContext.sessionId) {
      throw new Error("The current Host session is not bound to the logical Lead context.");
    }
    return { authority, contexts };
  }

  async function authorizedSource(sourceRequestId: unknown, runContext: ToolRunContext,
    platform: SpsPlatformInvocationContext) {
    const { authority, contexts } = await resolveAuthority(runContext, platform);
    const sourceId = id(sourceRequestId, "sourceRequestId");
    if (!UUID.test(sourceId)) throw new TypeError("sourceRequestId must be a canonical Lead turn UUID.");
    const source = await readLeadUserSource(sourceId, contexts, platform);
    const turn = await readLeadUserTurn(sourceId, contexts, platform);
    await authority.check();
    return { authority, contexts, source, turn, approvalSource: Object.freeze({ sourceId: source.id, sourceSha256: sha256Utf8(source.text) }) };
  }

  async function baselineFor(revision: UiRevision, platform: SpsPlatformInvocationContext) {
    const baseline = await readDesignBaseline(workspaceId, projectId, platform);
    if (!baseline || baseline.revision.revisionId !== revision.sourceBaselineRevisionId
      || sha256Utf8(JSON.stringify(baseline.revision)) !== revision.sourceBaselineDigest
      || baseline.revision.specification.revisionId !== revision.sourceSpecRevisionId) {
      throw new Error("The referenced published design baseline or Spec revision is stale or unavailable.");
    }
    return baseline.revision;
  }

  function guardedState(authority: Awaited<ReturnType<typeof resolveLogicalLeadContext>>, revision: UiRevision,
    platform: SpsPlatformInvocationContext): RevisionState {
    const assertCurrent = async () => {
      await authority.check();
      await baselineFor(revision, platform);
      await authority.check();
    };
    return {
      get: async key => { await assertCurrent(); const value = await state.get(key); await assertCurrent(); return value; },
      compareAndSet: state.compareAndSet ? async (...args) => {
        await assertCurrent(); const result = await state.compareAndSet!(...args); await assertCurrent(); return result;
      } : undefined,
    };
  }

  return Object.freeze({
    async propose(input: unknown, runContext: ToolRunContext, platform: SpsPlatformInvocationContext) {
      const patch = inputRecord(input, ["expectedBaseRevisionId", "sourceRequestId", "changedReferenceIds", "revision"], "uiProposal");
      const expectedBaseRevisionId = patch.expectedBaseRevisionId === null ? null : id(patch.expectedBaseRevisionId, "expectedBaseRevisionId");
      const changedReferenceIds = referenceIds(patch.changedReferenceIds);
      const { authority, contexts, turn, approvalSource } = await authorizedSource(patch.sourceRequestId, runContext, platform);
      if (authority.context !== "ui_design" && authority.context !== "background_planning") {
        throw new Error("Only UI Design or Background may store a proposal.");
      }
      if (turn.channel !== "ui_design" && turn.channel !== "question_discussion" && turn.channel !== "user_conversation") {
        throw new Error("A proposal requires an actual user turn from an allowed user-facing Lead context.");
      }
      const provisional = createDraft(patch.revision, projectId, "proposal", approvalSource,
        initialReview(parseUiContract((patch.revision as Record<string, unknown>).contract, projectId)));
      if (provisional.previousRevisionId !== expectedBaseRevisionId) throw new Error("The proposal parent must match the expected CAS base.");
      await baselineFor(provisional, platform);
      if (provisional.artifact.sourceSessionId !== contexts.contexts[authority.context]) {
        throw new Error("The HTML artifact must retain the Host session that authored this proposal.");
      }
      const previousFormal = await formalJournal(state).current();
      const prior = previousFormal?.revision;
      const canCarryReview = prior && prior.sourceBaselineRevisionId === provisional.sourceBaselineRevisionId
        && prior.sourceBaselineDigest === provisional.sourceBaselineDigest;
      const canCarryPriorReviewState = canCarryReview || changedReferenceIds.length > 0
        || prior?.sourceSpecRevisionId !== provisional.sourceSpecRevisionId;
      const revision = revisionWithDerivedReview(provisional, "proposal", approvalSource,
        canCarryPriorReviewState ? prior ?? null : null, changedReferenceIds);
      const journal = proposalJournal(guardedState(authority, revision, platform));
      await authority.check();
      const result = await journal.publish({ expectedBaseRevisionId, revision });
      await authority.check();
      return result;
    },

    async publishFormal(input: unknown, runContext: ToolRunContext, platform: SpsPlatformInvocationContext) {
      const patch = inputRecord(input, ["expectedBaseRevisionId", "sourceRequestId", "proposalRevisionId", "revisionId", "changedReferenceIds", "revision"], "formalUiPublication");
      const expectedBaseRevisionId = patch.expectedBaseRevisionId === null ? null : id(patch.expectedBaseRevisionId, "expectedBaseRevisionId");
      const changedReferenceIds = referenceIds(patch.changedReferenceIds);
      const { authority, turn, approvalSource } = await authorizedSource(patch.sourceRequestId, runContext, platform);
      if (!authority.mayPublishFormalRevision) throw new Error("Only Main may publish a formal UI Revision.");
      requireFormalRevisionAuthority(authority.context);
      if (turn.channel !== "user_conversation") throw new Error("Formal UI publication requires a current Main user turn as its approval source.");
      if (turn.runId !== runContext.runId || turn.sessionId !== runContext.sessionId) {
        throw new Error("The formal approval source must be the actual user input for this current Main run/session.");
      }
      const revisionId = id(patch.revisionId, "revisionId");
      let provisional: UiRevision;
      if (patch.proposalRevisionId !== null && patch.revision === null) {
        const proposalRevisionId = id(patch.proposalRevisionId, "proposalRevisionId");
        const sourceProposal = await proposalJournal(state).publishedRevision(proposalRevisionId);
        if (!sourceProposal || sourceProposal.revision.publication !== "proposal") {
          throw new Error("Only a published UI/Background proposal can be submitted for Main publication.");
        }
        await baselineFor(sourceProposal.revision, platform);
        provisional = parseUiRevision({ ...sourceProposal.revision, revisionId,
          sourceProposalRevisionId: proposalRevisionId,
          previousRevisionId: expectedBaseRevisionId, publication: "formal", approvalSource,
          reviewByInteractionId: initialReview(sourceProposal.revision.contract) }, projectId);
      } else if (patch.proposalRevisionId === null && patch.revision !== null) {
        provisional = createDraft(patch.revision, projectId, "formal", approvalSource,
          initialReview(parseUiContract((patch.revision as Record<string, unknown>).contract, projectId)));
        if (provisional.revisionId !== revisionId || provisional.sourceProposalRevisionId !== null || provisional.previousRevisionId !== expectedBaseRevisionId
          || provisional.artifact.sourceSessionId !== runContext.sessionId) {
          throw new Error("A direct Main UI Revision must use its current Main-authored artifact and exact formal base.");
        }
        await baselineFor(provisional, platform);
      } else {
        throw new TypeError("Formal publication must use exactly one published proposal or direct Main revision.");
      }
      const current = await formalJournal(state).current();
      const prior = current?.revision;
      const canCarryReview = prior && prior.sourceBaselineRevisionId === provisional.sourceBaselineRevisionId
        && prior.sourceBaselineDigest === provisional.sourceBaselineDigest;
      const canCarryPriorReviewState = canCarryReview || changedReferenceIds.length > 0
        || prior?.sourceSpecRevisionId !== provisional.sourceSpecRevisionId;
      const revision = revisionWithDerivedReview(provisional, "formal", approvalSource,
        canCarryPriorReviewState ? prior ?? null : null,
        changedReferenceIds);
      const journal = formalJournal(guardedState(authority, revision, platform));
      await authority.check();
      const result = await journal.publish({ expectedBaseRevisionId, revision });
      await authority.check();
      return result;
    },

    async currentFormal(runContext: ToolRunContext, platform: SpsPlatformInvocationContext) {
      const { authority } = await resolveAuthority(runContext, platform);
      const value = await formalJournal(state).current();
      await authority.check();
      return value;
    },

    async publishedFormal(revisionId: string, runContext: ToolRunContext, platform: SpsPlatformInvocationContext) {
      const { authority } = await resolveAuthority(runContext, platform);
      const value = await formalJournal(state).publishedRevision(revisionId);
      await authority.check();
      return value;
    },

    async publishedProposal(revisionId: string, runContext: ToolRunContext, platform: SpsPlatformInvocationContext) {
      const { authority } = await resolveAuthority(runContext, platform);
      const value = await proposalJournal(state).publishedRevision(revisionId);
      await authority.check();
      return value;
    },
  });
}

export type UiContractStateValue = JsonValue;
