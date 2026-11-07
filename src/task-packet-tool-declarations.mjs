const id = { type: "string", minLength: 1, maxLength: 160 };
const text = { type: "string", minLength: 1, maxLength: 4096, pattern: "\\S",
  description: "Nonblank text; the server enforces a 4096-byte UTF-8 limit." };
const ids = { type: "array", maxItems: 64, uniqueItems: true, items: id };
const texts = { type: "array", maxItems: 32, items: text };
const sourcePaths = { type: "array", maxItems: 128, uniqueItems: true, items: { ...text, maxLength: 1024 } };
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
    sourceAccess: { type: "object", additionalProperties: false,
      required: ["sourceId", "folderKey", "readPaths", "writePaths", "qaWritePaths"],
      description: "Optional typed Task file scope. Use the manifest-declared project-source folder alias configured by the Host user; do not invent a folder or local path. Core's stored Host folder grant remains authoritative; the Host must verify the alias resolves to this Workspace Source root. Worker implementation paths and separate QA test/config paths are disjoint; this does not grant Git or protected Node execution.",
      properties: { sourceId: { type: "string", format: "uuid" }, folderKey: id,
        readPaths: sourcePaths, writePaths: sourcePaths, qaWritePaths: sourcePaths } },
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

export const PREPARE_TASK_WORKER_TOOL = Object.freeze({
  name: "builder.prepare-task-worker", displayName: "Prepare a Task Worker or QA session",
  description: "Only the exact active Core-bound CTO may register an owned identity and keyed session for the specified current Task Packet revision on a supporting Host. This does not start an AI run, execute code, run QA or grant execution permission. Reconcile unknown results by reading; never retry automatically.",
  parametersSchema: { ...ctoTaskPacketScope, required: [...ctoTaskPacketScope.required, "taskId", "packetRevision", "role"],
    properties: { ...ctoTaskPacketScope.properties, taskId: id, packetRevision: { type: "integer", minimum: 1 },
      role: { enum: ["worker", "qa"] } } },
});

export const READ_TASK_WORKERS_TOOL = Object.freeze({
  name: "builder.read-task-workers", displayName: "Read this CTO's Task Worker registrations",
  description: "Only the exact active Core-bound CTO may read Task Worker and QA registration history for its Workstream. Registration is not execution, readiness, or QA evidence.",
  parametersSchema: ctoTaskPacketScope,
});

export const DISPATCH_TASK_WORKER_TOOL = Object.freeze({
  name: "builder.dispatch-task-worker", displayName: "Dispatch this CTO's prepared Task Worker",
  description: "Only the exact active Core-bound CTO delivery may dispatch a prepared Worker or QA session for an exact current packet revision. This starts one restricted session Run; it does not claim completion, Git commit, protected test execution or QA pass.",
  parametersSchema: { type: "object", additionalProperties: false,
    required: ["projectId", "ctoId", "workstreamId", "taskId", "packetRevision", "role"],
    properties: { projectId: id, ctoId: id, workstreamId: id, taskId: id,
      packetRevision: { type: "integer", minimum: 1 }, role: { enum: ["worker", "qa"] } } },
});

const taskFilePath = { type: "string", minLength: 1, maxLength: 1024, pattern: "\\S" };
export const READ_TASK_SOURCE_FILE_TOOL = Object.freeze({
  name: "builder.read-task-source-file", displayName: "Read an assigned Task source file",
  description: "Available only to the active registered Worker or QA session for its exact current Task Packet. The requested path must be in that packet's readPaths and the configured Host folder must currently match its pinned Workspace Source root.",
  parametersSchema: { type: "object", additionalProperties: false, required: ["relativePath"],
    properties: { relativePath: taskFilePath } },
});
export const WRITE_TASK_SOURCE_FILE_TOOL = Object.freeze({
  name: "builder.write-task-source-file", displayName: "Write an assigned Task source file",
  description: "Available only to the active registered Worker or QA session for its exact current Task Packet. Worker writes are restricted to writePaths; QA writes are restricted to qaWritePaths. This performs one atomic text-file write through the current Workspace Host folder API; it does not commit Git or run tests.",
  parametersSchema: { type: "object", additionalProperties: false, required: ["relativePath", "contents"],
    properties: { relativePath: taskFilePath, contents: { type: "string", maxLength: 262144 } } },
});
export const DELETE_TASK_SOURCE_FILE_TOOL = Object.freeze({
  name: "builder.delete-task-source-file", displayName: "Delete an assigned Task source file",
  description: "Available only to the active registered Worker or QA session for its exact current Task Packet. The requested path must be in that role's exact write set. This does not commit Git or establish completion.",
  parametersSchema: { type: "object", additionalProperties: false, required: ["relativePath"],
    properties: { relativePath: taskFilePath } },
});
