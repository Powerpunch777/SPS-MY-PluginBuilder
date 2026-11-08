import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { taskPacketRecordDigest, parseTaskPacket, type TaskPacketRecord } from "../src/domain/task-packets.ts";
import type { TaskWorkerRecord } from "../src/domain/task-workers.ts";
import { deriveTaskWorkerFileBinding, readTaskWorkerProtectedRun, readTaskWorkerSourceFile,
  writeTaskWorkerSourceFile, deleteTaskWorkerSourceFile, dispatchTaskWorkerSession, readTaskWorkerSessionRun,
  taskWorkerRequestId, TASK_WORKER_EXECUTION_POLICY } from "../src/task-worker-runtime.ts";

const W = "10000000-0000-4000-8000-000000000001";
const P = "20000000-0000-4000-8000-000000000002";
const CTO = "30000000-0000-4000-8000-000000000003";
const AGENT = "40000000-0000-4000-8000-000000000004";
const SESSION = "50000000-0000-4000-8000-000000000005";
const SOURCE = "60000000-0000-4000-8000-000000000006";
const RUN = "80000000-0000-4000-8000-000000000008";
const REQUEST = "90000000-0000-4000-8000-000000000009";
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const guards = [{ namespace: "sonpark.my-builder", stateKey: "current-task-head", expectedValue: { revisionId: "task-r1" } }];
const hostSupport = { state: "reported", contractVersion: "1.0", operations: ["localFolders.workspaceSourceFileEffectV1"] };

function packet(kind: "development" | "qa" = "development", overrides: Record<string, unknown> = {}) {
  return parseTaskPacket({ projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId: "task-1", revision: 1,
    kind, title: "Bounded task", goal: "Modify only the authorized source files.", scopeNodeIds: ["feature"],
    requirementIds: ["REQ-1"], dependencies: [], included: ["src/feature.ts"], excluded: [], constraints: [],
    acceptance: ["Review the exact result."], evidenceRequired: ["Protected receipt reference."], reuse: [],
    testPlan: kind === "qa" ? { environment: "Approved Node test", steps: ["Run the approved plan"],
      expectedResults: ["Core records a protected receipt"], passCriteria: ["Receipt pins match"] } : null,
    sourceAccess: { sourceId: SOURCE, folderKey: "approved-source", readPaths: ["src/feature.ts"],
      writePaths: kind === "development" ? ["src/feature.ts"] : [],
      qaWritePaths: kind === "qa" ? ["test/feature.test.ts"] : [] }, ...overrides }, P, CTO, "ws-1");
}

function record(kind: "development" | "qa" = "development", taskPacket = packet(kind)): TaskPacketRecord {
  return { packet: taskPacket, source: { requestId: REQUEST, workstreamId: "ws-1", specRevision: 4,
    instructionSha256: "a".repeat(64) }, author: { agentId: "a0000000-0000-4000-8000-00000000000a",
    sessionId: "b0000000-0000-4000-8000-00000000000b", runId: "c0000000-0000-4000-8000-00000000000c" },
    createdAtISO: "2026-11-06T01:02:03.004Z", dependencyPins: [] };
}

function worker(kind: "worker" | "qa" = "worker", taskRecord = record(kind === "qa" ? "qa" : "development")) {
  return { workstreamId: "ws-1", taskId: "task-1", packetRevision: taskRecord.packet.revision,
    packetRecordSha256: taskPacketRecordDigest(taskRecord, P, CTO, "ws-1"), role: kind, agentId: AGENT, sessionId: SESSION,
    pluginAgentKey: `builder-task-${kind}:${sha(JSON.stringify([P, "ws-1", "task-1", kind]))}`,
    source: { requestId: REQUEST, specRevision: 4, instructionSha256: "a".repeat(64) }, registeredAtISO: "2026-11-06T01:02:03.004Z" } as TaskWorkerRecord;
}

function fileBinding(kind: "worker" | "qa" = "worker") {
  const taskRecord = record(kind === "qa" ? "qa" : "development");
  return deriveTaskWorkerFileBinding({ workspaceId: W, projectId: P, ctoId: CTO, packet: taskRecord,
    currentPackets: [taskRecord], worker: worker(kind, taskRecord) });
}

function localFolderFixture(overrides: Record<string, unknown> = {}) {
  return { async status(folderKey: string) { return { folderKey, configured: true, healthy: true,
    readable: true, writable: true, access: "readWrite" }; },
    async matchWorkspaceSourceV1(folderKey: string, workspaceSourceId: string) {
      return { folderKey, workspaceSourceId, match: "same_root" };
    }, async workspaceSourceFileEffectV1() { throw new Error("Not a file-effect fixture"); }, ...overrides };
}

test("stale packet or Worker role cannot derive a task file binding", () => {
  const taskRecord = record();
  assert.throws(() => deriveTaskWorkerFileBinding({ workspaceId: W, projectId: P, ctoId: CTO,
    packet: { ...taskRecord, packet: { ...taskRecord.packet, revision: 2 } }, currentPackets: [taskRecord], worker: worker() }), /exact current Task Packet/u);
  assert.throws(() => deriveTaskWorkerFileBinding({ workspaceId: W, projectId: P, ctoId: CTO,
    packet: taskRecord, currentPackets: [{ ...taskRecord, packet: { ...taskRecord.packet, title: "new current head" } }], worker: worker() }), /exact current Task Packet/u);
  assert.throws(() => deriveTaskWorkerFileBinding({ workspaceId: W, projectId: P, ctoId: CTO,
    packet: taskRecord, currentPackets: [taskRecord], worker: { ...worker(), role: "qa" } as TaskWorkerRecord }), /role/u);
});

test("QA file permissions cannot overlap a pinned dependency implementation write set", () => {
  const developmentPacket = packet("development", { taskId: "impl-task", included: ["src/feature.ts"] });
  const developmentRecord = record("development", developmentPacket);
  const qaPacket = packet("qa", { taskId: "qa-task", dependencies: ["impl-task"], included: ["Run the approved checks"],
    sourceAccess: { sourceId: SOURCE, folderKey: "approved-source", readPaths: ["src/feature.ts"], writePaths: [],
      qaWritePaths: ["src/feature.ts"] } });
  const qaRecord = { ...record("qa", qaPacket), dependencyPins: [{ taskId: "impl-task", revision: 1,
    recordSha256: taskPacketRecordDigest(developmentRecord, P, CTO, "ws-1") }] };
  const qaWorker = { ...worker("qa", qaRecord), taskId: "qa-task",
    pluginAgentKey: `builder-task-qa:${sha(JSON.stringify([P, "ws-1", "qa-task", "qa"]))}` } as TaskWorkerRecord;
  assert.throws(() => deriveTaskWorkerFileBinding({ workspaceId: W, projectId: P, ctoId: CTO, packet: qaRecord,
    currentPackets: [qaRecord, developmentRecord], worker: qaWorker }), /overlaps a pinned implementation write path/u);
});

test("sourceAccess rejects traversal, aliases, collisions, and QA implementation writes", () => {
  for (const path of ["../outside.ts", "src\\feature.ts", "C:/outside.ts", ".git/config", "con.txt"]) {
    assert.throws(() => packet("development", { sourceAccess: { sourceId: SOURCE,
      folderKey: "approved-source", readPaths: [path], writePaths: [], qaWritePaths: [] } }), /canonical relative source path/u);
  }
  assert.throws(() => packet("development", { sourceAccess: { sourceId: SOURCE,
    folderKey: "approved-source", readPaths: ["src/A.ts", "src/a.ts"], writePaths: [], qaWritePaths: [] } }), /case-colliding/u);
  assert.throws(() => packet("qa", { sourceAccess: { sourceId: SOURCE,
    folderKey: "approved-source", readPaths: ["src/feature.ts"], writePaths: [], qaWritePaths: ["src/feature.ts"] } }), /role scope/u);
  assert.throws(() => packet("qa", { sourceAccess: { sourceId: SOURCE,
    folderKey: "approved-source", readPaths: ["src/feature.ts"], writePaths: ["test/feature.test.ts"],
    qaWritePaths: ["test/feature.test.ts"] } }), /permissions must be disjoint/u);
});

test("guarded file API absence never falls back to old Source-bound or alias-only IO", async () => {
  let oldCalls = 0;
  const old = async () => { oldCalls++; return "unscoped"; };
  const platform = { hostSupport, localFolders: localFolderFixture({ workspaceSourceFileEffectV1: undefined,
    readText: old, readWorkspaceSourceTextV1: old, writeWorkspaceSourceTextAtomicV1: old, deleteWorkspaceSourceFileV1: old }) } as unknown as SpsPlatformInvocationContext;
  const input = { platform, binding: fileBinding(), relativePath: "src/feature.ts", guards, async assertCurrent() {} };
  for (const result of [await readTaskWorkerSourceFile(input), await writeTaskWorkerSourceFile({ ...input, contents: "no" }),
    await deleteTaskWorkerSourceFile(input)]) {
    assert.deepEqual(result, { status: "unsupported", reason: "guarded-source-file-effect-unavailable" });
  }
  assert.equal(oldCalls, 0);
});

test("read/write/delete pass exact Source, role path and detached guards to one Core operation", async () => {
  const calls: unknown[] = [];
  const platform = { hostSupport, localFolders: localFolderFixture({ async workspaceSourceFileEffectV1(input: { operation: string }) {
    calls.push(input);
    return input.operation === "read" ? { status: "read", text: "source" } : { status: input.operation === "write" ? "written" : "deleted" };
  } }) } as unknown as SpsPlatformInvocationContext;
  let checks = 0;
  const input = { platform, binding: fileBinding(), relativePath: "src/feature.ts", guards,
    async assertCurrent() { checks++; } };
  assert.deepEqual(await readTaskWorkerSourceFile(input), { status: "read", text: "source" });
  assert.deepEqual(await writeTaskWorkerSourceFile({ ...input, contents: "new source" }), { status: "written" });
  assert.deepEqual(await deleteTaskWorkerSourceFile(input), { status: "deleted" });
  assert.deepEqual(calls, [
    { sourceId: SOURCE, folderKey: "approved-source", relativePath: "src/feature.ts", guards, operation: "read" },
    { sourceId: SOURCE, folderKey: "approved-source", relativePath: "src/feature.ts", guards, operation: "write", contents: "new source" },
    { sourceId: SOURCE, folderKey: "approved-source", relativePath: "src/feature.ts", guards, operation: "delete" },
  ]);
  assert.notEqual((calls[0] as { guards: unknown }).guards, guards);
  assert.equal(checks, 6);
  await assert.rejects(writeTaskWorkerSourceFile({ ...input, relativePath: "src/other.ts", contents: "no" }), /does not allow write/u);
  assert.deepEqual(await writeTaskWorkerSourceFile({ ...input, binding: fileBinding("qa"), relativePath: "test/feature.test.ts",
    contents: "test source" }), { status: "written" });
  await assert.rejects(writeTaskWorkerSourceFile({ ...input, binding: fileBinding("qa"), contents: "must not touch implementation" }), /does not allow write/u);
  assert.equal(calls.length, 4);
});

test("Core uncertainty, a mismatched receipt and a lost response never expose a read or repeat an effect", async () => {
  for (const receipt of [{ status: "unknown", reason: "file-effect-outcome-uncertain" }, { status: "written" },
    { status: "read", text: "source", extra: true }, null]) {
    let effects = 0;
    const platform = { hostSupport, localFolders: localFolderFixture({ async workspaceSourceFileEffectV1() { effects++; return receipt; } }) } as unknown as SpsPlatformInvocationContext;
    assert.deepEqual(await readTaskWorkerSourceFile({ platform, binding: fileBinding(), relativePath: "src/feature.ts", guards,
      async assertCurrent() {} }), { status: "unknown", reason: "task-source-file-effect-outcome-uncertain" });
    assert.equal(effects, 1);
  }
});

test("missing or oversized guard inventories never reach the Core file operation", async () => {
  let effects = 0;
  const platform = { hostSupport, localFolders: localFolderFixture({ async workspaceSourceFileEffectV1() { effects++; return { status: "written" }; } }) } as unknown as SpsPlatformInvocationContext;
  for (const selected of [[], Array.from({ length: 65 }, () => guards[0]!), [{ ...guards[0]!, expectedValue: "x".repeat(200_001) }]]) {
    assert.deepEqual(await writeTaskWorkerSourceFile({ platform, binding: fileBinding(), relativePath: "src/feature.ts", contents: "no",
      guards: selected, async assertCurrent() {} }), { status: "unsupported", reason: "task-source-authority-guards-unavailable" });
  }
  assert.equal(effects, 0);
});

test("authority loss after a file effect stays unknown and does not repeat the effect", async t => {
  for (const operation of ["write", "delete"] as const) await t.test(operation, async () => {
    let effects = 0, checks = 0;
    const platform = { hostSupport, localFolders: localFolderFixture({
      async workspaceSourceFileEffectV1() { effects += 1; return { status: operation === "write" ? "written" : "deleted" }; },
    }) } as unknown as SpsPlatformInvocationContext;
    const input = { platform, binding: fileBinding(), relativePath: "src/feature.ts", guards,
      async assertCurrent() { if (++checks > 1) throw new Error("Task scope was revoked after the effect."); } };
    const result = operation === "write"
      ? await writeTaskWorkerSourceFile({ ...input, contents: "bounded update" })
      : await deleteTaskWorkerSourceFile(input);
    assert.deepEqual(result, { status: "unknown", reason: "task-source-authority-changed-after-file-effect" });
    assert.equal(effects, 1);
    assert.equal(checks, 2);
  });
});

test("a lost file-operation response never claims no effect or automatically retries", async t => {
  for (const operation of ["write", "delete"] as const) await t.test(operation, async () => {
    let effects = 0;
    const effect = async () => { effects += 1; throw new Error("Transport closed after the file effect."); };
    const platform = { hostSupport, localFolders: localFolderFixture({
      workspaceSourceFileEffectV1: effect,
    }) } as unknown as SpsPlatformInvocationContext;
    const input = { platform, binding: fileBinding(), relativePath: "src/feature.ts", guards, async assertCurrent() {} };
    const result = operation === "write"
      ? await writeTaskWorkerSourceFile({ ...input, contents: "bounded update" })
      : await deleteTaskWorkerSourceFile(input);
    assert.deepEqual(result, { status: "unknown", reason: "task-source-file-effect-outcome-uncertain" });
    assert.equal(effects, 1);
  });
});

test("authority denied before a file effect still rejects without calling Core", async t => {
  for (const operation of ["write", "delete"] as const) await t.test(operation, async () => {
    let effects = 0;
    const effect = async () => { effects += 1; };
    const platform = { hostSupport, localFolders: localFolderFixture({
      workspaceSourceFileEffectV1: effect,
    }) } as unknown as SpsPlatformInvocationContext;
    const input = { platform, binding: fileBinding(), relativePath: "src/feature.ts", guards,
      async assertCurrent() { throw new Error("Task scope is not authorized."); } };
    await assert.rejects(operation === "write"
      ? writeTaskWorkerSourceFile({ ...input, contents: "must not be written" })
      : deleteTaskWorkerSourceFile(input), /not authorized/u);
    assert.equal(effects, 0);
  });
});

test("protected run reader stays unsupported until Core provides task and approved-plan binding", async () => {
  let calls = 0;
  const platform = ({ protectedTests: { async getRunV1() { calls += 1; return null; } } }) as unknown as SpsPlatformInvocationContext;
  const result = await readTaskWorkerProtectedRun({ platform, binding: fileBinding(), runId: RUN, async assertCurrent() {} });
  assert.deepEqual(result, { status: "unsupported",
    reason: "task-bound-protected-test-producer-and-approved-plan-binding-unavailable", qaVerdict: "not-established" });
  assert.equal(calls, 0);
});

test("pinned SDKs without the protected reader are unsupported and do not use session runs as fallback", async () => {
  let sendCalls = 0;
  const platform = ({ agents: { sessions: { async sendMessage() { sendCalls += 1; return { runId: RUN }; } } } }) as unknown as SpsPlatformInvocationContext;
  const result = await readTaskWorkerProtectedRun({ platform, binding: fileBinding(), runId: RUN, async assertCurrent() {} });
  assert.deepEqual(result, { status: "unsupported",
    reason: "task-bound-protected-test-producer-and-approved-plan-binding-unavailable", qaVerdict: "not-established" });
  assert.equal(sendCalls, 0);
});

test("Worker dispatch uses the pinned session executionPolicy and one deterministic request, not completion claims", async () => {
  const binding = fileBinding();
  let sendCalls = 0, getCalls = 0;
  const platform = ({ hostSupport, agents: { sessions: {
    async describePolicySupport() { return { schemaVersion: 1, modes: ["plugin-tools-only-v1"], enforcement: "dispatch-and-run",
      readiness: "unknown", osIsolation: "not-certified" }; },
    async getRequest(_sessionId: string, _companyId: string, requestId: string) {
      getCalls += 1;
      return getCalls === 1 ? null : { requestId, state: "submitted" as const, runId: RUN };
    },
    async sendMessage(_sessionId: string, _companyId: string, input: { requestId?: string; executionPolicy?: unknown }) {
      sendCalls += 1; assert.equal(input.executionPolicy, TASK_WORKER_EXECUTION_POLICY);
      assert.match(input.requestId ?? "", /^[0-9a-f-]{36}$/u);
      return { runId: RUN };
    },
  } }, localFolders: localFolderFixture({ async readWorkspaceSourceTextV1() { return ""; },
    async writeWorkspaceSourceTextAtomicV1() {}, async deleteWorkspaceSourceFileV1() {} }) }) as unknown as SpsPlatformInvocationContext;
  let validations = 0;
  const input = { platform, binding: fileBinding(), packet: record(), async assertCurrent() { validations += 1; } };
  const first = await dispatchTaskWorkerSession(input);
  assert.equal(first.status, "submitted");
  assert.equal(first.requestState, "submitted");
  assert.equal(first.runId, RUN);
  assert.equal(first.executionStarted, null);
  assert.equal(first.completion, "not-established");
  assert.equal(first.qaVerdict, "not-established");
  assert.equal(sendCalls, 1);
  const second = await dispatchTaskWorkerSession(input);
  assert.equal(second.status, "existing");
  assert.equal(second.requestState, "submitted");
  assert.equal(second.runId, RUN);
  assert.equal(second.executionStarted, null);
  assert.equal(sendCalls, 1);
  assert.equal(validations, 7);
});

test("existing admission is reconciled even when new dispatch support is unavailable", async () => {
  const binding = fileBinding();
  const requestId = taskWorkerRequestId(binding);
  for (const receipt of [{ requestId, state: "pending", runId: null }, { requestId, state: "submitted", runId: RUN }]) {
    const platform = { agents: { sessions: {
      async getRequest() { return receipt; },
      async sendMessage() { assert.fail("A prior request must not start another Run"); },
    } } } as unknown as SpsPlatformInvocationContext;
    const result = await dispatchTaskWorkerSession({ platform, binding, packet: record(), async assertCurrent() {} });
    assert.equal(result.status, "existing");
    assert.equal(result.requestState, receipt.state);
    assert.equal(result.runId, receipt.runId);
    assert.equal(result.executionStarted, null);
  }
});

test("an unreadable or inconsistent request receipt never triggers a replacement dispatch or Run lookup", async () => {
  const binding = fileBinding();
  const requestId = taskWorkerRequestId(binding);
  for (const getRequest of [
    async () => { throw new Error("receipt transport failed"); },
    async () => ({ requestId, state: "pending", runId: RUN }),
    async () => ({ requestId, state: "submitted", runId: null }),
    async () => ({ requestId: "different-request", state: "submitted", runId: RUN }),
  ]) {
    let unexpected = 0;
    const platform = { agents: { sessions: { getRequest,
      async sendMessage() { unexpected++; },
      async getRun() { unexpected++; },
    } } } as unknown as SpsPlatformInvocationContext;
    const dispatch = await dispatchTaskWorkerSession({ platform, binding, packet: record(), async assertCurrent() {} });
    assert.equal(dispatch.status, "unknown");
    assert.equal(dispatch.executionStarted, null);
    const observation = await readTaskWorkerSessionRun({ platform, binding, async assertCurrent() {} });
    assert.equal(observation.status, "unknown");
    assert.equal(observation.runId, null);
    assert.equal(unexpected, 0);
  }
});

test("Worker dispatch stays unsupported when only legacy alias-based file IO is available", async () => {
  let sends = 0, genericReads = 0;
  const platform = ({ hostSupport, agents: { sessions: {
    async describePolicySupport() { return { schemaVersion: 1, modes: ["plugin-tools-only-v1"], enforcement: "dispatch-and-run",
      readiness: "unknown", osIsolation: "not-certified" }; },
    async getRequest() { return null; },
    async sendMessage() { sends += 1; return { runId: RUN }; },
  } }, localFolders: localFolderFixture({ workspaceSourceFileEffectV1: undefined, async readText() { genericReads += 1; return ""; },
    async writeTextAtomic() {}, async deleteFile() {} }) }) as unknown as SpsPlatformInvocationContext;
  const result = await dispatchTaskWorkerSession({ platform, binding: fileBinding(), packet: record(), async assertCurrent() {} });
  assert.equal(result.status, "unsupported");
  assert.equal(sends, 0);
  assert.equal(genericReads, 0);
});

test("uncertain Worker dispatch is not retried and packet drift after admission stays unknown", async () => {
  const binding = fileBinding();
  let sendCalls = 0, assertCalls = 0;
  const platform = ({ hostSupport, agents: { sessions: {
    async describePolicySupport() { return { schemaVersion: 1, modes: ["plugin-tools-only-v1"], enforcement: "dispatch-and-run",
      readiness: "unknown", osIsolation: "not-certified" }; },
    async getRequest(_sessionId: string, _companyId: string, requestId: string) {
      return sendCalls === 0 ? null : { requestId, state: "uncertain" as const, runId: null };
    },
    async sendMessage() { sendCalls += 1; throw new Error("transport lost after admission"); },
  } }, localFolders: localFolderFixture({ async readWorkspaceSourceTextV1() { return ""; },
    async writeWorkspaceSourceTextAtomicV1() {}, async deleteWorkspaceSourceFileV1() {} }) }) as unknown as SpsPlatformInvocationContext;
  const uncertain = await dispatchTaskWorkerSession({ platform, binding: fileBinding(), packet: record(), async assertCurrent() {} });
  assert.equal(uncertain.status, "unknown");
  assert.equal(uncertain.runId, null);
  assert.equal(uncertain.executionStarted, null);
  assert.equal(sendCalls, 1);
  const reconciled = await dispatchTaskWorkerSession({ platform, binding: fileBinding(), packet: record(), async assertCurrent() {} });
  assert.equal(reconciled.status, "unknown");
  assert.equal(reconciled.requestState, "uncertain");
  assert.equal(sendCalls, 1);

  const acceptedPlatform = ({ hostSupport, agents: { sessions: {
    async describePolicySupport() { return { schemaVersion: 1, modes: ["plugin-tools-only-v1"], enforcement: "dispatch-and-run",
      readiness: "unknown", osIsolation: "not-certified" }; },
    async getRequest(_sessionId: string, _companyId: string, requestId: string) {
      return sendCalls === 1 ? null : { requestId, state: "submitted" as const, runId: RUN };
    },
    async sendMessage() { sendCalls += 1; return { runId: RUN }; },
  } }, localFolders: localFolderFixture({ async readWorkspaceSourceTextV1() { return ""; },
    async writeWorkspaceSourceTextAtomicV1() {}, async deleteWorkspaceSourceFileV1() {} }) }) as unknown as SpsPlatformInvocationContext;
  const raced = await dispatchTaskWorkerSession({ platform: acceptedPlatform, binding: fileBinding(), packet: record(), async assertCurrent() {
    assertCalls += 1; if (assertCalls === 4) throw new Error("packet revision changed after dispatch");
  } });
  assert.equal(raced.status, "unknown");
  assert.equal(raced.runId, RUN);
  assert.equal(raced.executionStarted, null);
  assert.equal(sendCalls, 2);
});

test("session result reader reports only exact Worker run state, never code completion or QA", async () => {
  const binding = fileBinding();
  const calls: string[] = [];
  const platform = ({ agents: { sessions: {
    async getRequest(_sessionId: string, _companyId: string, requestId: string) {
      return { requestId, state: "submitted" as const, runId: RUN };
    },
    async getRun(_sessionId: string, _companyId: string, runId: string) {
      calls.push(runId); return { runId, status: "succeeded", cancellationRequested: false, termination: "confirmed",
        errorCode: null, error: null, output: { state: "available", text: "Files changed." } };
    },
  } } }) as unknown as SpsPlatformInvocationContext;
  const result = await readTaskWorkerSessionRun({ platform, binding: fileBinding(), async assertCurrent() {} });
  assert.equal(result.status, "observed");
  if (result.status !== "observed") throw new Error("Expected session run observation.");
  assert.equal(result.runStatus, "succeeded");
  assert.equal(result.outputState, "available");
  assert.equal(result.completion, "not-established");
  assert.equal(result.qaVerdict, "not-established");
  assert.deepEqual(calls, [RUN]);
});

test("confirmed skipped Worker request is diagnostic only and never restarts the Task", async () => {
  for (const state of ["pending", "uncertain"] as const) {
    let sends = 0, runReads = 0, diagnostics = 0;
    const binding = fileBinding();
    const platform = { agents: { sessions: {
      async getRequest(_session: string, _workspace: string, requestId: string, options?: { includeDiagnostic: true }) {
        if (options) diagnostics++;
        return { requestId, state, runId: null,
          ...(options ? { diagnostic: { kind: "not_started", wakeupStatus: "skipped" } } : {}) };
      },
      async sendMessage() { sends++; return { runId: RUN }; },
      async getRun() { runReads++; throw new Error("No Run exists"); },
    } } } as unknown as SpsPlatformInvocationContext;
    const dispatch = await dispatchTaskWorkerSession({ platform, binding, packet: record(), async assertCurrent() {} });
    assert.equal(dispatch.status, "unknown");
    assert.equal(dispatch.requestState, state);
    assert.equal(dispatch.executionStarted, false);
    if (dispatch.status === "unknown") assert.equal(dispatch.reason, "worker-request-confirmed-not-started-no-automatic-retry");
    const observation = await readTaskWorkerSessionRun({ platform, binding, async assertCurrent() {} });
    assert.equal(observation.status, "unknown");
    if (observation.status === "unknown") assert.equal(observation.reason, "worker-session-request-confirmed-not-started-no-automatic-retry");
    assert.equal(observation.completion, "not-established");
    assert.equal(observation.qaVerdict, "not-established");
    assert.deepEqual({ sends, runReads, diagnostics }, { sends: 0, runReads: 0, diagnostics: 2 });
  }
});

test("QA Agent session is dispatchable with its distinct QA file-scope policy and no protected-pass claim", async () => {
  let sends = 0, reads = 0;
  const qaRecord = record("qa");
  const platform = ({ hostSupport, agents: { sessions: {
    async describePolicySupport() { return { schemaVersion: 1, modes: ["plugin-tools-only-v1"], enforcement: "dispatch-and-run",
      readiness: "unknown", osIsolation: "not-certified" }; },
    async getRequest(_sessionId: string, _companyId: string, requestId: string) {
      reads += 1; return reads === 1 ? null : { requestId, state: "submitted" as const, runId: RUN };
    },
    async sendMessage(_sessionId: string, _companyId: string, input: { prompt: string; executionPolicy?: unknown }) {
      sends += 1; assert.equal(input.executionPolicy, TASK_WORKER_EXECUTION_POLICY);
      assert.match(input.prompt, /qaWritePaths/u);
      assert.match(input.prompt, /finish this AI turn normally without polling/u);
      assert.match(input.prompt, /Unsupported or uncertain execution is not QA PASS/u);
      return { runId: RUN };
    },
  } }, localFolders: localFolderFixture({ async readWorkspaceSourceTextV1() { return ""; },
    async writeWorkspaceSourceTextAtomicV1() {}, async deleteWorkspaceSourceFileV1() {} }) }) as unknown as SpsPlatformInvocationContext;
  const result = await dispatchTaskWorkerSession({ platform, binding: fileBinding("qa"), packet: qaRecord, async assertCurrent() {} });
  assert.equal(result.status, "submitted"); assert.equal(result.completion, "not-established");
  assert.equal(result.qaVerdict, "not-established"); assert.equal(sends, 1);
});

test("a present SDK function without exact current Host advertisement starts neither a file effect nor a new Worker", async () => {
  let sends = 0, effects = 0;
  for (const support of [undefined, { state: "unknown", contractVersion: null, operations: [] },
    { state: "reported", contractVersion: "2.0", operations: hostSupport.operations },
    { state: "reported", contractVersion: "1.0", operations: [] }]) {
    const platform = { hostSupport: support, agents: { sessions: {
      async getRequest() { return null; }, async describePolicySupport() { assert.fail("Unsupported Host must not dispatch"); },
      async sendMessage() { sends++; return { runId: RUN }; },
    } }, localFolders: localFolderFixture({ async workspaceSourceFileEffectV1() { effects++; return { status: "written" }; } }) } as unknown as SpsPlatformInvocationContext;
    assert.equal((await dispatchTaskWorkerSession({ platform, binding: fileBinding(), packet: record(), async assertCurrent() {} })).status, "unsupported");
    assert.deepEqual(await writeTaskWorkerSourceFile({ platform, binding: fileBinding(), relativePath: "src/feature.ts", contents: "no", guards,
      async assertCurrent() {} }), { status: "unsupported", reason: "guarded-source-file-effect-unavailable" });
  }
  assert.equal(sends, 0); assert.equal(effects, 0);
});
