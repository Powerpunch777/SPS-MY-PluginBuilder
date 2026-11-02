import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSessionExecutionPolicySupport,
  CTO_SESSION_EXECUTION_POLICY,
  CTO_WORKSTREAM_TOOL_NAMES,
  LEAD_PLANNING_TOOL_NAMES,
  LEAD_SESSION_EXECUTION_POLICY,
} from "../src/session-execution-policy.ts";

const { default: manifest } = await import(new URL("../src/manifest.mjs", import.meta.url).href);
const manifestTools = (manifest as { tools: Array<{ name: string }> }).tools;
const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const supported = {
  schemaVersion: 1,
  modes: ["plugin-tools-only-v1"],
  enforcement: "dispatch-and-run",
  readiness: "unknown",
  osIsolation: "not-certified",
};

function platform(result: unknown = supported) {
  const describePolicySupport = async (receivedSessionId: string, receivedWorkspaceId: string) => {
    assert.equal(receivedSessionId, sessionId);
    assert.equal(receivedWorkspaceId, workspaceId);
    return result;
  };
  return { agents: { sessions: { describePolicySupport } } };
}

test("snapshots the declared Lead planning tools and keeps the CTO policy to its two tools", () => {
  const manifestNames = manifestTools.map(tool => tool.name);
  const ctoToolNames = new Set<string>(CTO_WORKSTREAM_TOOL_NAMES);
  assert.deepEqual([...LEAD_PLANNING_TOOL_NAMES].sort(),
    manifestNames.filter(name => !ctoToolNames.has(name)).sort());
  assert.deepEqual([...CTO_WORKSTREAM_TOOL_NAMES].sort(), [
    "builder.acknowledge-workstream", "builder.read-cto-workstream",
  ]);
  assert.deepEqual(LEAD_PLANNING_TOOL_NAMES, [...LEAD_PLANNING_TOOL_NAMES].sort());
  assert.deepEqual(CTO_WORKSTREAM_TOOL_NAMES, [...CTO_WORKSTREAM_TOOL_NAMES].sort());
  assert.deepEqual(LEAD_SESSION_EXECUTION_POLICY.toolNames, LEAD_PLANNING_TOOL_NAMES);
  assert.deepEqual(CTO_SESSION_EXECUTION_POLICY.toolNames, CTO_WORKSTREAM_TOOL_NAMES);
  assert.equal(Object.isFrozen(LEAD_PLANNING_TOOL_NAMES), true);
  assert.equal(Object.isFrozen(CTO_WORKSTREAM_TOOL_NAMES), true);
  assert.equal(Object.isFrozen(LEAD_SESSION_EXECUTION_POLICY), true);
  assert.equal(Object.isFrozen(CTO_SESSION_EXECUTION_POLICY), true);
  assert.throws(() => (LEAD_PLANNING_TOOL_NAMES as string[]).push("builder.unlisted"), TypeError);
});

test("requires the exact advertised mode and its enforcement/readiness/isolation semantics", async () => {
  assert.deepEqual(await assertSessionExecutionPolicySupport(platform(), sessionId, workspaceId), supported);
  await assert.rejects(assertSessionExecutionPolicySupport(platform({ ...supported, modes: [] }), sessionId, workspaceId), /fallback is forbidden/);
  for (const patch of [
    { schemaVersion: 2 },
    { enforcement: "dispatch-only" },
    { readiness: "ready" },
    { osIsolation: "certified" },
    { extra: true },
  ]) {
    await assert.rejects(assertSessionExecutionPolicySupport(platform({ ...supported, ...patch }), sessionId, workspaceId));
  }
});

test("fails closed for a missing method and never reads accessors", async () => {
  await assert.rejects(assertSessionExecutionPolicySupport({ agents: { sessions: {} } }, sessionId, workspaceId), /does not support/);

  let getterCalls = 0;
  const sessions = Object.defineProperty({}, "describePolicySupport", {
    enumerable: true,
    get() { getterCalls += 1; return async () => supported; },
  });
  await assert.rejects(assertSessionExecutionPolicySupport({ agents: { sessions } }, sessionId, workspaceId));
  const response = Object.defineProperty({ ...supported }, "readiness", {
    enumerable: true,
    get() { getterCalls += 1; return "unknown"; },
  });
  await assert.rejects(assertSessionExecutionPolicySupport(platform(response), sessionId, workspaceId));
  assert.equal(getterCalls, 0);
});

test("rejects sparse, accessor-backed, duplicate and unknown mode lists", async () => {
  const sparse = new Array(1);
  const accessor = ["plugin-tools-only-v1"];
  Object.defineProperty(accessor, "0", { enumerable: true, get: () => "plugin-tools-only-v1" });
  let ownKeysCalls = 0;
  const tooMany = new Proxy(["plugin-tools-only-v1", "plugin-tools-only-v1"], {
    ownKeys(target) { ownKeysCalls += 1; return Reflect.ownKeys(target); },
  });
  for (const modes of [sparse, accessor, ["unknown"], ["plugin-tools-only-v1", "plugin-tools-only-v1"]]) {
    await assert.rejects(assertSessionExecutionPolicySupport(platform({ ...supported, modes }), sessionId, workspaceId));
  }
  await assert.rejects(assertSessionExecutionPolicySupport(platform({ ...supported, modes: tooMany }), sessionId, workspaceId));
  assert.equal(ownKeysCalls, 0);
});
