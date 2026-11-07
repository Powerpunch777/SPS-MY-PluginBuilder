export const MAIN_G7_REVIEW_AREAS = ["approved-design", "deliverables", "installation", "usage", "validation-and-limits"] as const;
export type MainG7Review = Readonly<{
  packetSha256: string;
  currentPinsSha256: string;
  checks: readonly Readonly<{ area: (typeof MAIN_G7_REVIEW_AREAS)[number]; verdict: "PASS"; summary: string; evidenceSourceIds: readonly string[] }>[];
}>;
type Pin = Readonly<{ sourceId: string }>;
type ReviewPacket = Readonly<{ packetSha256: string; baseline: Pin; uiRevision: Pin; manifest: Pin;
  integration: Readonly<{ build: Pin; ciEvidence: readonly Pin[]; e2eEvidence: readonly Pin[]; regressionEvidence?: readonly Pin[] }>;
  documents: readonly Readonly<{ kind: string; pin: Pin }>[]; qaEvidence: readonly Pin[]; g6Evidence: readonly Pin[]; g7Evidence: readonly Pin[] }>;

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Invalid Main G7 review record.");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) throw new TypeError("Invalid Main G7 review fields.");
  return Object.fromEntries(fields.map(key => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw new TypeError("Invalid Main G7 review field.");
    return [key, field.value];
  }));
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\p{Cc}\p{Cf}\ufffd]/u.test(value)) throw new TypeError("Invalid Main G7 review text.");
  return value;
}
function list<T>(value: unknown, parse: (item: unknown) => T, min: number, max: number): readonly T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max
    || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError("Invalid Main G7 review list.");
  return Object.freeze(Array.from({ length: value.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw new TypeError("Invalid Main G7 review list value.");
    return parse(field.value);
  }));
}

/** Main's authored assessment is separate from server-verified preparation and QA. */
export function parseMainG7Review(value: unknown, packet: ReviewPacket, currentPinsSha256: string): MainG7Review {
  const row = record(value, ["packetSha256", "currentPinsSha256", "checks"]);
  if (row.packetSha256 !== packet.packetSha256 || row.currentPinsSha256 !== currentPinsSha256
    || !/^[a-f0-9]{64}$/u.test(currentPinsSha256)) throw new TypeError("Main G7 review does not bind the current packet and evidence.");
  const required: Record<(typeof MAIN_G7_REVIEW_AREAS)[number], readonly Pin[]> = {
    "approved-design": [packet.baseline, packet.uiRevision],
    deliverables: [packet.manifest, packet.integration.build],
    installation: packet.documents.filter(item => item.kind === "installation-guide").map(item => item.pin),
    usage: packet.documents.filter(item => item.kind === "user-guide").map(item => item.pin),
    "validation-and-limits": [...packet.qaEvidence, ...packet.g6Evidence, ...packet.g7Evidence,
      ...packet.integration.ciEvidence, ...packet.integration.e2eEvidence, ...(packet.integration.regressionEvidence ?? [])],
  };
  const checks = list(row.checks, value => {
    const check = record(value, ["area", "verdict", "summary", "evidenceSourceIds"]);
    if (check.verdict !== "PASS") throw new TypeError("Every Main G7 review area must explicitly pass before attestation.");
    if (typeof check.area !== "string" || !(MAIN_G7_REVIEW_AREAS as readonly string[]).includes(check.area)) throw new TypeError("Invalid Main G7 review area.");
    const area = check.area as (typeof MAIN_G7_REVIEW_AREAS)[number];
    const sourceIds = list(check.evidenceSourceIds, value => text(value, 1100), 1, 256);
    const expected = new Set(required[area].map(pin => pin.sourceId));
    if (!expected.size || new Set(sourceIds).size !== sourceIds.length || sourceIds.length !== expected.size
      || sourceIds.some(sourceId => !expected.has(sourceId))) throw new TypeError("Main G7 review evidence does not cover its exact area.");
    return Object.freeze({ area, verdict: "PASS" as const, summary: text(check.summary, 2048), evidenceSourceIds: sourceIds });
  }, MAIN_G7_REVIEW_AREAS.length, MAIN_G7_REVIEW_AREAS.length);
  if (new Set(checks.map(check => check.area)).size !== MAIN_G7_REVIEW_AREAS.length) throw new TypeError("Main G7 review areas are incomplete.");
  return Object.freeze({ packetSha256: packet.packetSha256, currentPinsSha256, checks });
}
