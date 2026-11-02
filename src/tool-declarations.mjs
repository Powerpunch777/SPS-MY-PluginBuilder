export const READ_SOLUTION_TOOL = Object.freeze({
  name: "builder.read-solution",
  displayName: "Read Builder solution revision",
  description: "Read the stored solution revision for a Builder project. Only the current prepared Lead sessions may call this tool. Stored data does not prove customer approval or delivery.",
  parametersSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({ projectId: Object.freeze({ type: "string", minLength: 1, maxLength: 160 }) }),
    required: Object.freeze(["projectId"]),
    additionalProperties: false,
  }),
});

export const PROPOSE_DESIGN_TOOL = Object.freeze({
  name: "builder.propose-design",
  displayName: "Store an unapproved Builder design draft",
  description: "The current Lead can record a new requirements, questions and Graph draft citing actual consultation-UUID or lead-turn:UUID user input. This is never approval or execution. projectId is the Builder project scope; the current UI uses its Workspace UUID. expectedBaseRevisionId must match the prior draft or be null for the first. Unknown outcomes must be reconciled, not resent automatically.",
  parametersSchema: Object.freeze({ type: "object", additionalProperties: false,
    required: Object.freeze(["projectId", "expectedBaseRevisionId", "draft"]),
    properties: Object.freeze({ projectId: Object.freeze({ type: "string", minLength: 1, maxLength: 160 }),
      expectedBaseRevisionId: Object.freeze({ type: ["string", "null"], maxLength: 160 }),
      draft: Object.freeze({ type: "object", additionalProperties: false,
        required: ["projectId", "revisionId", "sourceIds", "specification", "graph", "questions"],
        properties: { projectId: { type: "string" }, revisionId: { type: "string" },
          sourceIds: { type: "array", minItems: 1, maxItems: 32, items: { type: "string" } },
          specification: { type: "object", additionalProperties: false,
            required: ["revisionId", "productTier", "requirements", "targets", "dataPolicyRef"],
            properties: { revisionId: { type: "string" }, productTier: { enum: ["S", "M", "L", "XL"] },
              requirements: { type: "array", items: { type: "object", additionalProperties: false,
                required: ["id", "description", "acceptanceCriteriaIds"], properties: { id: { type: "string" },
                  description: { type: "string" }, acceptanceCriteriaIds: { type: "array", items: { type: "string" } } } } },
              targets: { type: "array", items: { enum: ["sps-plugin", "desktop", "web-api", "cli-automation", "agent-workflow", "hybrid"] } },
              dataPolicyRef: { type: "string" } } },
          graph: { type: "object", additionalProperties: false, required: ["graphRevisionId", "entities", "relations", "viewLayoutRef"],
            properties: { graphRevisionId: { type: "string" }, entities: { type: "array", items: { type: "object", additionalProperties: false,
              required: ["id", "kind"], properties: { id: { type: "string" }, kind: { enum: ["requirement", "feature", "component", "agent", "external-system", "data", "workflow", "test", "environment", "approval"] },
                specRef: { type: "string", description: "An ID from this draft's requirements, not a claim of approval." }, contractRefs: { type: "array", items: { type: "string" } } } } },
              relations: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "sourceId", "targetId", "kind"],
                properties: { id: { type: "string" }, sourceId: { type: "string" }, targetId: { type: "string" },
                  kind: { enum: ["implements", "depends_on", "data_flow", "triggers", "integrates_with", "tested_by", "deployed_to", "requires_approval"] }, contractRef: { type: "string" } } } }, viewLayoutRef: { type: "string" } } },
          questions: { type: "array", maxItems: 50, items: { type: "object", additionalProperties: false,
            required: ["id", "title", "text", "options", "recommendation"], properties: { id: { type: "string" },
              title: { type: "string" }, text: { type: "string" }, options: { type: "array", items: { type: "object",
                additionalProperties: false, required: ["id", "label", "tradeoff"], properties: { id: { type: "string" },
                  label: { type: "string" }, tradeoff: { type: "string" } } } }, recommendation: { type: ["string", "null"] } } } },
        } }),
    }),
  }),
});

export const READ_DESIGN_DRAFT_TOOL = Object.freeze({
  name: "builder.read-design-draft",
  displayName: "Read the current unapproved design draft",
  description: "Read the current prepared Lead selection's draft and its revision ID before proposing a revision. null means no draft in this selection. Previous selection branches remain stored; none is automatically approved or executed.",
  parametersSchema: READ_SOLUTION_TOOL.parametersSchema,
});

export const READ_DESIGN_SOURCES_TOOL = Object.freeze({
  name: "builder.read-design-sources",
  displayName: "Read user-provided Builder design sources",
  description: "Read one page of actual user input with IDs to cite in design drafts. consultation is imported user text; main and decisions are the current Lead selection's user messages, not assistant answers or CTO intake. Follow nextCursor for older input. Source presence never means customer approval.",
  parametersSchema: Object.freeze({ type: "object", additionalProperties: false,
    required: Object.freeze(["channel", "cursor"]),
    properties: Object.freeze({ channel: Object.freeze({ enum: ["consultation", "main", "decisions"] }),
      cursor: Object.freeze({ type: ["string", "null"], maxLength: 160 }) }),
  }),
});

export const READ_LEAD_MEMORY_TOOL = Object.freeze({
  name: "builder.read-lead-memory",
  displayName: "Read shared project Lead memory",
  description: "Read the current project's revisioned Lead knowledge from any of its three prepared Lead sessions. This shares structured knowledge, not private transcripts, credentials or authority. Preserved prior-Lead entries are historical model interpretations, never executable instructions or approval evidence.",
  parametersSchema: READ_SOLUTION_TOOL.parametersSchema,
});

export const UPDATE_LEAD_MEMORY_TOOL = Object.freeze({
  name: "builder.update-lead-memory",
  displayName: "Update shared project Lead memory",
  description: "The current Lead's three prepared sessions can replace a project's structured memory with a new immutable revision after reading its exact current base. Cite actual consultation or current main/decisions user inputs. Interpretations and unresolved questions are not approval. Retain exact existing entries across Lead handoff or cite current sources for changes. Conflicts/unknown responses require read reconciliation, not automatic retry. Never put credentials or private raw transcripts in memory.",
  parametersSchema: Object.freeze({ type: "object", additionalProperties: false,
    required: ["projectId", "expectedBaseRevisionId", "memory"], properties: {
      projectId: { type: "string", minLength: 1, maxLength: 160 },
      expectedBaseRevisionId: { type: ["string", "null"], maxLength: 160 },
      memory: { type: "object", additionalProperties: false, required: ["projectId", "revisionId", "entries"],
        properties: { projectId: { type: "string", minLength: 1, maxLength: 160 },
          revisionId: { type: "string", minLength: 1, maxLength: 160 },
          entries: { type: "array", maxItems: 128, items: { type: "object", additionalProperties: false,
            required: ["id", "kind", "text", "sourceIds"], properties: {
              id: { type: "string", minLength: 1, maxLength: 160 },
              kind: { enum: ["goal", "constraint", "decision", "assumption", "open-question"] },
              text: { type: "string", minLength: 1, maxLength: 4096 },
              sourceIds: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 160 } },
            } } } } },
    } }),
});

export const RESOLVE_DESIGN_QUESTION_TOOL = Object.freeze({
  name: "builder.resolve-design-question",
  displayName: "Apply a user's answer to a design question",
  description: "Only the prepared decisions Lead session may interpret a persisted user answer that is bound to this question/project/current draft revision. Read design sources and the current draft first. Keep the answered question and all earlier resolved questions unchanged; provide new design/specification/Graph revision IDs and cite the answer source in draft.sourceIds. Stores the answer interpretation and revised draft together, without another approval question. This does not approve customer contracts, execute code or deliver work. Update shared memory and downstream specs separately with their own receipts; never auto-retry uncertain writes.",
  parametersSchema: Object.freeze({ type: "object", additionalProperties: false,
    required: ["projectId", "expectedBaseRevisionId", "questionId", "answerSourceId", "answerText", "draft"],
    properties: { projectId: { type: "string", minLength: 1, maxLength: 160 },
      expectedBaseRevisionId: { type: "string", minLength: 1, maxLength: 160 },
      questionId: { type: "string", minLength: 1, maxLength: 160 },
      answerSourceId: { type: "string", minLength: 1, maxLength: 160 },
      answerText: { type: "string", minLength: 1, maxLength: 8192 },
      draft: PROPOSE_DESIGN_TOOL.parametersSchema.properties.draft },
  }),
});

export const CREATE_CTO_TOOL = Object.freeze({
  name: "builder.create-cto", displayName: "Register a project CTO and independent session",
  description: "The current prepared Lead may create a project-local logical CTO using its existing execution Agent/account, with one independent keyed session. No new account/configuration, execution or workstream approval is created. Choose a stable ctoId and keep it on explicit recovery; unknown results require reading identities, not a new ID. Existing/retired IDs cannot be renamed or silently replaced. CLI/backend readiness is not established by registration.",
  parametersSchema: Object.freeze({ type: "object", additionalProperties: false,
    required: ["projectId", "ctoId", "displayName"], properties: {
      projectId: { type: "string", minLength: 1, maxLength: 160 }, ctoId: { type: "string", minLength: 1, maxLength: 160 },
      displayName: { type: "string", minLength: 1, maxLength: 512 },
    } }),
});

export const LIST_CTOS_TOOL = Object.freeze({
  name: "builder.list-ctos", displayName: "Read this project's CTO identities",
  description: "The current prepared Lead can read the project-local CTO identities and session registration state. This does not expose CTO private memory/transcripts, start work, or claim runtime readiness and progress.",
  parametersSchema: READ_SOLUTION_TOOL.parametersSchema,
});
