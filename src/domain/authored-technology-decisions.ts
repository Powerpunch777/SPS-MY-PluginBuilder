import { parseTechnologyDecisionRegister, type TechnologyDecisionRegister } from "./technology-decisions.ts";

export type AuthoredTechnologyDecisions = Readonly<{
  register: TechnologyDecisionRegister;
  author: Readonly<{ agentId: string; sessionId: string; runId: string; selectionRevision: number }>;
  createdAt: string;
  baselineDigest: string;
}>;

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Invalid authored technology record.");
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError("Invalid authored technology fields.");
  }
  const row: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Technology fields must be data.");
    row[key] = descriptor.value;
  }
  return row;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError("A canonical author UUID is required.");
  return value;
}

/** Structural validation of model-authored research; not an independent research or approval attestation. */
export function parseAuthoredTechnologyDecisions(value: unknown, projectId: string): AuthoredTechnologyDecisions {
  const row = record(value, ["register", "author", "createdAt", "baselineDigest"]);
  const who = record(row.author, ["agentId", "sessionId", "runId", "selectionRevision"]);
  if (typeof who.selectionRevision !== "number" || !Number.isSafeInteger(who.selectionRevision) || who.selectionRevision < 1) {
    throw new TypeError("A positive Lead selection revision is required.");
  }
  if (typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt))
    || new Date(row.createdAt).toISOString() !== row.createdAt) throw new TypeError("A canonical creation timestamp is required.");
  if (typeof row.baselineDigest !== "string" || !/^[a-f0-9]{64}$/.test(row.baselineDigest)) throw new TypeError("A baseline digest is required.");
  return Object.freeze({ register: parseTechnologyDecisionRegister(row.register, projectId),
    author: Object.freeze({ agentId: uuid(who.agentId), sessionId: uuid(who.sessionId), runId: uuid(who.runId), selectionRevision: who.selectionRevision }),
    createdAt: row.createdAt, baselineDigest: row.baselineDigest });
}
