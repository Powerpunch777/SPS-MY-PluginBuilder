import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { LEAD_CONTEXTS, mayPublishFormalRevision, parseLeadContexts, resolveLeadContext, type BuilderLeadContexts } from "../src/domain/lead-contexts.ts";
import { resolveLogicalLeadContext, requireFormalRevisionAuthority } from "../src/lead-context-authority.ts";
import { requireLeadFormalPublicationAuthority, resolveLeadToolAuthority } from "../src/lead-tool-authority.ts";
import { beginLeadContextPreparation, readLeadContexts, writeLeadContextProgress, writeLeadContexts } from "../src/lead-context-store.ts";
import { createBuilderPlatform, prepareLeadContexts } from "../src/platform.ts";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
] as const;
const record = (): BuilderLeadContexts => ({ schemaVersion: 2, workspaceId: WORKSPACE, selectionRevision: 4,
  agentId: AGENT, requestId: "99999999-9999-4999-8999-999999999999", status: "ready", pendingContext: null,
  contexts: Object.fromEntries(LEAD_CONTEXTS.map((name, index) => [name, ids[index]])) as BuilderLeadContexts["contexts"] });

function storageFixture() {
  const values = new Map<string, JsonValue>();
  const calls = { compareAndSet: 0, committed: 0 };
  const key = (input: SpsStateKey) => JSON.stringify([input.scopeKind, input.scopeId, input.namespace, input.stateKey]);
  values.set(key({ scopeKind: "company", scopeId: WORKSPACE, namespace: "sonpark.my-builder", stateKey: "lead-agent.v1" }),
    { workspaceId: WORKSPACE, revision: 4, selectedAgentId: AGENT });
  const platform = { state: {
    async get(input: SpsStateKey) { return structuredClone(values.get(key(input)) ?? null); },
    async set() { throw new Error("Unconditional state.set is forbidden in this fixture."); },
    async compareAndSet(input: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
      calls.compareAndSet++;
      const present = values.has(key(input));
      if (expected.exists ? !present || JSON.stringify(values.get(key(input))) !== JSON.stringify(expected.value) : present) {
        return { swapped: false };
      }
      values.set(key(input), structuredClone(value));
      calls.committed++;
      return { swapped: true };
    },
  } } as unknown as SpsPlatformInvocationContext;
  return { platform, values, key, calls };
}

function preparationPlatform(options: { loseFirstResponse?: boolean; changeSelectionOnEnsure?: boolean } = {}) {
  const f = storageFixture();
  const calls: string[] = [];
  const sessions = new Map<string, string>();
  let nextId = 0;
  let lose = options.loseFirstResponse === true;
  (f.platform as unknown as { agents: unknown }).agents = {
    async list({ companyId }: { companyId: string }) {
      return [{ id: AGENT, name: "Lead", status: "idle", companyId }];
    },
    sessions: {
      async ensure(_agentId: string, _companyId: string, input: { taskKey: string; expectedSessionId?: string }) {
        calls.push(input.taskKey);
        let sessionId = sessions.get(input.taskKey);
        if (sessionId && input.expectedSessionId && input.expectedSessionId !== sessionId) {
          throw new Error("Host expected session conflict");
        }
        if (!sessionId) {
          sessionId = ids[nextId++]!;
          sessions.set(input.taskKey, sessionId);
        }
        if (options.changeSelectionOnEnsure) {
          f.values.set(f.key(currentBindingKey), { workspaceId: WORKSPACE, revision: 5, selectedAgentId: AGENT });
        }
        if (lose) { lose = false; throw new Error("Host response lost after ensure"); }
        return { sessionId, created: calls.filter(key => key === input.taskKey).length === 1 };
      },
    },
  };
  return { ...f, calls, sessions };
}
const explicitStart = (requestId: string) => ({ agentId: AGENT, expectedRevision: 4, requestId });

const contextKey = { scopeKind: "company" as const, scopeId: WORKSPACE,
  namespace: "sonpark.my-builder", stateKey: "lead-contexts.v2.4" };
const currentBindingKey = { ...contextKey, stateKey: "lead-agent.v1" };
const receiptIds = (value: BuilderLeadContexts) => LEAD_CONTEXTS.flatMap(context =>
  value.contexts[context] === null ? [] : [value.contexts[context]!]);
const progress = (): BuilderLeadContexts => ({ ...record(), status: "preparing", pendingContext: "user_conversation",
  contexts: Object.fromEntries(LEAD_CONTEXTS.map(context => [context, null])) as BuilderLeadContexts["contexts"] });
function readyPredecessor(value = record()): BuilderLeadContexts {
  return { ...value, status: "preparing", pendingContext: "question_discussion",
    contexts: { ...value.contexts, question_discussion: null } };
}
async function seedReady(f: ReturnType<typeof storageFixture>, value = record()) {
  const predecessor = readyPredecessor(value);
  await writeLeadContextProgress(WORKSPACE, predecessor, receiptIds(predecessor), f.platform);
  return writeLeadContexts(WORKSPACE, value, [...ids], f.platform);
}

test("v2 stores five unique logical contexts without changing the v1 shape", () => {
  const parsed = parseLeadContexts(record(), WORKSPACE);
  assert.equal(parsed.schemaVersion, 2);
  assert.deepEqual(Object.keys(parsed.contexts), [...LEAD_CONTEXTS]);
  assert.equal(new Set(Object.values(parsed.contexts)).size, 5);
  assert.deepEqual(LEAD_CONTEXTS, ["user_conversation", "ui_design", "background_planning", "question_intake", "question_discussion"]);
  assert.equal(mayPublishFormalRevision("user_conversation"), true);
  assert.equal(LEAD_CONTEXTS.filter(context => mayPublishFormalRevision(context)).length, 1);
});

test("v2 identity is scoped to Host Workspace and exact current Lead selection", () => {
  const value = record();
  const current = { selectionRevision: 4, agentId: AGENT };
  for (const [index, context] of LEAD_CONTEXTS.entries()) {
    assert.equal(resolveLeadContext(value, { workspaceId: WORKSPACE, agentId: AGENT, sessionId: ids[index]! }, current), context);
  }
  assert.throws(() => parseLeadContexts(value, OTHER_WORKSPACE), /cross-Workspace/);
  assert.throws(() => resolveLeadContext(value, { workspaceId: WORKSPACE, agentId: AGENT, sessionId: ids[0]! },
    { selectionRevision: 3, agentId: AGENT }), /stale/);
  assert.throws(() => resolveLeadContext(value, { workspaceId: WORKSPACE, agentId: OTHER_WORKSPACE, sessionId: ids[0]! }, current), /stale/);
  assert.throws(() => resolveLeadContext(value, { workspaceId: WORKSPACE, agentId: AGENT, sessionId: "66666666-6666-4666-8666-666666666666" }, current), /not an authorized/);
});

test("v2 rejects forged shape, unsupported version, duplicate IDs, and project-selected identity", () => {
  const valid = record();
  assert.throws(() => parseLeadContexts({ ...valid, schemaVersion: 1 }, WORKSPACE), /cross-Workspace|Invalid/);
  assert.throws(() => parseLeadContexts({ ...valid, projectId: OTHER_WORKSPACE }, WORKSPACE), /fields/);
  const duplicate = record();
  duplicate.contexts.ui_design = duplicate.contexts.user_conversation;
  assert.throws(() => parseLeadContexts(duplicate, WORKSPACE), /duplicate session IDs/);
  const extraContext = { ...valid, contexts: { ...valid.contexts, injected: ids[0] } };
  assert.throws(() => parseLeadContexts(extraContext, WORKSPACE), /fields/);
});

test("v2 storage is Workspace and current-selection scoped", async () => {
  const f = storageFixture();
  const predecessor = readyPredecessor();
  await writeLeadContextProgress(WORKSPACE, predecessor, receiptIds(predecessor), f.platform);
  const saved = await writeLeadContexts(WORKSPACE, record(), [...ids], f.platform);
  assert.deepEqual(saved, record());
  assert.deepEqual(await readLeadContexts(WORKSPACE, f.platform), record());
  assert.equal(await readLeadContexts(OTHER_WORKSPACE, f.platform), null);
  await assert.rejects(writeLeadContexts(WORKSPACE, record(), [ids[0], ids[1], ids[2], ids[3], "66666666-6666-4666-8666-666666666666"], f.platform),
    /Host-issued session receipts/);
  const stale = { ...record(), selectionRevision: 3 };
  await assert.rejects(writeLeadContexts(WORKSPACE, stale, [...ids], f.platform), /current Host Lead/);
  assert.equal(f.values.has(f.key({ scopeKind: "company", scopeId: WORKSPACE, namespace: "sonpark.my-builder", stateKey: "lead-contexts.v2.4" })), true);
});

test("authority derives context from Host identity, ignores project selection, and fences stale selection", async () => {
  const f = storageFixture();
  await seedReady(f);
  const main = await resolveLogicalLeadContext({ companyId: WORKSPACE, agentId: AGENT, runId: ids[0],
    sessionId: ids[0], projectId: OTHER_WORKSPACE }, f.platform);
  assert.equal(main.context, "user_conversation");
  assert.equal(main.mayPublishFormalRevision, true);
  requireFormalRevisionAuthority(main.context);
  const ui = await resolveLogicalLeadContext({ companyId: WORKSPACE, agentId: AGENT, runId: ids[1],
    sessionId: ids[1] }, f.platform);
  assert.equal(ui.context, "ui_design");
  assert.equal(ui.mayPublishFormalRevision, false);
  assert.throws(() => requireFormalRevisionAuthority(ui.context), /Only the Main/);
  const mainTool = await resolveLeadToolAuthority({ companyId: WORKSPACE, agentId: AGENT, runId: ids[0], sessionId: ids[0] }, f.platform);
  requireLeadFormalPublicationAuthority(mainTool);
  const uiTool = await resolveLeadToolAuthority({ companyId: WORKSPACE, agentId: AGENT, runId: ids[1], sessionId: ids[1] }, f.platform);
  assert.equal(uiTool.logicalContext, "ui_design");
  assert.throws(() => requireLeadFormalPublicationAuthority(uiTool), /Only the Main/);
  await assert.rejects(resolveLogicalLeadContext({ companyId: WORKSPACE, agentId: OTHER_WORKSPACE,
    runId: ids[0], sessionId: ids[0] }, f.platform), /current Host-selected/);
  await assert.rejects(resolveLogicalLeadContext({ companyId: OTHER_WORKSPACE, agentId: AGENT,
    runId: ids[0], sessionId: ids[0] }, f.platform));
});

test("authority rejects a context while its Host ensure receipt is unresolved", async () => {
  const f = storageFixture();
  const legacySession = "66666666-6666-4666-8666-666666666666";
  f.values.set(f.key({ scopeKind: "company", scopeId: WORKSPACE, namespace: "sonpark.my-builder", stateKey: "lead-sessions.v1.4" }),
    { workspaceId: WORKSPACE, selectionRevision: 4, agentId: AGENT,
      sessions: { main: legacySession, "cto-inbox": null, decisions: null } });
  const pending = { ...record(), pendingContext: "question_intake" as const,
    contexts: { ...record().contexts, question_intake: null } };
  await writeLeadContextProgress(WORKSPACE, { ...pending, status: "preparing" }, [ids[0], ids[1], ids[2], ids[4]], f.platform);
  const preparing = parseLeadContexts({ ...pending, status: "uncertain" }, WORKSPACE);
  await writeLeadContextProgress(WORKSPACE, preparing, [ids[0], ids[1], ids[2], ids[4]], f.platform);
  assert.equal((await readLeadContexts(WORKSPACE, f.platform))?.status, "uncertain");
  await assert.rejects(resolveLogicalLeadContext({ companyId: WORKSPACE, agentId: AGENT, runId: ids[0],
    sessionId: ids[0] }, f.platform), /stale/);
  await assert.rejects(resolveLeadToolAuthority({ companyId: WORKSPACE, agentId: AGENT, runId: legacySession,
    sessionId: legacySession }, f.platform), /authorized ready Lead context/);
});

test("a ready v2 context record never authorizes an unrelated v1 session", async () => {
  const f = storageFixture();
  await seedReady(f);
  const legacySession = "66666666-6666-4666-8666-666666666666";
  f.values.set(f.key({ scopeKind: "company", scopeId: WORKSPACE, namespace: "sonpark.my-builder", stateKey: "lead-sessions.v1.4" }),
    { workspaceId: WORKSPACE, selectionRevision: 4, agentId: AGENT,
      sessions: { main: legacySession, "cto-inbox": null, decisions: null } });
  await assert.rejects(resolveLeadToolAuthority({ companyId: WORKSPACE, agentId: AGENT, runId: legacySession,
    sessionId: legacySession }, f.platform), /authorized ready Lead context/);
});

test("ready context identity is immutable and identical publication is idempotent", async () => {
  const f = storageFixture();
  await seedReady(f);
  await writeLeadContexts(WORKSPACE, record(), [...ids], f.platform);
  assert.equal(f.calls.compareAndSet, 2);
  const replacement = record();
  replacement.contexts.ui_design = "66666666-6666-4666-8666-666666666666";
  await assert.rejects(writeLeadContexts(WORKSPACE, replacement, receiptIds(replacement), f.platform), /cannot be replaced/);
  await assert.rejects(writeLeadContextProgress(WORKSPACE, progress(), [], f.platform), /cannot be replaced/);
  assert.deepEqual(await readLeadContexts(WORKSPACE, f.platform), record());
  assert.equal(f.calls.committed, 2);
});

test("progress preserves known sessions and cannot abandon an unresolved receipt", async () => {
  const f = storageFixture();
  const initial = progress();
  await writeLeadContextProgress(WORKSPACE, initial, [], f.platform);
  await assert.rejects(writeLeadContextProgress(WORKSPACE, { ...initial, pendingContext: "ui_design" }, [], f.platform), /cannot be abandoned/);
  const next = { ...initial, pendingContext: "ui_design" as const,
    contexts: { ...initial.contexts, user_conversation: ids[0] } };
  await writeLeadContextProgress(WORKSPACE, next, [ids[0]], f.platform);
  await assert.rejects(writeLeadContextProgress(WORKSPACE, initial, [], f.platform), /cannot be replaced or removed/);
  const changed = { ...next, contexts: { ...next.contexts, user_conversation: ids[1] } };
  await assert.rejects(writeLeadContextProgress(WORKSPACE, changed, [ids[1]], f.platform), /cannot be replaced or removed/);
  let current: BuilderLeadContexts = next;
  for (let index = 1; index < LEAD_CONTEXTS.length - 1; index++) {
    const context = LEAD_CONTEXTS[index]!;
    const following = LEAD_CONTEXTS[index + 1]!;
    current = { ...current, pendingContext: following,
      contexts: { ...current.contexts, [context]: ids[index] } };
    await writeLeadContextProgress(WORKSPACE, current, receiptIds(current), f.platform);
  }
  await writeLeadContexts(WORKSPACE, record(), [...ids], f.platform);
  assert.equal(f.calls.committed, 6);
});

test("competing different publications preserve one winner without retrying writes", async () => {
  const f = storageFixture();
  const initial = readyPredecessor();
  await writeLeadContextProgress(WORKSPACE, initial, receiptIds(initial), f.platform);
  const competing = record();
  competing.contexts.question_discussion = "66666666-6666-4666-8666-666666666666";
  const results = await Promise.allSettled([
    writeLeadContexts(WORKSPACE, record(), [...ids], f.platform),
    writeLeadContexts(WORKSPACE, competing, receiptIds(competing), f.platform),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.equal(f.calls.committed, 2);
  assert.equal(f.calls.compareAndSet, 3);
  const saved = await readLeadContexts(WORKSPACE, f.platform);
  assert.ok(saved);
  assert.ok(saved.contexts.question_discussion === ids[4]
    || saved.contexts.question_discussion === competing.contexts.question_discussion);
});

test("concurrent identical publication accepts the actual winner without another write", async () => {
  const f = storageFixture();
  const predecessor = readyPredecessor();
  await writeLeadContextProgress(WORKSPACE, predecessor, receiptIds(predecessor), f.platform);
  const results = await Promise.all([
    writeLeadContexts(WORKSPACE, record(), [...ids], f.platform),
    writeLeadContexts(WORKSPACE, record(), [...ids], f.platform),
  ]);
  assert.deepEqual(results, [record(), record()]);
  assert.equal(f.calls.committed, 2);
  assert.equal(f.calls.compareAndSet, 3);
});

test("a lost conditional-write response is recovered by explicit identical readback", async () => {
  const f = storageFixture();
  const predecessor = readyPredecessor();
  await writeLeadContextProgress(WORKSPACE, predecessor, receiptIds(predecessor), f.platform);
  const original = f.platform.state.compareAndSet!;
  f.platform.state.compareAndSet = async (...args) => {
    await original(...args);
    throw new Error("Response lost after commit");
  };
  await assert.rejects(writeLeadContexts(WORKSPACE, record(), [...ids], f.platform), /Response lost/);
  assert.equal(f.calls.committed, 2);
  f.platform.state.compareAndSet = original;
  assert.deepEqual(await writeLeadContexts(WORKSPACE, record(), [...ids], f.platform), record());
  assert.equal(f.calls.compareAndSet, 2);
});

test("unsupported or malformed conditional state support fails without set fallback", async () => {
  const missing = storageFixture();
  const missingPredecessor = readyPredecessor();
  await writeLeadContextProgress(WORKSPACE, missingPredecessor, receiptIds(missingPredecessor), missing.platform);
  delete missing.platform.state.compareAndSet;
  await assert.rejects(writeLeadContexts(WORKSPACE, record(), [...ids], missing.platform), /atomic state.compareAndSet/);
  assert.equal(missing.values.has(missing.key(contextKey)), true);
  assert.equal(missing.calls.committed, 1);
  for (const invalid of [{}, { swapped: "yes" }, { swapped: true, extra: true },
    Object.defineProperty({}, "swapped", { enumerable: true, get() { throw new Error("Getter invoked"); } })]) {
    const f = storageFixture();
    const predecessor = readyPredecessor();
    await writeLeadContextProgress(WORKSPACE, predecessor, receiptIds(predecessor), f.platform);
    f.platform.state.compareAndSet = async () => invalid as { swapped: boolean };
    await assert.rejects(writeLeadContexts(WORKSPACE, record(), [...ids], f.platform), /Invalid/);
    assert.equal(f.values.has(f.key(contextKey)), true);
    assert.equal(f.calls.committed, 1);
  }
});

test("a CAS refusal with no identical committed record cannot be called success", async () => {
  const f = storageFixture();
  const predecessor = readyPredecessor();
  await writeLeadContextProgress(WORKSPACE, predecessor, receiptIds(predecessor), f.platform);
  f.platform.state.compareAndSet = async () => ({ swapped: false });
  await assert.rejects(writeLeadContexts(WORKSPACE, record(), [...ids], f.platform), /changed concurrently/);
  assert.equal(f.values.has(f.key(contextKey)), true);
  assert.equal(f.calls.committed, 1);
});

test("selection changes immediately before or after CAS never acknowledge current readiness", async () => {
  for (const timing of ["before", "after"] as const) {
    const f = storageFixture();
    const predecessor = readyPredecessor();
    await writeLeadContextProgress(WORKSPACE, predecessor, receiptIds(predecessor), f.platform);
    const original = f.platform.state.compareAndSet!;
    f.platform.state.compareAndSet = async (...args) => {
      if (timing === "before") f.values.set(f.key(currentBindingKey), { workspaceId: WORKSPACE, revision: 5, selectedAgentId: AGENT });
      const result = await original(...args);
      if (timing === "after") f.values.set(f.key(currentBindingKey), { workspaceId: WORKSPACE, revision: 5, selectedAgentId: AGENT });
      return result;
    };
    await assert.rejects(writeLeadContexts(WORKSPACE, record(), [...ids], f.platform), /selection changed/);
    assert.equal(await readLeadContexts(WORKSPACE, f.platform), null);
    assert.equal(f.calls.committed, 2);
  }
});

test("authority invalidates the whole original context record even when Main remains unchanged", async () => {
  const f = storageFixture();
  await seedReady(f);
  const authority = await resolveLogicalLeadContext({ companyId: WORKSPACE, agentId: AGENT,
    runId: ids[0], sessionId: ids[0] }, f.platform);
  await authority.check();
  const changed = record();
  changed.contexts.ui_design = "66666666-6666-4666-8666-666666666666";
  f.values.set(f.key(contextKey), changed as unknown as JsonValue);
  await assert.rejects(authority.check(), /authority changed/);
});

test("uncertain ensure cannot regress to preparing and ready requires durable prior progress", async () => {
  const f = storageFixture();
  const uncertain = { ...record(), status: "uncertain" as const, pendingContext: "user_conversation" as const,
    contexts: Object.fromEntries(LEAD_CONTEXTS.map(context => [context, null])) as BuilderLeadContexts["contexts"] };
  await writeLeadContextProgress(WORKSPACE, { ...uncertain, status: "preparing" }, [], f.platform);
  await writeLeadContextProgress(WORKSPACE, uncertain, [], f.platform);
  await assert.rejects(writeLeadContextProgress(WORKSPACE, { ...uncertain, status: "preparing" }, [], f.platform),
    /cannot return to preparing/);
  const forgedReady = record();
  await assert.rejects(writeLeadContexts(WORKSPACE, forgedReady, [...ids], f.platform), /durable prior progress/);
  assert.deepEqual(await readLeadContexts(WORKSPACE, f.platform), uncertain);
});

test("one explicit start request is durable and another request cannot replace it", async () => {
  const f = storageFixture();
  const requestId = "88888888-8888-4888-8888-888888888888";
  const started = await beginLeadContextPreparation(WORKSPACE, AGENT, 4, requestId, f.platform);
  assert.equal(started.status, "preparing");
  assert.equal(started.pendingContext, LEAD_CONTEXTS[0]);
  assert.equal(started.requestId, requestId);
  assert.deepEqual(await beginLeadContextPreparation(WORKSPACE, AGENT, 4, requestId, f.platform), started);
  await assert.rejects(beginLeadContextPreparation(WORKSPACE, AGENT, 4,
    "77777777-7777-4777-8777-777777777777", f.platform), /unresolved work was kept/);
});

test("explicit v2 action ensures five stable Host keys and publishes only direct Host IDs", async () => {
  const f = preparationPlatform();
  const requestId = "88888888-8888-4888-8888-888888888888";
  const result = await prepareLeadContexts(WORKSPACE, explicitStart(requestId), f.platform);
  assert.deepEqual(result, { saved: true, requestId, status: "ready", contextsReady: true });
  assert.equal(f.calls.length, 5);
  assert.equal(new Set(f.calls).size, 5);
  assert.ok(f.calls.every(key => key.includes(":session:lead:v2:4:")));
  const saved = await readLeadContexts(WORKSPACE, f.platform);
  assert.equal(saved?.status, "ready");
  assert.equal(saved?.requestId, requestId);
  assert.deepEqual(Object.values(saved!.contexts), [...ids]);
  const repeat = await prepareLeadContexts(WORKSPACE, explicitStart("77777777-7777-4777-8777-777777777777"), f.platform);
  assert.equal(repeat.status, "ready");
  assert.equal(f.calls.length, 5);
});

test("registered v2 start action requires trusted same-Workspace userAction metadata", async () => {
  const f = preparationPlatform();
  const action = createBuilderPlatform().actions.find(action => action.key === "builder.prepare-lead-contexts")!;
  let reads = 0;
  const originalGet = f.platform.state.get;
  f.platform.state.get = async (...args) => { reads++; return originalGet(...args); };
  const request = explicitStart("88888888-8888-4888-8888-888888888888");
  for (const actor of [{ type: "agent", companyId: WORKSPACE }, { type: "user", companyId: OTHER_WORKSPACE }] as const) {
    await assert.rejects(Promise.resolve().then(() => action.handler(request, { ...f.platform, companyId: WORKSPACE, actor })));
  }
  await assert.rejects(Promise.resolve().then(() => action.handler({ ...request, companyId: OTHER_WORKSPACE },
    { ...f.platform, companyId: WORKSPACE, actor: { type: "user", companyId: WORKSPACE } })));
  assert.equal(reads, 0);
});

test("lost ensure response remains uncertain and does not assume taskKey recovery", async () => {
  const f = preparationPlatform({ loseFirstResponse: true });
  const request = explicitStart("88888888-8888-4888-8888-888888888888");
  await assert.rejects(prepareLeadContexts(WORKSPACE, request, f.platform), /no automatic retry/);
  const uncertain = await readLeadContexts(WORKSPACE, f.platform);
  assert.equal(uncertain?.status, "uncertain");
  assert.equal(uncertain?.pendingContext, "user_conversation");
  assert.equal(uncertain?.requestId, request.requestId);
  await assert.rejects(prepareLeadContexts(WORKSPACE, request, f.platform), /SDK does not guarantee recovery/);
  assert.equal(f.calls.length, 1);
});

test("selection change during Host ensure cannot publish or restart old context work", async () => {
  const f = preparationPlatform({ changeSelectionOnEnsure: true });
  const request = explicitStart("88888888-8888-4888-8888-888888888888");
  await assert.rejects(prepareLeadContexts(WORKSPACE, request, f.platform), /selection changed/);
  const staleRecord = await readLeadContexts(WORKSPACE, f.platform);
  assert.equal(staleRecord, null);
  assert.equal(f.calls.length, 1);
  await assert.rejects(prepareLeadContexts(WORKSPACE, request, f.platform), /selection changed/);
  assert.equal(f.calls.length, 1);
});

test("input is snapshotted before asynchronous binding reads", async () => {
  const f = storageFixture();
  const predecessor = readyPredecessor();
  await writeLeadContextProgress(WORKSPACE, predecessor, receiptIds(predecessor), f.platform);
  const value = record();
  const save = writeLeadContexts(WORKSPACE, value, [...ids], f.platform);
  value.contexts.user_conversation = "66666666-6666-4666-8666-666666666666";
  assert.deepEqual(await save, record());
  assert.deepEqual(await readLeadContexts(WORKSPACE, f.platform), record());
});


