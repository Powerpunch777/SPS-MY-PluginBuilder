import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import type { BuilderLeadSessions } from "../domain/model.ts";
import { deliveryDocumentPin, readCurrentDeliveryDocuments, type DeliveryDocumentsRead } from "../project-documents/delivery-documents.ts";
import type { createFinalPacketStore } from "./final-packet.ts";

type Store = ReturnType<typeof createFinalPacketStore>;
type ReviewEvidence = NonNullable<Awaited<ReturnType<Store["reviewEvidence"]>>>;

export type FinalReviewDeliveryDocument = Readonly<{
  kind: "installation-guide" | "user-guide" | "other";
  pin: Readonly<{ sourceId: string; revisionId: string; sha256: string }>;
  status: "available" | "stale" | "unknown" | "unavailable";
  path: string | null;
  body: string | null;
}>;

/** Exposes only bodies whose exact producer pins match the displayed current packet. */
export function resolveFinalReviewDeliveryDocuments(packet: ReviewEvidence["snapshot"]["packet"], workspaceId: string,
  projectId: string, read: DeliveryDocumentsRead | null, packetIsCurrent: boolean): readonly FinalReviewDeliveryDocument[] {
  return Object.freeze(packet.documents.map(target => {
    const empty = (status: FinalReviewDeliveryDocument["status"]): FinalReviewDeliveryDocument => Object.freeze({
      kind: target.kind, pin: target.pin, status, path: null, body: null,
    });
    if (!packetIsCurrent) return empty("stale");
    if (!read || read.status !== "available" || !read.document) return empty("unavailable");
    if (read.source === "unknown") return empty("unknown");
    if (read.source === "stale") return empty("stale");
    const bundle = read.document;
    if (bundle.workspaceId !== workspaceId || bundle.projectId !== projectId || bundle.status !== "draft"
      || bundle.approvalStatus !== "unapproved" || bundle.completeness.status !== "unknown"
      || read.confirmed !== false || read.completeness !== "unknown" || read.currentRevisionId !== bundle.revisionId) return empty("unknown");
    const suffix = /^delivery-documents-v1:([a-f0-9]{64})$/u.exec(bundle.revisionId)?.[1];
    if (!suffix) return empty("unknown");
    for (const [index, candidate] of bundle.documents.entries()) {
      if (candidate.kind !== target.kind) continue;
      const pin = deliveryDocumentPin(bundle, index);
      if (pin.sourceId !== target.pin.sourceId) continue;
      if (target.pin.revisionId !== pin.revisionId || target.pin.sha256 !== pin.sha256) return empty("stale");
      return Object.freeze({ kind: target.kind, pin: target.pin, status: "available", path: candidate.path, body: candidate.body });
    }
    return empty(target.pin.sourceId.startsWith(`delivery-document:${workspaceId}/${projectId}:`) ? "stale" : "unavailable");
  }));
}

export async function readFinalReview(store: Store, sessions: BuilderLeadSessions, platform: SpsPlatformInvocationContext) {
  const [history, evidence] = await Promise.all([store.current(), store.reviewEvidence()]);
  const latest = history.revisions[0]?.revision ?? null;
  const storedRequest = latest ? history.revisions.find(({ revision }) => revision.requestId === latest.requestId && revision.kind === "approval-request")?.revision ?? null : null;
  const storedAttestation = latest ? history.revisions.find(({ revision }) => revision.requestId === latest.requestId && revision.kind === "main-attestation"
    && (!storedRequest?.request || revision.eventId === storedRequest.request.attestationEventId))?.revision ?? null : null;
  const historical = storedRequest?.request ?? storedAttestation?.attestation ?? null;
  const candidate = evidence?.snapshot.packet;
  const changedRevision = Boolean(candidate && historical && candidate.packetRevisionId !== historical.packet.packetRevisionId);
  const conflictingRevision = Boolean(candidate && historical && !changedRevision
    && candidate.packetSha256 !== historical.packet.packetSha256);
  const currentJournal = !changedRevision && !conflictingRevision;
  const request = currentJournal ? storedRequest : null;
  const attestation = currentJournal ? storedAttestation : null;
  const payload = request?.request ?? null;
  const main = attestation?.attestation ?? null;
  const decision = currentJournal && latest?.kind === "user-decision" ? latest : null;
  const pinnedEvidence = conflictingRevision ? null : evidence;
  const snapshot: ReviewEvidence["snapshot"] | null = pinnedEvidence?.snapshot ?? (historical ? {
    workspaceId: sessions.workspaceId, projectId: sessions.workspaceId, packet: historical.packet,
    currentPinsSha256: historical.currentPinsSha256, integrationCodeAuthority: "unknown", hostRuntimeAuthority: "unknown",
    g6: "UNKNOWN", g7Preparation: "UNKNOWN", g7: "UNKNOWN", qa: "UNKNOWN",
  } : null);
  if (!snapshot) return { status: "unknown" as const };
  const deliveryRead = await readCurrentDeliveryDocuments(sessions.workspaceId, platform);
  const deliveryDocuments = resolveFinalReviewDeliveryDocuments(snapshot.packet, snapshot.workspaceId, snapshot.projectId,
    deliveryRead, Boolean(candidate && currentJournal && !changedRevision && !conflictingRevision));

  async function receipt(sessionId: string, runId: string, agentId: string) {
    try {
      const run = await platform.agents.sessions.getRun(sessionId, sessions.workspaceId, runId);
      return run.runId === runId && run.status === "succeeded" && !run.cancellationRequested
        ? { verification: "verified" as const, workspaceId: sessions.workspaceId, sessionId, runId, agentId } : null;
    } catch { return null; }
  }
  const bound = Boolean(payload && main?.mainReview && payload.snapshotSha256 === main.snapshotSha256
    && payload.currentPinsSha256 === main.currentPinsSha256 && payload.packet.packetSha256 === main.packet.packetSha256
    && payload.mainLeadAgentId === main.mainLeadAgentId && payload.mainLeadSelectionRevision === main.mainLeadSelectionRevision
    && payload.mainLeadRunId === main.mainLeadRunId && payload.mainLeadSessionId === main.mainLeadSessionId
    && payload.mainLeadAgentId === sessions.agentId
    && payload.integrationReviewAgentId === sessions.agentId && payload.mainLeadSelectionRevision === sessions.selectionRevision
    && payload.mainLeadSessionId === sessions.sessions.main && payload.integrationReviewSessionId === sessions.sessions["integration-review"]
    && payload.mainLeadSessionId !== payload.integrationReviewSessionId);
  const [mainReceipt, integrationReviewReceipt] = payload && bound ? await Promise.all([
    receipt(payload.mainLeadSessionId, payload.mainLeadRunId, payload.mainLeadAgentId),
    receipt(payload.integrationReviewSessionId, payload.integrationReviewRunId, payload.integrationReviewAgentId),
  ]) : [null, null];
  const eligible = Boolean(pinnedEvidence?.eligible && payload && latest?.eventId === request?.eventId && mainReceipt && integrationReviewReceipt
    && payload.snapshotSha256 === pinnedEvidence.snapshotSha256 && payload.currentPinsSha256 === snapshot.currentPinsSha256);
  return { status: "ready" as const, snapshot, mainAttestation: attestation, approvalRequest: request, decision,
    deliveryDocuments,
    mainReceipt, integrationReviewReceipt, approvalEligibility: { status: eligible ? "eligible" as const : pinnedEvidence ? "blocked" as const : "unknown" as const,
      ...(changedRevision ? { reason: "The current packet revision needs its own Main attestation and approval request." }
        : conflictingRevision ? { reason: "The current packet hash conflicts with the recorded immutable revision." } : {}) },
    // A review view is bounded; the full immutable history stays in its existing journal.
    history: history.revisions.slice(0, 4).map(({ revision }) => ({ eventId: revision.eventId, kind: revision.kind,
      requestId: revision.requestId, decision: revision.decision })) };
}
