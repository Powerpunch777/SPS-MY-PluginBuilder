import { parseMainG7Review } from "../../src/domain/main-g7-review.ts";

type Packet = Parameters<typeof parseMainG7Review>[1];
export function mainG7ReviewFixture(packet: Packet, currentPinsSha256: string) {
  const groups = {
    "approved-design": [packet.baseline, packet.uiRevision],
    deliverables: [packet.manifest, packet.integration.build],
    installation: packet.documents.filter(document => document.kind === "installation-guide").map(document => document.pin),
    usage: packet.documents.filter(document => document.kind === "user-guide").map(document => document.pin),
    "validation-and-limits": [...packet.qaEvidence, ...packet.g6Evidence, ...packet.g7Evidence,
      ...packet.integration.ciEvidence, ...packet.integration.e2eEvidence, ...(packet.integration.regressionEvidence ?? [])],
  };
  const review = parseMainG7Review({ packetSha256: packet.packetSha256, currentPinsSha256,
    checks: Object.entries(groups).map(([area, pins]) => ({ area, summary: `Fixture Main comparison for ${area}.`,
      evidenceSourceIds: [...new Set(pins.map(pin => pin.sourceId))] })) }, packet, currentPinsSha256);
  return { ...review, checks: review.checks.map(check => ({ ...check, evidenceSourceIds: [...check.evidenceSourceIds] })) };
}
