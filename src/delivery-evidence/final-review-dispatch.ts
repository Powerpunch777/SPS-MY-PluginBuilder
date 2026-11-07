import type { createLeadConversationStore } from "../lead-conversations.ts";
import type { FinalPacketJournalEvent } from "./final-packet.ts";

export const FINAL_REVIEW_JOB = "builder.request-packet-user-review";
export const FINAL_REVIEW_EVENT = "builder.final-packet.main-attested";

export async function dispatchFinalReview(store: ReturnType<typeof createLeadConversationStore>, requestId: string,
  event: FinalPacketJournalEvent) {
  if (event.kind !== "main-attestation" || !event.attestation) throw new Error("An exact Main attestation is required.");
  const channel = "integration-review";
  const before = await store.inspectRequest(channel, requestId);
  if (before.turn && before.turn.inputKind !== "final-review-request") throw new Error("Final review request key belongs to another input kind.");
  if (before.coreReceiptRunId) return { status: "accepted" as const, requestId, runId: before.coreReceiptRunId };
  if (!before.turn || before.turn.state === "prepared") {
    await store.send(channel, requestId, [
      "Main recorded a final package readiness attestation in this Workspace.",
      `Read builder.read-final-review and inspect current attestation ${JSON.stringify(event.eventId)} for package ${JSON.stringify(event.requestId)}.`,
      "If all exact source and attestation references remain current, register the user review request with builder.request-final-review.",
      "The request must use this Main attestation event as its expectedBaseRevisionId and attestationEventId. Do not approve on behalf of the user.",
      "This internal handoff is not a user message, product change, deployment instruction or final package approval.",
    ].join("\n"), undefined, "final-review-request");
  } else await store.refresh(channel);
  const after = await store.inspectRequest(channel, requestId);
  return after.coreReceiptRunId ? { status: "accepted" as const, requestId, runId: after.coreReceiptRunId }
    : { status: "unconfirmed" as const, requestId };
}
