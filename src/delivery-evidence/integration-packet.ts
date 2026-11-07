import type { SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { readVerifiedWorkstreamForManager } from "../builder-gates/integration-manager-job.ts";
import { exactToolRecord, parseLeadToolContext } from "../lead-tool-authority.ts";
import type { RevisionPublicationGuard, RevisionState } from "../solution-revision-store.ts";
import { createFinalPacketStore } from "./final-packet.ts";
import { collectIntegrationPacketEvidence } from "./integration-packet-evidence.ts";

export async function publishIntegrationPacket(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const row = exactToolRecord(params, ["workstreamId", "eventId", "expectedBaseRevisionId"]);
  const context = parseLeadToolContext(runContext), workspaceId = context.companyId;
  const expected = row.expectedBaseRevisionId;
  if (expected !== null && (typeof expected !== "string" || expected.length > 200 || !expected.trim())) {
    throw new TypeError("An exact expected final-delivery head or null is required.");
  }
  const state = platform.state as RevisionState;
  const event = { workstreamId: row.workstreamId, eventId: row.eventId };
  await readVerifiedWorkstreamForManager(event, runContext, platform);
  if (typeof state.guardedCompareAndSetWithJobWakeV1 !== "function") return { status: "unsupported", reason: "integration-packet-atomic-main-wake-unavailable" };
  const captured = new Map<string, RevisionPublicationGuard>();
  const tracked = { ...platform, state: { ...platform.state, async get(key: SpsStateKey) {
    if (key.scopeKind !== "company" || key.scopeId !== workspaceId) throw new Error("Packet evidence escaped its Workspace.");
    const value = await platform.state.get(key);
    if (value !== null && !key.stateKey.includes("-revision.v1.")) {
      const identity = JSON.stringify([key.namespace ?? "default", key.stateKey]);
      const prior = captured.get(identity);
      if (prior && JSON.stringify(prior.expectedValue) !== JSON.stringify(value)) throw new Error("Packet evidence changed during read.");
      captured.set(identity, { stateKey: key.stateKey, ...(key.namespace === undefined ? {} : { namespace: key.namespace }), expectedValue: value });
    }
    return value;
  } } };
  const first = await collectIntegrationPacketEvidence(workspaceId, tracked);
  if (first.status !== "collected") return first;
  const store = createFinalPacketStore(workspaceId, workspaceId, state);
  const [head] = (await store.current()).revisions;
  const previous = await store.currentManagerPacket();
  await readVerifiedWorkstreamForManager(event, runContext, tracked);
  const latest = await collectIntegrationPacketEvidence(workspaceId, tracked);
  if (latest.status !== "collected" || latest.sha256 !== first.sha256) return { status: "stale", reason: "integration-packet-evidence-changed-before-write" };
  await readVerifiedWorkstreamForManager(event, runContext, tracked);
  if (previous?.revision.managerPacket?.sha256 === latest.sha256) return { status: "existing", eventId: previous.revision.eventId,
    packetRevisionId: previous.revision.requestId, sequence: previous.sequence };
  if ((head?.revision.eventId ?? null) !== expected) return { status: "conflict", actualBaseRevisionId: head?.revision.eventId ?? null };
  const guards = [...captured.values()];
  if (guards.length > 64 || Buffer.byteLength(JSON.stringify(guards), "utf8") > 200_000) {
    return { status: "unsupported", reason: "integration-packet-guard-bound" };
  }
  try {
    return await store.publishManagerPacket({ evidence: latest.evidence, sha256: latest.sha256, expectedBaseRevisionId: expected,
      author: { agentId: context.agentId, sessionId: context.sessionId, runId: context.runId }, guards });
  } catch {
    return { status: "unknown", reason: "integration-packet-publication-unconfirmed-read-before-retrying" };
  }
}

/** Main/Review read path; the historical packet survives lost current authority. */
export async function readCurrentIntegrationPacket(workspaceId: string, platform: SpsPlatformInvocationContext) {
  const store = createFinalPacketStore(workspaceId, workspaceId, platform.state);
  const entry = await store.currentManagerPacket();
  if (!entry?.revision.managerPacket) return { status: "pending" as const, reason: "manager-packet-not-published" };
  const current = await collectIntegrationPacketEvidence(workspaceId, platform);
  const latest = await store.currentManagerPacket();
  const reference = { eventId: entry.revision.eventId, packetRevisionId: entry.revision.requestId, sequence: entry.sequence };
  if (latest?.revision.eventId !== entry.revision.eventId || current.status !== "collected"
    || current.sha256 !== entry.revision.managerPacket.sha256) return { status: current.status === "unknown" || current.status === "unsupported"
      ? "unknown" as const : "stale" as const, ...reference,
    reason: current.status === "collected" ? "manager-packet-evidence-changed" : current.reason };
  return { status: "available" as const, ...reference, packet: entry.revision.managerPacket, approvalEligibility: "not-established" as const };
}
