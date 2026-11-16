import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createTaskPacketStore } from "../src/task-packet-tools.ts";
import { dispatchCtoWorkstream } from "../src/cto-workstream-delivery.ts";
import { workstreamInstructionDigest } from "../src/cto-delivery-store.ts";
import { prepareTaskWorker } from "../src/task-worker-tools.ts";
import { deriveTaskWorkerFileBinding, dispatchTaskWorkerSession, taskWorkerRequestId, writeTaskWorkerSourceFile } from "../src/task-worker-runtime.ts";
import { parseTaskWorkerRegistry, taskWorkerRegistryKey } from "../src/domain/task-workers.ts";
import type { TaskPacketRecord } from "../src/domain/task-packets.ts";
import { createBuilderPlatform } from "../src/platform.ts";
import { fixture, W, A, C, CTO, ctx, now, key, mapKey } from "./fixtures/cto-platform.ts";
import { prepareApprovedTaskFileDesign } from "./fixtures/task-file-approved-design.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", SOURCE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const METHOD = "localFolders.workspaceSourceFileEffectV1", NS = "sonpark.my-builder";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
type EffectInput = { sourceId: string; folderKey: string; relativePath: string; operation: "read" | "write" | "delete";
  contents?: string; guards: readonly { namespace?: string; stateKey: string; expectedValue: unknown }[] };

async function setup(role: "worker" | "qa" = "worker") {
  const f = await fixture(W);
  const design = await prepareApprovedTaskFileDesign(f);
  await dispatchCtoWorkstream(design.params, ctx(), f.platform);
  const delivery = (await f.deliveryStore().current())!.revision, ctoRun = [...f.runs.keys()][0]!;
  const taskId = role === "worker" ? "task-dev" : "task-readonly-qa";
  const record: TaskPacketRecord = { packet: { projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId, revision: 1,
    kind: role === "worker" ? "development" : "qa", title: "Exact guarded file fixture", goal: "Inspect only the scoped source.",
    scopeNodeIds: ["feature"], requirementIds: ["REQ-1"], dependencies: [], included: ["src/feature.ts"], excluded: [],
    constraints: [], acceptance: ["Inspect the source"], evidenceRequired: ["Bounded evidence"], reuse: [],
    testPlan: role === "qa" ? { environment: "Synthetic fixture", steps: ["Read the exact source"],
      expectedResults: ["No source mutations"], passCriteria: ["Assessment remains separate"] } : null,
    sourceAccess: { sourceId: SOURCE, folderKey: "project-source", branch: "feature/task", expectedHead: "a".repeat(40),
      readPaths: ["src/feature.ts"], writePaths: role === "worker" ? ["src/feature.ts"] : [], qaWritePaths: [] } },
    source: { requestId: delivery.requestId, workstreamId: "ws-1", specRevision: design.instruction.spec.revision,
      instructionSha256: workstreamInstructionDigest(design.instruction) }, author: { agentId: A, sessionId: C, runId: ctoRun },
    createdAtISO: now, dependencyPins: [] };
  const packets = createTaskPacketStore(W, W, CTO, "ws-1", f.state);
  assert.equal((await packets.publish({ expectedBaseRevisionId: null, revision: {
    projectId: W, ctoId: CTO, workstreamId: "ws-1", revisionId: "guarded-file-packets-1", packets: [record] } })).status, "published");
  const pluginAgentKey = `builder-task-${role}:${hash([W, "ws-1", taskId, role])}`;
  Object.assign(f.platform.agents, {
    owned: { async get(input: { pluginAgentKey: string }) { return input.pluginAgentKey === pluginAgentKey
      ? { status: "resolved", revision: 1, agent: { agentId: AGENT, status: "idle" } } : { status: "missing" }; },
    async ensure() { assert.fail("No replacement Agent may be created"); } },
    async list() { return [{ id: A, companyId: W, status: "idle" }, { id: AGENT, companyId: W, status: "idle" }]; },
  });
  Object.assign(f.platform.agents.sessions, { async ensure() { return { sessionId: SESSION, created: true }; } });
  const prepared = await prepareTaskWorker({ projectId: W, ctoId: CTO, workstreamId: "ws-1", taskId,
    packetRevision: 1, role }, ctx(C, ctoRun), f.platform);
  assert.equal((prepared.data as { status: string }).status, "registered", JSON.stringify(prepared.data));
  const registry = parseTaskWorkerRegistry(await f.state.get(key(taskWorkerRegistryKey(W, CTO))), W, W, CTO);
  const binding = deriveTaskWorkerFileBinding({ workspaceId: W, projectId: W, ctoId: CTO,
    packet: record, currentPackets: [record], worker: registry.records[0]! });
  let active = true, submitted = true, sends = 0;
  const getCtoRequest = f.platform.agents.sessions.getRequest, getCtoRun = f.platform.agents.sessions.getRun;
  Object.assign(f.platform.agents.sessions, {
    async getRun(sessionId: string, companyId: string, runId: string) {
      if (sessionId === C) return getCtoRun(sessionId, companyId, runId);
      assert.equal(sessionId, SESSION); assert.equal(companyId, W); assert.equal(runId, RUN);
      return { runId: RUN, status: "running", cancellationRequested: !active, termination: "not_applicable", error: null, errorCode: null };
    },
    async getRequest(sessionId: string, companyId: string, requestId: string) {
      if (sessionId === C) return getCtoRequest(sessionId, companyId, requestId);
      assert.equal(sessionId, SESSION); assert.equal(companyId, W); assert.equal(requestId, taskWorkerRequestId(binding));
      return submitted ? { requestId, state: "submitted", runId: RUN } : null;
    },
    async sendMessage() { sends++; return { runId: RUN }; },
  });
  const required = [taskWorkerRegistryKey(W, CTO), ...["project-ctos.v1.", "workstreams-head.v1.",
    "task-packets-head.v1.", "cto-delivery-head.v1.", "design-baseline-head.v1.", "technology-decisions-head.v1."].map(prefix => {
      const matches = [...f.values.keys()].map(value => JSON.parse(value) as { namespace: string; stateKey: string })
        .filter(value => value.namespace === NS && value.stateKey.startsWith(prefix));
      assert.equal(matches.length, 1, `fixture must contain one actual ${prefix} row`);
      return matches[0]!.stateKey;
    })];
  let legacyCalls = 0, effects = 0;
  let beforeCore = async (_input: EffectInput) => {};
  let reply: unknown = undefined;
  const calls: EffectInput[] = [], files = new Map([["src/feature.ts", "original"]]);
  const oldApi = async () => { legacyCalls++; assert.fail("No legacy folder or Source alias fallback"); };
  const localFolders = {
    async status(folderKey: string) { return { folderKey, configured: true, access: "readWrite", readable: true,
      writable: true, healthy: true, requiredDirectories: [], requiredFiles: [], missingDirectories: [], missingFiles: [], checkedAt: now }; },
    async matchWorkspaceSourceV1(folderKey: string, workspaceSourceId: string) { return { folderKey, workspaceSourceId, match: "same_root" }; },
    readText: oldApi, writeTextAtomic: oldApi, deleteFile: oldApi, readWorkspaceSourceTextV1: oldApi,
    writeWorkspaceSourceTextAtomicV1: oldApi, deleteWorkspaceSourceFileV1: oldApi,
    async workspaceSourceFileEffectV1(input: EffectInput): Promise<unknown> {
      calls.push(structuredClone(input));
      assert.equal(input.sourceId, SOURCE); assert.equal(input.folderKey, "project-source");
      assert.equal(input.relativePath, "src/feature.ts");
      assert.equal(Object.hasOwn(input, "companyId"), false);
      for (const stateKey of required) assert(input.guards.some(guard => guard.stateKey === stateKey && guard.namespace === NS));
      assert(input.guards.every(guard => !guard.stateKey.includes("-revision.v1.") && guard.expectedValue !== null));
      await beforeCore(input);
      for (const guard of input.guards) {
        // Keep namespace before stateKey: this fixture keys its Map by JSON property order.
        const actual = await f.state.get({ scopeKind: "company", scopeId: W, namespace: guard.namespace, stateKey: guard.stateKey });
        assert.notEqual(actual, null, "a missing row is not an existing null-valued guard");
        assert.deepEqual(actual, guard.expectedValue, `Core would reject changed ${guard.stateKey}`);
      }
      if (reply !== undefined) return reply;
      effects++;
      if (input.operation === "read") return { status: "read", text: files.get(input.relativePath) };
      if (input.operation === "write") { files.set(input.relativePath, input.contents!); return { status: "written" }; }
      files.delete(input.relativePath); return { status: "deleted" };
    },
  };
  Object.assign(f.platform, { localFolders, hostSupport: { state: "reported", contractVersion: "1.0", operations: [METHOD] } });
  const context = { companyId: W, agentId: AGENT, sessionId: SESSION, runId: RUN };
  const tools = createBuilderPlatform().tools;
  const call = async (operation: "read" | "write" | "delete", extra = {}) => {
    const tool = tools.find(value => value.name === `builder.${operation}-task-source-file`);
    assert(tool);
    return tool.handler({ relativePath: "src/feature.ts", ...(operation === "write" ? { contents: "updated" } : {}), ...extra } as never,
      context as never, f.platform);
  };
  return { f, record, binding, required, calls, files, localFolders, call,
    get effects() { return effects; }, get legacyCalls() { return legacyCalls; }, get sends() { return sends; },
    setReply(value: unknown) { reply = value; }, setBeforeCore(hook: typeof beforeCore) { beforeCore = hook; },
    cancel() { active = false; }, clearWorkerRequest() { submitted = false; } };
}

test("registered guarded file handlers bind the five authority heads plus current design heads and no caller guard", async () => {
  const f = await setup();
  assert.equal(((await f.call("read")).data as { text: string }).text, "original");
  assert.equal(((await f.call("write")).data as { status: string }).status, "written");
  assert.equal(((await f.call("delete")).data as { status: string }).status, "deleted");
  assert.equal(f.effects, 3); assert.equal(f.legacyCalls, 0);
  assert.equal(f.calls.length, 3);
  await assert.rejects(f.call("write", { guards: [] }), /Invalid Builder tool fields/u);
  assert.equal(f.calls.length, 3);
});

test("each mandatory head changing immediately before Core admission blocks the fixture file effect", async t => {
  const base = await setup();
  for (const wanted of base.required) await t.test(wanted.split(".v1.")[0]!, async () => {
    const f = await setup();
    f.setBeforeCore(async input => {
      const selected = input.guards.find(guard => guard.stateKey === wanted)!;
      assert(selected);
      f.f.values.set(mapKey(key(wanted)), { changed: "after Builder observation" });
    });
    const data = (await f.call("write")).data as { status: string; reason: string; completion: string; qaVerdict: string };
    assert.deepEqual(data, { status: "unknown", reason: "task-source-file-effect-outcome-uncertain",
      completion: "not-established", qaVerdict: "not-established" });
    assert.equal(f.effects, 0); assert.equal(f.files.get("src/feature.ts"), "original");
    assert.equal(f.calls.length, 1); assert.equal(f.legacyCalls, 0);
  });
});

test("a readonly QA Task can read but cannot write or delete its implementation read path", async () => {
  const f = await setup("qa");
  assert.equal(((await f.call("read")).data as { text: string }).text, "original");
  await assert.rejects(f.call("write"), /does not allow write/u);
  await assert.rejects(f.call("delete"), /does not allow delete/u);
  assert.equal(f.effects, 1); assert.equal(f.calls.length, 1); assert.equal(f.files.get("src/feature.ts"), "original");
});

test("an always-present SDK method without exact Host advertisement permits neither file effects nor new dispatch", async () => {
  const f = await setup();
  const unsupported = [undefined, { state: "unknown", contractVersion: null, operations: [] },
    { state: "reported", contractVersion: "2.0", operations: [METHOD] },
    { state: "reported", contractVersion: "1.0", operations: ["localFolders.writeWorkspaceSourceTextAtomicV1"] }];
  for (const support of unsupported) {
    Object.assign(f.f.platform, { hostSupport: support });
    for (const operation of ["read", "write", "delete"] as const) {
      assert.equal(((await f.call(operation)).data as { status: string }).status, "unsupported", operation);
    }
  }
  f.clearWorkerRequest();
  for (const support of unsupported) {
    Object.assign(f.f.platform, { hostSupport: support });
    const result = await dispatchTaskWorkerSession({ platform: f.f.platform, binding: f.binding, packet: f.record, async assertCurrent() {} });
    assert.equal(result.status, "unsupported");
  }
  assert.equal(f.sends, 0); assert.equal(f.effects, 0); assert.equal(f.calls.length, 0); assert.equal(f.legacyCalls, 0);
});

test("Core unknown/denial and missing guards never leak text, repeat the operation, or become QA completion", async () => {
  const f = await setup();
  f.setReply({ status: "unknown", reason: "file-effect-outcome-uncertain" });
  const unknown = (await f.call("read")).data as Record<string, unknown>;
  assert.deepEqual(unknown, { status: "unknown", reason: "task-source-file-effect-outcome-uncertain",
    completion: "not-established", qaVerdict: "not-established" });
  f.setBeforeCore(async () => { throw new Error("fixture pre-effect denial with private details"); });
  assert.deepEqual((await f.call("write")).data, unknown);
  const noGuards = await writeTaskWorkerSourceFile({ platform: f.f.platform, binding: f.binding, relativePath: "src/feature.ts",
    contents: "blocked", guards: [], async assertCurrent() {} });
  assert.equal(noGuards.status, "unsupported");
  assert.equal(f.calls.length, 2); assert.equal(f.effects, 0); assert.equal(f.legacyCalls, 0);
  f.cancel();
  await assert.rejects(f.call("write"), /uncancelled/u);
  assert.equal(f.calls.length, 2);
});

test("a lost Core reply after the fixture effect stays unknown and never implies rollback or retry", async () => {
  const f = await setup();
  f.setBeforeCore(async input => {
    assert.equal(input.operation, "write");
    f.files.set(input.relativePath, input.contents!);
    throw new Error("synthetic response lost after effect; private transport detail");
  });
  assert.deepEqual((await f.call("write")).data, { status: "unknown", reason: "task-source-file-effect-outcome-uncertain",
    completion: "not-established", qaVerdict: "not-established" });
  assert.equal(f.files.get("src/feature.ts"), "updated", "unknown does not mean the fixture write rolled back");
  assert.equal(f.calls.length, 1); assert.equal(f.legacyCalls, 0);
});
