const id = { type: "string", minLength: 1, maxLength: 160 };
const text = { type: "string", minLength: 1, maxLength: 4096, pattern: "\\S",
  description: "Nonblank text; the server validates its UTF-8 byte limit." };
const title = { type: "string", minLength: 1, maxLength: 512, pattern: "\\S" };
const evidenceRefs = { type: "array", maxItems: 32, uniqueItems: true, items: id };
const scopeNodeIds = { type: "array", minItems: 1, maxItems: 64, uniqueItems: true, items: id };
const project = { type: "object", additionalProperties: false, required: ["projectId"], properties: { projectId: id } };

export const SUBMIT_CTO_QUESTION_TOOL = Object.freeze({
  name: "builder.submit-cto-question", displayName: "Submit a planning question from this CTO",
  description: "Only the exact active Core-bound CTO delivery may submit a Workstream-scoped question for Lead intake. This stores a planning proposal only: it does not message the user, auto-dispatch work, grant approval, or authorize implementation. Reconcile an unknown write by reading; never automatically retry.",
  parametersSchema: { type: "object", additionalProperties: false,
    required: ["projectId", "ctoId", "workstreamId", "expectedBaseRevisionId", "revisionId", "proposal"],
    properties: { projectId: id, ctoId: id, workstreamId: id,
      expectedBaseRevisionId: { type: ["string", "null"], maxLength: 160 }, revisionId: id,
      proposal: { type: "object", additionalProperties: false,
        required: ["id", "title", "context", "reasonNeeded", "options", "recommendation", "delayImpact", "scopeNodeIds", "evidenceRefs"],
        properties: { id, title, context: text, reasonNeeded: text,
          options: { type: "array", minItems: 2, maxItems: 8, items: { type: "object", additionalProperties: false,
            required: ["id", "label", "tradeoff"], properties: { id, label: text, tradeoff: text } } },
          recommendation: { type: ["string", "null"], maxLength: 160 }, delayImpact: text,
          scopeNodeIds, evidenceRefs },
      },
    },
  },
});

export const READ_CTO_QUESTIONS_TOOL = Object.freeze({
  name: "builder.read-cto-questions", displayName: "Read questions waiting in this project's CTO intake",
  description: "Only a prepared Lead session with CTO intake authority may read project-scoped CTO question proposals for planning review. Reading does not approve an option, create a user question, dispatch work, or authorize implementation.",
  parametersSchema: project,
});

export const READ_OWN_CTO_QUESTION_TOOL = Object.freeze({
  name: "builder.read-own-cto-question", displayName: "Read this CTO's own question receipt",
  description: "Only the exact active Core-bound CTO session may read its own Workstream question and Lead review, plus the current board revision. No other CTO question or private memory is returned. Read before publishing and after an uncertain write; this never resends or starts work.",
  parametersSchema: { type: "object", additionalProperties: false, required: ["projectId", "ctoId", "workstreamId", "questionId"],
    properties: { projectId: id, ctoId: id, workstreamId: id, questionId: id } },
});

export const REVIEW_CTO_QUESTION_TOOL = Object.freeze({
  name: "builder.review-cto-question", displayName: "Record the Lead's planning review of a CTO question",
  description: "Only a prepared Lead CTO-intake session may record a revision-bound planning review: existing specification, delegated choice, or user decision needed. Only user-decision-needed is eligible for the user decisions list. This does not generate a user answer, approve implementation, respond to the CTO or dispatch work. Read the current revision before retrying; unknown writes are never automatically repeated.",
  parametersSchema: { type: "object", additionalProperties: false,
    required: ["projectId", "questionId", "expectedBaseRevisionId", "revisionId", "reviewId", "disposition", "rationale", "evidenceRefs"],
    properties: { projectId: id, questionId: id, expectedBaseRevisionId: id,
      revisionId: id, reviewId: id,
      disposition: { enum: ["existing-specification", "delegated-choice", "user-decision-needed"] },
      rationale: text, evidenceRefs },
  },
});
