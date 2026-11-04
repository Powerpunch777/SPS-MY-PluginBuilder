import { createHash } from "node:crypto";
import { evaluateSpecCoverage, SPEC_COVERAGE_LIMITS, type CoverageIdentity, type SpecCoverageInput, type SpecCoverageResult } from "../spec-coverage/evaluator.ts";

/** A deliberately finite, pure assurance model. It does not authorize product actions. */
export const SPEC_ASSURANCE_LIMITS = Object.freeze({ packs: 32, rules: 1_000, scenarios: 10_000, checks: 1_000_000, idLength: 160, adapterTimeoutMs: 100, evidenceTimeoutMs: 100 });
export type AssuranceStatus = "PASS" | "FAIL" | "UNKNOWN" | "NOT_CHECKED";
/** `verified` means the injected current-scope snapshot passed local validation, not product approval. */
export type CoverageAuthorityStatus = "verified" | "unavailable" | "failed" | "timeout" | "identity-mismatch" | "scope-mismatch";
export type Predicate = Readonly<{ all?: readonly string[]; any?: readonly string[]; none?: readonly string[] }>;
export type DomainRule = Readonly<{
  id: string;
  requirementIds: readonly string[];
  appliesWhen: Predicate;
  requiresCheck: boolean;
  /** Explicit finite expectations; absent or unexercised cases are insufficient model evidence. */
  modelCases?: readonly Readonly<{ when: Predicate; state: string; event: string; allowedNextStates: readonly string[] }>[];
}>;
export type DomainPack = Readonly<{
  packId: string;
  version: string;
  identity: CoverageIdentity;
  applicability: Predicate;
  rules: readonly DomainRule[];
  transitions: readonly Readonly<{ from: string; event: string; to: string }>[];
  exceptions: readonly Readonly<{ id: string; from: string; event: string; to: string }>[];
  excludedCombinations: readonly Readonly<{ from: string; event: string; to: string; reason: string }>[];
}>;
export type AssuranceScenario = Readonly<{ id: string; state: string; event: string; nextState: string; exceptionId: string | null }>;
export type AssuranceGap = Readonly<{ id: string; fingerprint: string; requirementId: string; ruleId: string; sourceIds: readonly string[];
  uiIds: readonly string[]; contractIds: readonly string[]; workstreamIds: readonly string[]; taskIds: readonly string[];
  severity: string | null; decisionOwnerId: string | null; detectionMethod: string; resolutionEvidence: readonly string[];
  reason: string; status: "candidate" }>;
export type ItemDecisionStatus = "VERIFIED" | "RESOLVED" | "DELEGATED" | "UNDECIDED" | "NOT_APPLICABLE" | "NOT_CHECKED" | "INCONCLUSIVE";
export type AssuranceResult = Readonly<{
  /** Checker outcome only. It is not an item decision or execution authorization. */
  status: AssuranceStatus;
  coverageAuthority: CoverageAuthorityStatus;
  identity: CoverageIdentity;
  scope: AssuranceInput["scope"];
  itemDecisions: readonly Readonly<{ requirementId: string; status: ItemDecisionStatus; reason: string }>[];
  packVersions: readonly Readonly<{ packId: string; version: string }>[];
  applicablePackIds: readonly string[];
  excludedPackIds: readonly string[];
  excludedRules: readonly Readonly<{ packId: string; ruleId: string; reason: string }>[];
  excludedCombinations: readonly Readonly<{ scenarioId: string; reason: string }>[];
  scenarios: readonly Readonly<{ scenarioId: string; status: AssuranceStatus; evidenceRefs: readonly string[]; reason: string | null }>[];
  checkerResults: readonly Readonly<{ packId: string; packVersion: string; ruleId: string; requirementId: string;
    status: AssuranceStatus; outcome: "pass" | "fail" | "not-run" | "throw" | "timeout" | "insufficient-model" | "invalid-evidence";
    evidenceRefs: readonly string[]; counterexample: Readonly<{ scenarioId: string; observedNextState: string; allowedNextStates: readonly string[] }> | null;
    reason: string | null }>[];
  gaps: readonly AssuranceGap[];
  sourceEvidence: readonly Readonly<{ sourceId: string; sourceDigest: string; revisionId: string }>[];
}>;

export type AssuranceInput = Readonly<{
  identity: CoverageIdentity;
  scope: Readonly<{ requirementIds: readonly string[]; uiIds?: readonly string[]; contractIds?: readonly string[];
    workstreamIds?: readonly string[]; taskIds?: readonly string[] }>;
  facts: readonly string[];
  packs: readonly DomainPack[];
  scenarios: readonly AssuranceScenario[];
  /** Optional local adapter hook. Its output must match an independent local finite-model evaluation exactly. */
  checkerAdapter?: BoundedCheckerAdapter | null;
  checkerTimeoutMs?: number;
}>;

export type BoundedCheckerRequest = Readonly<{ requestId: string; identity: CoverageIdentity; scope: AssuranceInput["scope"];
  packId: string; packVersion: string; ruleId: string; requirementId: string; facts: readonly string[];
  modelCases: NonNullable<DomainRule["modelCases"]>; scenarios: readonly AssuranceScenario[] }>;
export type BoundedCheckerOutput = Readonly<{ requestId: string; identity: CoverageIdentity; scope: AssuranceInput["scope"];
  packId: string; packVersion: string; ruleId: string; requirementId: string;
  outcome: "pass" | "fail" | "not-run" | "insufficient-model"; evidenceRefs: readonly string[];
  counterexample?: Readonly<{ scenarioId: string; observedNextState: string; allowedNextStates: readonly string[] }> | null }>;
export type BoundedCheckerAdapter = (request: BoundedCheckerRequest) => BoundedCheckerOutput | Promise<BoundedCheckerOutput>;

/** Server-side consumer query. It contains only the scope to be looked up, never client evidence. */
export type AssuranceCoverageQuery = Readonly<{ identity: CoverageIdentity; requirementIds: readonly string[] }>;
/** All inputs that can authorize aggregate PASS must come from the same server-owned lookup. */
export type SpecAssuranceAuthoritySnapshot = Readonly<{
  coverageInput: SpecCoverageInput;
  domainPacks: readonly DomainPack[];
  facts: readonly string[];
}>;
/** Inject only at the server-owned consumer boundary; never deserialize this provider from a client/model payload. */
export type AssuranceCoverageProvider = (query: AssuranceCoverageQuery) => SpecAssuranceAuthoritySnapshot | null
  | Promise<SpecAssuranceAuthoritySnapshot | null>;
export type SpecAssuranceConsumer = (input: AssuranceInput) => Promise<AssuranceResult>;

const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const canonicalPredicate = (p: Predicate) => JSON.stringify({ all: [...(p.all ?? [])].sort(), any: [...(p.any ?? [])].sort(), none: [...(p.none ?? [])].sort() });
function canonicalPack(p: DomainPack): string {
  return JSON.stringify({ packId: p.packId, version: p.version,
    identity: [p.identity.workspaceId, p.identity.projectId, p.identity.specRevisionId, p.identity.specDigest],
    applicability: canonicalPredicate(p.applicability),
    rules: p.rules.map(r => [r.id, [...r.requirementIds].sort(), canonicalPredicate(r.appliesWhen), r.requiresCheck,
      (r.modelCases ?? []).map(c => [canonicalPredicate(c.when), c.state, c.event, [...c.allowedNextStates].sort()])])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    transitions: p.transitions.map(t => [t.from, t.event, t.to]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    exceptions: p.exceptions.map(e => [e.id, e.from, e.event, e.to]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    excludedCombinations: p.excludedCombinations.map(c => [c.from, c.event, c.to, c.reason]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
}
const idOk = (s: unknown): s is string => typeof s === "string" && !!s.trim() && s.length <= SPEC_ASSURANCE_LIMITS.idLength && !/[\u0000-\u001f\u007f]/u.test(s);
const sameIdentity = (a: CoverageIdentity, b: CoverageIdentity) => a.workspaceId === b.workspaceId && a.projectId === b.projectId
  && a.specRevisionId === b.specRevisionId && a.specDigest === b.specDigest;
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new TypeError(message); }
function immutableCopy<T>(value: T): T {
  const serialized = JSON.stringify(value);
  ensure(typeof serialized === "string" && Buffer.byteLength(serialized, "utf8") <= SPEC_COVERAGE_LIMITS.serializedInputBytes,
    "Assurance snapshot exceeds the serialized input limit or is not JSON data.");
  const copy = JSON.parse(serialized) as T;
  const seen = new WeakSet<object>();
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}
function snapshotInput(input: AssuranceInput): AssuranceInput {
  ensure(input && input.identity && input.scope && Array.isArray(input.scope.requirementIds), "Assurance identity and requirement scope are required.");
  ensure(input.scope.requirementIds.length <= SPEC_ASSURANCE_LIMITS.rules, "Requirement scope limit exceeded.");
  ensure(Array.isArray(input.facts) && input.facts.length <= SPEC_ASSURANCE_LIMITS.rules, "Fact limit exceeded.");
  ensure(Array.isArray(input.packs) && input.packs.length <= SPEC_ASSURANCE_LIMITS.packs, "Domain pack limit exceeded.");
  ensure(Array.isArray(input.scenarios) && input.scenarios.length <= SPEC_ASSURANCE_LIMITS.scenarios, "Scenario limit exceeded.");
  const copy = immutableCopy({ ...input, checkerAdapter: null });
  return Object.freeze({ ...copy, checkerAdapter: input.checkerAdapter });
}
function predicateMatches(p: Predicate, facts: ReadonlySet<string>): boolean {
  return (p.all ?? []).every(x => facts.has(x)) && (!(p.any?.length) || p.any.some(x => facts.has(x))) && !(p.none ?? []).some(x => facts.has(x));
}
function validatePredicate(p: Predicate, label: string): void {
  ensure(p && typeof p === "object" && !Array.isArray(p), `${label} must be a predicate.`);
  const keys = Object.keys(p);
  ensure(keys.every(k => ["all", "any", "none"].includes(k)), `${label} has unknown fields.`);
  for (const k of ["all", "any", "none"] as const) {
    const values = p[k] ?? [];
    ensure(Array.isArray(values) && values.length <= SPEC_ASSURANCE_LIMITS.rules && values.every(idOk), `${label}.${k} is invalid.`);
    ensure(new Set(values).size === values.length, `${label}.${k} has duplicate facts.`);
  }
}
function validatePack(pack: DomainPack): void {
  ensure(pack && idOk(pack.packId) && idOk(pack.version), "Invalid domain pack identity.");
  validatePredicate(pack.applicability, `pack ${pack.packId} applicability`);
  ensure(Array.isArray(pack.rules) && pack.rules.length <= SPEC_ASSURANCE_LIMITS.rules, `pack ${pack.packId} rules exceed limit.`);
  const ruleIds = new Set<string>();
  for (const r of pack.rules) {
    ensure(idOk(r.id) && !ruleIds.has(r.id), `pack ${pack.packId} has invalid or duplicate rule IDs.`); ruleIds.add(r.id);
    ensure(Array.isArray(r.requirementIds) && r.requirementIds.length > 0 && r.requirementIds.every(idOk), `rule ${r.id} has invalid requirement scope.`);
    ensure(new Set(r.requirementIds).size === r.requirementIds.length, `rule ${r.id} has duplicate requirements.`);
    ensure(typeof r.requiresCheck === "boolean", `rule ${r.id} requiresCheck must be boolean.`);
    validatePredicate(r.appliesWhen, `rule ${r.id} applicability`);
    if (r.modelCases !== undefined) {
      ensure(Array.isArray(r.modelCases) && r.modelCases.length <= SPEC_ASSURANCE_LIMITS.scenarios, `rule ${r.id} model cases exceed limit.`);
      for (const c of r.modelCases) {
        validatePredicate(c.when, `rule ${r.id} model condition`);
        ensure(idOk(c.state) && idOk(c.event) && Array.isArray(c.allowedNextStates) && c.allowedNextStates.length > 0
          && c.allowedNextStates.length <= SPEC_ASSURANCE_LIMITS.scenarios && c.allowedNextStates.every(idOk)
          && new Set(c.allowedNextStates).size === c.allowedNextStates.length, `rule ${r.id} has an invalid finite model case.`);
      }
    }
  }
  for (const k of ["transitions", "exceptions", "excludedCombinations"] as const) ensure(Array.isArray(pack[k]) && pack[k].length <= SPEC_ASSURANCE_LIMITS.scenarios, `pack ${pack.packId} ${k} exceed limit.`);
  for (const t of pack.transitions) ensure(idOk(t.from) && idOk(t.event) && idOk(t.to), `pack ${pack.packId} has invalid transition.`);
  for (const e of pack.exceptions) ensure(idOk(e.id) && idOk(e.from) && idOk(e.event) && idOk(e.to), `pack ${pack.packId} has invalid exception.`);
  for (const c of pack.excludedCombinations) ensure(idOk(c.from) && idOk(c.event) && idOk(c.to) && idOk(c.reason), `pack ${pack.packId} has invalid excluded combination.`);
  ensure(new Set(pack.exceptions.map(e => e.id)).size === pack.exceptions.length, `pack ${pack.packId} has duplicate exception IDs.`);
}

/** Compose compatible packs; same pack/version duplicates collapse, conflicting versions fail closed. */
export function composeDomainPacks(packs: readonly DomainPack[], identity: CoverageIdentity, facts: readonly string[]) {
  ensure(Array.isArray(packs) && packs.length <= SPEC_ASSURANCE_LIMITS.packs, "Too many domain packs.");
  ensure(Array.isArray(facts) && facts.length <= SPEC_ASSURANCE_LIMITS.rules && facts.every(idOk), "Invalid fact set.");
  ensure(new Set(facts).size === facts.length, "Fact set contains duplicates.");
  const unique = new Map<string, DomainPack>();
  for (const p of packs) {
    validatePack(p);
    ensure(sameIdentity(p.identity, identity), `Domain pack ${p.packId} belongs to a different Workspace, Project, or specification Revision.`);
    const previous = unique.get(p.packId);
    if (previous && previous.version !== p.version) throw new TypeError(`Conflicting versions for domain pack ${p.packId}.`);
    if (previous && canonicalPack(previous) !== canonicalPack(p)) throw new TypeError(`Conflicting content for domain pack ${p.packId}@${p.version}.`);
    if (!previous) unique.set(p.packId, p);
  }
  const composedRules = [...unique.values()].reduce((n, p) => n + p.rules.length, 0);
  ensure(composedRules <= SPEC_ASSURANCE_LIMITS.rules, "Composed domain rules exceed the global limit.");
  const factSet = new Set(facts);
  const applicable = [...unique.values()].filter(p => predicateMatches(p.applicability, factSet)).sort((a, b) => a.packId.localeCompare(b.packId));
  return Object.freeze(applicable);
}

function stableScope(scope: AssuranceInput["scope"]): AssuranceInput["scope"] {
  return Object.freeze({ requirementIds: Object.freeze([...scope.requirementIds].sort()),
    uiIds: Object.freeze([...(scope.uiIds ?? [])].sort()), contractIds: Object.freeze([...(scope.contractIds ?? [])].sort()),
    workstreamIds: Object.freeze([...(scope.workstreamIds ?? [])].sort()), taskIds: Object.freeze([...(scope.taskIds ?? [])].sort()) });
}
function scopeKey(scope: AssuranceInput["scope"]): string {
  const value = stableScope(scope);
  return JSON.stringify([value.requirementIds, value.uiIds, value.contractIds, value.workstreamIds, value.taskIds]);
}

/** Execute only explicit finite cases; this is local model analysis, not registry or external evidence. */
function runBoundedModelChecker(request: BoundedCheckerRequest): BoundedCheckerOutput {
  if (request.modelCases.length === 0) return { ...request, outcome: "insufficient-model", evidenceRefs: [] };
  const facts = new Set(request.facts);
  const cases = request.modelCases.filter(c => predicateMatches(c.when, facts));
  if (cases.length === 0) return { ...request, outcome: "insufficient-model", evidenceRefs: [] };
  const evidenceRefs: string[] = [];
  for (const modelCase of cases) {
    const observed = request.scenarios.filter(s => s.state === modelCase.state && s.event === modelCase.event);
    if (observed.length === 0) return { ...request, outcome: "insufficient-model", evidenceRefs: [] };
    for (const scenario of observed) {
      evidenceRefs.push(scenario.id);
      if (!modelCase.allowedNextStates.includes(scenario.nextState)) return { ...request, outcome: "fail", evidenceRefs,
        counterexample: { scenarioId: scenario.id, observedNextState: scenario.nextState, allowedNextStates: modelCase.allowedNextStates } };
    }
  }
  return { ...request, outcome: "pass", evidenceRefs: [...new Set(evidenceRefs)].sort(), counterexample: null };
}

function sameCheckerOutput(output: BoundedCheckerOutput, expected: BoundedCheckerOutput): boolean {
  try {
    return !!output && output.requestId === expected.requestId && sameIdentity(output.identity, expected.identity)
      && scopeKey(output.scope) === scopeKey(expected.scope) && output.packId === expected.packId
      && output.packVersion === expected.packVersion && output.ruleId === expected.ruleId && output.requirementId === expected.requirementId
      && output.outcome === expected.outcome && Array.isArray(output.evidenceRefs)
      && JSON.stringify([...output.evidenceRefs].sort()) === JSON.stringify([...expected.evidenceRefs].sort())
      && JSON.stringify(output.counterexample ?? null) === JSON.stringify(expected.counterexample ?? null);
  } catch { return false; }
}

function timedAdapter(adapter: BoundedCheckerAdapter, request: BoundedCheckerRequest, timeoutMs: number): Promise<BoundedCheckerOutput> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("checker-timeout")), timeoutMs);
    Promise.resolve().then(() => adapter(request)).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

const evidenceTimeout = Symbol("evidence-provider-timeout");

/**
 * Build the server-owned consumer once with a trusted store/registry lookup. The lookup is a
 * code capability supplied by the server, never a field in AssuranceInput or a client payload.
 * Its returned CoverageInput is re-evaluated here instead of trusting a caller-supplied result.
 */
export function createSpecAssuranceConsumer(provider: AssuranceCoverageProvider | null): SpecAssuranceConsumer {
  return input => evaluateSpecAssuranceFromProvider(input, provider);
}

/** Pure/unwired entry point: absent an injected authority provider, source coverage is UNKNOWN. */
export function evaluateSpecAssurance(input: AssuranceInput): Promise<AssuranceResult> {
  return evaluateSpecAssuranceFromProvider(input, null);
}

async function evaluateSpecAssuranceFromProvider(input: AssuranceInput, provider: AssuranceCoverageProvider | null): Promise<AssuranceResult> {
  input = snapshotInput(input);
  let trustedCoverage: SpecCoverageResult | null = null;
  let trustedPacks: readonly DomainPack[] | null = null;
  let trustedFacts: readonly string[] | null = null;
  let coverageAuthority: CoverageAuthorityStatus = "unavailable";
  if (provider) {
    const query: AssuranceCoverageQuery = Object.freeze({ identity: Object.freeze({ ...input.identity }),
      requirementIds: Object.freeze([...input.scope.requirementIds].sort()) });
    try {
      const loaded = await Promise.race([
        Promise.resolve().then(() => provider(query)),
        new Promise<never>((_, reject) => setTimeout(() => reject(evidenceTimeout), SPEC_ASSURANCE_LIMITS.evidenceTimeoutMs)),
      ]);
      if (loaded === null) coverageAuthority = "unavailable";
      else {
        const snapshot = immutableCopy(loaded);
        if (!sameIdentity(snapshot.coverageInput.identity, input.identity)) coverageAuthority = "identity-mismatch";
        else if (snapshot.coverageInput.scope.requirementIds.length !== query.requirementIds.length
          || !query.requirementIds.every(id => snapshot.coverageInput.scope.requirementIds.includes(id))) coverageAuthority = "scope-mismatch";
        else {
        const result = evaluateSpecCoverage(snapshot.coverageInput);
        if (!sameIdentity(result.inputIdentity, input.identity)) coverageAuthority = "identity-mismatch";
        else if (result.scope.requirementIds.length !== query.requirementIds.length
          || !query.requirementIds.every(id => result.scope.requirementIds.includes(id))) coverageAuthority = "scope-mismatch";
        else if (!Array.isArray(snapshot.domainPacks) || !Array.isArray(snapshot.facts)) coverageAuthority = "failed";
        else {
          composeDomainPacks(snapshot.domainPacks, input.identity, snapshot.facts);
          trustedCoverage = result; trustedPacks = snapshot.domainPacks; trustedFacts = snapshot.facts; coverageAuthority = "verified";
        }
        }
      }
    } catch (error) {
      coverageAuthority = error === evidenceTimeout ? "timeout" : "failed";
    }
  }
  return evaluateSpecAssuranceWithCoverage(input, trustedCoverage, trustedPacks, trustedFacts, coverageAuthority);
}

/** Evaluate bounded supplied state/event/exception examples and provider-verified coverage. */
async function evaluateSpecAssuranceWithCoverage(input: AssuranceInput, trustedCoverage: SpecCoverageResult | null,
  trustedPacks: readonly DomainPack[] | null, trustedFacts: readonly string[] | null,
  coverageAuthority: CoverageAuthorityStatus): Promise<AssuranceResult> {
  ensure(input, "Assurance input is required.");
  ensure(Array.isArray(input.scope.requirementIds) && input.scope.requirementIds.length <= SPEC_ASSURANCE_LIMITS.rules
    && input.scope.requirementIds.every(idOk), "Invalid requirement scope.");
  ensure(new Set(input.scope.requirementIds).size === input.scope.requirementIds.length, "Duplicate requirement scope.");
  for (const key of ["uiIds", "contractIds", "workstreamIds", "taskIds"] as const) {
    const refs = input.scope[key] ?? [];
    ensure(Array.isArray(refs) && refs.length <= SPEC_ASSURANCE_LIMITS.rules && refs.every(idOk) && new Set(refs).size === refs.length,
      `Invalid scope ${key}.`);
  }
  ensure(Array.isArray(input.scenarios) && input.scenarios.length <= SPEC_ASSURANCE_LIMITS.scenarios, "Scenario limit exceeded.");
  const timeoutMs = input.checkerTimeoutMs ?? SPEC_ASSURANCE_LIMITS.adapterTimeoutMs;
  ensure(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= SPEC_ASSURANCE_LIMITS.adapterTimeoutMs, "Invalid checker timeout.");
  ensure(new Set(input.scenarios.map(s => s.id)).size === input.scenarios.length && input.scenarios.every(s => idOk(s.id) && idOk(s.state) && idOk(s.event) && idOk(s.nextState)
    && (s.exceptionId === null || idOk(s.exceptionId))), "Invalid or duplicate scenarios.");

  const factsForEvaluation = coverageAuthority === "verified" ? trustedFacts! : input.facts;
  const packsForEvaluation = coverageAuthority === "verified" ? trustedPacks! : input.packs;
  const packs = composeDomainPacks(packsForEvaluation, input.identity, factsForEvaluation);
  const modelRows = packs.reduce((n, p) => n + p.transitions.length + p.exceptions.length + p.excludedCombinations.length, 0);
  ensure(modelRows * input.scenarios.length <= SPEC_ASSURANCE_LIMITS.checks, "State/event comparison limit exceeded.");
  const modelChecks = packs.reduce((n, p) => n + p.rules.reduce((m, r) => m + (r.modelCases?.length ?? 0), 0), 0);
  const scopedRuleRequirements = packs.reduce((n, p) => n + p.rules.filter(r => r.requiresCheck && predicateMatches(r.appliesWhen, new Set(factsForEvaluation)))
    .reduce((m, r) => m + r.requirementIds.filter(id => input.scope.requirementIds.includes(id)).length, 0), 0);
  ensure(modelChecks * Math.max(1, input.scenarios.length) * Math.max(1, scopedRuleRequirements) <= SPEC_ASSURANCE_LIMITS.checks,
    "Conditional model comparison limit exceeded.");
  let unknown = false, failed = false;
  for (const scenario of input.scenarios) {
    const knownException = scenario.exceptionId !== null && packs.some(p => p.exceptions.some(e => e.id === scenario.exceptionId
      && e.from === scenario.state && e.event === scenario.event && e.to === scenario.nextState));
    const knownTransition = scenario.exceptionId === null && packs.some(p => p.transitions.some(t => t.from === scenario.state && t.event === scenario.event && t.to === scenario.nextState));
    const explicitExclusion = packs.some(p => p.excludedCombinations.some(c => c.from === scenario.state && c.event === scenario.event && c.to === scenario.nextState));
    if (explicitExclusion) failed = true;
    else if (!knownTransition && !knownException) unknown = true;
  }
  const rules = new Map<string, DomainRule>();
  for (const p of packs) for (const r of p.rules) {
    const key = `${r.id}\0${JSON.stringify([...r.requirementIds].sort())}\0${canonicalPredicate(r.appliesWhen)}\0${r.requiresCheck}\0${JSON.stringify(r.modelCases ?? [])}`;
    const old = rules.get(key);
    if (!old) rules.set(key, r);
  }
  const facts = new Set(factsForEvaluation);
  const gaps: AssuranceGap[] = [];
  const excludedRules: { packId: string; ruleId: string; reason: string }[] = [];
  for (const p of packs) for (const r of p.rules) {
    if (!predicateMatches(r.appliesWhen, facts)) excludedRules.push({ packId: p.packId, ruleId: r.id, reason: "rule-condition-not-satisfied" });
    else if (r.requirementIds.every(id => !input.scope.requirementIds.includes(id))) excludedRules.push({ packId: p.packId, ruleId: r.id, reason: "requirement-out-of-scope" });
  }
  for (const requirementId of input.scope.requirementIds) {
    gaps.push(makeGap(input, requirementId, "item-decision-status", "approved-specification-item-decision-resolver-unavailable", trustedCoverage));
  }
  if (!rules.size) for (const requirementId of input.scope.requirementIds) {
    gaps.push(makeGap(input, requirementId, "domain-pack-selector", "no-applicable-domain-rules", trustedCoverage));
  }
  const applicableRequirements = new Set([...rules.values()].filter(rule => predicateMatches(rule.appliesWhen, facts))
    .flatMap(rule => rule.requirementIds.filter(id => input.scope.requirementIds.includes(id))));
  for (const requirementId of input.scope.requirementIds) if (!applicableRequirements.has(requirementId)) {
    gaps.push(makeGap(input, requirementId, "domain-pack-selector", "no-applicable-domain-rules", trustedCoverage));
    unknown = true;
  }
  for (const [key, rule] of rules) {
    if (!predicateMatches(rule.appliesWhen, facts)) continue;
    for (const requirementId of rule.requirementIds) {
      if (!input.scope.requirementIds.includes(requirementId)) continue;
      const covered = trustedCoverage?.targets.find(t => t.targetKind === "requirement" && t.targetId === requirementId);
      if (coverageAuthority !== "verified") {
        gaps.push(makeGap(input, requirementId, rule.id, `coverage-provider-${coverageAuthority}`, trustedCoverage));
        unknown = true;
      } else if (!covered || covered.status !== "COVERED") {
        const reason = covered?.status ?? "missing-coverage-target";
        gaps.push(makeGap(input, requirementId, rule.id, `coverage-${reason}`, trustedCoverage));
        if (covered?.status === "GAP") failed = true; else unknown = true;
      }
    }
  }
  if (!rules.size) unknown = true;
  const checkerResults: NonNullable<AssuranceResult["checkerResults"]>[number][] = [];
  const checkedRuleKeys = new Set<string>();
  const requestedScope = stableScope(input.scope);
  const adapter = input.checkerAdapter === undefined ? runBoundedModelChecker : input.checkerAdapter;
  for (const p of packs) for (const rule of p.rules) {
    if (!rule.requiresCheck || !predicateMatches(rule.appliesWhen, facts)) continue;
    for (const requirementId of rule.requirementIds) {
      if (!input.scope.requirementIds.includes(requirementId)) continue;
      const ruleKey = `${rule.id}\0${[...rule.requirementIds].sort().join("\0")}\0${canonicalPredicate(rule.appliesWhen)}\0${JSON.stringify(rule.modelCases ?? [])}`;
      if (checkedRuleKeys.has(ruleKey)) continue;
      checkedRuleKeys.add(ruleKey);
      const requestCore = { identity: input.identity, scope: requestedScope, packId: p.packId, packVersion: p.version,
        ruleId: rule.id, requirementId, facts: Object.freeze([...factsForEvaluation].sort()),
        modelCases: rule.modelCases ?? Object.freeze([]), scenarios: input.scenarios };
      const request: BoundedCheckerRequest = Object.freeze({ ...requestCore,
        requestId: hash(JSON.stringify([requestCore.identity.workspaceId, requestCore.identity.projectId, requestCore.identity.specRevisionId,
          requestCore.identity.specDigest, scopeKey(requestCore.scope), requestCore.packId, requestCore.packVersion, rule.id,
          requirementId, requestCore.facts, requestCore.modelCases, requestCore.scenarios])) });
      const expected = runBoundedModelChecker(request);
      let outcome: NonNullable<AssuranceResult["checkerResults"]>[number]["outcome"];
      let status: AssuranceStatus;
      let reason: string | null = null;
      let evidenceRefs: readonly string[] = Object.freeze([]);
      let counterexample: NonNullable<AssuranceResult["checkerResults"]>[number]["counterexample"] = null;
      if (adapter === null) { outcome = "not-run"; status = "NOT_CHECKED"; reason = "checker-adapter-unavailable"; }
      else {
        try {
          const output = await timedAdapter(adapter, request, timeoutMs);
          if (!output || !sameCheckerOutput(output, expected)) {
            outcome = "invalid-evidence"; status = "UNKNOWN"; reason = "checker-output-identity-scope-or-evidence-mismatch";
          } else {
            outcome = output.outcome;
            evidenceRefs = Object.freeze([...output.evidenceRefs]);
            counterexample = output.counterexample ? Object.freeze({ ...output.counterexample,
              allowedNextStates: Object.freeze([...output.counterexample.allowedNextStates]) }) : null;
            if (outcome === "pass") status = "PASS";
            else if (outcome === "fail") { status = "FAIL"; reason = "bounded-counterexample-found"; }
            else { status = "UNKNOWN"; reason = outcome === "not-run" ? "checker-not-run" : "insufficient-model"; }
          }
        } catch (error) {
          const timeout = error instanceof Error && error.message === "checker-timeout";
          outcome = timeout ? "timeout" : "throw"; status = "UNKNOWN";
          reason = timeout ? "checker-timeout" : "checker-threw";
        }
      }
      if (status === "FAIL") failed = true;
      else if (status !== "PASS") unknown = true;
      checkerResults.push(Object.freeze({ packId: p.packId, packVersion: p.version, ruleId: rule.id, requirementId,
        status, outcome, evidenceRefs, counterexample, reason }));
      if (status !== "PASS") gaps.push(makeGap(input, requirementId, rule.id, `checker-${outcome}:${reason ?? ""}`, trustedCoverage));
    }
  }
  const scenarioResults = input.scenarios.map(s => {
    const exception = s.exceptionId === null ? null : packs.flatMap(p => p.exceptions).find(e => e.id === s.exceptionId);
    const valid = (s.exceptionId === null && packs.some(p => p.transitions.some(t => t.from === s.state && t.event === s.event && t.to === s.nextState)))
      || Boolean(exception && exception.from === s.state && exception.event === s.event && exception.to === s.nextState);
    const exclusion = packs.flatMap(p => p.excludedCombinations).find(c => c.from === s.state && c.event === s.event && c.to === s.nextState);
    return Object.freeze({ scenarioId: s.id, status: exclusion ? "FAIL" as const : valid ? "NOT_CHECKED" as const : "UNKNOWN" as const,
      evidenceRefs: Object.freeze([]), reason: exclusion?.reason ?? (valid ? null : "combination-not-modelled") });
  });
  for (const scenario of scenarioResults) if (scenario.status === "UNKNOWN" || scenario.status === "FAIL") {
    const linkedRules = [...rules.values()].filter(rule => rule.requirementIds.some(id => input.scope.requirementIds.includes(id)));
    const refs = linkedRules.length ? linkedRules : [{ id: "state-event-model", requirementIds: input.scope.requirementIds }];
    for (const rule of refs) for (const requirementId of rule.requirementIds) if (input.scope.requirementIds.includes(requirementId)) {
      gaps.push(makeGap(input, requirementId, rule.id, `${scenario.status === "FAIL" ? "excluded-combination" : "combination-not-modelled"}:${scenario.scenarioId}:${scenario.reason}`, trustedCoverage));
    }
  }
  const allRequiredChecksPassed = checkerResults.length > 0 && checkerResults.every(check => check.status === "PASS");
  const everyRequirementChecked = input.scope.requirementIds.every(requirementId =>
    checkerResults.some(check => check.requirementId === requirementId));
  if (!everyRequirementChecked) unknown = true;
  const status: AssuranceStatus = coverageAuthority !== "verified" ? "UNKNOWN"
    : failed ? "FAIL" : unknown ? "UNKNOWN" : allRequiredChecksPassed ? "PASS" : "NOT_CHECKED";
  const uniqGaps = new Map<string, AssuranceGap>();
  for (const gap of gaps) uniqGaps.set(gap.fingerprint, gap);
  const sourceEvidence = trustedCoverage?.targets.filter(target => target.targetKind === "requirement" && target.status === "COVERED"
    && input.scope.requirementIds.includes(target.targetId)).flatMap(target => target.evidence
      .filter(item => item.materialKind === "source" && item.revisionId === input.identity.specRevisionId)
      .map(({ sourceId, sourceDigest, revisionId }) => Object.freeze({ sourceId, sourceDigest, revisionId }))) ?? [];
  const uniqueSourceEvidence = new Map(sourceEvidence.map(item => [`${item.sourceId}\0${item.sourceDigest}\0${item.revisionId}`, item]));
  return Object.freeze({ status, coverageAuthority, identity: Object.freeze({ ...input.identity }), scope: requestedScope,
    itemDecisions: Object.freeze(input.scope.requirementIds.map(requirementId => Object.freeze({ requirementId,
      status: "NOT_CHECKED" as const, reason: "approved-specification-item-decision-resolver-unavailable" }))),
    packVersions: Object.freeze([...new Map(packsForEvaluation.map(p => [p.packId, p.version])).entries()].map(([packId, version]) => Object.freeze({ packId, version })).sort((a, b) => a.packId.localeCompare(b.packId))),
    applicablePackIds: Object.freeze(packs.map(p => p.packId)),
    excludedPackIds: Object.freeze([...new Set(packsForEvaluation.filter(p => !packs.some(a => a.packId === p.packId)).map(p => p.packId))].sort()),
    excludedRules: Object.freeze(excludedRules.map(item => Object.freeze(item))),
    excludedCombinations: Object.freeze(scenarioResults.filter(s => s.status === "FAIL").map(s => Object.freeze({ scenarioId: s.scenarioId, reason: s.reason! }))),
    scenarios: Object.freeze(scenarioResults), checkerResults: Object.freeze(checkerResults),
    gaps: Object.freeze([...uniqGaps.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))),
    sourceEvidence: Object.freeze([...uniqueSourceEvidence.values()].sort((a, b) => `${a.sourceId}\0${a.sourceDigest}\0${a.revisionId}`
      .localeCompare(`${b.sourceId}\0${b.sourceDigest}\0${b.revisionId}`))) });
}

function makeGap(input: AssuranceInput, requirementId: string, ruleId: string, reason: string,
  trustedCoverage: SpecCoverageResult | null): AssuranceGap {
  const sourceIds = [...new Set(trustedCoverage?.targets.find(item => item.targetKind === "requirement" && item.targetId === requirementId
    && item.status === "COVERED")?.evidence.filter(item => item.materialKind === "source" && item.revisionId === input.identity.specRevisionId)
    .map(item => item.sourceId) ?? [])].sort();
  const uiIds = [...new Set(input.scope.uiIds ?? [])].sort();
  const contractIds = [...new Set(input.scope.contractIds ?? [])].sort();
  const workstreamIds = [...new Set(input.scope.workstreamIds ?? [])].sort();
  const taskIds = [...new Set(input.scope.taskIds ?? [])].sort();
  const fingerprint = hash(JSON.stringify([input.identity.workspaceId, input.identity.projectId, input.identity.specRevisionId,
    input.identity.specDigest, requirementId, ruleId, sourceIds, uiIds, contractIds, workstreamIds, taskIds, reason]));
  const detectionMethod = reason.startsWith("coverage-") ? "coverage-evaluator"
    : reason.startsWith("excluded-combination:") || reason.startsWith("combination-not-modelled:")
      ? "bounded-transition-model" : "checker-integration-unavailable";
  return Object.freeze({ id: `gap-${fingerprint.slice(0, 24)}`, fingerprint, requirementId, ruleId, sourceIds: Object.freeze(sourceIds),
    uiIds: Object.freeze(uiIds), contractIds: Object.freeze(contractIds), workstreamIds: Object.freeze(workstreamIds), taskIds: Object.freeze(taskIds),
    severity: null, decisionOwnerId: null, detectionMethod, resolutionEvidence: Object.freeze([]), reason, status: "candidate" });
}
