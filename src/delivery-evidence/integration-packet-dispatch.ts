import { createHash } from "node:crypto";
import type { createLeadConversationStore } from "../lead-conversations.ts";

type Store = ReturnType<typeof createLeadConversationStore>;
export function integrationPacketMainRequestId(workspaceId: string, selectionRevision: number, eventId: string) {
  const bytes = createHash("sha256").update(JSON.stringify(["builder-main-packet-v1", workspaceId, selectionRevision, eventId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 128; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The caller serializes the Workspace and rechecks the persisted packet before each send. */
export async function dispatchIntegrationPacketToMain(store: Store, requestId: string, packetRevisionId: string) {
  const before = await store.inspectRequest("main", requestId);
  if (before.turn && before.turn.inputKind !== "integration-packet-request") throw new Error("Packet request key belongs to another input kind.");
  if (before.coreReceiptRunId) return { status: "accepted" as const, requestId, runId: before.coreReceiptRunId };
  if (!before.turn || before.turn.state === "prepared") {
    await store.send("main", requestId, [
      "The Integration Manager published an evidence packet in the existing Workspace journal.",
      `Read builder.read-final-review with projection=integration-packet and verify the exact current revision ${JSON.stringify(packetRevisionId)}.`,
      "Check the approved design, files, installation/use guides, target environment, limitations and G7 evidence. Do not invent missing evidence.",
      "This is an internal work handoff, not a user instruction, design revision, G7 pass or final package approval. Only the authenticated user can finalize a package.",
    ].join("\n"), undefined, "integration-packet-request");
  } else await store.refresh("main");
  const after = await store.inspectRequest("main", requestId);
  return after.coreReceiptRunId ? { status: "accepted" as const, requestId, runId: after.coreReceiptRunId }
    : { status: "unconfirmed" as const, requestId };
}
