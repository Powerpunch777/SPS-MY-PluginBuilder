const id = { type: "string", minLength: 1, maxLength: 160 };
const uuid = { type: "string", format: "uuid" };
const branch = { type: "string", minLength: 1, maxLength: 240 };
export const PUBLISH_INTEGRATION_PLAN_TOOL = Object.freeze({
  name: "builder.publish-integration-plan", displayName: "Publish the current integration plan",
  description: "Main records the candidate Source/branch and exact current Baseline/UI scope. Optional validationPlans pin Host-approved CI and E2E templates and a separate regression template when required, each with its test-plan hash. These are workflow references, not proof of approval or execution. No Git, CLI or Runner authority is granted and no run starts.",
  parametersSchema: { type: "object", additionalProperties: false,
    required: ["expectedBaseRevisionId", "sourceId", "folderKey", "baseBranch", "baseCommit", "candidateBranch"],
    properties: { expectedBaseRevisionId: { type: ["string", "null"], maxLength: 160 }, sourceId: uuid, folderKey: id,
      baseBranch: branch, baseCommit: { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }, candidateBranch: branch,
      validationPlans: { type: "object", additionalProperties: false, required: ["ci", "e2e"], properties:
        Object.fromEntries(["ci", "e2e", "regression"].map(stage => [stage, { type: "object", additionalProperties: false,
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
  description: "The exact active Integration Manager reads its admitted event's immutable attempts and actual technical receipts. Optional projection=candidate checks current Workstream verification, observed Task integration effects and CI/E2E plus any configured regression on the same candidate Commit/Tree. Missing regression is not a pass. This read never retries or starts execution, and does not establish G6/G7 or delivery approval.",
  parametersSchema: { ...eventScope, properties: { ...eventScope.properties, projection: { type: "string", enum: ["candidate"] } } },
});
export const REQUEST_INTEGRATION_VALIDATION_TOOL = Object.freeze({
  name: "builder.request-integration-validation", displayName: "Request exact candidate validation",
  description: "The exact admitted Integration Manager requests only a Main-pinned Host-approved CI, E2E or regression plan for its current observed candidate Commit/Tree. Core rechecks the separate technical template and execution permissions. Retries reconcile the same persisted request; finite technical success is not QA approval, G6/G7 completion or delivery approval.",
  parametersSchema: { ...eventScope, required: [...eventScope.required, "taskId", "phase"],
    properties: { ...eventScope.properties, taskId: id, phase: { type: "string", enum: ["ci", "e2e", "regression"] } } },
});
