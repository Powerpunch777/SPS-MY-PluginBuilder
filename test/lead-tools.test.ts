import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createBuilderPlatform, readLeadSolution } from "../src/platform.ts";
import { READ_SOLUTION_TOOL } from "../src/tool-declarations.mjs";
import { createSolutionRevisionStore } from "../src/solution-revision-store.ts";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const OTHER_AGENT = "44444444-4444-4444-8444-444444444444";
const RUN = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const SESSION_IDS = {
  main: "66666666-6666-4666-8666-666666666666",
  "cto-inbox": "77777777-7777-4777-8777-777777777777",
  decisions: "88888888-8888-4888-8888-888888888888",
};
const PROJECT = "builder-project-1";
const CHANNELS = Object.keys(SESSION_IDS) as Array<keyof typeof SESSION_IDS>;

type StoredKey = SpsStateKey & { scopeId: string; stateKey: string };
const fullKey = (key: SpsStateKey) => JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);

function solutionRevision(graphRevisionId: string) {
  return {
    approvedSpecRevisionId: "spec-v1",
    graphRevisionId,
    entities: [{ id: "feature-1", kind: "feature" }],
    relations: [],
    viewLayoutRef: "layout-v1",
  };
}

function fixture(options: { companyId?: string; agentId?: string; sessionId?: string; bindingRevision?: number } = {}) {
  const companyId = options.companyId ?? COMPANY;
  const bindingRevision = options.bindingRevision ?? 2;
  const values = new Map<string, JsonValue>();
  const getCalls: StoredKey[] = [];
  let writes = 0;
  let onGet: ((key: StoredKey) => void) | undefined;
  const state = {
    async get(key: SpsStateKey) {
      const storedKey = structuredClone(key) as StoredKey;
      getCalls.push(storedKey);
      onGet?.(storedKey);
      return structuredClone(values.get(fullKey(key)) ?? null);
    },
    async set(key: SpsStateKey, value: JsonValue) {
      writes += 1;
      values.set(fullKey(key), structuredClone(value));
    },
    async compareAndSet(key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
      const id = fullKey(key);
      const exists = values.has(id);
      const current = values.get(id);
      const matches = expected.exists ? exists && JSON.stringify(current) === JSON.stringify(expected.value) : !exists;
      if (matches) {
        writes += 1;
        values.set(id, structuredClone(value));
      }
      return { swapped: matches };
    },
  };
  values.set(fullKey({ scopeKind: "company", scopeId: companyId, namespace: "sonpark.my-builder", stateKey: "lead-agent.v1" }), {
    workspaceId: companyId, revision: bindingRevision, selectedAgentId: AGENT,
  });
  values.set(fullKey({ scopeKind: "company", scopeId: companyId, namespace: "sonpark.my-builder", stateKey: `lead-sessions.v1.${bindingRevision}` }), {
    workspaceId: companyId,
    selectionRevision: bindingRevision,
    agentId: AGENT,
    sessions: { ...SESSION_IDS },
  });
  const platform = {
    state,
    agents: new Proxy({}, { get() { throw new Error("Read tool must not access the Agent API"); } }),
  } as unknown as SpsPlatformInvocationContext;
  const context = {
    agentId: options.agentId ?? AGENT,
    runId: RUN,
    companyId,
    sessionId: options.sessionId ?? SESSION_IDS.main,
  };
  return {
    platform, values, getCalls, context,
    get writes() { return writes; },
    resetWrites() { writes = 0; },
    setOnGet(callback: typeof onGet) { onGet = callback; },
  };
}

async function withPublishedSolution(f: ReturnType<typeof fixture>) {
  const store = createSolutionRevisionStore(COMPANY, PROJECT, f.platform.state);
  const revision = solutionRevision("graph-v1");
  assert.equal((await store.publish({ expectedBaseRevisionId: null, revision })).status, "published");
  f.resetWrites();
  return { sequence: 1, revision };
}

test("registered read-only tool declaration matches the manifest and platform registration", async () => {
  const manifest = (await import(new URL("../src/manifest.mjs", import.meta.url).href)).default;
  const registered = createBuilderPlatform().tools.find(tool => tool.name === READ_SOLUTION_TOOL.name);
  assert.ok(registered);
  assert.deepEqual(manifest.tools, [READ_SOLUTION_TOOL]);
  assert.deepEqual(registered.declaration, {
    displayName: READ_SOLUTION_TOOL.displayName,
    description: READ_SOLUTION_TOOL.description,
    parametersSchema: READ_SOLUTION_TOOL.parametersSchema,
  });
  assert.ok(manifest.capabilities.includes("agent.tools.register"));
  assert.equal(createBuilderPlatform().actions.some(action => action.key === READ_SOLUTION_TOOL.name), false);
});

test("current prepared Lead may read a published solution from any of its three channels without writes", async () => {
  for (const channel of CHANNELS) {
    const f = fixture({ sessionId: SESSION_IDS[channel] });
    const expected = await withPublishedSolution(f);
    const result = await readLeadSolution({ projectId: PROJECT }, f.context, f.platform);
    assert.deepEqual(result.data, { projectId: PROJECT, solution: expected });
    assert.match(result.content, /Stored solution revision/);
    assert.doesNotMatch(result.content, /approved|approval granted|delivered/i);
    assert.equal(f.writes, 0);
    assert.ok(f.getCalls.every(key => key.scopeId === COMPANY));
  }
});

test("no stored solution returns null and does not claim approval or delivery", async () => {
  const f = fixture();
  const result = await readLeadSolution({ projectId: PROJECT }, f.context, f.platform);
  assert.deepEqual(result.data, { projectId: PROJECT, solution: null });
  assert.match(result.content, /No stored solution revision/);
  assert.doesNotMatch(result.content, /approved|approval granted|delivered/i);
  assert.equal(f.writes, 0);
});

test("tool params require exactly one own enumerable data projectId field", async () => {
  const f = fixture();
  const invalid: unknown[] = [null, [], "project", {}, { projectId: PROJECT, extra: true },
    Object.assign(Object.create({ inherited: true }), { projectId: PROJECT }),
    { [Symbol("hidden")]: true, projectId: PROJECT }];
  const accessor = Object.defineProperty({}, "projectId", { enumerable: true, get() { throw new Error("getter ran"); } });
  const nonEnumerable = Object.defineProperty({}, "projectId", { value: PROJECT, enumerable: false });
  invalid.push(accessor, nonEnumerable);
  for (const params of invalid) await assert.rejects(readLeadSolution(params, f.context, f.platform));
  for (const projectId of ["", " \t ", "x\n", "x\0y", "x".repeat(161)]) {
    await assert.rejects(readLeadSolution({ projectId }, f.context, f.platform));
  }
  assert.equal(f.writes, 0);
});

test("Host run context requires exact canonical UUID metadata and rejects caller-added roles", async () => {
  const f = fixture();
  const base = f.context;
  const invalid: unknown[] = [null, {}, { ...base, role: "lead" }, { ...base, companyId: OTHER_COMPANY },
    { ...base, agentId: OTHER_AGENT }, { ...base, runId: "bad" }, { ...base, sessionId: "bad" },
    { ...base, runId: RUN.toUpperCase() }, { ...base, projectId: "not-a-core-uuid" }];
  for (const context of invalid) await assert.rejects(readLeadSolution({ projectId: PROJECT }, context, f.platform));
  for (const field of ["agentId", "runId", "companyId", "sessionId"] as const) {
    const missing = { ...base } as Record<string, unknown>;
    delete missing[field];
    await assert.rejects(readLeadSolution({ projectId: PROJECT }, missing, f.platform));
  }
  assert.equal(f.writes, 0);
});

test("rejects a worker, old Lead, other Workspace, or session not in current prepared binding", async () => {
  const worker = fixture({ agentId: OTHER_AGENT });
  await assert.rejects(readLeadSolution({ projectId: PROJECT }, worker.context, worker.platform), /current Builder Lead/);
  const oldLead = fixture({ bindingRevision: 3 });
  oldLead.values.set(fullKey({ scopeKind: "company", scopeId: COMPANY, namespace: "sonpark.my-builder", stateKey: "lead-agent.v1" }), {
    workspaceId: COMPANY, revision: 3, selectedAgentId: OTHER_AGENT,
  });
  await assert.rejects(readLeadSolution({ projectId: PROJECT }, oldLead.context, oldLead.platform), /current Builder Lead/);
  const differentWorkspace = fixture({ companyId: OTHER_COMPANY, sessionId: "99999999-9999-4999-8999-999999999999" });
  await assert.rejects(readLeadSolution({ projectId: PROJECT }, differentWorkspace.context, differentWorkspace.platform), /prepared current Lead session/);
  const missing = fixture({ sessionId: "99999999-9999-4999-8999-999999999999" });
  await assert.rejects(readLeadSolution({ projectId: PROJECT }, missing.context, missing.platform), /prepared current Lead session/);
  const unprepared = fixture();
  unprepared.values.set(fullKey({ scopeKind: "company", scopeId: COMPANY, namespace: "sonpark.my-builder", stateKey: "lead-sessions.v1.2" }), {
    workspaceId: COMPANY, selectionRevision: 2, agentId: AGENT,
    sessions: { main: null, "cto-inbox": null, decisions: null },
  });
  await assert.rejects(readLeadSolution({ projectId: PROJECT }, unprepared.context, unprepared.platform), /prepared current Lead session/);
});

test("rejects cross-Workspace or mismatched current Lead-session state", async () => {
  const f = fixture();
  f.values.set(fullKey({ scopeKind: "company", scopeId: COMPANY, namespace: "sonpark.my-builder", stateKey: "lead-sessions.v1.2" }), {
    workspaceId: OTHER_COMPANY, selectionRevision: 2, agentId: AGENT, sessions: { ...SESSION_IDS },
  });
  await assert.rejects(readLeadSolution({ projectId: PROJECT }, f.context, f.platform), /cross-Workspace/);
  assert.equal(f.writes, 0);
});

test("rechecks selection binding and all prepared session IDs after the solution read", async () => {
  for (const changedKey of ["lead-agent.v1", "lead-sessions.v1.2"]) {
    const f = fixture();
    let changed = false;
    f.setOnGet(key => {
      if (changed || key.stateKey !== `solution-head.v1.${createHashForProject(PROJECT)}`) return;
      changed = true;
      const target = changedKey === "lead-agent.v1" ? "lead-agent.v1" : "lead-sessions.v1.2";
      const full = fullKey({ scopeKind: "company", scopeId: COMPANY, namespace: "sonpark.my-builder", stateKey: target });
      const current = f.values.get(full) as Record<string, any>;
      f.values.set(full, changedKey === "lead-agent.v1"
        ? { ...current, revision: current.revision + 1 }
        : { ...current, sessions: { ...current.sessions, decisions: "99999999-9999-4999-8999-999999999999" } });
    });
    await assert.rejects(readLeadSolution({ projectId: PROJECT }, f.context, f.platform), /changed|authority/);
    assert.equal(f.writes, 0);
  }
});

function createHashForProject(projectId: string) {
  return createHash("sha256").update(projectId, "utf8").digest("hex");
}
