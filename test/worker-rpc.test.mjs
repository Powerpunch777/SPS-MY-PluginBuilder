import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { access, stat } from "node:fs/promises";

const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const expectedStateKey = companyId => ({
  scopeKind: "company",
  scopeId: companyId,
  namespace: "sonpark.my-builder",
  stateKey: "snapshot.v1",
});
const clone = value => value === undefined ? null : JSON.parse(JSON.stringify(value));

test("built Worker JSONL round-trips workspace state and rejects cross-workspace action input", { timeout: 20_000 }, async () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(testDirectory, "..");
  const workerPath = path.join(projectRoot, "dist", "worker.js");
  await access(workerPath);
  assert.equal((await stat(workerPath)).isFile(), true);

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
    const waiterIndex = waiting.findIndex(waiter => waiter.predicate(message));
    const waiter = waiterIndex < 0 ? undefined : waiting.splice(waiterIndex, 1)[0];
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
    else messages.push(message);
  });
  const closed = once(child, "close").then(([code, signal]) => ({ code, signal }));
  const waitForMessage = (description, predicate) => {
    const index = messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: undefined,
      };
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
  const hostState = new Map();
  async function answerStateCall(expectedMethod, companyId) {
    const call = await waitForMessage(`${expectedMethod} for Workspace ${companyId}`,
      message => typeof message.method === "string" && message.id !== undefined);
    assert.equal(call.jsonrpc, "2.0");
    assert.equal(call.method, expectedMethod, "fake host rejects every unrecognized RPC");
    if (expectedMethod === "state.get") {
      assert.deepEqual(call.params, expectedStateKey(companyId));
      send({ jsonrpc: "2.0", id: call.id, result: clone(hostState.get(companyId)) });
      return;
    }
    assert.equal(expectedMethod, "state.set");
    const { value, ...key } = call.params;
    assert.deepEqual(key, expectedStateKey(companyId));
    assert.ok(value && typeof value === "object" && !Array.isArray(value));
    hostState.set(companyId, clone(value));
    send({ jsonrpc: "2.0", id: call.id, result: null });
  }
  async function workerResponse(id) {
    return waitForMessage(`Worker response ${id}`, message => message.id === id);
  }

  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const initialized = await workerResponse(1);
    assert.deepEqual(initialized.result, { ok: true, supportedMethods: ["health", "shutdown", "executeTool", "onEvent", "runJob", "getData", "performAction"] });

    send({ jsonrpc: "2.0", id: 2, method: "getData", params: { key: "builder.snapshot", companyId: workspaceA } });
    await answerStateCall("state.get", workspaceA);
    const emptyA = await workerResponse(2);
    assert.equal(emptyA.error, undefined);
    assert.equal(emptyA.result.workspaceId, workspaceA);
    assert.equal(emptyA.result.revision, 0);
    assert.deepEqual(emptyA.result.messages, []);

    send({
      jsonrpc: "2.0",
      id: 3,
      method: "performAction",
      paperclipInvocation: { id: "test-invocation-a", scope: { companyId: workspaceA } },
      params: {
        key: "builder.import-consultation",
        params: { requestId, text: "Selected user-provided consultation text." },
        actorContext: { type: "user", companyId: workspaceA, userId: "test-user" },
      },
    });
    await answerStateCall("state.get", workspaceA);
    await answerStateCall("state.set", workspaceA);
    const actionResult = await workerResponse(3);
    assert.deepEqual(actionResult.result, { saved: true, analysisStarted: false, revision: 1 });

    send({ jsonrpc: "2.0", id: 4, method: "getData", params: { key: "builder.snapshot", companyId: workspaceA } });
    await answerStateCall("state.get", workspaceA);
    const savedA = await workerResponse(4);
    assert.equal(savedA.result.workspaceId, workspaceA);
    assert.equal(savedA.result.revision, 1);
    assert.deepEqual(savedA.result.messages.map(message => [message.role, message.text]), [["user", "Selected user-provided consultation text."]]);

    send({ jsonrpc: "2.0", id: 5, method: "getData", params: { key: "builder.snapshot", companyId: workspaceB } });
    await answerStateCall("state.get", workspaceB);
    const emptyB = await workerResponse(5);
    assert.equal(emptyB.result.workspaceId, workspaceB);
    assert.equal(emptyB.result.revision, 0);
    assert.deepEqual(emptyB.result.messages, []);

    send({
      jsonrpc: "2.0",
      id: 6,
      method: "performAction",
      paperclipInvocation: { id: "test-invocation-a-malicious", scope: { companyId: workspaceA } },
      params: {
        key: "builder.import-consultation",
        params: { requestId, text: "Tenant override must not be accepted.", companyId: workspaceB },
        actorContext: { type: "user", companyId: workspaceA, userId: "test-user" },
      },
    });
    const maliciousResult = await workerResponse(6);
    assert.ok(maliciousResult.error, "company-B action parameters must be rejected in Workspace A");
    assert.match(maliciousResult.error.message, /request ID|selected text/);
    assert.equal(messages.some(message => message.method === "state.get" || message.method === "state.set"), false,
      "malicious action must be rejected before any host state call");
    assert.equal(hostState.has(workspaceB), false);

    send({ jsonrpc: "2.0", id: 7, method: "shutdown", params: {} });
    const shutdown = await workerResponse(7);
    assert.equal(shutdown.error, undefined);
    assert.equal(shutdown.result, null);
    child.stdin.end();
    let closeTimer;
    const exit = await Promise.race([
      closed,
      new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error("Worker did not close its JSONL pipes after shutdown.")), 3_000); }),
    ]).finally(() => clearTimeout(closeTimer));
    assert.deepEqual(exit, { code: 0, signal: null });
  } finally {
    for (const waiter of waiting.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Worker test is cleaning up."));
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      const graceful = await Promise.race([closed.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 500))]);
      if (!graceful && child.exitCode === null && child.signalCode === null) child.kill();
    }
  }
});
