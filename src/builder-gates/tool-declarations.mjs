const id = { type: "string", minLength: 1, maxLength: 160 };
const uuid = { type: "string", format: "uuid" };
const branch = { type: "string", minLength: 1, maxLength: 240 };
export const PUBLISH_INTEGRATION_PLAN_TOOL = Object.freeze({
  name: "builder.publish-integration-plan", displayName: "Publish the current integration plan",
  description: "Main records the candidate Source/branch and exact current Baseline/UI scope. Optional validationPlans pin separate Host-approved CI and E2E template IDs and test-plan hashes; these are workflow references, not proof of technical approval or test execution. The candidate must differ from the protected base branch. This workflow plan grants no Git, CLI or Runner authority and starts no run. Host grants are separately checked for every effect.",
  parametersSchema: { type: "object", additionalProperties: false,
    required: ["expectedBaseRevisionId", "sourceId", "folderKey", "baseBranch", "baseCommit", "candidateBranch"],
    properties: { expectedBaseRevisionId: { type: ["string", "null"], maxLength: 160 }, sourceId: uuid, folderKey: id,
      baseBranch: branch, baseCommit: { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }, candidateBranch: branch,
      validationPlans: { type: "object", additionalProperties: false, required: ["ci", "e2e"], properties:
        Object.fromEntries(["ci", "e2e"].map(stage => [stage, { type: "object", additionalProperties: false,
          required: ["approvalTemplateId", "planSha256"], properties: { approvalTemplateId: uuid,
            planSha256: { type: "string", pattern: "^[a-f0-9]{64}$" } } }])) } } },
});
const eventScope = { type: "object", additionalProperties: false, required: ["workstreamId", "eventId"],
  properties: { workstreamId: id, eventId: id } };
export const READ_VERIFIED_WORKSTREAM_TOOL = Object.freeze({
  name: "builder.read-verified-workstream", displayName: "Read current verified integration evidence",
  description: "Only the exact independently dispatched Integration Manager run may read its current persisted verification event. This is evidence inspection, not integration, CI completion or approval.",
  parametersSchema: eventScope,
});
export const INTEGRATE_VERIFIED_TASK_TOOL = Object.freeze({
  name: "builder.integrate-verified-task", displayName: "Integrate an exact verified Task into its candidate",
  description: "The active Integration Manager may merge only a Task from its admitted, currently verified event into the Main-pinned candidate. Exact persisted source pins, reservation, current guards and the separate Host Git grant are required. A merge receipt is not CI, QA, final delivery or a protected base-branch update.",
  parametersSchema: { ...eventScope, required: [...eventScope.required, "taskId"], properties: { ...eventScope.properties, taskId: id } },
});
export const READ_INTEGRATION_PROGRESS_TOOL = Object.freeze({
  name: "builder.read-integration-progress", displayName: "Read exact integration progress",
  description: "The exact active Integration Manager reads its admitted event's immutable attempts and actual technical receipts. Unknown effects stay uncertain; this read never retries, starts a model or reports CI as passed without evidence.",
  parametersSchema: eventScope,
});
