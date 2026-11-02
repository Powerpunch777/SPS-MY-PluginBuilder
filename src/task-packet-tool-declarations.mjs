const id = { type: "string", minLength: 1, maxLength: 160 };
const text = { type: "string", minLength: 1, maxLength: 4096, pattern: "\\S",
  description: "Nonblank text; the server enforces a 4096-byte UTF-8 limit." };
const ids = { type: "array", maxItems: 64, uniqueItems: true, items: id };
const texts = { type: "array", maxItems: 32, items: text };
const ctoTaskPacketScope = { type: "object", additionalProperties: false,
  required: ["projectId", "ctoId", "workstreamId"],
  properties: { projectId: id, ctoId: id, workstreamId: id } };

const packetSchema = { type: "object", additionalProperties: false,
  description: "Planning-only packet stored for the exact current instruction. The server enforces a 48 KiB UTF-8 JSON limit.",
  required: ["projectId", "ctoId", "workstreamId", "taskId", "revision", "kind", "title", "goal", "scopeNodeIds", "requirementIds", "dependencies", "included", "excluded", "constraints", "acceptance", "evidenceRequired", "reuse", "testPlan"],
  properties: {
    projectId: id, ctoId: id, workstreamId: id, taskId: id, revision: { type: "integer", minimum: 1 },
    kind: { enum: ["development", "qa"] }, title: { ...text, maxLength: 512 }, goal: text,
    scopeNodeIds: { ...ids, minItems: 1 }, requirementIds: { ...ids, minItems: 1 }, dependencies: { ...ids, maxItems: 64 },
    included: { ...texts, minItems: 1 }, excluded: texts, constraints: texts,
    acceptance: { ...texts, minItems: 1 }, evidenceRequired: { ...texts, minItems: 1 },
    reuse: { type: "array", maxItems: 16, items: { type: "object", additionalProperties: false,
      required: ["id", "sourceUrl", "licenseStatus", "licenseExpression", "evidenceRefs", "compatibilityStatus", "reuseScope", "doNotRebuild"],
      properties: { id, sourceUrl: { type: "string", format: "uri", pattern: "^https://", maxLength: 4096,
        description: "HTTPS URL without credentials; the server verifies the protocol and rejects embedded username or password." },
        licenseStatus: { enum: ["unreviewed", "reviewed", "restricted"] },
        licenseExpression: { type: ["string", "null"], maxLength: 512 }, evidenceRefs: { ...ids, maxItems: 32 },
        compatibilityStatus: { enum: ["not-verified", "verified", "incompatible"] }, reuseScope: text, doNotRebuild: text },
    } },
    testPlan: { type: ["object", "null"], additionalProperties: false,
      required: ["environment", "steps", "expectedResults", "passCriteria"],
      properties: { environment: text, steps: { ...texts, minItems: 1 }, expectedResults: { ...texts, minItems: 1 }, passCriteria: { ...texts, minItems: 1 } } },
  },
};

export const READ_CTO_TASK_PACKETS_TOOL = Object.freeze({
  name: "builder.read-task-packets", displayName: "Read this CTO's current task packets",
  description: "Only the exact active Core-bound CTO may read packets for its current instruction. Returns planning records only; it does not create sessions, invoke providers, execute code, run QA or represent completion.",
  parametersSchema: ctoTaskPacketScope,
});

export const PUBLISH_CTO_TASK_PACKET_TOOL = Object.freeze({
  name: "builder.publish-task-packet", displayName: "Publish a planning packet for this CTO's task",
  description: "Only the exact active Core-bound CTO may publish a task packet against its current instruction and expected base revision. This stores planning only: it does not create sessions, invoke providers, execute code, run QA or represent completion. QA packets require a test plan; the service enforces that requirement. Reconcile unknown writes by reading; never retry automatically.",
  parametersSchema: { type: "object", additionalProperties: false,
    required: ["projectId", "ctoId", "workstreamId", "expectedBaseRevisionId", "revisionId", "packet"],
    properties: { projectId: id, ctoId: id, workstreamId: id,
      expectedBaseRevisionId: { type: ["string", "null"], maxLength: 160 }, revisionId: id, packet: packetSchema },
  },
});
