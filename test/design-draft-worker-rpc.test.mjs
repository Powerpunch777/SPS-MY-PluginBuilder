import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { access, stat } from "node:fs/promises";

const workspaceA = "11111111-1111-4111-8111-111111111111";
const leadId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const runId = "55555555-5555-4555-8555-555555555555";
const invocationId = "design-draft-rpc-invocation-a";
const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const consultationId = `consultation-${requestId}`;
const namespace = "sonpark.my-builder";
const stateKey = name => ({ scopeKind: "company", scopeId: workspaceA, namespace, stateKey: name });
const clone = value => value === undefined ? null : JSON.parse(JSON.stringify(value));
const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");

function createFakeHostState() {
  const values = new Map();
  values.set(JSON.stringify(stateKey("lead-agent.v1")), {
    workspaceId: workspaceA, revision: 1, selectedAgentId: leadId,
  });
  values.set(JSON.stringify(stateKey("lead-sessions.v1.1")), {
    workspaceId: workspaceA, selectionRevision: 1, agentId: leadId,
    sessions: { main: sessionId, "cto-inbox": null, decisions: null },
  });
  values.set(JSON.stringify(stateKey("snapshot.v1")), {
    schemaVersion: 1, workspaceId: workspaceA, revision: 1,
    leadSessions: { main: null, "cto-inbox": null, decisions: null },
    actors: [],
    messages: [{ id: consultationId, channel: "main", actorId: null, role: "user",
      text: "Build a private project tracker with clear ownership and an audit history.",
      createdAt: "2026-11-02T00:00:00.000Z", runId: null }],
    documents: [], questions: [], graph: { revisionId: null, entities: [], relations: [] }, activity: [],
    integrations: { ai: "not_configured", github: "not_configured", htmlPreview: "unavailable" },
  });
  return values;
}

const draft = {
  projectId: workspaceA,
  revisionId: "design-draft-1",
  sourceIds: [consultationId],
  specification: {
    revisionId: "spec-1", productTier: "M",
    requirements: [{ id: "req-1", description: "Track projects, owners and changes.", acceptanceCriteriaIds: [] }],
    targets: ["desktop"], dataPolicyRef: "policy-to-review",
  },
  graph: { graphRevisionId: "graph-1", entities: [], relations: [], viewLayoutRef: "layout-to-review" },
  questions: [],
};

test("built Worker routes design sources to an unapproved draft and back without implicit writes or Agent sends", { timeout: 20_000 }, async () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(testDirectory, "..");
  const workerPath = path.join(projectRoot, "dist", "worker.js");
  await access(workerPath);
  assert.equal((await stat(workerPath)).isFile(), true);

  // This is a deterministic fake Host for invocation A, not actualHost and not realAI.
  const hostState = createFakeHostState();
  const child = spawn(process.execPath, [workerPath], {
    cwd: projectRoot,
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const stderr = [];
  child.stderr.on("data", chunk => {
    if (stderr.reduce((size, item) => size + item.length, 0) < 8_192) stderr.push(chunk.toString("utf8"));
  });
  const messages = [];
  const waiting = [];
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); }
    catch (error) {
      for (const waiter of waiting.splice(0)) waiter.reject(new Error(`Worker emitted invalid JSONL: ${error.message}`));
      return;
    }
    const index = waiting.findIndex(waiter => waiter.predicate(message));
    const waiter = index < 0 ? undefined : waiting.splice(index, 1)[0];
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else messages.push(message);
  });
  const closed = once(child, "close").then(([code, signal]) => ({ code, signal }));
  const waitForMessage = (description, predicate) => {
    const index = messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: undefined };
      waiting.push(waiter);
      waiter.timer = setTimeout(() => {
        const position = waiting.indexOf(waiter);
        if (position >= 0) waiting.splice(position, 1);
        reject(new Error(`Timed out waiting for ${description}. stderr: ${stderr.join("")}`));
      }, 4_000);
    });
  };
  const send = message => {
    assert.equal(child.stdin.destroyed, false, "Worker stdin must remain open for JSONL requests");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const response = id => waitForMessage(`Worker response ${id}`, message => message.id === id);
  const calls = [];
  const answerHostCall = async call => {
    assert.equal(call.jsonrpc, "2.0");
    assert.equal(call.paperclipInvocationId, invocationId, "fake Host only serves the declared invocation");
    assert.ok(typeof call.id === "number" || typeof call.id === "string");
    assert.ok(call.method === "state.get" || call.method === "state.compareAndSet",
      `unexpected Host RPC ${call.method}; state.set and Agent send are forbidden`);
    calls.push(call.method);
    assert.ok(call.params && typeof call.params === "object" && !Array.isArray(call.params));
    const { scopeKind, scopeId, namespace: requestedNamespace, stateKey: requestedKey } = call.params;
    assert.equal(scopeKind, "company");
    assert.equal(scopeId, workspaceA, "fake Host only permits invocation scope A");
    assert.equal(requestedNamespace, namespace, "exact Builder namespace required");
    assert.equal(typeof requestedKey, "string");
    assert.deepEqual(Object.keys(call.params).sort(), call.method === "state.get"
      ? ["namespace", "scopeId", "scopeKind", "stateKey"]
      : ["expected", "namespace", "scopeId", "scopeKind", "stateKey", "value"].sort());
    const key = stateKey(requestedKey);
    const id = JSON.stringify(key);
    if (call.method === "state.get") {
      send({ jsonrpc: "2.0", id: call.id, result: clone(hostState.get(id)) });
      return;
    }
    const expected = call.params.expected;
    assert.ok(expected && typeof expected === "object" && typeof expected.exists === "boolean");
    assert.deepEqual(Object.keys(expected).sort(), expected.exists ? ["exists", "value"] : ["exists"]);
    const exists = hostState.has(id);
    const current = hostState.get(id);
    const matches = expected.exists
      ? exists && JSON.stringify(current) === JSON.stringify(expected.value)
      : !exists;
    if (matches) hostState.set(id, clone(call.params.value));
    send({ jsonrpc: "2.0", id: call.id, result: { swapped: matches } });
  };
  const serviceUntil = async responseId => {
    while (true) {
      const next = await waitForMessage(`Host RPC or Worker response ${responseId}`,
        message => message.id === responseId || typeof message.method === "string");
      if (next.id === responseId) return next;
      await answerHostCall(next);
    }
  };

  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const initialized = await response(1);
    assert.deepEqual(initialized.result, { ok: true,
      supportedMethods: ["health", "shutdown", "executeTool", "onEvent", "runJob", "getData", "performAction"] });

    const runContext = { companyId: workspaceA, agentId: leadId, sessionId, runId };
    const invoke = (id, toolName, parameters, context = runContext) => send({ jsonrpc: "2.0", id, method: "executeTool",
      paperclipInvocation: { id: invocationId, scope: { companyId: workspaceA } },
      params: { toolName, parameters, runContext: context } });
    invoke(2, "builder.read-design-sources", { channel: "consultation", cursor: null });
    const sourceReply = await serviceUntil(2);
    assert.equal(sourceReply.error, undefined, JSON.stringify(sourceReply.error));
    assert.deepEqual(sourceReply.result.data.sources, [{ id: consultationId,
      text: "Build a private project tracker with clear ownership and an audit history." }]);
    assert.equal(sourceReply.result.data.channel, "consultation");

    invoke(3, "builder.propose-design", { projectId: workspaceA, expectedBaseRevisionId: null, draft });
    const proposalReply = await serviceUntil(3);
    assert.equal(proposalReply.error, undefined, JSON.stringify(proposalReply.error));
    assert.equal(proposalReply.result.data.status, "published");
    assert.equal(proposalReply.result.data.revision.status, "draft");
    assert.deepEqual(proposalReply.result.data.revision.sourceDigests, [{ id: consultationId,
      sha256: sha256("Build a private project tracker with clear ownership and an audit history.") }]);
    assert.match(proposalReply.result.content, /not customer approval, execution authorization/);

    invoke(4, "builder.read-design-draft", { projectId: workspaceA });
    const readReply = await serviceUntil(4);
    assert.equal(readReply.error, undefined, JSON.stringify(readReply.error));
    assert.equal(readReply.result.data.current.sequence, 1);
    assert.equal(readReply.result.data.current.revision.status, "draft");
    assert.equal(readReply.result.data.current.revision.draft.revisionId, "design-draft-1");
    assert.match(readReply.result.content, /unapproved/);
    assert.ok(calls.includes("state.compareAndSet"), "proposal publication must use conditional state writes");
    assert.equal(hostState.get(JSON.stringify(stateKey("snapshot.v1"))).revision, 1,
      "design flow must not implicitly write the consultation snapshot");
    assert.equal(messages.some(message => typeof message.method === "string"), false);

    const casCount = calls.filter(method => method === "state.compareAndSet").length;
    invoke(5, "builder.read-design-draft", { projectId: workspaceA }, { ...runContext,
      sessionId: "77777777-7777-4777-8777-777777777777" });
    const rejectedSession = await serviceUntil(5);
    assert.ok(rejectedSession.error, "an unprepared session must not read the current draft");
    assert.equal(calls.filter(method => method === "state.compareAndSet").length, casCount,
      "a rejected session must not create or update draft state");

    send({ jsonrpc: "2.0", id: 6, method: "shutdown", params: {} });
    const shutdown = await response(6);
    assert.equal(shutdown.error, undefined);
    assert.equal(shutdown.result, null);
    child.stdin.end();
    let closeTimer;
    const exit = await Promise.race([closed, new Promise((_, reject) => {
      closeTimer = setTimeout(() => reject(new Error("Worker did not close its JSONL pipes after shutdown.")), 3_000);
    })]).finally(() => clearTimeout(closeTimer));
    assert.deepEqual(exit, { code: 0, signal: null });
  } finally {
    for (const waiter of waiting.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Design draft Worker test is cleaning up."));
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      const graceful = await Promise.race([closed.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 500))]);
      if (!graceful && child.exitCode === null && child.signalCode === null) child.kill();
    }
  }
});
