import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { deliveryDocumentPin, readCurrentDeliveryDocuments } from "../project-documents/delivery-documents.ts";
import { integrationCandidateEvidenceDigest, readIntegrationCandidate } from "./integration-candidate.ts";
import { readDeliveryInventory } from "./delivery-inventory.ts";

export const integrationPacketDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
export const INTEGRATION_PACKET_MAIN_JOB = "builder.review-integration-packet";
export const INTEGRATION_PACKET_EVENT = "builder.integration.packet-published";

/** This is the Manager-to-Main evidence, not a user approval candidate.
 * Source and document observations have to refer to the same immutable candidate. */
export async function collectIntegrationPacketEvidence(workspaceId: string, platform: SpsPlatformInvocationContext) {
  const candidate = await readIntegrationCandidate(workspaceId, platform);
  if (candidate.status !== "observed") return candidate;
  const pending = (reason: string) => ({ status: "pending" as const, reason });
  if (!candidate.regression) return pending("integration-packet-regression-not-configured");
  if (candidate.scopeTrace.unmappedRequirementIds.length) return pending("integration-packet-approved-scope-incomplete");
  const g6 = candidate.snapshots.map(snapshot => ({ workstreamId: snapshot.workstreamId, eventId: snapshot.eventId,
    gate: snapshot.gateDecisions.find(gate => gate.gateId === "G6"), qa: snapshot.qaEvidence }));
  if (g6.some(item => !item.gate?.evidenceRefs.length || !item.qa.length)) return pending("integration-packet-workstream-g6-unavailable");
  const validation = [candidate.ci, candidate.e2e, candidate.regression].map(run =>
    ({ phase: run.phase, runId: run.runId, receiptSha256: run.receiptSha256 }));
  if (validation.some(run => !run.runId || !run.receiptSha256)) return pending("integration-packet-exact-validation-receipts-unavailable");
  const inventory = await readDeliveryInventory(workspaceId, platform);
  if (inventory.status !== "observed") return inventory;
  const evidenceSha256 = integrationCandidateEvidenceDigest(candidate);
  if (inventory.candidateEvidenceSha256 !== evidenceSha256) return { status: "stale" as const, reason: "integration-packet-candidate-evidence-changed" };
  const docs = await readCurrentDeliveryDocuments(workspaceId, platform);
  const document = docs.document;
  if (docs.status !== "available" || !document || docs.source !== "current") return pending("integration-packet-current-guides-unavailable");
  const { sourceId, folderKey, branch, commitSha, treeSha } = document.source;
  if (inventory.candidate.sourceId !== sourceId || inventory.candidate.folderKey !== folderKey || inventory.candidate.branch !== branch
    || inventory.candidate.commitSha !== commitSha || inventory.candidate.treeSha !== treeSha
    || document.integrationPlan.revisionId !== candidate.plan.revisionId) {
    return { status: "stale" as const, reason: "integration-packet-guide-candidate-mismatch" };
  }
  const documents = document.documents.map((item, index) => ({ kind: item.kind, path: item.path, classification: item.classification,
    scope: item.scope, pin: deliveryDocumentPin(document, index) }));
  for (const item of documents) {
    const file = inventory.files.find(file => file.path.toLowerCase() === item.path.toLowerCase());
    if (file && (file.path !== item.path || file.sha256 !== item.pin.sha256)) {
      return { status: "unknown" as const, reason: "integration-packet-guide-file-disagrees-with-pinned-document" };
    }
  }
  const tasks = [...new Map(candidate.scopeTrace.requirements.flatMap(requirement => requirement.tasks)
    .map(task => [JSON.stringify([task.workstreamId, task.taskId]), task])).values()];
  if (tasks.length !== candidate.attempts.length) return pending("integration-packet-task-trace-incomplete");
  const scope = candidate.scopeTrace.requirements.map(requirement => ({ requirementId: requirement.requirementId,
    acceptanceCriteriaIds: requirement.acceptanceCriteriaIds, tasks: requirement.tasks.map(task => [task.workstreamId, task.taskId]) }));
  const evidence = {
    workspaceId, projectId: workspaceId, candidate: candidate.candidate, candidateEvidenceSha256: evidenceSha256,
    plan: document.integrationPlan, baseline: document.baseline, ui: document.ui, boardRevisionId: candidate.boardRevisionId,
    workstreams: g6, tasks, scope, validation, buildOutputs: candidate.ci.outputs?.status === "matched" ? candidate.ci.outputs : null,
    manifest: inventory.manifest, files: inventory.files, documentRevisionId: document.revisionId, documents,
    finalReadiness: "main-g7-required" as const, deliveryAuthority: "not-established" as const,
  };
  return { status: "collected" as const, evidence, sha256: integrationPacketDigest(evidence) };
}

export type IntegrationPacketEvidence = Extract<Awaited<ReturnType<typeof collectIntegrationPacketEvidence>>, { status: "collected" }>["evidence"];
