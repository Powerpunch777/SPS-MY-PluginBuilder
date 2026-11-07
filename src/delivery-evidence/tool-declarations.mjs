const revisionId = { type: "string", minLength: 1, maxLength: 200 };
const base = { eventId: revisionId, requestId: revisionId, expectedBaseRevisionId: { anyOf: [revisionId, { type: "null" }] } };

export const READ_FINAL_REVIEW_TOOL = Object.freeze({ name: "builder.read-final-review", displayName: "Read final review records",
  description: "Read pinned final review records. projection=integration-packet reads the exact Manager handoff and verifies whether its evidence is still current. Never approve or deliver.",
  parametersSchema: { type: "object", additionalProperties: false, properties: { projection: { type: "string", enum: ["integration-packet"] } } } });

export const ATTEST_FINAL_PACKET_TOOL = Object.freeze({ name: "builder.attest-final-packet", displayName: "Attest Final Packet readiness",
  description: "Main only. Recheck current Final Packet and required QA/G6/G7 evidence before recording readiness. This is not user approval.",
  parametersSchema: { type: "object", additionalProperties: false, properties: base, required: Object.keys(base) } });

export const REQUEST_FINAL_REVIEW_TOOL = Object.freeze({ name: "builder.request-final-review", displayName: "Request user final review",
  description: "Integration Review only. Post the exact Main-attested packet for a user decision. Never approve on behalf of the user.",
  parametersSchema: { type: "object", additionalProperties: false, properties: { ...base, attestationEventId: revisionId },
    required: [...Object.keys(base), "attestationEventId"] } });
