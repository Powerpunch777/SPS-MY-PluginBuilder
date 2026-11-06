const identifier = { type: "string", minLength: 1, maxLength: 160 };

export const READ_REUSE_CANDIDATES_TOOL = Object.freeze({
  name: "builder.read-reuse-candidates",
  displayName: "Read project reuse candidates",
  description: "Main or Background reads this Workspace's immutable Reuse-First candidate journal. A cited user research excerpt is not license, compatibility or reuse clearance. Unknown rights remain blocked.",
  parametersSchema: { type: "object", additionalProperties: false, required: ["projectId"],
    properties: { projectId: identifier } },
});

export const RECORD_REUSE_CANDIDATE_TOOL = Object.freeze({
  name: "builder.record-reuse-candidate",
  displayName: "Record a sourced reuse candidate",
  description: "Background only. Read the current candidate revision, then record a candidate from bounded lines of an existing authenticated Main or Discussion user turn. This is a user-provided research report, not external research, verified rights or approval. No caller excerpt/hash, consultation source or license claim is accepted. Keep candidateId stable and reconcile unknown writes by reading.",
  parametersSchema: { type: "object", additionalProperties: false, required: ["projectId", "expectedRevisionId", "candidate"],
    properties: { projectId: identifier, expectedRevisionId: { type: ["string", "null"], maxLength: 160 },
      candidate: { type: "object", additionalProperties: false,
        required: ["candidateId", "name", "kind", "originUrl", "originVersion", "source", "productTier", "route", "deliveryTargets"],
        properties: { candidateId: identifier, name: { type: "string", minLength: 1, maxLength: 240 },
          kind: { enum: ["blueprint", "code", "external-product", "new-code-gap"] },
          originUrl: { type: "string", minLength: 1, maxLength: 2048 }, originVersion: { type: ["string", "null"], maxLength: 256 },
          source: { type: "object", additionalProperties: false, required: ["sourceId", "fromLine", "throughLine"],
            properties: { sourceId: identifier, fromLine: { type: "integer", minimum: 1 }, throughLine: { type: "integer", minimum: 1 } } },
          productTier: { enum: ["S", "M", "L", "XL"] }, route: { enum: ["FAST", "ASSEMBLY", "CUSTOM"] },
          deliveryTargets: { type: "array", minItems: 1, maxItems: 6, uniqueItems: true,
            items: { enum: ["sps-plugin", "desktop", "web-api", "cli-automation", "agent-workflow", "hybrid"] } },
        },
      },
    },
  },
});
