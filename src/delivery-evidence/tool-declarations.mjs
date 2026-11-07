const revisionId = { type: "string", minLength: 1, maxLength: 200 };
const base = { eventId: revisionId, requestId: revisionId, expectedBaseRevisionId: { anyOf: [revisionId, { type: "null" }] } };

export const READ_FINAL_REVIEW_TOOL = Object.freeze({ name: "builder.read-final-review", displayName: "Read final review records",
  description: "Read pinned final review records. projection=integration-packet reads the exact Manager handoff and verifies whether its evidence is still current. Never approve or deliver.",
  parametersSchema: { type: "object", additionalProperties: false, properties: { projection: { type: "string", enum: ["integration-packet"] } } } });

export const ATTEST_FINAL_PACKET_TOOL = Object.freeze({ name: "builder.attest-final-packet", displayName: "Attest Final Packet readiness",
  description: "Main only. Record your five-part G7 assessment against the exact current packet and evidence pins after comparing approved design, deliverables, installation, usage, validation and limitations. Server preparation and QA checks still apply. This is not user approval.",
  parametersSchema: { type: "object", additionalProperties: false, properties: { ...base,
    mainReview: { type: "object", additionalProperties: false, properties: {
      packetSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, currentPinsSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      checks: { type: "array", minItems: 5, maxItems: 5, items: { type: "object", additionalProperties: false, properties: {
        area: { type: "string", enum: ["approved-design", "deliverables", "installation", "usage", "validation-and-limits"] },
        summary: { type: "string", minLength: 1, maxLength: 2048 },
        evidenceSourceIds: { type: "array", minItems: 1, maxItems: 256, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 1100 } },
      }, required: ["area", "summary", "evidenceSourceIds"] } },
    }, required: ["packetSha256", "currentPinsSha256", "checks"] },
  }, required: [...Object.keys(base), "mainReview"] } });

export const REQUEST_FINAL_REVIEW_TOOL = Object.freeze({ name: "builder.request-final-review", displayName: "Request user final review",
  description: "Integration Review only. Post the exact Main-attested packet for a user decision. Never approve on behalf of the user.",
  parametersSchema: { type: "object", additionalProperties: false, properties: { ...base, attestationEventId: revisionId },
    required: [...Object.keys(base), "attestationEventId"] } });
