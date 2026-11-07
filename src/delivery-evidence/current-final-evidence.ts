import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { deliveryDocumentPin, readCurrentDeliveryDocuments } from "../project-documents/delivery-documents.ts";
import { readProtectedOutputArtifactBytes } from "../protected-test-output-artifacts.ts";
import { readCurrentIntegrationPacket } from "./integration-packet.ts";
import { readIntegrationCandidate, integrationCandidateEvidenceDigest } from "./integration-candidate.ts";
import { readDeliverySourceSnapshot } from "./source-snapshot.ts";
import { finalPacketPinsDigest, sealFinalPacket, type FinalEvidenceReader, type FinalPacketPin } from "./final-packet.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytesHash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const pin = (sourceId: string, revisionId: string, sha256: string): FinalPacketPin => ({ sourceId, revisionId, sha256 });

/** Server-owned current evidence only. Readiness checks prepare a candidate for
 * Main's separate attestation; no external caller supplies PASS or file bytes. */
export function createCurrentFinalEvidenceReader(workspaceId: string, platform: SpsPlatformInvocationContext): FinalEvidenceReader {
  return async () => {
    const unknown = (reason: string) => ({ status: "unknown" as const, reason });
    try {
      const handoff = await readCurrentIntegrationPacket(workspaceId, platform);
      if (handoff.status !== "available") return unknown("current-manager-packet-unavailable");
      const evidence = handoff.packet.evidence, preparationRead = await readCurrentDeliveryDocuments(workspaceId, platform);
      const docs = preparationRead.document, preparation = docs?.preparation;
      if (!docs || !preparation || preparationRead.source !== "current" || docs.revisionId !== evidence.documentRevisionId) {
        return unknown("current-delivery-preparation-unavailable");
      }
      const candidate = await readIntegrationCandidate(workspaceId, platform);
      if (candidate.status !== "observed" || integrationCandidateEvidenceDigest(candidate) !== evidence.candidateEvidenceSha256
        || !candidate.regression || candidate.scopeTrace.unmappedRequirementIds.length) return unknown("current-integration-evidence-changed");
      if (!candidate.ci.outputs || candidate.ci.outputs.status !== "matched" || !candidate.ci.outputs.files.length) {
        return unknown("current-build-artifact-bytes-unavailable");
      }
      const files = evidence.files;
      const declaredTargets = new Set(preparation.targets.map(item => item.target));
      if (new Set(files.map(file => file.target)).size !== declaredTargets.size || files.some(file => !declaredTargets.has(file.target))) {
        return unknown("delivery-preparation-targets-do-not-match-inventory");
      }
      for (const target of preparation.targets) {
        for (const path of target.entryPaths) if (!files.some(file => file.path === path && file.target === target.target && file.byteLength > 0)) {
          return unknown("delivery-entry-file-not-proven");
        }
        for (const path of target.supplementaryPaths) if (!files.some(file => file.path === path && file.target === target.target)
          && !docs.documents.some(document => document.path === path)) return unknown("delivery-supplementary-file-not-proven");
      }
      const gitPaths = files.filter(file => file.source === "git").map(file => file.path);
      const git = await readDeliverySourceSnapshot(evidence.candidate, gitPaths.length ? gitPaths : [evidence.manifest.path], platform);
      if (git.status !== "available" || git.manifestSha256 !== evidence.manifest.sourceTreeManifestSha256) return unknown("current-delivery-git-bytes-unavailable");
      const reference = candidate.attempts.flatMap(attempt => attempt.validationRuns?.ci ? [attempt.validationRuns.ci] : [])
        .find(ref => ref.runId === candidate.ci.runId && ref.commitSha === candidate.candidate.commitSha && ref.treeSha === candidate.candidate.treeSha);
      if (!reference?.runId || !reference.approvalId) return unknown("current-build-run-reference-unavailable");
      const build = await readProtectedOutputArtifactBytes({ workspaceId, runId: reference.runId, subjectKey: reference.subjectKey,
        approvalId: reference.approvalId, sourceId: evidence.candidate.sourceId, commitSha: evidence.candidate.commitSha,
        treeSha: evidence.candidate.treeSha, planSha256: reference.planSha256 }, platform);
      if (build.status !== "available" || build.manifestSha256 !== candidate.ci.outputs.manifestSha256) return unknown("current-build-output-unconfirmed");
      const fileBytes: Array<{ path: string; bytes: Uint8Array }> = [];
      for (const file of files) {
        const data = (file.source === "git" ? git.fileBytes : build.fileBytes).find(item => item.path === file.path);
        if (!data || data.bytes.byteLength !== file.byteLength || bytesHash(data.bytes) !== file.sha256) return unknown("delivery-file-bytes-disagree");
        fileBytes.push({ path: file.path, bytes: data.bytes });
      }
      const packetFiles = files.map(file => ({ path: file.path, classification: file.classification, size: file.byteLength, sha256: file.sha256 }));
      for (const document of docs.documents) {
        const bytes = new TextEncoder().encode(document.body), existing = packetFiles.find(file => file.path.toLowerCase() === document.path.toLowerCase());
        if (existing && (existing.path !== document.path || existing.sha256 !== document.bodySha256 || existing.size !== bytes.byteLength)) {
          return unknown("delivery-document-file-disagrees");
        }
        if (!existing) {
          packetFiles.push({ path: document.path, classification: document.classification, size: bytes.byteLength, sha256: document.bodySha256 });
          fileBytes.push({ path: document.path, bytes });
        }
      }
      const technicalPin = (phase: string) => {
        const value = evidence.validation.find(run => run.phase === phase)!;
        return pin(`protected-${phase}:${value.runId}`, value.receiptSha256!, value.receiptSha256!);
      };
      const qaById = new Map<string, FinalPacketPin>();
      for (const workstream of evidence.workstreams) for (const qa of workstream.qa) {
        const old = qaById.get(qa.report.sourceId);
        if (old && JSON.stringify(old) !== JSON.stringify(qa.report)) return unknown("conflicting-current-qa-references");
        qaById.set(qa.report.sourceId, qa.report);
      }
      const packetRevisionId = `delivery-packet-v1:${hash([handoff.packetRevisionId, docs.revisionId])}`;
      const packet = sealFinalPacket({
        packetId: `workspace-delivery:${workspaceId}`, packetRevisionId,
        baseline: pin(evidence.baseline.sourceId, evidence.baseline.revisionId, evidence.baseline.sha256),
        uiRevision: evidence.ui, manifest: pin(`delivery-inventory:${hash([evidence.candidate.sourceId, evidence.manifest.path])}`,
          evidence.candidate.commitSha, evidence.manifest.sha256),
        integration: { branch: evidence.candidate.branch, commitSha: evidence.candidate.commitSha,
          build: pin(`protected-build-output:${reference.runId}`, candidate.ci.receiptSha256!, build.manifestSha256),
          ciEvidence: [technicalPin("ci")], e2eEvidence: [technicalPin("e2e")], regressionEvidence: [technicalPin("regression")] },
        files: packetFiles, documents: docs.documents.map((document, index) => ({ kind: document.kind, pin: deliveryDocumentPin(docs, index) })),
        qaEvidence: [...qaById.values()], g6Evidence: evidence.workstreams.map(workstream => pin(`g6-workstream:${hash(workstream.workstreamId)}`,
          workstream.eventId, hash(workstream))),
        g7Evidence: [pin(`delivery-preparation:${workspaceId}`, docs.revisionId, hash({ preparation,
          candidate: evidence.candidateEvidenceSha256, manifest: evidence.manifest, files: packetFiles }))],
        limits: [preparation.limitationStatement, ...preparation.limitations].filter((value, index, all) => all.indexOf(value) === index),
        changeHistory: [], preparation,
      });
      const after = await readCurrentIntegrationPacket(workspaceId, platform);
      if (after.status !== "available" || after.packetRevisionId !== handoff.packetRevisionId || after.packet.sha256 !== handoff.packet.sha256) {
        return unknown("current-final-evidence-changed-during-read");
      }
      return { status: "available", value: { provenance: { adapter: "builder.final-packet-current-evidence.v1", operation: "readCurrent" },
        workspaceId, projectId: workspaceId, packet, commitObjectBytes: git.commitObjectBytes, fileBytes,
        integrationCodeAuthority: "verified", hostRuntimeAuthority: "verified", g6: "PASS", g7: "PASS", qa: "PASS",
        currentPinsSha256: finalPacketPinsDigest(packet) } };
    } catch { return unknown("current-final-evidence-unconfirmed"); }
  };
}
