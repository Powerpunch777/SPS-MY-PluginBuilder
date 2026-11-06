export const SPEC_ASSURANCE_PACK_PROPOSAL_TOOL = Object.freeze({
  name: "builder.propose-spec-assurance-pack",
  displayName: "Propose a specification assurance pack",
  description: "Only Main stores a versioned Domain Pack proposal for the current approved specification. Source IDs name the baseline's actual Main user source; digests and specification identity are server-derived. This proposal is not approval, source coverage, QA or execution permission.",
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
        properties: { packId: firstId, version: firstId, applicability: { type: "object" }, rules: { type: "array" },
          transitions: { type: "array" }, exceptions: { type: "array" }, excludedCombinations: { type: "array" } } },
      sourcePins: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
        required: ["requirementId", "acId", "sourceId"], properties: { requirementId: firstId, acId: { type: ["string", "null"] }, sourceId: firstId } } },
      designModel: { type: "object", additionalProperties: false,
        required: ["facts", "rulesVersion", "coverageRules", "coverageTargets", "scenarios", "itemDecisions", "acceptanceCriteria"],
        properties: { facts: { type: "array", maxItems: 1000, items: firstId }, rulesVersion: firstId,
          coverageRules: { type: "array", maxItems: 1000 }, coverageTargets: { type: "array", maxItems: 101000 },
          scenarios: { type: "array", maxItems: 10000 }, itemDecisions: { type: "array", maxItems: 1000 },
          acceptanceCriteria: { type: "array", maxItems: 10000, items: { type: "object", additionalProperties: false,
            required: ["requirementId", "acId", "sourceId", "quote"], properties: { requirementId: firstId, acId: firstId,
              sourceId: firstId, quote: { type: "string", minLength: 1, maxLength: 8192 } } } } } },
    },
  },
});
