import assert from "node:assert/strict";
import test from "node:test";
import { composeDomainPacks, createSpecAssuranceConsumer, evaluateSpecAssurance, type AssuranceCoverageQuery, type AssuranceInput, type DomainPack } from "./evaluator.ts";
import { coverageRulesManifestDigest, evaluateSpecCoverage, type SpecCoverageInput } from "../spec-coverage/evaluator.ts";

const identity = { workspaceId: "ws-1", projectId: "project-1", specRevisionId: "spec-r1", specDigest: "a".repeat(64) } as const;
const requirementId = "REQ-1";
const rule = { id: "rule-1", requirementIds: [requirementId], appliesWhen: { all: ["enabled"] }, requiresCheck: true } as const;
const pack: DomainPack = {
  packId: "orders", version: "1.2.0", identity, applicability: { all: ["orders"] }, rules: [rule],
  transitions: [{ from: "draft", event: "submit", to: "pending" }],
  exceptions: [{ id: "hold-1", from: "draft", event: "submit", to: "held" }], excludedCombinations: [],
};
const sourceDigest = "b".repeat(64);
const coverageManifest = {
  identity, scope: { requirementIds: [requirementId], acIds: [] }, rulesVersion: "rules-v1",
  rules: [{ id: "coverage-rule", requiresCheck: true, requiredEvidenceKinds: ["source"] }],
  targets: [{ targetId: requirementId, targetKind: "requirement", ruleIds: ["coverage-rule"] }], digest: "0".repeat(64),
};
coverageManifest.digest = coverageRulesManifestDigest(coverageManifest);
const coverageInput = {
  identity, scope: { requirementIds: [requirementId], acIds: [] }, rulesVersion: "rules-v1", manifest: coverageManifest,
  materials: [
    { kind: "specification", identity, presence: "present", verification: "validated", entities: [
      { kind: "requirement", id: requirementId, bodyDigest: "c".repeat(64), relationIds: [] },
    ] },
    { kind: "source", identity, presence: "present", verification: "validated", entities: [
      { kind: "source", id: "SRC-1", bodyDigest: sourceDigest, relationIds: [] },
    ] },
  ],
  sourceRefs: [{ requirementId, acId: null, sourceId: "SRC-1", sourceDigest, revisionId: identity.specRevisionId }],
  checks: [{ targetId: requirementId, ruleId: "coverage-rule", status: "passed", evidenceRefs: ["SRC-1"] }],
} as unknown as SpecCoverageInput;
const actualCoverage = evaluateSpecCoverage(coverageInput);
const authoritySnapshot = (input: SpecCoverageInput = coverageInput, packs: readonly DomainPack[] = [pack]) => ({
  coverageInput: input, domainPacks: packs, facts: ["orders", "enabled"],
});
const scenario = { id: "case-1", state: "draft", event: "submit", nextState: "pending", exceptionId: null } as const;
const base = (overrides: Partial<AssuranceInput> = {}): AssuranceInput => ({ identity, scope: { requirementIds: [requirementId], uiIds: ["UI-1"], workstreamIds: ["WS-1"], taskIds: ["TASK-1"] },
  facts: ["orders", "enabled"], packs: [pack], scenarios: [scenario], ...overrides });

test("composes applicable versioned packs and deduplicates identical rules deterministically", () => {
  const result = composeDomainPacks([pack, { ...pack, rules: [...pack.rules].reverse(), transitions: [...pack.transitions].reverse() },
    { ...pack, packId: "not-applicable", applicability: { all: ["missing"] } }], identity, ["orders"]);
  assert.deepEqual(result.map(p => p.packId), ["orders"]);
  assert.throws(() => composeDomainPacks([pack, { ...pack, version: "2.0.0" }], identity, ["orders"]), /Conflicting versions/);
  assert.throws(() => composeDomainPacks([pack], { ...identity, projectId: "other" }, ["orders"]), /different Workspace/);
  assert.throws(() => composeDomainPacks([pack], { ...identity, workspaceId: "other" }, ["orders"]), /different Workspace/);
});

test("actual COVERED values are ignored without an injected server authority provider", async () => {
  const result = await evaluateSpecAssurance(base());
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.coverageAuthority, "unavailable");
  assert.equal(actualCoverage.targets[0]?.status, "COVERED");
  assert.deepEqual(result.applicablePackIds, ["orders"]);
  assert.equal(result.scenarios[0]?.status, "NOT_CHECKED");
  assert.deepEqual(result.sourceEvidence, []);
  assert(result.gaps.some(gap => gap.reason === "coverage-provider-unavailable"));
  assert.deepEqual(result.itemDecisions, [{ requirementId, status: "NOT_CHECKED", reason: "approved-specification-item-decision-resolver-unavailable" }]);
});

test("missing coverage, checker resolution, and decision resolution never PASS", async () => {
  assert.equal((await evaluateSpecAssurance(base())).status, "UNKNOWN");
  assert.equal((await evaluateSpecAssurance(base({ packs: [] }))).status, "UNKNOWN");
});

test("unmodelled combinations remain UNKNOWN; explicitly excluded tuples fail with stable linked gaps", async () => {
  const unmodelled = await evaluateSpecAssurance(base({ scenarios: [{ ...scenario, nextState: "closed" }] }));
  assert.equal(unmodelled.status, "UNKNOWN");
  assert.equal(unmodelled.scenarios[0]?.reason, "combination-not-modelled");
  const excludedPack = { ...pack, excludedCombinations: [{ from: "draft", event: "submit", to: "closed", reason: "closed is disallowed before review" }] };
  const invalid = await evaluateSpecAssurance(base({ packs: [excludedPack], scenarios: [{ ...scenario, nextState: "closed" }] }));
  assert.equal(invalid.status, "UNKNOWN");
  assert.equal(invalid.scenarios[0]?.status, "FAIL");
  assert.equal(invalid.excludedCombinations[0]?.reason, "closed is disallowed before review");
  const missing = await evaluateSpecAssurance(base());
  const repeated = await evaluateSpecAssurance(base());
  assert.equal(missing.gaps[0]?.fingerprint, repeated.gaps[0]?.fingerprint);
  assert.deepEqual(missing.gaps[0]?.sourceIds, []);
  assert.deepEqual(missing.gaps[0]?.uiIds, ["UI-1"]);
  assert.deepEqual(missing.gaps[0]?.taskIds, ["TASK-1"]);
});

test("a declared exception is valid only for its exact state, event, and destination", async () => {
  const exact = await evaluateSpecAssurance(base({ scenarios: [{ id: "exception-case", state: "draft", event: "submit", nextState: "held", exceptionId: "hold-1" }] }));
  assert.equal(exact.status, "UNKNOWN");
  assert.equal(exact.scenarios[0]?.status, "NOT_CHECKED");
  const wrong = await evaluateSpecAssurance(base({ scenarios: [{ id: "bad-exception", state: "draft", event: "submit", nextState: "held", exceptionId: "unknown" }] }));
  assert.equal(wrong.status, "UNKNOWN");
});

test("a finite conditional model reports its local PASS while unconfigured coverage remains UNKNOWN", async () => {
  const modeledPack = { ...pack, rules: [{ ...rule, modelCases: [{ when: { all: ["enabled"] }, state: "draft", event: "submit", allowedNextStates: ["pending"] }] }] };
  const result = await evaluateSpecAssurance(base({ packs: [modeledPack] }));
  assert.equal(result.checkerResults[0]?.outcome, "pass");
  assert.equal(result.checkerResults[0]?.status, "PASS");
  assert.deepEqual(result.checkerResults[0]?.evidenceRefs, ["case-1"]);
  // PASS is only the bounded checker outcome, never a decision or product approval.
  assert.equal(result.status, "UNKNOWN");
  assert(result.gaps.some(gap => gap.reason === "coverage-provider-unavailable"));
  assert.equal(result.itemDecisions[0]?.status, "NOT_CHECKED");
});

test("injected provider input is evaluated locally and binds emitted source evidence", async () => {
  const modeledPack = { ...pack, rules: [{ ...rule, modelCases: [{ when: { all: ["enabled"] }, state: "draft", event: "submit", allowedNextStates: ["pending"] }] }] };
  const provider = (query: AssuranceCoverageQuery) => {
    assert.deepEqual(query.identity, identity);
    assert.deepEqual(query.requirementIds, [requirementId]);
    return authoritySnapshot(coverageInput, [modeledPack]);
  };
  const valid = await createSpecAssuranceConsumer(provider)(base({ packs: [modeledPack] }));
  assert.equal(valid.coverageAuthority, "verified");
  assert.equal(valid.status, "PASS");
  assert.equal(valid.checkerResults[0]?.status, "PASS");
  assert.deepEqual(valid.sourceEvidence, [{ sourceId: "SRC-1", sourceDigest, revisionId: identity.specRevisionId }]);
});

test("trusted provider packs and facts override caller/model-supplied alternatives", async () => {
  const trustedPack = { ...pack, rules: [{ ...rule, modelCases: [{ when: { all: ["enabled"] }, state: "draft", event: "submit", allowedNextStates: ["pending"] }] }] };
  const forgedPack = { ...trustedPack, rules: [{ ...rule, modelCases: [{ when: { all: ["enabled"] }, state: "draft", event: "submit", allowedNextStates: ["closed"] }] }] };
  const provider = () => authoritySnapshot(coverageInput, [trustedPack]);
  const result = await createSpecAssuranceConsumer(provider)(base({ packs: [forgedPack], facts: ["client-fact-is-not-authority"] }));
  assert.equal(result.coverageAuthority, "verified");
  assert.equal(result.checkerResults[0]?.outcome, "pass");
  assert.equal(result.checkerResults[0]?.packVersion, trustedPack.version);
  assert.equal(result.status, "PASS");
});

test("excluded pack IDs use the authoritative provider pack set", async () => {
  const trustedPack = { ...pack, rules: [{ ...rule, modelCases: [{ when: { all: ["enabled"] }, state: "draft", event: "submit", allowedNextStates: ["pending"] }] }] };
  const excludedPack = { ...pack, packId: "provider-not-applicable", applicability: { all: ["provider-only"] } };
  const result = await createSpecAssuranceConsumer(() => authoritySnapshot(coverageInput, [trustedPack, excludedPack]))(
    base({ packs: [{ ...trustedPack, packId: "caller-forged-pack" }] }));
  assert.deepEqual(result.applicablePackIds, ["orders"]);
  assert.deepEqual(result.excludedPackIds, ["provider-not-applicable"]);
  assert(!result.excludedPackIds.includes("caller-forged-pack"));
});

test("a requirement with no applicable rule prevents aggregate PASS", async () => {
  const secondRequirementId = "REQ-2";
  const twoRequirementCoverage = structuredClone(coverageInput) as unknown as {
    scope: { requirementIds: string[] };
    manifest: { scope: { requirementIds: string[] }; targets: { targetId: string; targetKind: "requirement"; ruleIds: string[] }[] };
    materials: { entities: { kind: string; id: string; bodyDigest: string; relationIds: string[] }[] }[];
    sourceRefs: { requirementId: string; acId: null; sourceId: string; sourceDigest: string; revisionId: string }[];
    checks: { targetId: string; ruleId: string; status: "passed"; evidenceRefs: string[] }[];
  };
  twoRequirementCoverage.scope.requirementIds.push(secondRequirementId);
  twoRequirementCoverage.manifest!.scope.requirementIds.push(secondRequirementId);
  twoRequirementCoverage.manifest!.targets.push({ targetId: secondRequirementId, targetKind: "requirement", ruleIds: ["coverage-rule"] });
  twoRequirementCoverage.materials[0]!.entities.push({ kind: "requirement", id: secondRequirementId, bodyDigest: "f".repeat(64), relationIds: [] });
  twoRequirementCoverage.materials[1]!.entities.push({ kind: "source", id: "SRC-2", bodyDigest: "a".repeat(64), relationIds: [] });
  twoRequirementCoverage.sourceRefs.push({ requirementId: secondRequirementId, acId: null, sourceId: "SRC-2", sourceDigest: "a".repeat(64), revisionId: identity.specRevisionId });
  twoRequirementCoverage.checks.push({ targetId: secondRequirementId, ruleId: "coverage-rule", status: "passed", evidenceRefs: ["SRC-2"] });
  const twoRequirementManifest = twoRequirementCoverage.manifest as unknown as typeof coverageManifest;
  twoRequirementManifest.digest = coverageRulesManifestDigest(twoRequirementManifest);
  const modeled = { ...pack, rules: [{ ...rule, modelCases: [{ when: { all: ["enabled"] }, state: "draft", event: "submit", allowedNextStates: ["pending"] }] }] };
  const result = await createSpecAssuranceConsumer(() => authoritySnapshot(twoRequirementCoverage as unknown as SpecCoverageInput, [modeled]))(
    base({ scope: { requirementIds: [requirementId, secondRequirementId] }, packs: [modeled] }));
  assert.deepEqual(evaluateSpecCoverage(twoRequirementCoverage as unknown as SpecCoverageInput).targets
    .filter(target => target.targetKind === "requirement").map(target => [target.targetId, target.status]),
  [[requirementId, "COVERED"], [secondRequirementId, "COVERED"]]);
  assert.equal(result.checkerResults.length, 1);
  assert.equal(result.checkerResults[0]?.requirementId, requirementId);
  assert.deepEqual(result.checkerResults.map(check => check.requirementId), [requirementId]);
  assert.deepEqual(result.itemDecisions, [requirementId, secondRequirementId].map(id => ({ requirementId: id,
    status: "NOT_CHECKED", reason: "approved-specification-item-decision-resolver-unavailable" })));
  assert.equal(result.status, "UNKNOWN");
  assert(result.gaps.some(gap => gap.requirementId === secondRequirementId && gap.reason === "no-applicable-domain-rules"));
});

test("caller input is captured before an awaited provider can change it", async () => {
  let release!: (value: ReturnType<typeof authoritySnapshot>) => void;
  const snapshotPromise = new Promise<ReturnType<typeof authoritySnapshot>>(resolve => { release = resolve; });
  const mutable = base() as unknown as { identity: { workspaceId: string; projectId: string; specRevisionId: string; specDigest: string }; scope: { requirementIds: string[] };
    scenarios: { id: string; state: string; event: string; nextState: string; exceptionId: string | null }[] };
  const pending = createSpecAssuranceConsumer(() => snapshotPromise)(mutable as unknown as AssuranceInput);
  mutable.identity = { ...identity, projectId: "mutated-project" };
  mutable.scope.requirementIds[0] = "MUTATED-REQ";
  mutable.scenarios[0] = { ...mutable.scenarios[0]!, nextState: "closed" };
  release(authoritySnapshot());
  const result = await pending;
  assert.deepEqual(result.identity, identity);
  assert.deepEqual(result.scope.requirementIds, [requirementId]);
  assert.equal(result.scenarios[0]?.scenarioId, "case-1");
  assert.equal(result.scenarios[0]?.status, "NOT_CHECKED");
});

test("provider snapshot mutation during async checking cannot change checker semantics", async () => {
  const modeledPack: DomainPack = { ...pack, transitions: [...pack.transitions], rules: [{ ...rule, modelCases: [{ when: { all: ["enabled"] }, state: "draft", event: "submit", allowedNextStates: ["pending"] }] }] };
  const snapshot = authoritySnapshot(coverageInput, [modeledPack]);
  let started!: () => void;
  let release!: () => void;
  const checkerStarted = new Promise<void>(resolve => { started = resolve; });
  const checkerGate = new Promise<void>(resolve => { release = resolve; });
  const pending = createSpecAssuranceConsumer(() => snapshot)(base({ checkerAdapter: async request => {
    started();
    await checkerGate;
    return { ...request, outcome: "pass", evidenceRefs: ["case-1"] };
  } }));
  await checkerStarted;
  (modeledPack.rules[0]!.modelCases![0]!.allowedNextStates as string[])[0] = "closed";
  (snapshot.facts as string[]).splice(0, snapshot.facts.length, "orders");
  (snapshot.domainPacks[0]!.transitions as { from: string; event: string; to: string }[])[0]!.to = "closed";
  release();
  const result = await pending;
  assert.equal(result.checkerResults[0]?.outcome, "pass");
  assert.deepEqual(result.checkerResults[0]?.evidenceRefs, ["case-1"]);
  assert.equal(result.status, "PASS");
});

test("provider data with altered refs, digests, revisions, or unsupported materials cannot pass", async () => {
  const modeledPack = { ...pack, rules: [{ ...rule, modelCases: [{ when: { all: ["enabled"] }, state: "draft", event: "submit", allowedNextStates: ["pending"] }] }] };
  const alteredInputs: SpecCoverageInput[] = [
    { ...coverageInput, sourceRefs: coverageInput.sourceRefs.map(ref => ({ ...ref, sourceId: "FORGED-SOURCE" })) },
    { ...coverageInput, sourceRefs: coverageInput.sourceRefs.map(ref => ({ ...ref, sourceDigest: "d".repeat(64) })) },
    { ...coverageInput, sourceRefs: coverageInput.sourceRefs.map(ref => ({ ...ref, revisionId: "older-revision" })) },
    { ...coverageInput, materials: coverageInput.materials.map(material => material.kind === "source"
      ? { ...material, entities: material.entities.map(entity => ({ ...entity, bodyDigest: "d".repeat(64) })) } : material) },
    { ...coverageInput, materials: coverageInput.materials.map(material => material.kind === "source"
      ? { ...material, verification: "unknown" as const } : material) },
  ];
  const alteredRefResults = await Promise.all(alteredInputs.map(tampered =>
    createSpecAssuranceConsumer(() => authoritySnapshot(tampered, [modeledPack]))(base({ packs: [modeledPack] }))));
  for (const result of alteredRefResults) {
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.coverageAuthority, "verified");
    assert.deepEqual(result.sourceEvidence, []);
  }
});

test("caller-constructed internally consistent COVERED fields are ignored by the consumer", async () => {
  const forgedId = "FORGED-SOURCE", forgedDigest = "d".repeat(64);
  const forgedResult = { ...actualCoverage,
    sourceRefs: actualCoverage.sourceRefs.map(ref => ({ ...ref, sourceId: forgedId, sourceDigest: forgedDigest })),
    targets: actualCoverage.targets.map(target => ({ ...target, evidence: [{ sourceId: forgedId, sourceDigest: forgedDigest,
      revisionId: identity.specRevisionId, materialKind: "source" as const }] })),
  };
  const modeledPack = { ...pack, rules: [{ ...rule, modelCases: [{ when: { all: ["enabled"] }, state: "draft", event: "submit", allowedNextStates: ["pending"] }] }] };
  // A JSON/client coverage field is not part of AssuranceInput or a provider capability.
  const result = await evaluateSpecAssurance({ ...base({ packs: [modeledPack] }), coverage: forgedResult } as AssuranceInput);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.coverageAuthority, "unavailable");
  assert.deepEqual(result.sourceEvidence, []);
  assert.equal(result.checkerResults[0]?.status, "PASS");
  assert(result.gaps.some(gap => gap.reason === "coverage-provider-unavailable"));
});

test("stale provider revision or digest and provider failures stay UNKNOWN without evidence", async () => {
  const staleRevision = { ...coverageInput, identity: { ...identity, specRevisionId: "old-revision" } } as SpecCoverageInput;
  const staleDigest = { ...coverageInput, identity: { ...identity, specDigest: "e".repeat(64) } } as SpecCoverageInput;
  const staleRev = await createSpecAssuranceConsumer(() => authoritySnapshot(staleRevision))(base());
  const staleHash = await createSpecAssuranceConsumer(() => authoritySnapshot(staleDigest))(base());
  const missing = await createSpecAssuranceConsumer(() => null)(base());
  const failed = await createSpecAssuranceConsumer(() => { throw new Error("lookup failed"); })(base());
  const timedOut = await createSpecAssuranceConsumer(() => new Promise(() => {}))(base());
  assert.equal(staleRev.coverageAuthority, "identity-mismatch");
  assert.equal(staleHash.coverageAuthority, "identity-mismatch");
  assert.equal(missing.coverageAuthority, "unavailable");
  assert.equal(failed.coverageAuthority, "failed");
  assert.equal(timedOut.coverageAuthority, "timeout");
  for (const result of [staleRev, staleHash, missing, failed, timedOut]) {
    assert.equal(result.status, "UNKNOWN");
    assert.deepEqual(result.sourceEvidence, []);
  }
});

test("a finite model emits a concrete counterexample for a disallowed observed transition", async () => {
  const modeledPack = { ...pack, rules: [{ ...rule, modelCases: [{ when: { all: ["enabled"] }, state: "draft", event: "submit", allowedNextStates: ["pending"] }] }] };
  const result = await evaluateSpecAssurance(base({ packs: [modeledPack], scenarios: [{ ...scenario, nextState: "closed" }] }));
  assert.equal(result.checkerResults[0]?.outcome, "fail");
  assert.deepEqual(result.checkerResults[0]?.counterexample, { scenarioId: "case-1", observedNextState: "closed", allowedNextStates: ["pending"] });
  assert.equal(result.status, "UNKNOWN");
});

test("conditionally absent, unavailable, throwing, timed out, and unbound adapters stay conservative", async () => {
  const modeledPack = { ...pack, rules: [{ ...rule, modelCases: [{ when: { all: ["different-condition"] }, state: "draft", event: "submit", allowedNextStates: ["pending"] }] }] };
  const insufficient = await evaluateSpecAssurance(base({ packs: [modeledPack] }));
  assert.equal(insufficient.checkerResults[0]?.outcome, "insufficient-model");
  assert.equal(insufficient.checkerResults[0]?.status, "UNKNOWN");

  const unavailable = await evaluateSpecAssurance(base({ checkerAdapter: null }));
  assert.equal(unavailable.checkerResults[0]?.outcome, "not-run");
  assert.equal(unavailable.checkerResults[0]?.status, "NOT_CHECKED");

  const throwing = await evaluateSpecAssurance(base({ checkerAdapter: () => { throw new Error("provider output hidden"); } }));
  assert.equal(throwing.checkerResults[0]?.outcome, "throw");
  assert.equal(throwing.checkerResults[0]?.status, "UNKNOWN");

  const timedOut = await evaluateSpecAssurance(base({ checkerTimeoutMs: 5, checkerAdapter: () => new Promise(() => {}) }));
  assert.equal(timedOut.checkerResults[0]?.outcome, "timeout");
  assert.equal(timedOut.checkerResults[0]?.status, "UNKNOWN");

  const invalid = await evaluateSpecAssurance(base({ checkerAdapter: request => ({ ...request, identity: { ...request.identity, projectId: "other" }, outcome: "pass", evidenceRefs: ["invented"] }) }));
  assert.equal(invalid.checkerResults[0]?.outcome, "invalid-evidence");
  assert.equal(invalid.checkerResults[0]?.status, "UNKNOWN");
});

test("a normal transition carrying an exception ID is UNKNOWN in both aggregate and scenario results", async () => {
  const inconsistent = await evaluateSpecAssurance(base({ scenarios: [{ ...scenario, exceptionId: "hold-1" }] }));
  assert.equal(inconsistent.status, "UNKNOWN");
  assert.equal(inconsistent.scenarios[0]?.status, "UNKNOWN");
  assert.equal(inconsistent.scenarios[0]?.reason, "combination-not-modelled");
});
