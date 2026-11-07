const projectId = { type: "string", minLength: 1, maxLength: 160 };
const textList = (minItems, maxItems, maxLength = 2048) => ({ type: "array", minItems, maxItems, uniqueItems: true,
  items: { type: "string", minLength: 1, maxLength } });
const preparation = { type: "object", additionalProperties: false,
  required: ["packageVersion", "targets", "limitationStatement", "limitations", "changeNotes"],
  properties: { packageVersion: { type: "string", minLength: 1, maxLength: 80 },
    targets: { type: "array", minItems: 1, maxItems: 6, items: { type: "object", additionalProperties: false,
      required: ["target", "environments", "dependencies", "entryPaths", "supplementaryPaths"],
      properties: { target: { enum: ["sps-plugin", "desktop", "web-api", "cli-automation", "agent-workflow", "hybrid"] },
        environments: textList(1, 16), dependencies: textList(0, 32), entryPaths: textList(1, 32, 200),
        supplementaryPaths: textList(0, 32, 200) } } },
    limitationStatement: { type: "string", minLength: 1, maxLength: 2048 }, limitations: textList(0, 32),
    changeNotes: textList(1, 32) } };

export const PROPOSE_DELIVERY_DOCUMENTS_TOOL = Object.freeze({
  name: "builder.propose-delivery-documents", displayName: "Store delivery document drafts",
  description: "Main only. Store installation and user guides as unapproved drafts in the existing document Revision journal. The server pins the current Baseline, formal UI, integration plan and authorized Source commit/tree. It uses the current candidate when present and the plan base only before the candidate exists. A draft does not prove integration, QA, G7 or user approval. Read the current head before changing it; reconcile uncertain outcomes without generating another revision.",
  parametersSchema: { type: "object", additionalProperties: false,
    required: ["projectId", "expectedBaseRevisionId", "documents"], properties: {
      projectId, expectedBaseRevisionId: { type: ["string", "null"], minLength: 1, maxLength: 200 },
      preparation,
      documents: { type: "array", minItems: 2, maxItems: 32,
        description: "Exactly one installation-guide and one user-guide are required. All bodies together must fit 192 KiB UTF-8.",
        items: { type: "object", additionalProperties: false, required: ["kind", "path", "classification", "scope", "body"],
          properties: { kind: { enum: ["installation-guide", "user-guide", "other"] },
            path: { type: "string", minLength: 1, maxLength: 512 },
            classification: { type: "string", minLength: 1, maxLength: 160 },
            scope: { type: "string", minLength: 1, maxLength: 2048 },
            body: { type: "string", minLength: 1, maxLength: 196608 } } } },
    } },
});

export const READ_DELIVERY_DOCUMENTS_TOOL = Object.freeze({
  name: "builder.read-delivery-documents", displayName: "Read delivery document drafts",
  description: "Read current Main-authored installation/user guide drafts, exact revision/hash pins and current/stale/unknown Source status. Only prepared Lead sessions may read this tool. Drafts remain unapproved and completeness remains unknown; a read does not execute AI, attest G7 or approve delivery.",
  parametersSchema: { type: "object", additionalProperties: false, required: ["projectId"], properties: { projectId } },
});
