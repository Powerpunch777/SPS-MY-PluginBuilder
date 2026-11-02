import {
  CREATE_CTO_TOOL,
  LIST_CTOS_TOOL,
  PROPOSE_DESIGN_TOOL,
  PUBLISH_DESIGN_BASELINE_TOOL,
  PUBLISH_TECHNOLOGY_DECISIONS_TOOL,
  READ_DESIGN_BASELINE_TOOL,
  READ_DESIGN_DRAFT_TOOL,
  READ_DESIGN_SOURCES_TOOL,
  READ_LEAD_MEMORY_TOOL,
  READ_SOLUTION_TOOL,
  READ_TECHNOLOGY_DECISIONS_TOOL,
  RESOLVE_DESIGN_QUESTION_TOOL,
  UPDATE_LEAD_MEMORY_TOOL,
} from "./tool-declarations.mjs";
import { ACKNOWLEDGE_WORKSTREAM_TOOL, PUBLISH_WORKSTREAM_TOOL, READ_CTO_WORKSTREAM_TOOL, READ_WORKSTREAMS_TOOL } from "./workstream-tool-declarations.mjs";
import { DISPATCH_CTO_WORKSTREAM_TOOL, READ_CTO_WORKSTREAM_DELIVERY_TOOL, CANCEL_CTO_WORKSTREAM_DELIVERY_TOOL } from "./delivery-tool-declarations.mjs";
import { READ_CTO_MEMORY_TOOL, UPDATE_CTO_MEMORY_TOOL } from "./cto-memory-tool-declarations.mjs";
import { SUBMIT_CTO_QUESTION_TOOL, READ_OWN_CTO_QUESTION_TOOL, READ_CTO_QUESTIONS_TOOL, REVIEW_CTO_QUESTION_TOOL } from "./cto-question-tool-declarations.mjs";
import { READ_CTO_TASK_PACKETS_TOOL, PUBLISH_CTO_TASK_PACKET_TOOL } from "./task-packet-tool-declarations.mjs";

export const LEAD_PLANNING_TOOL_NAMES = Object.freeze([
  READ_SOLUTION_TOOL.name,
  PROPOSE_DESIGN_TOOL.name,
  READ_DESIGN_DRAFT_TOOL.name,
  READ_DESIGN_SOURCES_TOOL.name,
  READ_LEAD_MEMORY_TOOL.name,
  UPDATE_LEAD_MEMORY_TOOL.name,
  RESOLVE_DESIGN_QUESTION_TOOL.name,
  CREATE_CTO_TOOL.name,
  LIST_CTOS_TOOL.name,
  PUBLISH_DESIGN_BASELINE_TOOL.name,
  READ_DESIGN_BASELINE_TOOL.name,
  PUBLISH_TECHNOLOGY_DECISIONS_TOOL.name,
  READ_TECHNOLOGY_DECISIONS_TOOL.name,
  PUBLISH_WORKSTREAM_TOOL.name,
  READ_WORKSTREAMS_TOOL.name,
  DISPATCH_CTO_WORKSTREAM_TOOL.name,
  READ_CTO_WORKSTREAM_DELIVERY_TOOL.name,
  CANCEL_CTO_WORKSTREAM_DELIVERY_TOOL.name,
  READ_CTO_QUESTIONS_TOOL.name,
  REVIEW_CTO_QUESTION_TOOL.name,
].sort());

export const CTO_WORKSTREAM_TOOL_NAMES = Object.freeze([
  READ_CTO_WORKSTREAM_TOOL.name,
  ACKNOWLEDGE_WORKSTREAM_TOOL.name,
  READ_CTO_MEMORY_TOOL.name,
  UPDATE_CTO_MEMORY_TOOL.name,
  SUBMIT_CTO_QUESTION_TOOL.name,
  READ_OWN_CTO_QUESTION_TOOL.name,
  READ_CTO_TASK_PACKETS_TOOL.name,
  PUBLISH_CTO_TASK_PACKET_TOOL.name,
].sort());

export type SessionExecutionPolicy = Readonly<{
  mode: "plugin-tools-only-v1";
  toolNames: readonly string[];
}>;

export const LEAD_SESSION_EXECUTION_POLICY: SessionExecutionPolicy = Object.freeze({
  mode: "plugin-tools-only-v1",
  toolNames: LEAD_PLANNING_TOOL_NAMES,
});

export const CTO_SESSION_EXECUTION_POLICY: SessionExecutionPolicy = Object.freeze({
  mode: "plugin-tools-only-v1",
  toolNames: CTO_WORKSTREAM_TOOL_NAMES,
});

type SessionPolicyPlatform = {
  readonly agents?: {
    readonly sessions?: {
      readonly describePolicySupport?: (sessionId: string, workspaceId: string) => Promise<unknown>;
    };
  };
};

function ownDataRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("Session execution policy support is malformed.");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) {
    throw new TypeError("Session execution policy support has unexpected fields.");
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("Session execution policy support contains an accessor or hidden field.");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function ownDataProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("Session execution policy discovery is unavailable.");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) {
    throw new TypeError("Session execution policy discovery is unavailable.");
  }
  return descriptor.value;
}

function snapshotModes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError("Session execution policy modes are malformed.");
  }
  if (value.length > 1) throw new TypeError("Session execution policy advertises too many modes.");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    throw new TypeError("Session execution policy modes must be dense and exact.");
  }
  const modes: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")
      || descriptor.value !== "plugin-tools-only-v1") {
      throw new TypeError("Session execution policy advertises an unsupported mode.");
    }
    modes.push(descriptor.value);
  }
  if (new Set(modes).size !== modes.length) throw new TypeError("Session execution policy modes must be unique.");
  return Object.freeze(modes);
}

export async function assertSessionExecutionPolicySupport(
  platform: SessionPolicyPlatform,
  sessionId: string,
  workspaceId: string,
): Promise<Readonly<{ schemaVersion: 1; modes: readonly "plugin-tools-only-v1"[];
  enforcement: "dispatch-and-run"; readiness: "unknown"; osIsolation: "not-certified" }>> {
  const agents = ownDataProperty(platform, "agents");
  const sessions = ownDataProperty(agents, "sessions");
  const methodDescriptor = Object.getOwnPropertyDescriptor(sessions, "describePolicySupport");
  if (!methodDescriptor || !Object.hasOwn(methodDescriptor, "value") || typeof methodDescriptor.value !== "function") {
    throw new TypeError("Host does not support session execution policy discovery.");
  }

  const raw = await methodDescriptor.value.call(sessions, sessionId, workspaceId);
  const support = ownDataRecord(raw, ["schemaVersion", "modes", "enforcement", "readiness", "osIsolation"]);
  const modes = snapshotModes(support.modes);
  if (support.schemaVersion !== 1 || support.enforcement !== "dispatch-and-run"
    || support.readiness !== "unknown" || support.osIsolation !== "not-certified" || modes.length === 0) {
    throw new Error("Host does not support restricted session execution; unrestricted fallback is forbidden.");
  }
  return Object.freeze({ schemaVersion: 1, modes: modes as readonly "plugin-tools-only-v1"[],
    enforcement: "dispatch-and-run", readiness: "unknown", osIsolation: "not-certified" });
}
