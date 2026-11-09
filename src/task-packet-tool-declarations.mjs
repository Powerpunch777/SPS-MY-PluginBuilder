const id = { type: "string", minLength: 1, maxLength: 160 };
const text = { type: "string", minLength: 1, maxLength: 4096, pattern: "\\S",
  description: "Nonblank text; the server enforces a 4096-byte UTF-8 limit." };
const ids = { type: "array", maxItems: 64, uniqueItems: true, items: id };
const texts = { type: "array", maxItems: 32, items: text };
const sourcePaths = { type: "array", maxItems: 128, uniqueItems: true, items: { ...text, maxLength: 1024 } };
const ctoTaskPacketScope = { type: "object", additionalProperties: false,
  required: ["projectId", "ctoId", "workstreamId"],
  properties: { projectId: id, ctoId: id, workstreamId: id } };

export const VERIFY_WORKSTREAM_TOOL = Object.freeze({
  name: "builder.verify-workstream", displayName: "Verify this CTO's current Workstream",
  description: "Only the assigned active CTO may request G4/G6 verification. The server reads current Baseline, coverage, Task source acceptance, completed protected execution and independent QA reports. No caller verdict or evidence is accepted. A successful current publication emits the existing integration job atomically; it is not integration completion or final delivery approval.",
  parametersSchema: ctoTaskPacketScope,
});

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
        branch: { type: "string", minLength: 1, maxLength: 240, pattern: "^(?!/)(?!.*(?:\\.\\.|\\.lock(?:/|$)|/\\.|//|@\\{))[A-Za-z0-9._/-]{1,240}(?<!\\.)$",
          description: "Optional exact source branch. Required with expectedHead to enable immutable source submission; never inferred." },
        expectedHead: { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$",
          description: "Optional exact Git head object ID. Required with branch; never inferred or chosen by a Worker." },
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
  description: "Only the exact active Core-bound CTO may publish Task Packets against its current instruction and expected base revision. Include dependent packets in additionalPackets when updating a connected group to a new instruction. All packets share one board publication. This stores planning only: it does not create sessions, execute code, run QA or represent completion. QA packets require a test plan. Reconcile unknown writes by reading; never retry automatically.",
  parametersSchema: { type: "object", additionalProperties: false,
    required: ["projectId", "ctoId", "workstreamId", "expectedBaseRevisionId", "revisionId", "packet"],
    properties: { projectId: id, ctoId: id, workstreamId: id,
      expectedBaseRevisionId: { type: ["string", "null"], maxLength: 160 }, revisionId: id, packet: packetSchema,
      additionalPackets: { type: "array", maxItems: 63, items: packetSchema } },
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
export const SUBMIT_TASK_SOURCE_TOOL = Object.freeze({
  name: "builder.submit-task-source", displayName: "Submit assigned Task source changes",
  description: "Available only to the exact active registered Worker or QA session. Commits a nonempty subset of the current role's Task write paths to the packet-pinned source alias, branch and expected head, then records the exact Core commit receipt. A conflict or uncertain outcome is not retried. This is not CTO acceptance, a protected test, task completion or QA pass.",
  parametersSchema: { type: "object", additionalProperties: false, required: ["paths"],
    properties: { paths: { type: "array", minItems: 1, maxItems: 64, uniqueItems: true, items: taskFilePath } } },
});

const taskSourceHandoffScope = { type: "object", additionalProperties: false,
  required: ["projectId", "ctoId", "workstreamId", "taskId", "submissionId"],
  properties: { projectId: id, ctoId: id, workstreamId: id, taskId: id,
    submissionId: { type: "string", pattern: "^[a-f0-9]{64}$" } } };
export const READ_TASK_SOURCE_SUBMISSIONS_TOOL = Object.freeze({
  name: "builder.read-task-source-submissions", displayName: "Read an exact Task source submission",
  description: "Only the assigned active CTO may discover the current Task source submission, or look up its exact ID. This checks the recorded source and Run, not the current Git tip or protected QA.",
  parametersSchema: { ...taskSourceHandoffScope, required: ["projectId", "ctoId", "workstreamId", "taskId"] },
});
export const ACCEPT_TASK_SOURCE_SUBMISSION_TOOL = Object.freeze({
  name: "builder.accept-task-source-submission", displayName: "Acknowledge receipt of exact submitted source",
  description: "Only the assigned active CTO may acknowledge the exact immutable submitted commit once. This records receipt, not branch freshness, QA, Task completion, or VERIFIED.",
  parametersSchema: taskSourceHandoffScope,
});

const protectedTaskQaPlan = { approvalId: { type: "string", format: "uuid" },
  planSha256: { type: "string", pattern: "^[a-f0-9]{64}$" } };
export const REQUEST_PROTECTED_TASK_QA_TOOL = Object.freeze({
  name: "builder.request-protected-task-qa", displayName: "Request protected QA for this exact Task",
  description: "Only the exact active QA Worker for its current prepared QA Task and active dispatch Run may request protected execution after the current development dependency has durable CTO acceptance and exact current Host Git proofs. Core validates the supplied approved protected plan ID and hash. Request identity is derived from the Task and acceptance; retry only the same Core idempotency request. This queues technical execution, not QA PASS, completion, or VERIFIED. When the Task run reference is confirmed, end the current AI turn normally without polling so the Node can execute the test; the real terminal event will continue the pending QA. Do not invent a completion/DONE message or a replacement request.",
  parametersSchema: { type: "object", additionalProperties: false, required: ["approvalId", "planSha256"], properties: protectedTaskQaPlan },
});
export const READ_PROTECTED_TASK_QA_TOOL = Object.freeze({
  name: "builder.read-protected-task-qa", displayName: "Read protected QA status for this exact Task",
  description: "The current CTO for this Workstream, or the exact current QA Worker, may observe only a Core run bound to this Task and acceptance. Observation is read-only and remains available after the QA model Run ends; source drift is reported as stale while retaining the protected receipt.",
  parametersSchema: { type: "object", additionalProperties: false,
    required: ["projectId", "ctoId", "workstreamId", "qaTaskId", "approvalId", "planSha256", "runId"],
    properties: { projectId: id, ctoId: id, workstreamId: id, qaTaskId: id, ...protectedTaskQaPlan,
      runId: { type: "string", format: "uuid" } } },
});
export const READ_PROTECTED_TASK_QA_HISTORY_TOOL = Object.freeze({
  name: "builder.read-protected-task-qa-history", displayName: "Read protected QA run history for this Task",
  description: "Only the exact active CTO for this Workstream may page through immutable Task-to-Core-run references. Historical pins remain visible after packet/source changes; Core is queried for current technical run status, and no QA verdict or completion is inferred.",
  parametersSchema: { type: "object", additionalProperties: false,
    required: ["projectId", "ctoId", "workstreamId", "qaTaskId"],
    properties: { projectId: id, ctoId: id, workstreamId: id, qaTaskId: id,
      cursor: { type: ["string", "null"], maxLength: 512 } } },
});

export const PUBLISH_TASK_QA_REPORT_TOOL = Object.freeze({
  name: "builder.publish-task-qa-report", displayName: "Publish exact independent Task QA report",
  description: "Only the exact active independent QA Worker may assess every current Task acceptance and test-plan criterion against its exact completed protected Core run. Verdict is derived from the technical receipt and criterion assessments, never a caller pass flag. This is not Workstream VERIFIED, integration, or user delivery approval.",
  parametersSchema: { type: "object", additionalProperties: false,
    required: ["projectId", "ctoId", "workstreamId", "qaTaskId", "approvalId", "planSha256", "runId", "expectedBaseRevisionId", "checks", "summary"],
    properties: { projectId: id, ctoId: id, workstreamId: id, qaTaskId: id, ...protectedTaskQaPlan,
      runId: { type: "string", format: "uuid" }, expectedBaseRevisionId: { anyOf: [id, { type: "null" }] },
      checks: { type: "array", minItems: 1, maxItems: 128, items: { type: "object", additionalProperties: false,
        required: ["criterionId", "verdict", "note"], properties: { criterionId: { type: "string", minLength: 1, maxLength: 100 },
          verdict: { type: "string", enum: ["passed", "failed", "not-tested"] }, note: { type: "string", minLength: 1, maxLength: 4096 } } } },
      summary: { type: "string", minLength: 1, maxLength: 8192 } } },
});
