import { isTrustedRegistryResolution, type RegistryResolution } from "./registry.ts";

export const BUILDER_GATE_IDS = ["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7"] as const;
export type BuilderGateId = typeof BUILDER_GATE_IDS[number];
export const BUILDER_GATE_PURPOSES: Readonly<Record<BuilderGateId, string>> = Object.freeze({
  G0: "customer requirements, product, quotation, contract terms, licensing and reuse rights",
  G1: "consultation to structured specification, including source, behavior, exceptions, coverage, UI links and acceptance criteria",
  G2: "post-design technology and reuse selection, operating cost, capability, license and environment evidence",
  G3: "Lead to CTO Workstream coverage, dependencies, interfaces, approved UI contracts, ownership and revision",
  G4: "CTO to Worker Task contract, allowed effects, authority, tests and execution-time revision",
  G5: "additional requirements and design changes, old/new Spec and UI diffs, bidirectional impact, ACK and staleness",
  G6: "Worker implementation to CTO/Lead integration, independent QA and bidirectional code/spec/UI conformance",
  G7: "Builder deliverable readiness: program, install/run/use documentation, required UI description, test results and limitations",
});
export type GateVerdict = "PASS" | "BLOCK" | "REVIEW" | "UNKNOWN";
export type EvidencePin = Readonly<{ sourceId: string; revisionId: string; sha256: string }>;

/** Exact scope identity and source pins expected by the caller at evaluation time. */
export type GateScopeSnapshot = Readonly<{
  workspaceId: string;
  projectId: string;
  scopeId: string;
  revisionId: string;
  pins: readonly EvidencePin[];
}>;

/** The only accepted gate evidence carries a resolution minted by the Registry lookup path. */
export type GateEvidence = Readonly<{
  gateId: BuilderGateId;
  target: GateScopeSnapshot;
  evidenceRefs: readonly EvidencePin[];
  registry: RegistryResolution;
}>;

/** Checker identity is matched against a Registry lookup result, never a model verdict. */
export type GateRequirement = Readonly<{
  gateId: BuilderGateId;
  checkerId: string;
  checkerVersion: string;
  requireAuthority: boolean;
  requireQa: boolean;
}>;

export type BuilderGateScopeInput = Readonly<{
  current: GateScopeSnapshot;
  requirements: readonly GateRequirement[];
  evidence: readonly GateEvidence[];
}>;

export type GateEvaluation = Readonly<{
  gateId: BuilderGateId;
  verdict: GateVerdict;
  reasons: readonly string[];
}>;
export type BuilderGateScopeResult = Readonly<{
  scopeId: string;
  verdict: GateVerdict;
  gates: readonly GateEvaluation[];
  limitations: readonly string[];
  enforcement: "NOT_ENFORCED";
}>;
export type BuilderGatesResult = Readonly<{
  scopes: readonly BuilderGateScopeResult[];
  limitations: readonly string[];
  enforcement: "NOT_ENFORCED";
}>;

const HASH = /^[0-9a-f]{64}$/u;
const nonblank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const gateId = (value: unknown): value is BuilderGateId => typeof value === "string" && (BUILDER_GATE_IDS as readonly string[]).includes(value);

function samePin(a: EvidencePin, b: EvidencePin): boolean {
  return a.sourceId === b.sourceId && a.revisionId === b.revisionId && a.sha256 === b.sha256;
}

function sameSnapshot(actual: GateScopeSnapshot, expected: GateScopeSnapshot): boolean {
  if (actual.workspaceId !== expected.workspaceId || actual.projectId !== expected.projectId
    || actual.scopeId !== expected.scopeId || actual.revisionId !== expected.revisionId
    || actual.pins.length !== expected.pins.length) return false;
  const actualPins = [...actual.pins].sort((a, b) => a.sourceId.localeCompare(b.sourceId, "en"));
  const expectedPins = [...expected.pins].sort((a, b) => a.sourceId.localeCompare(b.sourceId, "en"));
  return actualPins.every((pin, index) => samePin(pin, expectedPins[index]));
}

function validateSnapshot(snapshot: GateScopeSnapshot): string[] {
  const issues: string[] = [];
  if (!nonblank(snapshot.workspaceId) || !nonblank(snapshot.projectId) || !nonblank(snapshot.scopeId) || !nonblank(snapshot.revisionId)) {
    issues.push("scope-identity-missing");
  }
  const ids = new Set<string>();
  for (const pin of snapshot.pins) {
    if (!nonblank(pin.sourceId) || !nonblank(pin.revisionId) || !HASH.test(pin.sha256)) issues.push("source-pin-invalid");
    if (ids.has(pin.sourceId)) issues.push(`source-pin-duplicate:${pin.sourceId}`);
    ids.add(pin.sourceId);
  }
  if (snapshot.pins.length === 0) issues.push("source-pins-missing");
  return issues;
}

function evaluateGate(
  requirement: GateRequirement,
  evidence: GateEvidence | undefined,
  current: GateScopeSnapshot,
): GateEvaluation {
  const reasons: string[] = [];
  if (!evidence) reasons.push("gate-evidence-missing");
  if (evidence) {
    if (evidence.gateId !== requirement.gateId) reasons.push("gate-identity-mismatch");
    if (!sameSnapshot(evidence.target, current)) reasons.push("scope-or-source-pins-stale");
    if (!isTrustedRegistryResolution(evidence.registry) || evidence.registry.status !== "RESOLVED") {
      reasons.push("registry-lookups-unresolved-or-untrusted");
      for (const lookup of evidence.registry?.requiredLookups ?? []) reasons.push(`required-lookup:${lookup}`);
    } else if (evidence.registry.gateId !== requirement.gateId || !sameSnapshot(evidence.registry.target, current)) {
      reasons.push("registry-resolution-scope-or-gate-mismatch");
    }
    if (!isTrustedRegistryResolution(evidence.registry) || !evidence.registry.checker) reasons.push("checker-identity-unverified");
    else if (evidence.registry.checker.checkerId !== requirement.checkerId
      || evidence.registry.checker.checkerVersion !== requirement.checkerVersion) {
      reasons.push("checker-unknown-or-stale");
    }
    if (evidence.evidenceRefs.length === 0) reasons.push("evidence-references-missing");
    for (const ref of evidence.evidenceRefs) {
      if (!nonblank(ref.sourceId) || !nonblank(ref.revisionId) || !HASH.test(ref.sha256)) reasons.push("evidence-reference-invalid");
      else if (!current.pins.some(pin => samePin(pin, ref))) reasons.push("evidence-reference-not-pinned");
      else if (isTrustedRegistryResolution(evidence.registry)
        && !evidence.registry.resolved.sources.some(source => source.sourceId === ref.sourceId
          && source.revisionId === ref.revisionId)) reasons.push("evidence-source-not-resolved-from-storage");
    }
    if (requirement.requireAuthority && (!isTrustedRegistryResolution(evidence.registry)
      || evidence.registry.status !== "RESOLVED" || !evidence.registry.resolved.authority)) {
      reasons.push("current-authority-lookup-missing");
    }
    if (requirement.requireQa && (!isTrustedRegistryResolution(evidence.registry)
      || evidence.registry.status !== "RESOLVED" || !evidence.registry.resolved.qa)) {
      reasons.push("independent-qa-lookup-missing");
    }
  }
  const uniqueReasons = [...new Set(reasons)].sort((a, b) => a.localeCompare(b, "en"));
  const verdict: GateVerdict = uniqueReasons.length > 0
    ? uniqueReasons.some(reason => reason === "evidence-verdict-block") ? "BLOCK" : "UNKNOWN"
    : "PASS";
  return Object.freeze({ gateId: requirement.gateId, verdict, reasons: Object.freeze(uniqueReasons) });
}

/**
 * Pure, scope-isolated evaluation of Registry-resolved evidence. PASS means
 * required lookups resolved and pins match; it never grants runtime authority.
 */
export function evaluateBuilderGates(inputs: readonly BuilderGateScopeInput[]): BuilderGatesResult {
  const scopes = inputs.map(input => {
    const snapshotIssues = validateSnapshot(input.current);
    const ids = new Set<BuilderGateId>();
    let invalidRequirements = false;
    const requirements = input.requirements.filter(requirement => {
      if (!gateId(requirement.gateId) || ids.has(requirement.gateId)) {
        invalidRequirements = true;
        return false;
      }
      ids.add(requirement.gateId);
      return true;
    });
    const evidenceByGate = new Map<BuilderGateId, GateEvidence>();
    const duplicateEvidence = new Set<BuilderGateId>();
    for (const evidence of input.evidence) {
      if (!gateId(evidence.gateId)) continue;
      if (evidenceByGate.has(evidence.gateId)) duplicateEvidence.add(evidence.gateId);
      else evidenceByGate.set(evidence.gateId, evidence);
    }
    const gates = requirements.map(requirement => {
      const result = evaluateGate(requirement, evidenceByGate.get(requirement.gateId), input.current);
      const missingRequiredQa = requirement.gateId === "G6" && !requirement.requireQa;
      if (!duplicateEvidence.has(requirement.gateId) && snapshotIssues.length === 0 && !invalidRequirements && !missingRequiredQa) return result;
      const reasons = [...result.reasons, ...(duplicateEvidence.has(requirement.gateId) ? ["gate-evidence-ambiguous"] : []),
        ...(invalidRequirements ? ["gate-requirements-ambiguous-or-invalid"] : []),
        ...(missingRequiredQa ? ["g6-requires-independent-qa-evidence"] : []), ...snapshotIssues];
      return Object.freeze({ gateId: requirement.gateId, verdict: "UNKNOWN" as const,
        reasons: Object.freeze([...new Set(reasons)].sort((a, b) => a.localeCompare(b, "en"))) });
    });
    const verdict: GateVerdict = gates.some(gate => gate.verdict === "BLOCK") ? "BLOCK"
      : gates.length === 0 || gates.some(gate => gate.verdict === "UNKNOWN") ? "UNKNOWN"
        : gates.some(gate => gate.verdict === "REVIEW") ? "REVIEW" : "PASS";
    return Object.freeze({ scopeId: input.current.scopeId, verdict, gates: Object.freeze(gates),
      limitations: Object.freeze(["PASS is current Registry evidence consistency only; execution and product acceptance remain unenforced."]),
      enforcement: "NOT_ENFORCED" as const });
  });
  return Object.freeze({ scopes: Object.freeze(scopes),
    limitations: Object.freeze(["G0-G7 meanings follow reviewed CSAS v0.8 section F; domain-specific acceptance decisions remain outside this pure evaluator.",
      "Registry providers must read current stored records and source bytes; missing providers remain UNKNOWN.",
      "This pure evaluation is not Host, Runner, Worker, merge, or product acceptance enforcement."]),
    enforcement: "NOT_ENFORCED" as const });
}
