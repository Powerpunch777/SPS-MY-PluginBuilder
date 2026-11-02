const id = { type: "string", minLength: 1, maxLength: 160 };
const text = { type: "string", minLength: 1, maxLength: 4096, pattern: "\\S" };
const ids = { type: "array", maxItems: 128, uniqueItems: true, items: id };
const texts = { type: "array", maxItems: 128, uniqueItems: true, items: text };
const project = { type: "object", additionalProperties: false, required: ["projectId"], properties: { projectId: id } };

export const PUBLISH_WORKSTREAM_TOOL = Object.freeze({
  name: "builder.publish-workstream", displayName: "Record a versioned CTO Workstream instruction",
  description: "Only the prepared Lead may publish a functional Workstream, not a dependency edge. Read baseline, technology register, CTO identities and current board first. Supply the exact next specification revision and prior board revision, goal, included/excluded scope, interface refs, acceptance/evidence and explicit change impact/timing. The Host pins exact published source revisions. Each Graph node has one responsible CTO; that CTO delegates internal parallel work to its Workers. Other CTOs can use interfaces/dependencies without co-owning that node. This records an instruction pending CTO receipt, never sends a session message, starts code/Workers or grants external authority. Unknown writes require reads, not automatic retry.",
  parametersSchema: { type: "object", additionalProperties: false,
    required: ["projectId", "expectedBaseRevisionId", "revisionId", "spec", "change"],
    properties: { projectId: id, expectedBaseRevisionId: { type: ["string", "null"], maxLength: 160 }, revisionId: id,
      spec: { type: "object", additionalProperties: false,
        required: ["projectId", "id", "revision", "sourceSpecRevisionId", "assignedCtoId", "title", "goal", "scopeNodeIds", "included", "excluded", "dependencies", "interfaceContracts", "technologyDecisionsRef", "reuseCandidates", "acceptance", "evidenceRequired", "openQuestions"],
        properties: { projectId: id, id, revision: { type: "integer", minimum: 1 }, sourceSpecRevisionId: id,
          assignedCtoId: id, title: { type: "string", minLength: 1, maxLength: 512, pattern: "\\S" }, goal: text,
          scopeNodeIds: { ...ids, minItems: 1 }, included: { ...texts, minItems: 1 }, excluded: texts,
          dependencies: texts, interfaceContracts: ids, technologyDecisionsRef: id, reuseCandidates: texts,
          acceptance: { ...texts, minItems: 1 }, evidenceRequired: { ...texts, minItems: 1 }, openQuestions: ids,
        } },
      change: { type: "object", additionalProperties: false,
        required: ["previousRevision", "reason", "diff", "impactNodeIds", "impactInterfaceContracts", "impactTaskIds", "effectiveFrom"],
        properties: { previousRevision: { type: ["integer", "null"], minimum: 1 }, reason: text, diff: text,
          impactNodeIds: ids, impactInterfaceContracts: ids, impactTaskIds: ids, effectiveFrom: text } },
    } },
});
export const READ_WORKSTREAMS_TOOL = Object.freeze({
  name: "builder.read-workstreams", displayName: "Read the project Workstream board as Lead",
  description: "The current prepared Lead reads the versioned project instructions and CTO readiness reports. Pending receipt is not delivery, readiness is not execution, and no PR/test/QA completion is inferred. Earlier revisions remain historical.",
  parametersSchema: project,
});
export const READ_CTO_WORKSTREAM_TOOL = Object.freeze({
  name: "builder.read-cto-workstream", displayName: "Read this CTO's assigned Workstream and pinned sources",
  description: "Only the registered CTO's exact Agent/session can read its assigned instruction with published design/technology sources. Pass the received Workstream ID and read the board revision before acknowledging. Sources stay pinned, not silently upgraded. This is not another CTO's private memory, a dispatch or code execution authority.",
  parametersSchema: { type: "object", additionalProperties: false, required: ["projectId", "ctoId", "workstreamId"],
    properties: { projectId: id, ctoId: id, workstreamId: id } },
});
export const ACKNOWLEDGE_WORKSTREAM_TOOL = Object.freeze({
  name: "builder.acknowledge-workstream", displayName: "Record the assigned CTO's understanding and readiness",
  description: "Only the assigned CTO's exact independent session records understanding/readiness for the exact current Workstream specification and expected board revision. ready is a CTO report, never a running/completed state or code permission. Explain ambiguities/blocks; execution cancellation/continuation/rework and Worker/QA evidence are separate later contracts. Unknown writes require read reconciliation, not automatic retry. The user or Lead cannot impersonate this receipt.",
  parametersSchema: { type: "object", additionalProperties: false,
    required: ["projectId", "ctoId", "workstreamId", "expectedBaseRevisionId", "revisionId", "specRevision", "readiness", "note"],
    properties: { projectId: id, ctoId: id, workstreamId: id, expectedBaseRevisionId: id, revisionId: id,
      specRevision: { type: "integer", minimum: 1 }, readiness: { enum: ["ready", "needs-clarification", "blocked"] }, note: text } },
});
