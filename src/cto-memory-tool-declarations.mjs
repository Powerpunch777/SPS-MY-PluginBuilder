const id = { type: "string", minLength: 1, maxLength: 160 };
const uuid = { type: "string", minLength: 36, maxLength: 36,
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" };
const text = { type: "string", minLength: 1, maxLength: 4096, pattern: "\\S",
  description: "Nonblank text; the server enforces a 4096-byte UTF-8 limit." };
const projectCtoWorkstream = { type: "object", additionalProperties: false,
  required: ["projectId", "ctoId", "workstreamId"],
  properties: { projectId: id, ctoId: id, workstreamId: id } };

export const READ_CTO_MEMORY_TOOL = Object.freeze({
  name: "builder.read-cto-memory", displayName: "Read this registered CTO's private project memory",
  description: "Only this registered CTO's exact active Core-bound Workstream run may read its own project-and-CTO-scoped memory across its Workstream revisions. The Workstream is the access context, not a separate shared memory pool. A Lead or another CTO cannot read it. Memory is the CTO's bounded interpretation, not approval, evidence, or execution authority.",
  parametersSchema: projectCtoWorkstream,
});

export const UPDATE_CTO_MEMORY_TOOL = Object.freeze({
  name: "builder.update-cto-memory", displayName: "Update this registered CTO's private project memory",
  description: "Only this registered CTO's exact active Core-bound Workstream run may replace its own project-and-CTO-scoped memory at the exact expected base revision. Entries are context, decisions, assumptions or open questions with source request UUIDs. New interpretations cite this exact delivery; unchanged inherited notes may retain old provenance. Interpretations are not approval or evidence. Unknown write outcomes must be reconciled by reading; never automatically retry. A Lead or another CTO cannot write this memory.",
  parametersSchema: { type: "object", additionalProperties: false,
    required: ["projectId", "ctoId", "workstreamId", "expectedBaseRevisionId", "memory"],
    properties: { projectId: id, ctoId: id, workstreamId: id,
      expectedBaseRevisionId: { type: ["string", "null"], maxLength: 160 },
      memory: { type: "object", additionalProperties: false,
        description: "The server enforces a 128 KiB UTF-8 JSON limit across this memory revision.",
        required: ["projectId", "ctoId", "revisionId", "entries"],
        properties: { projectId: id, ctoId: id, revisionId: id,
          entries: { type: "array", maxItems: 128, items: { type: "object", additionalProperties: false,
            required: ["id", "kind", "text", "sourceRequestIds"],
            properties: { id, kind: { enum: ["context", "decision", "assumption", "open-question"] }, text,
              sourceRequestIds: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: uuid } },
          } } },
      },
    },
  },
});
