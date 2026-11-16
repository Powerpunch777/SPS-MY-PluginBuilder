const id = { type: "string", minLength: 1, maxLength: 160 };
const projectCto = { type: "object", additionalProperties: false, required: ["projectId", "ctoId"],
  properties: { projectId: id, ctoId: id } };

export const DISPATCH_CTO_WORKSTREAM_TOOL = Object.freeze({
  name: "builder.dispatch-workstream", displayName: "Dispatch a planning-only Workstream event to its registered CTO",
  description: "The prepared Lead admits the exact Workstream revision to its already registered independent CTO session using Core's stable admission receipt. This is planning-only: it does not create or replace sessions, retry an unknown write, start code or Workers, authorize QA, or establish implementation completion. Read the existing delivery after an uncertain result.",
  parametersSchema: { type: "object", additionalProperties: false,
    required: ["projectId", "workstreamId", "specRevision", "boardRevisionId"],
    properties: { projectId: id, workstreamId: id, specRevision: { type: "integer", minimum: 1 }, boardRevisionId: id } },
});

export const READ_CTO_WORKSTREAM_DELIVERY_TOOL = Object.freeze({
  name: "builder.read-workstream-delivery", displayName: "Read the existing CTO Workstream delivery",
  description: "Read Core's existing provider status for the registered CTO delivery. This reports delivery status only; it does not resend, replace a session, or imply readiness, code, Workers, QA, or implementation completion.",
  parametersSchema: projectCto,
});

export const CANCEL_CTO_WORKSTREAM_DELIVERY_TOOL = Object.freeze({
  name: "builder.cancel-workstream-delivery", displayName: "Request cancellation of the exact CTO delivery run",
  description: "Request cancellation only for the exact verified Core run recorded for this delivery. A cancellation request or acknowledgement is not proof of process exit, and does not imply implementation completion. An unknown dispatch is never retried or replaced.",
  parametersSchema: projectCto,
});
