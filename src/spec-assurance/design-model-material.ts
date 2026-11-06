import { createHash } from "node:crypto";
import { exactToolRecord } from "../lead-tool-authority.ts";
import { coverageRulesManifestDigest, parseSpecCoverageInput, type CoverageIdentity,
  type CoverageRulesManifest } from "../spec-coverage/evaluator.ts";
import { composeDomainPacks, SPEC_ASSURANCE_LIMITS, type AssuranceScenario, type DomainPack,
  type ItemDecisionStatus } from "./evaluator.ts";

type Requirement = Readonly<{ id: string; acceptanceCriteriaIds: readonly string[] }>;
type SourcePin = Readonly<{ requirementId: string; acId: string | null; sourceId: string; sourceDigest: string }>;
export type DesignModelItemDecision = Readonly<{ requirementId: string;
  status: Exclude<ItemDecisionStatus, "VERIFIED">; reason: string; sourceIds: readonly string[] }>;
export type DesignModelMaterial = Readonly<{
  kind: "design-model-v1";
  facts: readonly string[];
  rulesManifest: CoverageRulesManifest;
  scenarios: readonly AssuranceScenario[];
  itemDecisions: readonly DesignModelItemDecision[];
  acceptanceCriteria: readonly Readonly<{ requirementId: string; acId: string; sourceId: string;
    sourceDigest: string; text: string; textSha256: string }>[];
}>;
const id = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a bounded identifier.`);
  }
  return value;
};
function list(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError(`${label} must be a bounded dense array.`);
  return Array.from({ length: value.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !("value" in field)) throw new TypeError(`${label} must contain plain data.`);
    return field.value;
  });
}
const unique = (values: readonly string[], label: string) => {
  if (new Set(values).size !== values.length) throw new TypeError(`${label} contains duplicate identifiers.`);
};

/** Static design-model inputs, not runtime observations or an approval. Identity always comes from the exact reviewed specification. */
export function parseDesignModelMaterial(value: unknown, identity: CoverageIdentity, requirements: readonly Requirement[],
  pack: DomainPack, sourcePins: readonly SourcePin[], stored = false, sourceBodies?: ReadonlyMap<string, string>): DesignModelMaterial {
  const row = exactToolRecord(value, stored ? ["kind", "facts", "rulesManifest", "scenarios", "itemDecisions", "acceptanceCriteria"]
    : ["facts", "rulesVersion", "coverageRules", "coverageTargets", "scenarios", "itemDecisions", "acceptanceCriteria"]);
  if (stored && row.kind !== "design-model-v1") throw new TypeError("Unsupported design-model material kind.");
  const facts = list(row.facts, SPEC_ASSURANCE_LIMITS.rules, "Design facts").map(value => id(value, "Design fact"));
  unique(facts, "Design facts");
  composeDomainPacks([pack], identity, facts);
  const scope = { requirementIds: requirements.map(item => item.id).sort(),
    acIds: [...new Set(requirements.flatMap(item => item.acceptanceCriteriaIds))].sort() };
  const manifest = stored ? row.rulesManifest : { identity, scope, rulesVersion: id(row.rulesVersion, "Rules version"),
    rules: row.coverageRules, targets: row.coverageTargets, digest: "0".repeat(64) };
  const rawManifest = manifest as CoverageRulesManifest;
  const derived = stored ? rawManifest : { ...rawManifest, digest: coverageRulesManifestDigest(rawManifest) };
  const parsed = parseSpecCoverageInput({ identity, scope, rulesVersion: derived.rulesVersion,
    manifest: derived, materials: [], sourceRefs: [], checks: [] }).manifest;
  if (!parsed || JSON.stringify(parsed.identity) !== JSON.stringify(identity)
    || JSON.stringify(parsed.scope) !== JSON.stringify(scope) || parsed.digest !== coverageRulesManifestDigest(parsed)) {
    throw new TypeError("Design-model coverage manifest must bind the exact reviewed specification and complete scope.");
  }
  const rules = new Map(pack.rules.map(rule => [rule.id, rule]));
  if (parsed.rules.length !== rules.size || parsed.rules.some(rule => !rules.has(rule.id)
    || rules.get(rule.id)!.requiresCheck !== rule.requiresCheck)) {
    throw new TypeError("Design-model coverage rules must match the exact Domain Pack rule IDs and check requirements.");
  }
  for (const target of parsed.targets) {
    const requirementIds = target.targetKind === "requirement" ? requirements.filter(item => item.id === target.targetId).map(item => item.id)
      : requirements.filter(item => item.acceptanceCriteriaIds.includes(target.targetId)).map(item => item.id);
    if (!requirementIds.length || target.ruleIds.some(ruleId => !requirementIds.some(requirementId =>
      rules.get(ruleId)?.requirementIds.includes(requirementId)))) {
      throw new TypeError("Coverage targets must use exact in-scope requirement/AC and Domain Pack rule relationships.");
    }
  }
  const scenarios = list(row.scenarios, SPEC_ASSURANCE_LIMITS.scenarios, "Design scenarios").map(value => {
    const item = exactToolRecord(value, ["id", "state", "event", "nextState", "exceptionId"]);
    return Object.freeze({ id: id(item.id, "Scenario ID"), state: id(item.state, "Scenario state"),
      event: id(item.event, "Scenario event"), nextState: id(item.nextState, "Scenario next state"),
      exceptionId: item.exceptionId === null ? null : id(item.exceptionId, "Scenario exception") });
  });
  unique(scenarios.map(item => item.id), "Design scenarios");
  const statuses = new Set(["RESOLVED", "DELEGATED", "UNDECIDED", "NOT_APPLICABLE", "NOT_CHECKED", "INCONCLUSIVE"]);
  const itemDecisions = list(row.itemDecisions, SPEC_ASSURANCE_LIMITS.rules, "Design item decisions").map(value => {
    const item = exactToolRecord(value, ["requirementId", "status", "reason", "sourceIds"]);
    const requirementId = id(item.requirementId, "Decision requirement");
    if (!requirements.some(requirement => requirement.id === requirementId) || typeof item.status !== "string" || !statuses.has(item.status)
      || typeof item.reason !== "string" || !item.reason.trim() || Buffer.byteLength(item.reason, "utf8") > 4096
      || /[\u0000-\u001f\u007f]/u.test(item.reason)) throw new TypeError("Design item decision is outside its exact specification or status contract.");
    const sourceIds = list(item.sourceIds, 1000, "Decision source IDs").map(value => id(value, "Decision source"));
    unique(sourceIds, "Decision source IDs");
    if ((item.status === "RESOLVED" || item.status === "DELEGATED" || item.status === "NOT_APPLICABLE") && sourceIds.length === 0
      || sourceIds.some(sourceId => !sourcePins.some(pin => pin.requirementId === requirementId && pin.sourceId === sourceId))) {
      throw new TypeError("Resolved/delegated/excluded design items require their exact reviewed original-source relationships.");
    }
    return Object.freeze({ requirementId, status: item.status as DesignModelItemDecision["status"], reason: item.reason,
      sourceIds: Object.freeze(sourceIds) });
  });
  unique(itemDecisions.map(item => item.requirementId), "Design item decisions");
  if (requirements.some(requirement => !itemDecisions.some(item => item.requirementId === requirement.id))) {
    throw new TypeError("Every reviewed requirement needs an explicit item decision; absence is not resolution.");
  }
  const acceptanceCriteria = list(row.acceptanceCriteria, 10000, "Exact AC bodies").map(value => {
    const item = exactToolRecord(value, stored ? ["requirementId", "acId", "sourceId", "sourceDigest", "text", "textSha256"]
      : ["requirementId", "acId", "sourceId", "quote"]);
    const requirementId = id(item.requirementId, "AC requirement"), acId = id(item.acId, "AC ID"), sourceId = id(item.sourceId, "AC source");
    const pin = sourcePins.find(pin => pin.requirementId === requirementId && pin.acId === acId && pin.sourceId === sourceId);
    const text = stored ? item.text : item.quote;
    if (!requirements.some(requirement => requirement.id === requirementId && requirement.acceptanceCriteriaIds.includes(acId))
      || !pin || typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > 8192) {
      throw new TypeError("AC bodies must name an exact reviewed AC-to-original-source relationship and bounded original text.");
    }
    const textSha256 = createHash("sha256").update(text, "utf8").digest("hex");
    if (stored ? item.sourceDigest !== pin.sourceDigest || item.textSha256 !== textSha256
      : !sourceBodies?.get(sourceId)?.includes(text)) throw new TypeError("AC body is not the exact pinned original-source quote.");
    return Object.freeze({ requirementId, acId, sourceId, sourceDigest: pin.sourceDigest, text, textSha256 });
  });
  unique(acceptanceCriteria.map(item => `${item.requirementId}\0${item.acId}\0${item.sourceId}`), "AC body references");
  for (const acId of new Set(acceptanceCriteria.map(item => item.acId))) {
    if (new Set(acceptanceCriteria.filter(item => item.acId === acId).map(item => item.textSha256)).size > 1) {
      throw new TypeError("The same AC ID has conflicting reviewed body text.");
    }
  }
  const material = Object.freeze({ kind: "design-model-v1" as const, facts: Object.freeze(facts), rulesManifest: parsed,
    scenarios: Object.freeze(scenarios), itemDecisions: Object.freeze(itemDecisions), acceptanceCriteria: Object.freeze(acceptanceCriteria) });
  if (Buffer.byteLength(JSON.stringify(material), "utf8") > 192 * 1024) throw new TypeError("Design-model material exceeds its bounded size.");
  return material;
}

/** Rebind identity only; never remap requirement, AC, rule, scenario, or source IDs by position. */
export function rebindDesignModelMaterial(material: DesignModelMaterial, identity: CoverageIdentity): DesignModelMaterial {
  const manifest = { ...material.rulesManifest, identity, digest: "0".repeat(64) };
  return Object.freeze({ ...material, rulesManifest: Object.freeze({ ...manifest, digest: coverageRulesManifestDigest(manifest) }) });
}

export function designModelMaterialDigest(material: DesignModelMaterial) {
  return createHash("sha256").update(JSON.stringify(material), "utf8").digest("hex");
}
