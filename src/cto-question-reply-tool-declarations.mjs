const id = { type: "string", minLength: 1, maxLength: 160, pattern: "\\S" };
const evidenceRefs = { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: id };

export const ANSWER_CTO_QUESTION_TOOL = Object.freeze({
  name: "builder.answer-cto-question", displayName: "Record the Lead's internal answer to a CTO question",
  description: "Only the exact receipt-bound Lead CTO-intake run may answer the delivered question for its CTO. This records an internal planning reply and stable admission only, not a user decision, approval or implementation completion. Unknown sends must be read and reconciled; never resend automatically.",
  parametersSchema: { type: "object", additionalProperties: false, required: ["projectId", "questionId", "answer"],
    properties: { projectId: id, questionId: id, answer: { type: "object", additionalProperties: false,
      required: ["text", "selectedOptionId", "evidenceRefs"], properties: {
        text: { type: "string", minLength: 1, maxLength: 8192, pattern: "\\S",
          description: "Nonblank internal reply; the server validates the 8192-byte UTF-8 limit." },
        selectedOptionId: { type: ["string", "null"], maxLength: 160 }, evidenceRefs,
      } },
    },
  },
});

const ownQuestion = { type: "object", additionalProperties: false,
  required: ["projectId", "ctoId", "workstreamId", "questionId"],
  properties: { projectId: id, ctoId: id, workstreamId: id, questionId: id } };

export const READ_CTO_QUESTION_ANSWER_TOOL = Object.freeze({
  name: "builder.read-cto-question-answer", displayName: "Read the internal Lead reply to this CTO question",
  description: "Only the actual registered CTO on the exact current Workstream run may read its bound question answer/admission receipt. This is internal planning context, never implementation approval or completion.",
  parametersSchema: ownQuestion,
});

export const ACKNOWLEDGE_CTO_QUESTION_ANSWER_TOOL = Object.freeze({
  name: "builder.acknowledge-cto-question-answer", displayName: "Acknowledge the internal reply to this CTO question",
  description: "Only the actual registered CTO on the exact current Workstream run may acknowledge its bound internal planning reply. Understanding is not implementation approval, completion or user consent.",
  parametersSchema: { type: "object", additionalProperties: false,
    required: ["projectId", "ctoId", "workstreamId", "questionId", "understanding"],
    properties: { projectId: id, ctoId: id, workstreamId: id, questionId: id,
      understanding: { type: "string", minLength: 1, maxLength: 4096, pattern: "\\S",
        description: "Nonblank CTO acknowledgement; the server validates the 4096-byte UTF-8 limit." } },
  },
});
