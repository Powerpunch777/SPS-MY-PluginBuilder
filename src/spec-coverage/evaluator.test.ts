import assert from "node:assert/strict";
import test from "node:test";
import {
  coverageRulesManifestDigest,
  evaluateSpecCoverage,
  parseSpecCoverageInput,
  type CoverageIdentity,
  type CoverageRulesManifest,
  type SpecCoverageInput,
} from "./evaluator.ts";

const identity: CoverageIdentity = {
  workspaceId: "workspace-1",
  projectId: "project-1",
  specRevisionId: "revision-1",
  specDigest: "a".repeat(64),
};
const requirementId = "REQ-1";
const acId = "AC-1";
const sourceDigest = "b".repeat(64);
const bodyDigest = "c".repeat(64);

function manifestDraft(overrides: Record<string, unknown> = {}) {
  return {
    identity,
    scope: { requirementIds: [requirementId], acIds: [acId] },
    rulesVersion: "rules-v1",
    rules: [{ id: "rule-1", requiresCheck: true, requiredEvidenceKinds: ["source"] }],
    targets: [
      { targetId: requirementId, targetKind: "requirement", ruleIds: ["rule-1"] },
      { targetId: acId, targetKind: "ac", ruleIds: ["rule-1"] },
    ],
    digest: "0".repeat(64),
    ...overrides,
  };
}

function sealedManifest(overrides: Record<string, unknown> = {}): CoverageRulesManifest {
  const draft = manifestDraft(overrides);
  const digest = coverageRulesManifestDigest(draft);
  return { ...draft, digest } as CoverageRulesManifest;
}

function material(overrides: Record<string, unknown> = {}) {
  return {
    kind: "specification",
    identity,
    presence: "present",
    verification: "validated",
    entities: [
      { kind: "requirement", id: requirementId, bodyDigest, relationIds: [acId] },
      { kind: "ac", id: acId, bodyDigest, relationIds: [requirementId] },
    ],
    ...overrides,
  };
}

function sourceMaterial(overrides: Record<string, unknown> = {}) {
  return {
    kind: "source",
    identity,
    presence: "present",
    verification: "validated",
    entities: [{ kind: "source", id: "SRC-1", bodyDigest: sourceDigest, relationIds: [] }],
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}): SpecCoverageInput {
  return {
    identity,
    scope: { requirementIds: [requirementId], acIds: [acId] },
    rulesVersion: "rules-v1",
    manifest: sealedManifest(),
    materials: [material(), sourceMaterial()],
    sourceRefs: [
      { requirementId, acId: null, sourceId: "SRC-1", sourceDigest, revisionId: identity.specRevisionId },
      { requirementId, acId, sourceId: "SRC-1", sourceDigest, revisionId: identity.specRevisionId },
    ],
    checks: [
      { targetId: requirementId, ruleId: "rule-1", status: "passed", evidenceRefs: ["SRC-1"] },
      { targetId: acId, ruleId: "rule-1", status: "passed", evidenceRefs: ["SRC-1"] },
    ],
    ...overrides,
  } as SpecCoverageInput;
}

test("covers only scoped targets with a matching, digested manifest and validated linked evidence", () => {
  const result = evaluateSpecCoverage(input());
  assert.equal(result.targets.length, 2);
  assert.deepEqual(result.targets.map(target => target.status), ["COVERED", "COVERED"]);
  assert.equal(result.targets[0]?.evidence[0]?.sourceId, "SRC-1");
  assert.equal(result.gaps.length, 0);
  assert.equal(result.taskCandidates.length, 0);
  assert.equal(result.manifestDigest, (input().manifest as CoverageRulesManifest).digest);
});

test("missing, partial, version/digest/scope mismatched rule manifests remain UNKNOWN", () => {
  assert(evaluateSpecCoverage(input({ manifest: null })).targets.every(target => target.status === "UNKNOWN"));
  assert(evaluateSpecCoverage(input({ manifest: sealedManifest({ targets: [{
    targetId: requirementId, targetKind: "requirement", ruleIds: ["rule-1"],
  }] }) })).targets.find(target => target.targetId === acId)?.status === "UNKNOWN");
  assert(evaluateSpecCoverage(input({ rulesVersion: "rules-v2" })).targets.every(target => target.status === "UNKNOWN"));
  const badDigest = { ...sealedManifest(), digest: "d".repeat(64) };
  assert(evaluateSpecCoverage(input({ manifest: badDigest })).targets.every(target => target.status === "UNKNOWN"));
  const badScope = sealedManifest({ scope: { requirementIds: ["other"], acIds: [acId] } });
  assert(evaluateSpecCoverage(input({ manifest: badScope })).targets.every(target => target.status === "UNKNOWN"));
  const badIdentity = sealedManifest({ identity: { ...identity, projectId: "other-project" } });
  assert(evaluateSpecCoverage(input({ manifest: badIdentity })).targets.every(target => target.status === "UNKNOWN"));

  const orderedScope = { requirementIds: ["REQ-B", requirementId], acIds: ["AC-B", acId] };
  const reversedScope = { requirementIds: [...orderedScope.requirementIds].reverse(), acIds: [...orderedScope.acIds].reverse() };
  assert.equal(coverageRulesManifestDigest(manifestDraft({ scope: orderedScope })),
    coverageRulesManifestDigest(manifestDraft({ scope: reversedScope })));
  const reversedInputScope = { requirementIds: [requirementId, "REQ-B"], acIds: [acId, "AC-B"] };
  const canonicalScopeManifest = sealedManifest({ scope: reversedInputScope });
  const canonicalScope = evaluateSpecCoverage(input({ scope: reversedInputScope, manifest: canonicalScopeManifest,
    materials: [material(), sourceMaterial()], sourceRefs: input().sourceRefs,
    checks: input().checks }));
  assert.deepEqual(canonicalScope.scope, { requirementIds: [requirementId, "REQ-B"], acIds: [acId, "AC-B"] });
});

test("preprocessed target-kind mismatches make the matching scoped target UNKNOWN", () => {
  const scoped = { requirementIds: [requirementId], acIds: [] };
  const manifest = sealedManifest({ scope: scoped,
    rules: [{ id: "optional-rule", requiresCheck: false, requiredEvidenceKinds: [] }],
    targets: [{ targetId: requirementId, targetKind: "requirement", ruleIds: ["optional-rule"] }] });
  const result = evaluateSpecCoverage(input({ scope: scoped, manifest, sourceRefs: [],
    checks: [{ targetId: requirementId, targetKind: "ac", ruleId: "optional-rule", status: "passed", evidenceRefs: [] }] }));
  assert.equal(result.targets[0]?.status, "UNKNOWN");
  assert(result.unknowns.some(item => item.targetId === requirementId && item.targetKind === "requirement"
    && item.code === "check-target-kind-mismatch"));
  assert(result.checkResults.some(item => item.targetKind === "ac" && item.assessment === "target-out-of-scope"));
});

test("partial, missing, unverified, invalid, or unlinked source evidence cannot prove coverage", () => {
  for (const verification of ["unvalidated", "invalid", "unknown"] as const) {
    const materials = [material(), sourceMaterial({ verification })];
    assert(evaluateSpecCoverage(input({ materials })).targets.every(target => target.status === "UNKNOWN"));
  }
  assert(evaluateSpecCoverage(input({ materials: [material({ presence: "partial" }), sourceMaterial()] }))
    .targets.every(target => target.status === "UNKNOWN"));
  assert(evaluateSpecCoverage(input({ sourceRefs: [{ requirementId, acId: null, sourceId: "FAKE", sourceDigest,
    revisionId: identity.specRevisionId }], checks: [{ targetId: requirementId, ruleId: "rule-1", status: "passed", evidenceRefs: ["FAKE"] }] }))
    .targets.find(target => target.targetId === requirementId)?.status === "UNKNOWN");
  assert(evaluateSpecCoverage(input({ sourceRefs: [], checks: [] })).targets.every(target => target.status === "UNKNOWN"));
});

test("passed checks must cite evidence that resolves to validated, in-scope material", () => {
  const uncited = evaluateSpecCoverage(input({ checks: [
    { targetId: requirementId, ruleId: "rule-1", status: "passed", evidenceRefs: [] },
    { targetId: acId, ruleId: "rule-1", status: "passed", evidenceRefs: ["SRC-1"] },
  ] }));
  assert.equal(uncited.targets.find(target => target.targetId === requirementId)?.status, "UNKNOWN");

  const fabricated = evaluateSpecCoverage(input({ checks: [
    { targetId: requirementId, ruleId: "rule-1", status: "passed", evidenceRefs: ["UNVERIFIED-SRC"] },
    { targetId: acId, ruleId: "rule-1", status: "passed", evidenceRefs: ["SRC-1"] },
  ] }));
  assert.equal(fabricated.targets.find(target => target.targetId === requirementId)?.status, "UNKNOWN");
  assert(fabricated.unknowns.some(item => item.targetId === requirementId && item.targetKind === "requirement"
    && item.code === "check-evidence-unverified:rule-1"));
  assert.equal(fabricated.checkResults.find(item => item.targetKind === "requirement")?.assessment, "evidence-unverified");
});

test("same target ID in requirement and AC namespaces never shares untyped checks or conflicts", () => {
  const sharedId = "SHARED-ID";
  const sharedScope = { requirementIds: [sharedId], acIds: [sharedId] };
  const rules = [
    { id: "req-rule", requiresCheck: true, requiredEvidenceKinds: ["source"] },
    { id: "ac-rule", requiresCheck: true, requiredEvidenceKinds: ["source"] },
  ];
  const targets = [
    { targetId: sharedId, targetKind: "requirement", ruleIds: ["req-rule"] },
    { targetId: sharedId, targetKind: "ac", ruleIds: ["ac-rule"] },
  ];
  const specification = material({ entities: [
    { kind: "requirement", id: sharedId, bodyDigest, relationIds: [sharedId] },
    { kind: "ac", id: sharedId, bodyDigest: "d".repeat(64), relationIds: [] },
  ] });
  const refs = [
    { requirementId: sharedId, acId: null, sourceId: "SRC-1", sourceDigest, revisionId: identity.specRevisionId },
    { requirementId: sharedId, acId: sharedId, sourceId: "SRC-1", sourceDigest, revisionId: identity.specRevisionId },
  ];
  const base = {
    scope: sharedScope,
    manifest: sealedManifest({ scope: sharedScope, rules, targets }),
    materials: [specification, sourceMaterial()],
    sourceRefs: refs,
  };
  const ambiguous = evaluateSpecCoverage(input({ ...base, checks: [
    { targetId: sharedId, ruleId: "req-rule", status: "passed", evidenceRefs: ["SRC-1"] },
  ] }));
  assert(ambiguous.targets.every(target => target.status === "UNKNOWN"));
  assert(ambiguous.notChecked.some(item => item.targetId === sharedId && item.targetKind === "requirement"
    && item.reason === "ambiguous-target-id"));
  assert(ambiguous.notChecked.some(item => item.targetId === sharedId && item.targetKind === "ac"
    && item.reason === "ambiguous-target-id"));
  assert(ambiguous.unknowns.some(item => item.targetId === sharedId && item.targetKind === "requirement"
    && item.code === "check-target-kind-ambiguous"));
  assert(ambiguous.checkResults.some(item => item.assessment === "ambiguous-target-id"));

  const ambiguousWithExplicitPasses = evaluateSpecCoverage(input({ ...base, checks: [
    { targetId: sharedId, ruleId: "req-rule", status: "passed", evidenceRefs: ["SRC-1"] },
    { targetId: sharedId, targetKind: "requirement", ruleId: "req-rule", status: "passed", evidenceRefs: ["SRC-1"] },
    { targetId: sharedId, targetKind: "ac", ruleId: "ac-rule", status: "passed", evidenceRefs: ["SRC-1"] },
  ] }));
  assert(ambiguousWithExplicitPasses.targets.every(target => target.status === "UNKNOWN"));
  assert(ambiguousWithExplicitPasses.targets.every(target => target.reasons.includes("check-target-kind-ambiguous")));

  const explicit = evaluateSpecCoverage(input({ ...base, materials: [material({ entities: [
    { kind: "requirement", id: sharedId, bodyDigest, relationIds: [sharedId] },
    { kind: "requirement", id: sharedId, bodyDigest: "e".repeat(64), relationIds: [sharedId] },
    { kind: "ac", id: sharedId, bodyDigest: "d".repeat(64), relationIds: [] },
  ] }), sourceMaterial()], checks: [
    { targetId: sharedId, targetKind: "requirement", ruleId: "req-rule", status: "failed", evidenceRefs: ["SRC-1"] },
    { targetId: sharedId, targetKind: "ac", ruleId: "ac-rule", status: "passed", evidenceRefs: ["SRC-1"] },
  ] }));
  assert.equal(explicit.targets.find(target => target.targetKind === "requirement")?.status, "GAP");
  assert.equal(explicit.targets.find(target => target.targetKind === "ac")?.status, "COVERED");
  assert(explicit.gaps.every(gap => gap.targetKind === "requirement"));
  assert(explicit.taskCandidates.every(candidate => candidate.targetKind === "requirement"));
});

test("explicit verified absence and failed checks produce stable review-only Gap and Task candidates", () => {
  const missingSource = sourceMaterial({ presence: "missing", entities: [] });
  const result = evaluateSpecCoverage(input({ materials: [material(), missingSource], sourceRefs: [], checks: [] }));
  assert(result.targets.every(target => target.status === "GAP"));
  assert(result.gaps.every(gap => gap.status === "candidate"));
  assert.equal(result.taskCandidates.length, result.gaps.length);
  assert(result.taskCandidates.every(candidate => candidate.status === "candidate" && candidate.reasonRefs.length === 1));

  const failed = evaluateSpecCoverage(input({ checks: [
    { targetId: requirementId, ruleId: "rule-1", status: "failed", evidenceRefs: ["SRC-1"] },
    { targetId: acId, ruleId: "rule-1", status: "passed", evidenceRefs: ["SRC-1"] },
  ] }));
  assert.equal(failed.targets.find(target => target.targetId === requirementId)?.status, "GAP");
  assert(failed.gaps.some(gap => gap.kind === "failed-check" && gap.targetIds.includes(requirementId)));

  const unverifiedFailure = evaluateSpecCoverage(input({ checks: [
    { targetId: requirementId, ruleId: "rule-1", status: "failed", evidenceRefs: ["FABRICATED"] },
    { targetId: acId, ruleId: "rule-1", status: "passed", evidenceRefs: ["SRC-1"] },
  ] }));
  assert.equal(unverifiedFailure.targets.find(target => target.targetId === requirementId)?.status, "UNKNOWN");
  assert(!unverifiedFailure.gaps.some(gap => gap.kind === "failed-check" && gap.targetKind === "requirement"));
  assert(unverifiedFailure.checkResults.some(result => result.targetKind === "requirement" && result.assessment === "evidence-unverified"));
});

test("gap candidate IDs include gap kind even when target and evidence references match", () => {
  const scoped = { requirementIds: [requirementId], acIds: [] };
  const manifest = sealedManifest({ scope: scoped,
    rules: [{ id: "requirement-entity-absent", requiresCheck: true, requiredEvidenceKinds: [] }],
    targets: [{ targetId: requirementId, targetKind: "requirement", ruleIds: ["requirement-entity-absent"] }] });
  const result = evaluateSpecCoverage(input({ scope: scoped, manifest,
    materials: [material({ entities: [] })], sourceRefs: [],
    checks: [{ targetId: requirementId, targetKind: "requirement", ruleId: "requirement-entity-absent", status: "failed", evidenceRefs: [] }] }));
  const structural = result.gaps.find(gap => gap.kind === "missing-structure");
  const failed = result.gaps.find(gap => gap.kind === "failed-check");
  assert.deepEqual(structural?.evidenceRefs, failed?.evidenceRefs);
  assert.notEqual(structural?.id, failed?.id);
});

test("AC source references must belong to a requirement explicitly related to that AC", () => {
  const otherRequirementId = "REQ-2";
  const scoped = { requirementIds: [requirementId, otherRequirementId], acIds: [acId] };
  const manifest = sealedManifest({ scope: scoped, targets: [
    { targetId: requirementId, targetKind: "requirement", ruleIds: ["rule-1"] },
    { targetId: otherRequirementId, targetKind: "requirement", ruleIds: ["rule-1"] },
    { targetId: acId, targetKind: "ac", ruleIds: ["rule-1"] },
  ] });
  const specification = material({ entities: [
    { kind: "requirement", id: requirementId, bodyDigest, relationIds: [acId] },
    { kind: "requirement", id: otherRequirementId, bodyDigest, relationIds: [] },
    { kind: "ac", id: acId, bodyDigest, relationIds: [requirementId] },
  ] });
  const result = evaluateSpecCoverage(input({ scope: scoped, manifest, materials: [specification, sourceMaterial()],
    sourceRefs: [{ requirementId: otherRequirementId, acId, sourceId: "SRC-1", sourceDigest,
      revisionId: identity.specRevisionId }],
    checks: [{ targetId: acId, targetKind: "ac", ruleId: "rule-1", status: "passed", evidenceRefs: ["SRC-1"] }] }));
  assert.equal(result.targets.find(target => target.targetKind === "ac")?.status, "UNKNOWN");
  assert(result.unknowns.some(item => item.targetKind === "ac" && item.targetId === acId
    && item.code === "ac-source-ref-requirement-relation-mismatch"));
  assert.equal(result.checkResults.find(item => item.targetKind === "ac")?.assessment, "evidence-unverified");
  assert.deepEqual(result.targets.find(target => target.targetKind === "ac")?.evidence, []);
});

test("legacy ApprovedSpecRevision AC links without AC bodies remain UNKNOWN, while explicit absence is a candidate gap", () => {
  const legacySpec = material({ entities: [
    { kind: "requirement", id: requirementId, bodyDigest, relationIds: [acId] },
  ] });
  const linkedWithoutBody = evaluateSpecCoverage(input({ materials: [legacySpec, sourceMaterial()] }));
  assert.equal(linkedWithoutBody.targets.find(target => target.targetKind === "ac")?.status, "UNKNOWN");
  assert(linkedWithoutBody.unknowns.some(item => item.targetKind === "ac" && item.targetId === acId
    && item.code === "ac-body-not-provided"));
  assert(!linkedWithoutBody.gaps.some(gap => gap.targetKind === "ac"));

  const omittedRelation = material({ entities: [
    { kind: "requirement", id: requirementId, bodyDigest, relationIds: [] },
  ] });
  const explicitOmission = evaluateSpecCoverage(input({ materials: [omittedRelation, sourceMaterial()] }));
  assert.equal(explicitOmission.targets.find(target => target.targetKind === "ac")?.status, "GAP");
  assert(explicitOmission.gaps.some(gap => gap.targetKind === "ac" && gap.kind === "missing-structure"));
});

test("confirmed gaps survive manifest uncertainty and not-run checks remain separately visible", () => {
  const incomplete = evaluateSpecCoverage(input({ manifest: null, materials: [
    material({ entities: [{ kind: "ac", id: acId, bodyDigest, relationIds: [] }] }), sourceMaterial(),
  ], checks: [{ targetId: requirementId, ruleId: "rule-1", status: "not-run", evidenceRefs: [] }] }));
  const requirement = incomplete.targets.find(target => target.targetKind === "requirement");
  assert.equal(requirement?.status, "GAP");
  assert(incomplete.gaps.some(gap => gap.targetKind === "requirement"));
  assert(incomplete.unknowns.some(item => item.targetKind === "requirement" && item.code === "manifest-not-provided"));
  assert(incomplete.notChecked.some(item => item.targetKind === "requirement" && item.reason === "manifest-unverified"));
  assert.equal(incomplete.checks[0]?.status, "not-run");
  assert.equal(incomplete.checkResults[0]?.assessment, "manifest-unverified");
  assert(incomplete.materialStates.some(state => state.kind === "specification" && state.presence === "present"
    && state.verification === "validated"));
});

test("in-scope checks for undeclared rules and out-of-scope failed checks are retained but not applied", () => {
  const result = evaluateSpecCoverage(input({ checks: [
    { targetId: requirementId, targetKind: "requirement", ruleId: "not-in-manifest", status: "failed", evidenceRefs: ["FAKE"] },
    { targetId: "OUTSIDE", ruleId: "rule-1", status: "failed", evidenceRefs: ["FAKE"] },
  ] }));
  assert(!result.gaps.some(gap => gap.kind === "failed-check"));
  assert(result.unknowns.some(item => item.targetKind === "requirement" && item.code === "check-rule-not-applicable"));
  assert(result.notChecked.some(item => item.targetId === requirementId && item.reason === "rule-not-applicable"));
  assert(result.notChecked.some(item => item.targetId === "OUTSIDE" && item.reason === "target-out-of-scope"));
  assert(result.checkResults.some(item => item.assessment === "rule-not-applicable"));
  assert(result.checkResults.some(item => item.assessment === "target-out-of-scope"));

  const mixed = evaluateSpecCoverage(input({ checks: [
    { targetId: requirementId, targetKind: "requirement", ruleId: "rule-1", status: "passed", evidenceRefs: ["SRC-1"] },
    { targetId: requirementId, targetKind: "requirement", ruleId: "not-in-manifest", status: "passed", evidenceRefs: ["SRC-1"] },
    { targetId: acId, targetKind: "ac", ruleId: "rule-1", status: "passed", evidenceRefs: ["SRC-1"] },
  ] }));
  assert.equal(mixed.targets.find(item => item.targetKind === "requirement")?.status, "UNKNOWN");
  assert(mixed.targets.find(item => item.targetKind === "requirement")?.reasons.includes("check-rule-not-applicable"));
});

test("missing checks are UNKNOWN while explicit not-run and out-of-scope checks are NOT_CHECKED", () => {
  const missing = evaluateSpecCoverage(input({ checks: [] }));
  assert(missing.targets.every(target => target.status === "UNKNOWN"));
  const notRun = evaluateSpecCoverage(input({ checks: [
    { targetId: requirementId, ruleId: "rule-1", status: "not-run", evidenceRefs: [] },
    { targetId: acId, ruleId: "rule-1", status: "passed", evidenceRefs: ["SRC-1"] },
    { targetId: "OUTSIDE", ruleId: "rule-1", status: "not-run", evidenceRefs: [] },
  ] }));
  assert.equal(notRun.targets.find(target => target.targetId === requirementId)?.status, "NOT_CHECKED");
  assert(notRun.notChecked.some(item => item.targetId === "OUTSIDE" && item.reason === "target-out-of-scope"));
  assert(!notRun.unknowns.some(item => item.code === "out-of-scope-check-not-evaluated"));
});

test("records structural omissions and same-kind ID body or explicit relation conflicts, not semantic similarity", () => {
  const absent = material({ entities: [{ kind: "requirement", id: requirementId, bodyDigest, relationIds: [acId] }] });
  const missingAc = evaluateSpecCoverage(input({ materials: [absent, sourceMaterial()],
    checks: [{ targetId: requirementId, ruleId: "rule-1", status: "passed", evidenceRefs: ["SRC-1"] }] }));
  assert.equal(missingAc.targets.find(target => target.targetKind === "ac")?.status, "UNKNOWN");
  assert(!missingAc.gaps.some(gap => gap.targetKind === "ac"));

  const conflict = material({ entities: [
    { kind: "requirement", id: requirementId, bodyDigest, relationIds: [acId] },
    { kind: "requirement", id: requirementId, bodyDigest: "d".repeat(64), relationIds: [acId] },
    { kind: "ac", id: acId, bodyDigest, relationIds: [requirementId] },
  ] });
  const conflictResult = evaluateSpecCoverage(input({ materials: [conflict, sourceMaterial()] }));
  assert.equal(conflictResult.targets.find(target => target.targetId === requirementId)?.status, "GAP");
  assert(conflictResult.gaps.some(gap => gap.kind === "identity-conflict"));

  const relationConflict = material({ entities: [
    { kind: "requirement", id: requirementId, bodyDigest, relationIds: [acId] },
    { kind: "requirement", id: requirementId, bodyDigest, relationIds: ["OTHER-AC"] },
    { kind: "ac", id: acId, bodyDigest, relationIds: [requirementId] },
  ] });
  const relationConflictResult = evaluateSpecCoverage(input({ materials: [relationConflict, sourceMaterial()] }));
  assert(relationConflictResult.gaps.some(gap => gap.kind === "identity-conflict"));
  assert.notEqual(relationConflictResult.gaps.find(gap => gap.kind === "identity-conflict")?.id,
    conflictResult.gaps.find(gap => gap.kind === "identity-conflict")?.id);

  const crossKind = material({ entities: [
    { kind: "requirement", id: requirementId, bodyDigest, relationIds: [acId] },
    { kind: "ac", id: requirementId, bodyDigest: "d".repeat(64), relationIds: ["OTHER"] },
    { kind: "ac", id: acId, bodyDigest, relationIds: [requirementId] },
  ] });
  assert(!evaluateSpecCoverage(input({ materials: [crossKind, sourceMaterial()] })).gaps.some(gap => gap.kind === "identity-conflict"));
});

test("stable IDs are canonical across input ordering and isolated by Workspace/project/Revision identity", () => {
  const base = evaluateSpecCoverage(input());
  const reversed = evaluateSpecCoverage(input({ checks: [...input().checks].reverse(),
    materials: [sourceMaterial(), material()], sourceRefs: [...input().sourceRefs].reverse() }));
  assert.deepEqual(base, reversed);

  const conflictMaterial = material({ entities: [
    { kind: "requirement", id: requirementId, bodyDigest, relationIds: [acId] },
    { kind: "requirement", id: requirementId, bodyDigest: "d".repeat(64), relationIds: [acId] },
    { kind: "ac", id: acId, bodyDigest, relationIds: [requirementId] },
  ] });
  const gapInput = input({ materials: [conflictMaterial, sourceMaterial()] });
  const firstGap = evaluateSpecCoverage(gapInput).gaps[0]?.id;
  for (const change of [
    { workspaceId: "workspace-2" },
    { projectId: "project-2" },
    { specRevisionId: "revision-2" },
  ]) {
    const nextIdentity = { ...identity, ...change };
    const isolated = evaluateSpecCoverage(input({ identity: nextIdentity, manifest: sealedManifest({ identity: nextIdentity }),
      materials: [conflictMaterial, sourceMaterial({ identity: nextIdentity })] }));
    assert.notEqual(isolated.gaps[0]?.id, firstGap);
    assert(isolated.targets.every(target => target.status !== "COVERED"));
  }
});

test("input snapshot is detached and caller history remains unchanged", () => {
  const callerInput = input() as unknown as Record<string, any>;
  const before = structuredClone(callerInput);
  const parsed = parseSpecCoverageInput(callerInput);
  const result = evaluateSpecCoverage(callerInput);
  assert.deepEqual(callerInput, before);
  assert.notEqual(parsed, callerInput);
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.scope.requirementIds));
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.targets[0]));
  callerInput.scope.requirementIds.push("LATER");
  assert.deepEqual(parsed.scope.requirementIds, [requirementId]);
  assert.deepEqual(result.scope.requirementIds, [requirementId]);
});

test("rejects oversized and ambiguous evaluator input with parser-style bounded validation", () => {
  assert.throws(() => parseSpecCoverageInput({ ...input(), extra: true }), /unknown or missing fields/);
  assert.throws(() => parseSpecCoverageInput(input({ scope: { requirementIds: [requirementId, requirementId], acIds: [acId] } })), /unique identifiers/);
  assert.throws(() => evaluateSpecCoverage(input({ checks: [
    { targetId: requirementId, ruleId: "rule-1", status: "passed", evidenceRefs: [] },
    { targetId: requirementId, ruleId: "rule-1", status: "failed", evidenceRefs: [] },
  ] })), /duplicate target\/rule pairs/);
  assert.throws(() => parseSpecCoverageInput(input({ checks: [{ targetId: requirementId, ruleId: "rule-1", status: "maybe", evidenceRefs: [] }] })), /unsupported value/);
});

test("sizes only validated snapshots and never executes caller getters or toJSON", () => {
  let getterCalls = 0;
  const accessorInput = input() as unknown as Record<string, unknown>;
  Object.defineProperty(accessorInput, "rulesVersion", {
    enumerable: true,
    configurable: true,
    get() { getterCalls += 1; return "rules-v1"; },
  });
  assert.throws(() => parseSpecCoverageInput(accessorInput), /enumerable data field/);
  assert.equal(getterCalls, 0);

  let toJSONCalls = 0;
  const customToJSON = input() as unknown as Record<string, unknown>;
  Object.defineProperty(customToJSON, "toJSON", {
    configurable: true,
    value() { toJSONCalls += 1; return {}; },
  });
  assert.throws(() => parseSpecCoverageInput(customToJSON), /unknown or missing fields/);
  assert.equal(toJSONCalls, 0);

  const sparse = input({ scope: { requirementIds: new Array(1), acIds: [acId] } });
  assert.throws(() => parseSpecCoverageInput(sparse), /dense with no extra properties/);
});
