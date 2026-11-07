const proposalStaticId = { type: "string", minLength: 1, maxLength: 160 };
const proposalStaticIdList = (maxItems, minItems = 0) => ({ type: "array", minItems, maxItems, uniqueItems: true, items: proposalStaticId });
const proposalStaticPredicate = { type: "object", additionalProperties: false, properties: {
  all: proposalStaticIdList(1000), any: proposalStaticIdList(1000), none: proposalStaticIdList(1000),
} };
const proposalStaticDesignModel = { type: "object", additionalProperties: false,
  required: ["facts", "rulesVersion", "coverageRules", "coverageTargets", "scenarios", "itemDecisions", "acceptanceCriteria"],
  properties: {
    facts: proposalStaticIdList(1000), rulesVersion: proposalStaticId,
    coverageRules: { type: "array", maxItems: 1000, items: { type: "object", additionalProperties: false,
      required: ["id", "requiresCheck", "requiredEvidenceKinds"], properties: {
        id: proposalStaticId, requiresCheck: { type: "boolean" },
        requiredEvidenceKinds: { type: "array", maxItems: 5, uniqueItems: true,
          items: { type: "string", enum: ["specification", "workstream", "task", "question", "source"] } },
      } } },
    coverageTargets: { type: "array", maxItems: 101000, items: { type: "object", additionalProperties: false,
      required: ["targetKind", "targetId", "ruleIds"], properties: {
        targetKind: { type: "string", enum: ["requirement", "ac"] }, targetId: proposalStaticId, ruleIds: proposalStaticIdList(1000),
      } } },
    scenarios: { type: "array", maxItems: 10000, items: { type: "object", additionalProperties: false,
      required: ["id", "state", "event", "nextState", "exceptionId"], properties: {
        id: proposalStaticId, state: proposalStaticId, event: proposalStaticId, nextState: proposalStaticId,
        exceptionId: { type: ["string", "null"], minLength: 1, maxLength: 160 },
      } } },
    itemDecisions: { type: "array", maxItems: 1000, items: { type: "object", additionalProperties: false,
      required: ["requirementId", "status", "reason", "sourceIds"], properties: {
        requirementId: proposalStaticId,
        status: { type: "string", enum: ["RESOLVED", "DELEGATED", "UNDECIDED", "NOT_APPLICABLE", "NOT_CHECKED", "INCONCLUSIVE"] },
        reason: { type: "string", minLength: 1, maxLength: 4096 }, sourceIds: proposalStaticIdList(1000),
      } } },
    acceptanceCriteria: { type: "array", maxItems: 10000, items: { type: "object", additionalProperties: false,
      required: ["requirementId", "acId", "sourceId", "quote"], properties: {
        requirementId: proposalStaticId, acId: proposalStaticId, sourceId: proposalStaticId,
        quote: { type: "string", minLength: 1, maxLength: 8192 },
      } } },
  } };

export const CONFIRM_CURRENT_BASELINE_SPEC_ASSURANCE_PACK_ACTION = Object.freeze({
  key: "builder.confirm-current-baseline-spec-assurance-pack",
  displayName: "Confirm the current specification assurance pack",
  description: "An authenticated user confirms the exact current Main-proposed pack and optional static design model. This does not publish or approve a Baseline, assert runtime QA, or grant technical execution authority.",
  parametersSchema: Object.freeze({ type: "object", additionalProperties: false,
    required: ["projectId", "packId", "expectedProposalRevisionId", "expectedBaselineRevisionId", "expectedApprovalRevisionId"],
    properties: { projectId: { type: "string", minLength: 1, maxLength: 160 }, packId: { type: "string", minLength: 1, maxLength: 160 },
      expectedProposalRevisionId: { type: "string", minLength: 1, maxLength: 160 },
      expectedBaselineRevisionId: { type: "string", minLength: 1, maxLength: 160 },
      expectedApprovalRevisionId: { type: ["string", "null"], maxLength: 160 },
    } }),
});

export const SPEC_ASSURANCE_PACK_PROPOSAL_TOOL = Object.freeze({
  name: "builder.propose-spec-assurance-pack",
  displayName: "Propose a specification assurance pack",
  description: "Only Main stores a versioned Domain Pack proposal for the current approved specification. Optional designModel contains explicit facts, coverage rules/targets, finite design scenarios, source-linked item decisions and exact AC quotes from the current Main user turn. Source IDs name the baseline's actual Main user source; digests and specification identity are server-derived. Proposal data is not user confirmation, source-coverage evidence, runtime QA or execution permission.",
  parametersSchema: Object.freeze({ type: "object", additionalProperties: false,
    required: ["projectId", "expectedBaseRevisionId", "packId", "version", "applicability", "rules", "transitions", "exceptions",
      "excludedCombinations", "rulesVersion", "coverageRules", "coverageTargets", "sourceRefs"],
    properties: { projectId: { type: "string", minLength: 1, maxLength: 160 },
      expectedBaseRevisionId: { type: ["string", "null"], maxLength: 160 }, packId: { type: "string", minLength: 1, maxLength: 160 },
      version: { type: "string", minLength: 1, maxLength: 160 }, applicability: { type: "object" },
      rules: { type: "array", maxItems: 1000 }, transitions: { type: "array", maxItems: 10000 },
      exceptions: { type: "array", maxItems: 10000 }, excludedCombinations: { type: "array", maxItems: 10000 },
      rulesVersion: { type: "string", minLength: 1, maxLength: 160 }, coverageRules: { type: "array", maxItems: 1000 },
      coverageTargets: { type: "array", maxItems: 101000 }, sourceRefs: { type: "array", maxItems: 101000,
        items: { type: "object", additionalProperties: false, required: ["requirementId", "acId", "sourceId"], properties: {
          requirementId: { type: "string" }, acId: { type: ["string", "null"] }, sourceId: { type: "string" },
        } } },
      designModel: proposalStaticDesignModel,
    },
  }),
});

export const READ_SPEC_ASSURANCE_PACK_TOOL = Object.freeze({
  name: "builder.read-spec-assurance-pack", displayName: "Read a specification assurance pack proposal",
  description: "Main reads the exact current proposal revision before updating it. The server reports whether its Baseline is current. A proposal and candidate gaps are not approved rules, verified coverage or QA evidence.",
  parametersSchema: Object.freeze({ type: "object", additionalProperties: false, required: ["projectId", "packId"],
    properties: { projectId: { type: "string", minLength: 1, maxLength: 160 }, packId: { type: "string", minLength: 1, maxLength: 160 } } }),
});

const firstId = { type: "string", minLength: 1, maxLength: 160 };
const idList = (maxItems, minItems = 0) => ({ type: "array", minItems, maxItems, uniqueItems: true, items: firstId });
const gapScope = { projectId: firstId, expectedBaselineRevisionId: firstId, requirementId: firstId };
const gapRequired = Object.keys(gapScope);

export const RECORD_SPEC_GAPS_TOOL = Object.freeze({
  name: "builder.record-spec-assurance-gaps", displayName: "Record current specification gap candidates",
  description: "Main evaluates the selected requirement against its exact current approved Baseline and records candidate gaps. Do not supply findings. A candidate is not a resolved decision, verified coverage, or permission.",
  parametersSchema: Object.freeze({ type: "object", additionalProperties: false, required: gapRequired, properties: gapScope }),
});

export const READ_SPEC_GAPS_TOOL = Object.freeze({
  name: "builder.read-spec-assurance-gaps", displayName: "Read recorded specification gap candidates",
  description: "Main reads candidates for the exact current approved Baseline and requirement. For subsequent pages pass the returned observation revision and next offset. Missing candidates are not automatically resolved.",
  parametersSchema: Object.freeze({ type: "object", additionalProperties: false, required: gapRequired,
    properties: { ...gapScope, observationRevisionId: firstId, offset: { type: "integer", minimum: 0, maximum: 256 } } }),
});
const predicate = { type: "object", additionalProperties: false, properties: {
  all: idList(1000), any: idList(1000), none: idList(1000),
} };
const domainRules = { type: "array", maxItems: 1000, items: { type: "object", additionalProperties: false,
  required: ["id", "requirementIds", "appliesWhen", "requiresCheck"], properties: {
    id: firstId, requirementIds: idList(1000, 1), appliesWhen: predicate, requiresCheck: { type: "boolean" },
    modelCases: { type: "array", maxItems: 10000, items: { type: "object", additionalProperties: false,
      required: ["when", "state", "event", "allowedNextStates"], properties: {
        when: predicate, state: firstId, event: firstId, allowedNextStates: idList(10000, 1),
      } } },
  } } };
const transitionFields = { from: firstId, event: firstId, to: firstId };
const transitions = { type: "array", maxItems: 10000, items: { type: "object", additionalProperties: false,
  required: ["from", "event", "to"], properties: transitionFields } };
const exceptions = { type: "array", maxItems: 10000, items: { type: "object", additionalProperties: false,
  required: ["id", "from", "event", "to"], properties: { id: firstId, ...transitionFields } } };
const excludedCombinations = { type: "array", maxItems: 10000, items: { type: "object", additionalProperties: false,
  required: ["from", "event", "to", "reason"], properties: { ...transitionFields, reason: firstId } } };
const coverageRules = { type: "array", maxItems: 1000, items: { type: "object", additionalProperties: false,
  required: ["id", "requiresCheck", "requiredEvidenceKinds"], properties: {
    id: firstId, requiresCheck: { type: "boolean" }, requiredEvidenceKinds: { type: "array", maxItems: 5, uniqueItems: true,
      items: { type: "string", enum: ["specification", "workstream", "task", "question", "source"] } },
  } } };
const coverageTargets = { type: "array", maxItems: 101000, items: { type: "object", additionalProperties: false,
  required: ["targetId", "targetKind", "ruleIds"], properties: { targetId: firstId,
    targetKind: { type: "string", enum: ["requirement", "ac"] }, ruleIds: idList(1000) } } };
const scenarios = { type: "array", maxItems: 10000, items: { type: "object", additionalProperties: false,
  required: ["id", "state", "event", "nextState", "exceptionId"], properties: {
    id: firstId, state: firstId, event: firstId, nextState: firstId, exceptionId: { type: ["string", "null"], minLength: 1, maxLength: 160 },
  } } };
const itemDecisions = { type: "array", maxItems: 1000, items: { type: "object", additionalProperties: false,
  required: ["requirementId", "status", "reason", "sourceIds"], properties: {
    requirementId: firstId, status: { type: "string", enum: ["RESOLVED", "DELEGATED", "UNDECIDED", "NOT_APPLICABLE", "NOT_CHECKED", "INCONCLUSIVE"] },
    reason: { type: "string", minLength: 1, maxLength: 4096 }, sourceIds: idList(1000),
  } } };
export const READ_FIRST_DESIGN_REVIEW_TOOL = Object.freeze({
  name: "builder.read-first-design-review", displayName: "Read the initial design review",
  description: "Main reads the latest initial design review, its exact head and any recorded user approval. Does not publish a Baseline.",
  parametersSchema: { type: "object", additionalProperties: false, properties: {} },
});

export const PROPOSE_FIRST_DESIGN_REVIEW_TOOL = Object.freeze({
  name: "builder.propose-first-design-review", displayName: "Propose the initial design review",
  description: "Main proposes original-source links and a versioned rule pack for the exact current DesignDraft before the first Baseline. Optional designModel supplies explicit design facts, coverage rules/targets, finite design scenarios, source-linked item decisions and exact AC quotes for the same user review. These are static design inputs, not runtime observations or QA. Identity and source hashes are server-derived; the exact proposal must be confirmed by the user in Builder.",
  parametersSchema: { type: "object", additionalProperties: false,
    required: ["projectId", "expectedDraftRevisionId", "expectedReviewHeadRevisionId", "pack", "sourcePins"],
    properties: { projectId: firstId, expectedDraftRevisionId: firstId, expectedReviewHeadRevisionId: { type: ["string", "null"], maxLength: 160 },
      pack: { type: "object", additionalProperties: false,
        required: ["packId", "version", "applicability", "rules", "transitions", "exceptions", "excludedCombinations"],
        properties: { packId: firstId, version: firstId, applicability: predicate, rules: domainRules,
          transitions, exceptions, excludedCombinations } },
      sourcePins: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
        required: ["requirementId", "acId", "sourceId"], properties: { requirementId: firstId, acId: { type: ["string", "null"] }, sourceId: firstId } } },
      designModel: { type: "object", additionalProperties: false,
        required: ["facts", "rulesVersion", "coverageRules", "coverageTargets", "scenarios", "itemDecisions", "acceptanceCriteria"],
        properties: { facts: { type: "array", maxItems: 1000, items: firstId }, rulesVersion: firstId,
          coverageRules, coverageTargets, scenarios, itemDecisions,
          acceptanceCriteria: { type: "array", maxItems: 10000, items: { type: "object", additionalProperties: false,
            required: ["requirementId", "acId", "sourceId", "quote"], properties: { requirementId: firstId, acId: firstId,
              sourceId: firstId, quote: { type: "string", minLength: 1, maxLength: 8192 } } } } } },
    },
  },
});
