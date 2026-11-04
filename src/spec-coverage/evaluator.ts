import { createHash } from "node:crypto";

export const SPEC_COVERAGE_LIMITS = Object.freeze({
  identifierCharacters: 160,
  listEntries: 101_000,
  rules: 1_000,
  checks: 1_000_000,
  serializedInputBytes: 64 * 1024 * 1024,
});

export type CoverageTargetKind = "requirement" | "ac";
export type MaterialKind = "specification" | "workstream" | "task" | "question" | "source";
export type VerificationLevel = "validated" | "unvalidated" | "invalid" | "unknown";
export type Presence = "present" | "partial" | "missing" | "not-provided";
export type CoverageStatus = "COVERED" | "GAP" | "UNKNOWN" | "NOT_CHECKED";

export type CoverageIdentity = Readonly<{
  workspaceId: string;
  projectId: string;
  specRevisionId: string;
  specDigest: string;
}>;

export type CoverageScope = Readonly<{
  requirementIds: readonly string[];
  acIds: readonly string[];
}>;

export type CoverageRule = Readonly<{
  id: string;
  requiresCheck: boolean;
  requiredEvidenceKinds: readonly MaterialKind[];
}>;

export type CoverageManifestTarget = Readonly<{
  targetId: string;
  targetKind: CoverageTargetKind;
  ruleIds: readonly string[];
}>;

export type CoverageRulesManifest = Readonly<{
  identity: CoverageIdentity;
  scope: CoverageScope;
  rulesVersion: string;
  rules: readonly CoverageRule[];
  targets: readonly CoverageManifestTarget[];
  digest: string;
}>;

export type CoverageSourceRef = Readonly<{
  requirementId: string;
  acId: string | null;
  sourceId: string;
  sourceDigest: string;
  revisionId: string;
}>;

export type CoverageCheck = Readonly<{
  targetId: string;
  targetKind?: CoverageTargetKind;
  ruleId: string;
  status: "passed" | "failed" | "not-run";
  evidenceRefs: readonly string[];
}>;

export type CoverageEntity = Readonly<{
  kind: "requirement" | "ac" | "workstream" | "task" | "question" | "source";
  id: string;
  bodyDigest: string;
  relationIds: readonly string[];
}>;

export type CoverageMaterial = Readonly<{
  kind: MaterialKind;
  identity: CoverageIdentity;
  presence: Presence;
  verification: VerificationLevel;
  entities: readonly CoverageEntity[];
}>;

export type SpecCoverageInput = Readonly<{
  identity: CoverageIdentity;
  scope: CoverageScope;
  rulesVersion: string;
  manifest: CoverageRulesManifest | null;
  materials: readonly CoverageMaterial[];
  sourceRefs: readonly CoverageSourceRef[];
  checks: readonly CoverageCheck[];
}>;

export type CoverageEvidence = Readonly<{
  sourceId: string;
  sourceDigest: string;
  revisionId: string;
  materialKind: MaterialKind;
}>;

export type CoverageTargetResult = Readonly<{
  targetId: string;
  targetKind: CoverageTargetKind;
  status: CoverageStatus;
  ruleIds: readonly string[];
  evidence: readonly CoverageEvidence[];
  reasons: readonly string[];
}>;

export type CoverageGap = Readonly<{
  id: string;
  kind: "missing-structure" | "failed-check" | "identity-conflict";
  targetKind: CoverageTargetKind;
  targetIds: readonly string[];
  evidenceRefs: readonly string[];
  status: "candidate";
}>;

export type CoverageTaskCandidate = Readonly<{
  id: string;
  targetKind: CoverageTargetKind;
  targetIds: readonly string[];
  reasonRefs: readonly string[];
  status: "candidate";
}>;

export type SpecCoverageResult = Readonly<{
  inputIdentity: CoverageIdentity;
  scope: CoverageScope;
  rulesVersion: string;
  manifestDigest: string | null;
  limits: typeof SPEC_COVERAGE_LIMITS;
  targets: readonly CoverageTargetResult[];
  gaps: readonly CoverageGap[];
  taskCandidates: readonly CoverageTaskCandidate[];
  materialStates: readonly Readonly<{ kind: MaterialKind; identity: CoverageIdentity; presence: Presence; verification: VerificationLevel }> [];
  sourceRefs: readonly CoverageSourceRef[];
  checks: readonly CoverageCheck[];
  checkResults: readonly Readonly<{ targetId: string; targetKind: CoverageTargetKind | null; ruleId: string;
    status: CoverageCheck["status"]; evidenceRefs: readonly string[]; assessment: string }> [];
  notChecked: readonly Readonly<{ targetId: string; targetKind: CoverageTargetKind | null; ruleId: string; reason: string }> [];
  unknowns: readonly Readonly<{ targetId: string | null; targetKind: CoverageTargetKind | null; code: string }> [];
}>;

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function fail(label: string, detail: string): never {
  throw new TypeError(`${label} ${detail}`);
}

function record(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(label, "must be a plain record.");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(label, "must be a plain record.");
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(fields);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !allowed.has(key))) {
    fail(label, "has unknown or missing fields.");
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail(`${label}.${key}`, "must be an enumerable data field.");
    result[key] = descriptor.value;
  }
  return result;
}

function list(value: unknown, label: string, maximum: number = SPEC_COVERAGE_LIMITS.listEntries): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(label, "must be a standard array.");
  const keys = Reflect.ownKeys(value);
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length > maximum) fail(label, `must have at most ${maximum} entries.`);
  if (keys.length !== length + 1 || !keys.includes("length")) fail(label, "must be dense with no extra properties.");
  const output: unknown[] = [];
  for (let i = 0; i < length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail(label, "must contain dense data.");
    output.push(descriptor.value);
  }
  return output;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > SPEC_COVERAGE_LIMITS.identifierCharacters
    || /[\u0000-\u001f\u007f]/u.test(value)) fail(label, `must be a nonblank identifier of at most ${SPEC_COVERAGE_LIMITS.identifierCharacters} characters without ASCII controls.`);
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) fail(label, "must be 64 lowercase hexadecimal characters.");
  return value;
}

function enumValue<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) fail(label, "has an unsupported value.");
  return value as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseIdentity(value: unknown, label: string): CoverageIdentity {
  const row = record(value, ["workspaceId", "projectId", "specRevisionId", "specDigest"], label);
  return Object.freeze({
    workspaceId: identifier(row.workspaceId, `${label}.workspaceId`),
    projectId: identifier(row.projectId, `${label}.projectId`),
    specRevisionId: identifier(row.specRevisionId, `${label}.specRevisionId`),
    specDigest: digest(row.specDigest, `${label}.specDigest`),
  });
}

function parseScope(value: unknown, label: string): CoverageScope {
  const row = record(value, ["requirementIds", "acIds"], label);
  const requirementIds = list(row.requirementIds, `${label}.requirementIds`).map((item, i) => identifier(item, `${label}.requirementIds[${i}]`));
  const acIds = list(row.acIds, `${label}.acIds`).map((item, i) => identifier(item, `${label}.acIds[${i}]`));
  for (const [name, values] of [["requirementIds", requirementIds], ["acIds", acIds]] as const) {
    if (new Set(values).size !== values.length) fail(`${label}.${name}`, "must contain unique identifiers.");
  }
  return Object.freeze({
    requirementIds: Object.freeze(requirementIds.sort()),
    acIds: Object.freeze(acIds.sort()),
  });
}

function parseRule(value: unknown, index: number): CoverageRule {
  const label = `manifest.rules[${index}]`;
  const row = record(value, ["id", "requiresCheck", "requiredEvidenceKinds"], label);
  if (typeof row.requiresCheck !== "boolean") fail(`${label}.requiresCheck`, "must be boolean.");
  const evidence = list(row.requiredEvidenceKinds, `${label}.requiredEvidenceKinds`).map((item, i) => enumValue(item,
    ["specification", "workstream", "task", "question", "source"] as const, `${label}.requiredEvidenceKinds[${i}]`));
  if (new Set(evidence).size !== evidence.length) fail(`${label}.requiredEvidenceKinds`, "must contain unique kinds.");
  return Object.freeze({ id: identifier(row.id, `${label}.id`), requiresCheck: row.requiresCheck, requiredEvidenceKinds: Object.freeze(evidence) });
}

function parseManifestTarget(value: unknown, index: number): CoverageManifestTarget {
  const label = `manifest.targets[${index}]`;
  const row = record(value, ["targetId", "targetKind", "ruleIds"], label);
  const ruleIds = list(row.ruleIds, `${label}.ruleIds`).map((item, i) => identifier(item, `${label}.ruleIds[${i}]`));
  if (new Set(ruleIds).size !== ruleIds.length) fail(`${label}.ruleIds`, "must be unique.");
  return Object.freeze({
    targetId: identifier(row.targetId, `${label}.targetId"`),
    targetKind: enumValue(row.targetKind, ["requirement", "ac"] as const, `${label}.targetKind`),
    ruleIds: Object.freeze(ruleIds),
  });
}

function parseRulesManifest(value: unknown): CoverageRulesManifest {
  const row = record(value, ["identity", "scope", "rulesVersion", "rules", "targets", "digest"], "manifest");
  const rules = list(row.rules, "manifest.rules", SPEC_COVERAGE_LIMITS.rules).map(parseRule);
  const targets = list(row.targets, "manifest.targets").map(parseManifestTarget);
  if (new Set(rules.map(item => item.id)).size !== rules.length) fail("manifest.rules", "IDs must be unique.");
  const targetKeys = targets.map(item => `${item.targetKind}\0${item.targetId}`);
  if (new Set(targetKeys).size !== targetKeys.length) fail("manifest.targets", "target kind and IDs must be unique.");
  const knownRules = new Set(rules.map(item => item.id));
  for (const target of targets) for (const id of target.ruleIds) if (!knownRules.has(id)) fail("manifest.targets", `references unknown rule ${id}.`);
  const manifest: CoverageRulesManifest = Object.freeze({
    identity: parseIdentity(row.identity, "manifest.identity"),
    scope: parseScope(row.scope, "manifest.scope"),
    rulesVersion: identifier(row.rulesVersion, "manifest.rulesVersion"),
    rules: Object.freeze(rules),
    targets: Object.freeze(targets),
    digest: digest(row.digest, "manifest.digest"),
  });
  return manifest;
}

function parseSourceRef(value: unknown, index: number): CoverageSourceRef {
  const label = `sourceRefs[${index}]`;
  const row = record(value, ["requirementId", "acId", "sourceId", "sourceDigest", "revisionId"], label);
  return Object.freeze({
    requirementId: identifier(row.requirementId, `${label}.requirementId`),
    acId: row.acId === null ? null : identifier(row.acId, `${label}.acId`),
    sourceId: identifier(row.sourceId, `${label}.sourceId`),
    sourceDigest: digest(row.sourceDigest, `${label}.sourceDigest`),
    revisionId: identifier(row.revisionId, `${label}.revisionId`),
  });
}

function parseCheck(value: unknown, index: number): CoverageCheck {
  const label = `checks[${index}]`;
  const hasTargetKind = value !== null && typeof value === "object" && Object.hasOwn(value, "targetKind");
  const row = record(value, hasTargetKind
    ? ["targetId", "targetKind", "ruleId", "status", "evidenceRefs"]
    : ["targetId", "ruleId", "status", "evidenceRefs"], label);
  const evidenceRefs = list(row.evidenceRefs, `${label}.evidenceRefs`).map((item, i) => identifier(item, `${label}.evidenceRefs[${i}]`));
  if (new Set(evidenceRefs).size !== evidenceRefs.length) fail(`${label}.evidenceRefs`, "must contain unique references.");
  const parsed = {
    targetId: identifier(row.targetId, `${label}.targetId`),
    ruleId: identifier(row.ruleId, `${label}.ruleId`),
    status: enumValue(row.status, ["passed", "failed", "not-run"] as const, `${label}.status`),
    evidenceRefs: Object.freeze(evidenceRefs),
  };
  return Object.freeze(hasTargetKind
    ? { ...parsed, targetKind: enumValue(row.targetKind, ["requirement", "ac"] as const, `${label}.targetKind`) }
    : parsed);
}

function parseEntity(value: unknown, label: string): CoverageEntity {
  const row = record(value, ["kind", "id", "bodyDigest", "relationIds"], label);
  const relationIds = list(row.relationIds, `${label}.relationIds`).map((item, i) => identifier(item, `${label}.relationIds[${i}]`));
  return Object.freeze({
    kind: enumValue(row.kind, ["requirement", "ac", "workstream", "task", "question", "source"] as const, `${label}.kind`),
    id: identifier(row.id, `${label}.id`),
    bodyDigest: digest(row.bodyDigest, `${label}.bodyDigest`),
    relationIds: Object.freeze(relationIds),
  });
}

function parseMaterial(value: unknown, index: number): CoverageMaterial {
  const label = `materials[${index}]`;
  const row = record(value, ["kind", "identity", "presence", "verification", "entities"], label);
  const entities = list(row.entities, `${label}.entities`).map((item, i) => parseEntity(item, `${label}.entities[${i}]`));
  return Object.freeze({
    kind: enumValue(row.kind, ["specification", "workstream", "task", "question", "source"] as const, `${label}.kind`),
    identity: parseIdentity(row.identity, `${label}.identity`),
    presence: enumValue(row.presence, ["present", "partial", "missing", "not-provided"] as const, `${label}.presence`),
    verification: enumValue(row.verification, ["validated", "unvalidated", "invalid", "unknown"] as const, `${label}.verification`),
    entities: Object.freeze(entities),
  });
}

function canonical(value: JsonValue): string {
  if (value === null) return "n";
  if (typeof value === "boolean") return value ? "b1" : "b0";
  if (typeof value === "number") return `d${String(value).length}:${String(value)}`;
  if (typeof value === "string") return `s${value.length}:${value}`;
  if (Array.isArray(value)) return `a${value.length}:[${value.map(canonical).map(part => `${part.length}:${part}`).join("")}]`;
  const object = value as { readonly [key: string]: JsonValue };
  const keys = Object.keys(object).sort();
  return `o${keys.length}:{${keys.map(key => {
    const part = canonical(object[key]!);
    return `${key.length}:${key}${part.length}:${part}`;
  }).join("")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function manifestContent(manifest: CoverageRulesManifest): JsonValue {
  return {
    identity: manifest.identity,
    scope: {
      requirementIds: [...manifest.scope.requirementIds].sort(),
      acIds: [...manifest.scope.acIds].sort(),
    },
    rulesVersion: manifest.rulesVersion,
    rules: manifest.rules.map(rule => ({
      id: rule.id,
      requiresCheck: rule.requiresCheck,
      requiredEvidenceKinds: [...rule.requiredEvidenceKinds].sort(),
    })).sort((a, b) => a.id.localeCompare(b.id)),
    targets: manifest.targets.map(target => ({ targetId: target.targetId, targetKind: target.targetKind,
      ruleIds: [...target.ruleIds].sort() })).sort((a, b) => `${a.targetKind}\0${a.targetId}`.localeCompare(`${b.targetKind}\0${b.targetId}`)),
  };
}

function parseInput(value: unknown): SpecCoverageInput {
  const row = record(value, ["identity", "scope", "rulesVersion", "manifest", "materials", "sourceRefs", "checks"], "input");
  const materials = list(row.materials, "input.materials").map(parseMaterial);
  const sourceRefs = list(row.sourceRefs, "input.sourceRefs").map(parseSourceRef);
  const checks = list(row.checks, "input.checks", SPEC_COVERAGE_LIMITS.checks).map(parseCheck);
  const result: SpecCoverageInput = Object.freeze({
    identity: parseIdentity(row.identity, "input.identity"),
    scope: parseScope(row.scope, "input.scope"),
    rulesVersion: identifier(row.rulesVersion, "input.rulesVersion"),
    manifest: row.manifest === null ? null : parseRulesManifest(row.manifest),
    materials: Object.freeze(materials),
    sourceRefs: Object.freeze(sourceRefs),
    checks: Object.freeze(checks),
  });
  // Size only the validated, getter-free snapshot; never stringify caller objects.
  const inputBytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  if (inputBytes > SPEC_COVERAGE_LIMITS.serializedInputBytes) fail("input", `exceeds ${SPEC_COVERAGE_LIMITS.serializedInputBytes} serialized bytes.`);
  return result;
}

function sameIdentity(a: CoverageIdentity, b: CoverageIdentity): boolean {
  return a.workspaceId === b.workspaceId && a.projectId === b.projectId
    && a.specRevisionId === b.specRevisionId && a.specDigest === b.specDigest;
}

function sameScope(a: CoverageScope, b: CoverageScope): boolean {
  return canonical([...a.requirementIds].sort()) === canonical([...b.requirementIds].sort())
    && canonical([...a.acIds].sort()) === canonical([...b.acIds].sort());
}

function stableId(kind: string, identity: CoverageIdentity, targetKind: CoverageTargetKind,
  targetIds: readonly string[], refs: readonly string[]): string {
  const sortedTargets = [...targetIds].sort();
  const sortedRefs = [...refs].sort();
  return `D3-${kind.toUpperCase()}-${sha256(canonical({ identity, kind, targetKind, targetIds: sortedTargets, refs: sortedRefs }))}`;
}

function freezeResult<T extends object>(result: T): T {
  return deepFreeze(result);
}

/** Validates and snapshots evaluator input without changing caller-owned values. */
export function parseSpecCoverageInput(value: unknown): SpecCoverageInput {
  return parseInput(value);
}

/** Canonical manifest digest for producers; digest is excluded from its own hash. */
export function coverageRulesManifestDigest(value: unknown): string {
  const manifest = parseRulesManifest(value);
  return sha256(canonical(manifestContent(manifest)));
}

/** Pure structural evaluator. It does not infer source truth from reference strings. */
export function evaluateSpecCoverage(value: unknown): SpecCoverageResult {
  const input = parseInput(value);
  const { identity, scope, manifest } = input;
  const unknowns: { targetId: string | null; targetKind: CoverageTargetKind | null; code: string }[] = [];
  const gaps: CoverageGap[] = [];
  const notChecked: { targetId: string; targetKind: CoverageTargetKind | null; ruleId: string; reason: string }[] = [];
  const targetResults: CoverageTargetResult[] = [];
  const checkResults: { targetId: string; targetKind: CoverageTargetKind | null; ruleId: string;
    status: CoverageCheck["status"]; evidenceRefs: readonly string[]; assessment: string }[] = input.checks.map(check => ({
      targetId: check.targetId, targetKind: check.targetKind ?? null, ruleId: check.ruleId, status: check.status,
      evidenceRefs: check.evidenceRefs, assessment: "unresolved",
    }));
  const scoped = [
    ...scope.requirementIds.map(targetId => ({ targetId, targetKind: "requirement" as const })),
    ...scope.acIds.map(targetId => ({ targetId, targetKind: "ac" as const })),
  ].sort((a, b) => `${a.targetKind}\0${a.targetId}`.localeCompare(`${b.targetKind}\0${b.targetId}`));
  const targetKey = (targetKind: CoverageTargetKind, targetId: string): string => `${targetKind}\0${targetId}`;
  const scopedByKey = new Map(scoped.map(target => [targetKey(target.targetKind, target.targetId), target]));
  const scopedById = new Map<string, typeof scoped>();
  for (const target of scoped) scopedById.set(target.targetId, [...(scopedById.get(target.targetId) ?? []), target]);
  const targetUnknownCodes = new Map<string, Set<string>>();
  const addUnknown = (target: typeof scoped[number] | null, code: string): void => {
    unknowns.push({ targetId: target?.targetId ?? null, targetKind: target?.targetKind ?? null, code });
    if (target) {
      const key = targetKey(target.targetKind, target.targetId);
      const codes = targetUnknownCodes.get(key) ?? new Set<string>();
      codes.add(code);
      targetUnknownCodes.set(key, codes);
    }
  };
  const addNotChecked = (targetId: string, targetKind: CoverageTargetKind | null, ruleId: string, reason: string): void => {
    notChecked.push({ targetId, targetKind, ruleId, reason });
  };
  const addGap = (target: typeof scoped[number], kind: CoverageGap["kind"], refs: readonly string[]): void => {
    const evidenceRefs = [...refs].sort();
    gaps.push(Object.freeze({
      id: stableId("gap", identity, target.targetKind, [target.targetId], [`gap-kind:${kind}`, ...evidenceRefs]),
      kind,
      targetKind: target.targetKind,
      targetIds: Object.freeze([target.targetId]),
      evidenceRefs: Object.freeze(evidenceRefs),
      status: "candidate",
    }));
  };

  const materialsByKind = new Map<MaterialKind, CoverageMaterial[]>();
  for (const material of input.materials) {
    const bucket = materialsByKind.get(material.kind) ?? [];
    bucket.push(material);
    materialsByKind.set(material.kind, bucket);
  }
  const allEntities: { material: CoverageMaterial; entity: CoverageEntity }[] = [];
  for (const material of input.materials) for (const entity of material.entities) allEntities.push({ material, entity });

  const conflictGroups = new Map<string, typeof allEntities>();
  for (const item of allEntities) {
    if (!sameIdentity(item.material.identity, identity) || item.material.presence !== "present"
      || item.material.verification !== "validated") continue;
    const key = `${item.entity.kind}\0${item.entity.id}`;
    const group = conflictGroups.get(key) ?? [];
    group.push(item);
    conflictGroups.set(key, group);
  }
  const conflictTargets = new Map<string, string[]>();
  const conflictGapSpecs: { key: string; targetKind: CoverageTargetKind; targetId: string; refs: string[] }[] = [];
  for (const [key, group] of conflictGroups) {
    const signatures = new Set(group.map(({ entity }) => canonical({ bodyDigest: entity.bodyDigest, relationIds: [...entity.relationIds].sort() })));
    if (signatures.size < 2) continue;
    const [kind, entityId] = key.split("\0") as [string, string];
    const targetKind: CoverageTargetKind | null = kind === "requirement" ? "requirement" : kind === "ac" ? "ac" : null;
    if (!targetKind || !scopedByKey.has(targetKey(targetKind, entityId))) continue;
    const refs = group.map(({ entity }) => canonical({
      bodyDigest: entity.bodyDigest,
      relationIds: [...entity.relationIds].sort(),
    })).sort();
    const scopedKey = targetKey(targetKind, entityId);
    conflictGapSpecs.push({ key, targetKind, targetId: entityId, refs });
    conflictTargets.set(scopedKey, [...(conflictTargets.get(scopedKey) ?? []), key]);
  }

  const manifestDigest = manifest ? sha256(canonical(manifestContent(manifest))) : null;
  const manifestValid = manifest !== null
    && manifest.digest === manifestDigest
    && sameIdentity(manifest.identity, identity)
    && sameScope(manifest.scope, scope)
    && manifest.rulesVersion === input.rulesVersion;
  const rulesById = new Map((manifest?.rules ?? []).map(rule => [rule.id, rule]));
  const manifestTargets = new Map((manifest?.targets ?? []).map(target => [`${target.targetKind}\0${target.targetId}`, target]));
  const appliedChecks = new Map<string, { check: CoverageCheck; index: number }>();
  const seenChecks = new Set<string>();
  for (let index = 0; index < input.checks.length; index += 1) {
    const check = input.checks[index]!;
    const idMatches = scopedById.get(check.targetId) ?? [];
    const checkTargetKind = check.targetKind ?? null;
    const target = checkTargetKind === null
      ? (idMatches.length === 1 ? idMatches[0]! : null)
      : scopedByKey.get(targetKey(checkTargetKind, check.targetId)) ?? null;
    if (!target) {
      if (checkTargetKind === null && idMatches.length > 1) {
        checkResults[index]!.assessment = "ambiguous-target-id";
        for (const match of idMatches) {
          addUnknown(match, "check-target-kind-ambiguous");
          addNotChecked(match.targetId, match.targetKind, check.ruleId, "ambiguous-target-id");
        }
      } else {
        checkResults[index]!.assessment = "target-out-of-scope";
        addNotChecked(check.targetId, checkTargetKind, check.ruleId, "target-out-of-scope");
        if (checkTargetKind !== null && idMatches.some(match => match.targetId === check.targetId)) {
          for (const match of idMatches) addUnknown(match, "check-target-kind-mismatch");
        }
      }
      continue;
    }
    checkResults[index]!.targetKind = target.targetKind;
    const pair = `${targetKey(target.targetKind, target.targetId)}\0${check.ruleId}`;
    if (seenChecks.has(pair)) fail("input.checks", "contains duplicate target/rule pairs in the same target-kind namespace.");
    seenChecks.add(pair);
    const manifestTarget = manifestTargets.get(targetKey(target.targetKind, target.targetId));
    if (!manifestValid) {
      checkResults[index]!.assessment = "manifest-unverified";
      addUnknown(target, "check-not-assessable-manifest-unverified");
      addNotChecked(target.targetId, target.targetKind, check.ruleId, "manifest-unverified");
    } else if (!manifestTarget?.ruleIds.includes(check.ruleId)) {
      checkResults[index]!.assessment = "rule-not-applicable";
      addUnknown(target, "check-rule-not-applicable");
      addNotChecked(target.targetId, target.targetKind, check.ruleId, "rule-not-applicable");
    } else {
      checkResults[index]!.assessment = "applicable";
      appliedChecks.set(`${pair}`, { check, index });
    }
  }

  for (const target of scoped) {
    const reasons: string[] = [...(targetUnknownCodes.get(targetKey(target.targetKind, target.targetId)) ?? [])];
    const evidence: CoverageEvidence[] = [];
    const targetUnknowns = new Set(targetUnknownCodes.get(targetKey(target.targetKind, target.targetId)) ?? []);
    let targetNotChecked = false;
    const addTargetUnknown = (code: string): void => { reasons.push(code); targetUnknowns.add(code); addUnknown(target, code); };
    const manifestTarget = manifestTargets.get(`${target.targetKind}\0${target.targetId}`);
    const declaredInManifest = manifestTarget !== undefined;
    const applicableRuleIds = manifestValid ? manifestTarget?.ruleIds ?? [] : [];
    if (!manifestValid) {
      const code = manifest === null ? "manifest-not-provided" : "manifest-pin-or-digest-mismatch";
      addTargetUnknown(code);
    } else if (!declaredInManifest || applicableRuleIds.length === 0) {
      addTargetUnknown("target-rule-set-missing");
    }

    const relevantMaterials = input.materials.filter(material => material.kind === "specification" || material.kind === "source");
    const relevantInvalid = relevantMaterials.some(material => material.verification === "invalid");
    const relevantUnverified = relevantMaterials.some(material =>
      (material.presence === "present" || material.presence === "partial" || material.presence === "missing")
      && material.verification !== "validated");
    const relevantIdentityMismatch = relevantMaterials.some(material => !sameIdentity(material.identity, identity));
    if (relevantInvalid || relevantUnverified || relevantIdentityMismatch) {
      const code = relevantIdentityMismatch ? "source-material-identity-mismatch"
        : relevantInvalid ? "source-material-invalid" : "source-material-unverified";
      addTargetUnknown(code);
    }

    const verifiedSpecification = materialsByKind.get("specification")?.some(material => sameIdentity(material.identity, identity)
      && material.presence === "present" && material.verification === "validated") ?? false;
    const validatedSpecificationEntities = allEntities.filter(({ material }) => sameIdentity(material.identity, identity)
      && material.kind === "specification" && material.presence === "present" && material.verification === "validated");
    if (!verifiedSpecification) {
      const explicitAbsence = materialsByKind.get("specification")?.some(material => sameIdentity(material.identity, identity)
        && material.presence === "missing" && material.verification === "validated") ?? false;
      if (explicitAbsence) addGap(target, "missing-structure", ["validated-specification-absent", target.targetKind]);
      else addTargetUnknown("specification-material-unavailable");
    } else {
      const entityExists = validatedSpecificationEntities.some(({ entity }) => entity.kind === target.targetKind && entity.id === target.targetId);
      if (!entityExists && target.targetKind === "requirement") {
        addGap(target, "missing-structure", ["requirement-entity-absent"]);
        reasons.push("scoped-target-missing-from-validated-specification");
      } else if (!entityExists && target.targetKind === "ac") {
        const relationDeclared = validatedSpecificationEntities.some(({ entity }) => entity.kind === "requirement"
          && entity.relationIds.includes(target.targetId));
        if (relationDeclared) addTargetUnknown("ac-body-not-provided");
        else {
          addGap(target, "missing-structure", ["ac-relation-absent-from-validated-specification"]);
          reasons.push("scoped-ac-not-declared-in-validated-specification");
        }
      }
    }

    const scopedKey = targetKey(target.targetKind, target.targetId);
    const targetRecordConflict = conflictTargets.has(scopedKey);
    if (targetRecordConflict) {
      reasons.push("same-id-body-or-relation-conflict");
      const refs = conflictGapSpecs.filter(item => item.targetKind === target.targetKind && item.targetId === target.targetId)
        .flatMap(item => item.refs).sort();
      addGap(target, "identity-conflict", refs);
    }

    const relatedRequirementIds = new Set(target.targetKind === "ac"
      ? validatedSpecificationEntities.filter(({ entity }) => entity.kind === "requirement"
        && entity.relationIds.includes(target.targetId)).map(({ entity }) => entity.id)
      : []);
    const unrelatedAcRefs = target.targetKind === "ac" ? input.sourceRefs.filter(ref => ref.acId === target.targetId
      && scope.requirementIds.includes(ref.requirementId) && !relatedRequirementIds.has(ref.requirementId)) : [];
    if (unrelatedAcRefs.length > 0) addTargetUnknown("ac-source-ref-requirement-relation-mismatch");
    const matchingRefs = input.sourceRefs.filter(ref => ref.acId === (target.targetKind === "ac" ? target.targetId : null)
      && (target.targetKind === "requirement" ? ref.requirementId === target.targetId : relatedRequirementIds.has(ref.requirementId)));
    const validatedRefs: CoverageSourceRef[] = [];
    for (const ref of matchingRefs) {
      if (!scope.requirementIds.includes(ref.requirementId)
        || (target.targetKind === "ac" && !scope.acIds.includes(ref.acId ?? ""))
        || ref.revisionId !== identity.specRevisionId) continue;
      const sourcePresent = allEntities.some(({ material, entity }) => sameIdentity(material.identity, identity) && material.kind === "source"
        && material.presence === "present" && material.verification === "validated"
        && entity.kind === "source" && entity.id === ref.sourceId && entity.bodyDigest === ref.sourceDigest);
      if (sourcePresent) validatedRefs.push(ref);
    }

    const requiredKinds = new Set<MaterialKind>();
    if (manifestValid && manifestTarget) for (const ruleId of manifestTarget.ruleIds) {
      const rule = rulesById.get(ruleId);
      if (!rule) {
        addTargetUnknown("manifest-rule-missing");
        continue;
      }
      for (const kind of rule.requiredEvidenceKinds) requiredKinds.add(kind);
      const checkEntry = appliedChecks.get(`${scopedKey}\0${ruleId}`);
      if (rule.requiresCheck) {
        if (!checkEntry) addTargetUnknown(`check-missing:${ruleId}`);
      }
      if (!checkEntry) continue;
      const { check, index } = checkEntry;
      if (check.status === "not-run") {
        targetNotChecked = true;
        reasons.push(`check-not-run:${ruleId}`);
        addNotChecked(target.targetId, target.targetKind, ruleId, "check-not-run");
        checkResults[index]!.assessment = "not-run";
        continue;
      }
      const matchesMaterial = (kind: MaterialKind, evidenceRef: string): boolean => {
        if (kind === "source") return validatedRefs.some(ref => ref.sourceId === evidenceRef);
        return input.materials.some(material => material.kind === kind && sameIdentity(material.identity, identity)
          && material.presence === "present" && material.verification === "validated"
          && material.entities.some(entity => entity.id === evidenceRef
            || (kind === "specification" && target.targetKind === "ac" && entity.kind === "requirement"
              && entity.relationIds.includes(evidenceRef))));
      };
      const expectedKinds = rule.requiredEvidenceKinds.length > 0 ? rule.requiredEvidenceKinds : ["specification", "workstream", "task", "question", "source"] as const;
      const missingKinds = rule.requiredEvidenceKinds.filter(kind => !check.evidenceRefs.some(ref => matchesMaterial(kind, ref)));
      const unvalidatedRefs = check.evidenceRefs.filter(ref => !expectedKinds.some(kind => matchesMaterial(kind, ref)));
      if (missingKinds.length > 0 || unvalidatedRefs.length > 0) {
        checkResults[index]!.assessment = "evidence-unverified";
        addTargetUnknown(`check-evidence-unverified:${ruleId}`);
        for (const ref of unvalidatedRefs) reasons.push(`check-evidence-reference-unverified:${ruleId}:${ref}`);
        for (const kind of missingKinds) reasons.push(`check-evidence-kind-missing:${ruleId}:${kind}`);
      } else if (check.status === "failed") {
        checkResults[index]!.assessment = "failed-verified";
        reasons.push(`check-failed:${ruleId}`);
        addGap(target, "failed-check", [ruleId, ...check.evidenceRefs]);
      } else {
        checkResults[index]!.assessment = "passed-verified";
        for (const evidenceRef of check.evidenceRefs) {
          const sourceMatches = validatedRefs.filter(ref => ref.sourceId === evidenceRef);
          for (const ref of sourceMatches) evidence.push(Object.freeze({ sourceId: ref.sourceId, sourceDigest: ref.sourceDigest,
            revisionId: ref.revisionId, materialKind: "source" }));
        }
      }
    }

    for (const kind of requiredKinds) {
      if (kind === "source") {
        if (validatedRefs.length === 0) {
          const inventory = materialsByKind.get("source") ?? [];
          const explicitlyMissing = inventory.some(item => item.presence === "missing" && item.verification === "validated"
            && sameIdentity(item.identity, identity));
          if (explicitlyMissing) {
            reasons.push("required-source-reference-missing");
            addGap(target, "missing-structure", ["source-ref-missing"]);
          } else {
            addTargetUnknown("source-inventory-unverified-or-missing");
          }
        } else {
          for (const ref of validatedRefs) evidence.push(Object.freeze({ sourceId: ref.sourceId, sourceDigest: ref.sourceDigest,
            revisionId: ref.revisionId, materialKind: "source" }));
        }
      } else {
        const inventory = materialsByKind.get(kind) ?? [];
        const available = inventory.some(item => sameIdentity(item.identity, identity)
          && item.presence === "present" && item.verification === "validated");
        if (!available) {
          addTargetUnknown(`required-material-unavailable:${kind}`);
        }
      }
    }

    const distinctEvidence = new Map(evidence.map(item => [`${item.sourceId}\0${item.sourceDigest}\0${item.revisionId}`, item]));
    const confirmedGap = gaps.some(gap => gap.targetKind === target.targetKind && gap.targetIds.includes(target.targetId));
    const targetUnknown = targetUnknowns.size > 0;
    // Preserve all candidate/unknown/not-checked collections; target status priority is GAP > UNKNOWN > NOT_CHECKED > COVERED.
    const status: CoverageStatus = confirmedGap ? "GAP" : targetUnknown ? "UNKNOWN" : targetNotChecked ? "NOT_CHECKED" : "COVERED";
    targetResults.push(Object.freeze({ targetId: target.targetId, targetKind: target.targetKind, status,
      ruleIds: Object.freeze([...applicableRuleIds]), evidence: Object.freeze([...distinctEvidence.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId))),
      reasons: Object.freeze([...new Set(reasons)].sort()) }));
  }
  const gapsById = new Map(gaps.map(gap => [gap.id, gap]));
  const stableGaps = [...gapsById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const taskCandidates = stableGaps.map(gap => Object.freeze({
    id: stableId("task", identity, gap.targetKind, gap.targetIds, [gap.id]),
    targetKind: gap.targetKind,
    targetIds: gap.targetIds,
    reasonRefs: Object.freeze([gap.id]),
    status: "candidate" as const,
  }));

  return freezeResult({
    inputIdentity: identity,
    scope,
    rulesVersion: input.rulesVersion,
    manifestDigest,
    limits: SPEC_COVERAGE_LIMITS,
    targets: Object.freeze(targetResults),
    gaps: Object.freeze(stableGaps),
    taskCandidates: Object.freeze(taskCandidates),
    materialStates: Object.freeze(input.materials.map(material => Object.freeze({ kind: material.kind, identity: material.identity,
      presence: material.presence, verification: material.verification }))
      .sort((a, b) => `${a.kind}\0${a.identity.workspaceId}\0${a.identity.projectId}\0${a.identity.specRevisionId}\0${a.identity.specDigest}\0${a.presence}\0${a.verification}`
        .localeCompare(`${b.kind}\0${b.identity.workspaceId}\0${b.identity.projectId}\0${b.identity.specRevisionId}\0${b.identity.specDigest}\0${b.presence}\0${b.verification}`))),
    sourceRefs: Object.freeze([...input.sourceRefs].sort((a, b) => canonical(a).localeCompare(canonical(b)))),
    checks: Object.freeze([...input.checks].sort((a, b) => `${a.targetKind ?? ""}\0${a.targetId}\0${a.ruleId}\0${a.status}\0${canonical([...a.evidenceRefs].sort())}`
      .localeCompare(`${b.targetKind ?? ""}\0${b.targetId}\0${b.ruleId}\0${b.status}\0${canonical([...b.evidenceRefs].sort())}`))),
    checkResults: Object.freeze(checkResults.sort((a, b) => `${a.targetKind ?? ""}\0${a.targetId}\0${a.ruleId}\0${a.assessment}`
      .localeCompare(`${b.targetKind ?? ""}\0${b.targetId}\0${b.ruleId}\0${b.assessment}`))),
    notChecked: Object.freeze(notChecked.sort((a, b) => `${a.targetKind ?? ""}\0${a.targetId}\0${a.ruleId}\0${a.reason}`
      .localeCompare(`${b.targetKind ?? ""}\0${b.targetId}\0${b.ruleId}\0${b.reason}`))),
    unknowns: Object.freeze(unknowns.sort((a, b) => `${a.targetKind ?? ""}\0${a.targetId ?? ""}\0${a.code}`
      .localeCompare(`${b.targetKind ?? ""}\0${b.targetId ?? ""}\0${b.code}`))),
  });
}
