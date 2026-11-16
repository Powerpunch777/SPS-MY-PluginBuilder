import assert from "node:assert/strict";
import test from "node:test";
import { createBuilderPlatform } from "../src/platform.ts";
import { LEAD_CHANNELS } from "../src/domain/lead-sessions.ts";
import { readLeadUserSource } from "../src/lead-conversations.ts";

const uuid = n => `${n.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const workspace = uuid(1), agent = uuid(2), request = uuid(3);

function fixture() {
  const values = new Map(), receipts = new Map(), sends = [];
  let loseSendResponse = false;
  const address = key => JSON.stringify(key);
  const state = {
    async get(key) { return structuredClone(values.get(address(key)) ?? null); },
    async set(key, value) { values.set(address(key), structuredClone(value)); },
    async compareAndSet(key, expected, value) {
      const id = address(key), exists = values.has(id);
      const swapped = expected.exists ? exists && JSON.stringify(values.get(id)) === JSON.stringify(expected.value) : !exists;
      if (swapped) values.set(id, structuredClone(value));
      return { swapped };
    },
  };
  const key = stateKey => ({ scopeKind: "company", scopeId: workspace, namespace: "sonpark.my-builder", stateKey });
  const sessions = Object.fromEntries(LEAD_CHANNELS.map((channel, index) => [channel, uuid(index + 20)]));
  values.set(address(key("lead-agent.v1")), { workspaceId: workspace, revision: 1, selectedAgentId: agent });
  values.set(address(key("lead-sessions.v1.1")), { workspaceId: workspace, selectionRevision: 1, agentId: agent, sessions });
  const context = { state, companyId: workspace, actor: { type: "user", companyId: workspace }, agents: {
    async list() { return [{ id: agent, companyId: workspace, name: "Lead", status: "idle" }]; },
    sessions: {
      async describePolicySupport() { return { schemaVersion: 1, modes: ["plugin-tools-only-v1"], enforcement: "dispatch-and-run",
        readiness: "unknown", osIsolation: "not-certified" }; },
      async sendMessage(sessionId, companyId, input) {
        const runId = uuid(100 + sends.length);
        sends.push({ sessionId, companyId, ...input });
        receipts.set(input.requestId, { requestId: input.requestId, state: "submitted", runId });
        if (loseSendResponse) throw new Error("Accepted response lost");
        return { runId };
      },
      async getRequest(_session, _workspace, requestId) { return receipts.get(requestId) ?? null; },
      async getRun(_session, _workspace, runId) { return { runId, status: "running", cancellationRequested: false,
        termination: "not_applicable", error: null, errorCode: null, output: { state: "not_ready", text: null } }; },
    },
  } };
  const contract = createBuilderPlatform();
  const action = name => contract.actions.find(row => row.key === name).handler;
  const tool = contract.tools.find(row => row.name === "builder.read-consultation-analysis").handler;
  const run = { companyId: workspace, agentId: agent, runId: uuid(101), sessionId: sessions.main };
  return { values, sends, context, sessions, run, tool, action, contract, lose() { loseSendResponse = true; } };
}

test("registered explicit analysis action freezes sources and replay never dispatches a second run", async () => {
  const f = fixture();
  const imported = await f.action("builder.import-consultation")({ requestId: uuid(4), text: "Original customer source" }, f.context);
  assert.equal(imported.analysisStarted, false);
  assert.equal(f.sends.length, 0);
  const input = { requestId: request, expectedCollectionRevision: imported.revision };
  const result = await f.action("builder.start-consultation-analysis")(input, f.context);
  assert.equal(result.status, "requested");
  assert.equal(result.requestSaved, true);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].sessionId, f.sessions.main);
  assert.match(f.sends[0].prompt, /builder.read-consultation-analysis/);
  assert.doesNotMatch(f.sends[0].prompt, /Original customer source/);
  await f.action("builder.import-consultation")({ requestId: uuid(5), text: "Later source" }, f.context);
  await f.action("builder.start-consultation-analysis")(input, f.context);
  assert.equal(f.sends.length, 1);
  const page = await f.tool({ analysisId: request, cursor: null }, f.run, f.context);
  assert.equal(page.data.sourceCount, 1);
  assert.equal(page.data.sources[0].text, "Original customer source");
  assert.equal(page.data.nextCursor, null);
  const binding = { workspaceId: workspace, selectionRevision: 1, agentId: agent, sessions: f.sessions };
  await assert.rejects(() => readLeadUserSource(request, binding, f.context), /not user-provided source or approval/);
  const sourcePage = await f.contract.tools.find(tool => tool.name === "builder.read-design-sources").handler(
    { channel: "main", cursor: null }, f.run, f.context);
  assert.deepEqual(sourcePage.data.sources, []);
  await assert.rejects(() => f.action("builder.send-lead-message")({ channel: "main", requestId: request,
    text: f.sends[0].prompt }, f.context), /unavailable or changed/);
  assert.equal(f.sends.length, 1);
});

test("stale collection and untrusted actors cannot dispatch; Main-only reader rejects other sessions", async () => {
  const f = fixture();
  const input = { requestId: request, expectedCollectionRevision: 0 };
  await assert.rejects(() => f.action("builder.start-consultation-analysis")(input,
    { ...f.context, actor: { type: "agent", companyId: workspace } }), /authenticated user/);
  const imported = await f.action("builder.import-consultation")({ requestId: uuid(4), text: "Source" }, f.context);
  assert.equal((await f.action("builder.start-consultation-analysis")(input, f.context)).status, "conflict");
  assert.equal(f.sends.length, 0);
  await f.action("builder.start-consultation-analysis")({ ...input, expectedCollectionRevision: imported.revision }, f.context);
  await assert.rejects(() => f.tool({ analysisId: request, cursor: null }, { ...f.run, sessionId: f.sessions.decisions }, f.context), /Only Main/);
  await assert.rejects(() => f.tool({ analysisId: request, cursor: null }, { ...f.run, companyId: uuid(500) }, f.context), /current Builder Lead/);
});

test("lost analysis admission response and a prepared restart preserve origin and never resend an accepted request", async () => {
  for (const preparedCrash of [false, true]) {
    const f = fixture();
    const imported = await f.action("builder.import-consultation")({ requestId: uuid(4), text: "Source" }, f.context);
    const input = { requestId: request, expectedCollectionRevision: imported.revision };
    const originalSet = f.context.state.set;
    if (preparedCrash) f.context.state.set = async (key, value) => {
      if (value.state === "dispatching") throw new Error("Crash before dispatch");
      return originalSet(key, value);
    };
    else f.lose();
    if (preparedCrash) {
      await assert.rejects(() => f.action("builder.start-consultation-analysis")(input, f.context), /Crash before dispatch/);
      assert.equal(f.sends.length, 0);
      f.context.state.set = originalSet;
      await f.action("builder.resume-prepared-lead-message")({ channel: "main", requestId: request }, f.context);
    } else await f.action("builder.start-consultation-analysis")(input, f.context);
    await f.action("builder.start-consultation-analysis")(input, f.context);
    assert.equal(f.sends.length, 1);
    await assert.rejects(() => readLeadUserSource(request,
      { workspaceId: workspace, selectionRevision: 1, agentId: agent, sessions: f.sessions }, f.context), /not user-provided/);
  }
});
