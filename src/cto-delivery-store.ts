import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import type { WorkstreamRecord } from "./domain/workstreams.ts";
import { parseCtoDelivery } from "./domain/cto-deliveries.ts";
import { createRevisionJournal, type RevisionState } from "./solution-revision-store.ts";
import type { parseLeadToolContext } from "./lead-tool-authority.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const workstreamInstructionDigest = (record: WorkstreamRecord) => hash({ ...record, receipt: null });

export function createCtoDeliveryStore(workspaceId: string, projectId: string, ctoId: string, state: RevisionState) {
  // The opaque journal key includes both logical scopes without introducing a
  // second scheduler. The codec still validates the real project and CTO IDs.
  return createRevisionJournal(workspaceId, `cto:${hash([projectId, ctoId])}`, state, {
    prefix: "cto-delivery", parse: value => parseCtoDelivery(value, workspaceId, projectId, ctoId),
    revisionId: value => value.revisionId,
  });
}

/** Bind new delivery turns to the actual Core receipt, not a model's claimed run ID. */
export async function resolveCtoDeliveryRun(context: ReturnType<typeof parseLeadToolContext>, projectId: string,
  ctoId: string, workstreamId: string, platform: SpsPlatformInvocationContext) {
  const current = await createCtoDeliveryStore(context.companyId, projectId, ctoId, platform.state).current();
  // Preserve existing explicitly trusted/manual tool records. Every new
  // dispatcher creates this lane before starting a CTO run.
  if (!current) return null;
  const delivery = current.revision;
  if (delivery.instruction.ctoAgentId !== context.agentId || delivery.instruction.ctoSessionId !== context.sessionId
    || delivery.instruction.spec.id !== workstreamId || delivery.phase === "prepared"
    || delivery.runId !== null && delivery.runId !== context.runId) {
    throw new Error("This CTO run is not the recorded Workstream delivery.");
  }
  const receipt = await platform.agents.sessions.getRequest(context.sessionId, context.companyId, delivery.requestId);
  if (!receipt || receipt.requestId !== delivery.requestId || receipt.state !== "submitted" || receipt.runId !== context.runId) {
    throw new Error("The Core delivery receipt does not match this active CTO run.");
  }
  return delivery;
}
