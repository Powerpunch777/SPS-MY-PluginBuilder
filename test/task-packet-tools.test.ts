import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { A, C, CTO, P, S, W, ctx, fixture, mapKey } from "./fixtures/cto-platform.ts";
import { dispatchCtoWorkstream } from "../src/cto-workstream-delivery.ts";
import { workstreamInstructionDigest } from "../src/cto-delivery-store.ts";
import { taskPacketRecordDigest } from "../src/domain/task-packets.ts";
import { createTaskPacketStore, publishCtoTaskPacket, readCtoTaskPackets } from "../src/task-packet-tools.ts";
import { createWorkstreamStore } from "../src/workstream-tools.ts";

const packet = (overrides: Record<string, unknown> = {}) => ({
  projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId: "task-1", revision: 1, kind: "development",
  title: "Implement the assigned feature", goal: "Implement only the agreed feature.", scopeNodeIds: ["feature"],
  requirementIds: ["REQ-1"], dependencies: [], included: ["Assigned feature"], excluded: ["Unrelated work"],
  constraints: ["Keep existing public contracts stable."], acceptance: ["The focused check passes."],
  evidenceRequired: ["Record the test result."], reuse: [], testPlan: null,
  ...overrides,
});

async function delivered() {
  const f = await fixture();
  await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  const delivery = (await f.deliveryStore().current())!.revision;
  assert.ok(delivery.runId);
  return { f, runId: delivery.runId!, ctoContext: ctx(C, delivery.runId!) };
}

const publish = (f: Awaited<ReturnType<typeof delivered>>["f"], runContext: unknown, value = packet(),
  expectedBaseRevisionId: string | null = null, revisionId: string = randomUUID()) => publishCtoTaskPacket({
  projectId: P, ctoId: CTO, workstreamId: "ws-1", expectedBaseRevisionId, revisionId, packet: value,
}, runContext, f.platform);

const read = (f: Awaited<ReturnType<typeof delivered>>["f"], runContext: unknown) =>
  readCtoTaskPackets({ projectId: P, ctoId: CTO, workstreamId: "ws-1" }, runContext, f.platform);

async function reviseWorkstream(f: Awaited<ReturnType<typeof delivered>>["f"], revisionId: string) {
  const store = createWorkstreamStore(W, P, f.platform.state);
  const current = (await store.current())!.revision;
  const revision = {
    ...current,
    revisionId,
    workstreams: current.workstreams.map(item => item.spec.id !== "ws-1" ? item : ({
      ...item,
      spec: { ...item.spec, revision: item.spec.revision + 1 },
      change: { ...item.change, previousRevision: item.spec.revision },
    })),
  };
  const published = await store.publish({ expectedBaseRevisionId: current.revisionId, revision });
  assert.equal(published.status, "published");
}

test("CTO publishes a scoped Task Packet and reads only the current source-linked board", async () => {
  const { f, ctoContext } = await delivered();
  const result = await publish(f, ctoContext);
  const data = result.data as { status: string; taskId: string; boardRevisionId: string; executionStarted: boolean };
  assert.equal(data.status, "published");
  assert.equal(data.taskId, "task-1");
  assert.equal(data.executionStarted, false);
  const visible = await read(f, ctoContext);
  const visibleData = visible.data as { projectId: string; ctoId: string; workstreamId: string; currentSource: unknown;
    taskStates: Array<{ taskId: string; instruction: string; dependencies: string }>;
    current: { sequence: number; revision: { revisionId: string; packets: Array<{ packet: unknown; source: unknown; author: unknown; dependencyPins: unknown[] }> } } };
  const current = visibleData.current;
  assert.equal(current.revision.revisionId, data.boardRevisionId);
  assert.equal(current.sequence, 1);
  assert.deepEqual(current.revision.packets[0]?.packet, packet());
  assert.deepEqual(current.revision.packets[0]?.dependencyPins, []);
  assert.equal((current.revision.packets[0]?.source as { specRevision: number }).specRevision, 1);
  assert.equal((current.revision.packets[0]?.source as { workstreamId: string }).workstreamId, "ws-1");
  const sourceDigest = (current.revision.packets[0]?.source as { instructionSha256: string }).instructionSha256;
  assert.equal(sourceDigest, workstreamInstructionDigest(f.instruction));
  assert.equal((current.revision.packets[0]?.author as { runId: string }).runId, ctoContext.runId);
  const delivery = (await f.deliveryStore().current())!.revision;
  assert.deepEqual(visibleData.currentSource, { requestId: delivery.requestId, workstreamId: "ws-1",
    specRevision: 1, sha256: workstreamInstructionDigest(delivery.instruction) });
  assert.deepEqual(visibleData.taskStates, [{ taskId: "task-1", instruction: "current", dependencies: "current" }]);
  assert.match(result.content, /No Worker, code, QA run or completion was created/);
  assert.equal(f.sends, 1, "only the explicit setup delivery was sent; publishing and reading do not send");
});

test("Lead main, another CTO, forged run, and cancelled CTO run cannot publish or read", async () => {
  const { f, ctoContext, runId } = await delivered();
  const registry = f.values.get(mapKey(f.registryKey)) as { ctos: unknown[] };
  registry.ctos.push({ ctoId: "cto-two", displayName: "Other CTO", agentId: "66666666-6666-4666-8666-666666666666",
    sessionId: "77777777-7777-4777-8777-777777777777", status: "ACTIVE", createdAt: "2026-11-02T01:02:03.004Z",
    createdBy: { agentId: A, sessionId: S, runId: "55555555-5555-4555-8555-555555555555", selectionRevision: 1 } });
  const otherCto = ctx("77777777-7777-4777-8777-777777777777", runId);
  for (const unauthorized of [ctx(), otherCto, ctx(C, randomUUID())]) {
    await assert.rejects(publish(f, unauthorized), /CTO|delivery|run|session|permitted/i);
    await assert.rejects(read(f, unauthorized), /CTO|delivery|run|session|permitted/i);
  }
  f.runs.set(runId, { ...f.runs.get(runId)!, cancellationRequested: true, termination: "pending" });
  await assert.rejects(publish(f, ctoContext), /cancel|active|run/i);
  assert.equal((await createTaskPacketStore(W, P, CTO, "ws-1", f.platform.state).current()), null);
  assert.equal(f.sends, 1);
});

test("Task Packet node and requirement IDs must link to the delivered scope and pinned specification", async () => {
  const { f, ctoContext } = await delivered();
  await assert.rejects(publish(f, ctoContext, packet({ scopeNodeIds: ["invented-node"] })), /node|Workstream|scope/i);
  await assert.rejects(publish(f, ctoContext, packet({ requirementIds: ["REQ-INVENTED"] })), /requirement|pinned specification/i);
  assert.equal(await createTaskPacketStore(W, P, CTO, "ws-1", f.platform.state).current(), null);
});

test("QA packets require an explicit test plan; unreviewed reuse and QA evidence are not invented", async () => {
  const { f, ctoContext } = await delivered();
  const reuse = { id: "reference-1", sourceUrl: "https://example.com/reference", licenseStatus: "unreviewed",
    licenseExpression: null, evidenceRefs: [], compatibilityStatus: "not-verified", reuseScope: "Consider only for this feature.",
    doNotRebuild: "Do not reproduce unrelated components." };
  await assert.rejects(publish(f, ctoContext, packet({ kind: "qa", testPlan: null })), /testPlan/i);
  const result = await publish(f, ctoContext, packet({ kind: "qa", reuse: [reuse], testPlan: {
    environment: "Declared test environment", steps: ["Run the focused test"],
    expectedResults: ["The expected behavior is observed"], passCriteria: ["All focused assertions pass"],
  } }));
  assert.equal((result.data as { status: string }).status, "published");
  const current = (await read(f, ctoContext)).data as { current: { revision: { packets: Array<{ packet: { reuse: Array<{ licenseStatus: string; compatibilityStatus: string }> } }> } } };
  assert.equal(current.current.revision.packets[0]?.packet.reuse[0]?.licenseStatus, "unreviewed");
  assert.equal(current.current.revision.packets[0]?.packet.reuse[0]?.compatibilityStatus, "not-verified");
});

test("task revisions are monotonic and exact retries are unchanged while changed immutable content is rejected", async () => {
  const { f, ctoContext } = await delivered();
  const first = await publish(f, ctoContext, packet(), null, "board-1");
  assert.equal((first.data as { status: string }).status, "published");
  const unchanged = await publish(f, ctoContext, packet(), null, "ignored-retry-id");
  assert.equal((unchanged.data as { status: string }).status, "existing");
  await assert.rejects(publish(f, ctoContext, packet({ goal: "Different content under the same task revision." }), null, "different"), /different content|immutable/i);
  await assert.rejects(publish(f, ctoContext, packet({ revision: 3 }), "board-1", "skip-revision"), /revision 1|next exact/i);
  const second = await publish(f, ctoContext, packet({ revision: 2, goal: "Clarified bounded implementation." }), "board-1", "board-2");
  assert.equal((second.data as { status: string }).status, "published");
  const history = await createTaskPacketStore(W, P, CTO, "ws-1", f.platform.state).current();
  assert.equal(history?.sequence, 2);
  assert.equal(history?.revision.packets[0]?.packet.revision, 2);
});

test("dependencies must exist on the same instruction and form a DAG", async () => {
  const { f, ctoContext } = await delivered();
  await assert.rejects(publish(f, ctoContext, packet({ dependencies: ["missing-task"] })), /dependency .*missing/i);
  const first = await publish(f, ctoContext, packet({ taskId: "task-a" }), null, "board-a");
  assert.equal((first.data as { status: string }).status, "published");
  const dependent = packet({ taskId: "task-b", dependencies: ["task-a"] });
  const second = await publish(f, ctoContext, dependent, "board-a", "board-b");
  assert.equal((second.data as { status: string }).status, "published");
  const current = (await createTaskPacketStore(W, P, CTO, "ws-1", f.platform.state).current())!;
  const recordA1 = current.revision.packets.find(record => record.packet.taskId === "task-a")!;
  const recordB1 = current.revision.packets.find(record => record.packet.taskId === "task-b")!;
  assert.deepEqual(recordB1.dependencyPins, [{ taskId: "task-a", revision: 1,
    recordSha256: taskPacketRecordDigest(recordA1, P, CTO, "ws-1") }]);
  const revisedA = await publish(f, ctoContext, packet({ taskId: "task-a", revision: 2,
    goal: "Clarify the exact feature implementation." }), "board-b", "board-c");
  assert.equal((revisedA.data as { status: string }).status, "published");
  const updated = (await createTaskPacketStore(W, P, CTO, "ws-1", f.platform.state).current())!;
  const recordA2 = updated.revision.packets.find(record => record.packet.taskId === "task-a")!;
  const recordB2 = updated.revision.packets.find(record => record.packet.taskId === "task-b")!;
  assert.equal(recordA2.packet.revision, 2);
  assert.deepEqual(recordB2.dependencyPins, [{ taskId: "task-a", revision: 1,
    recordSha256: taskPacketRecordDigest(recordA1, P, CTO, "ws-1") }], "publishing a dependency revision never rewrites a dependent's pin");
  const states = (await read(f, ctoContext)).data as { taskStates: Array<{ taskId: string; instruction: string; dependencies: string }> };
  assert.deepEqual(states.taskStates.find(state => state.taskId === "task-a"),
    { taskId: "task-a", instruction: "current", dependencies: "current" });
  assert.deepEqual(states.taskStates.find(state => state.taskId === "task-b"),
    { taskId: "task-b", instruction: "current", dependencies: "changed" });
  await assert.rejects(createTaskPacketStore(W, P, CTO, "ws-1", f.platform.state).publish({ expectedBaseRevisionId: "board-c",
    revision: { ...updated.revision, revisionId: "cycle", packets: updated.revision.packets.map(record => ({
      ...record,
      packet: record.packet.taskId === "task-a" ? { ...record.packet, dependencies: ["task-b"] } : record.packet,
      dependencyPins: record.packet.taskId === "task-a" ? [{ taskId: "task-b", revision: 1,
        recordSha256: taskPacketRecordDigest(recordB2, P, CTO, "ws-1") }] : record.dependencyPins,
    })) } }), /DAG|cycle/i);
});

test("a connected development and QA group is rebound to a new instruction in one board revision", async () => {
  const { f, ctoContext } = await delivered();
  const development = packet({ taskId: "development" });
  const qa = packet({ taskId: "qa", kind: "qa", dependencies: ["development"], testPlan: {
    environment: "Fixture", steps: ["Run check"], expectedResults: ["Expected output"], passCriteria: ["All checks pass"],
  } });
  const scope = { projectId: P, ctoId: CTO, workstreamId: "ws-1" };
  const group = (context: unknown, base: string | null, revisionId: string, revision: number) => publishCtoTaskPacket({
    ...scope, expectedBaseRevisionId: base, revisionId, packet: { ...qa, revision }, additionalPackets: [{ ...development, revision }],
  }, context, f.platform);
  const store = createTaskPacketStore(W, P, CTO, "ws-1", f.platform.state);
  assert.equal(((await group(ctoContext, null, "group-1", 1)).data as { status: string }).status, "published");
  const old = (await store.current())!;
  assert.equal(old.sequence, 1);
  await reviseWorkstream(f, "group-workstream-2");
  f.runs.set(ctoContext.runId, { ...f.runs.get(ctoContext.runId)!, status: "succeeded" });
  await dispatchCtoWorkstream({ projectId: P, workstreamId: "ws-1", specRevision: 2, boardRevisionId: "group-workstream-2" }, ctx(), f.platform);
  const nextContext = ctx(C, (await f.deliveryStore().current())!.revision.runId!);
  await assert.rejects(publish(f, nextContext, { ...development, revision: 2 }, "group-1", "partial"), /same specification revision/);
  assert.deepEqual(await store.current(), old);
  assert.equal(((await group(nextContext, "group-1", "group-2", 2)).data as { status: string }).status, "published");
  const next = (await store.current())!;
  assert.equal(next.sequence, 2);
  const dev = next.revision.packets.find(row => row.packet.taskId === "development")!;
  const reviewed = next.revision.packets.find(row => row.packet.taskId === "qa")!;
  assert.equal(dev.source.specRevision, 2);
  assert.deepEqual(reviewed.source, dev.source);
  assert.deepEqual(reviewed.dependencyPins, [{ taskId: "development", revision: 2,
    recordSha256: taskPacketRecordDigest(dev, P, CTO, "ws-1") }]);
  assert.deepEqual(await store.publishedRevision("group-1"), old);
  const replay = await group(nextContext, "group-1", "group-2", 2);
  assert.equal((replay.data as { status: string }).status, "existing");
  assert.deepEqual(await store.current(), next);
  assert.equal(f.sends, 2, "planning publication does not dispatch Worker or QA");
});

test("an invalid companion rejects the entire publication before CAS", async () => {
  const { f, ctoContext } = await delivered();
  const first = packet({ taskId: "a" }), second = packet({ taskId: "b" });
  const publishGroup = (value: unknown, additionalPackets: unknown) => publishCtoTaskPacket({
    projectId: P, ctoId: CTO, workstreamId: "ws-1", expectedBaseRevisionId: null, revisionId: "invalid-group",
    packet: value, additionalPackets,
  }, ctoContext, f.platform);
  const accessor: unknown[] = [];
  Object.defineProperty(accessor, "0", { enumerable: true, get() { assert.fail("companion getter ran"); } });
  const stateBefore = structuredClone(f.values);
  await assert.rejects(publishGroup(first, accessor), /must contain data/);
  await assert.rejects(publishGroup(first, [first]), /IDs must be unique/);
  await assert.rejects(publishGroup(first, [{ ...second, ctoId: "another-cto" }]), /scope|ctoId/i);
  await assert.rejects(publishGroup(first, [{ ...second, revision: 2 }]), /next exact/);
  await assert.rejects(publishGroup({ ...first, dependencies: ["b"] }, [{ ...second, dependencies: ["a"] }]), /DAG/);
  assert.deepEqual(f.values, stateBefore);
  assert.equal(await createTaskPacketStore(W, P, CTO, "ws-1", f.platform.state).current(), null);
});

test("stale delivered Workstream and the legacy six-tool delivery policy are denied", async () => {
  const { f, ctoContext } = await delivered();
  await publish(f, ctoContext, packet(), null, "packet-before-revision");
  await reviseWorkstream(f, "board-2");
  await assert.rejects(publish(f, ctoContext), /no longer current|revised specification|delivery authority/i);
  await assert.rejects(read(f, ctoContext), /no longer current|revised specification|delivery authority/i);
  await assert.rejects(dispatchCtoWorkstream({ projectId: P, workstreamId: "ws-1", specRevision: 2,
    boardRevisionId: "board-2" }, ctx(), f.platform), /active or uncertain/);
  f.runs.set(ctoContext.runId, { ...f.runs.get(ctoContext.runId)!, status: "succeeded" });
  await dispatchCtoWorkstream({ projectId: P, workstreamId: "ws-1", specRevision: 2, boardRevisionId: "board-2" }, ctx(), f.platform);
  const updatedDelivery = (await f.deliveryStore().current())!.revision;
  const updatedContext = ctx(C, updatedDelivery.runId!);
  const historical = (await read(f, updatedContext)).data as { current: { revision: { packets: unknown[] } };
    currentSource: { specRevision: number }; taskStates: Array<{ taskId: string; instruction: string; dependencies: string }> };
  assert.equal(historical.currentSource.specRevision, 2);
  assert.equal(historical.current.revision.packets.length, 1);
  assert.deepEqual(historical.taskStates, [{ taskId: "task-1", instruction: "historical", dependencies: "current" }]);

  const g = await delivered();
  const active = (await g.f.deliveryStore().current())!.revision;
  const oldPolicy = { ...active, revisionId: "legacy-policy", executionPolicy: {
    mode: "plugin-tools-only-v1" as const,
    toolNames: ["builder.acknowledge-workstream", "builder.read-cto-memory", "builder.read-cto-workstream",
      "builder.read-own-cto-question", "builder.submit-cto-question", "builder.update-cto-memory"],
  } };
  await g.f.deliveryStore().publish({ expectedBaseRevisionId: active.revisionId, revision: oldPolicy });
  await assert.rejects(publish(g.f, g.ctoContext), /permitted|authority|delivery/i);
  assert.equal((await createTaskPacketStore(W, P, CTO, "ws-1", g.f.platform.state).current()), null);
});

test("source Workstream changes after the Task Packet head CAS reject the call but retain history for the next delivery", async () => {
  const { f, ctoContext } = await delivered();
  let sourceChanged = false;
  f.setAfterCas(async input => {
    if (!sourceChanged && input.stateKey.startsWith("task-packets-head")) {
      sourceChanged = true;
      await reviseWorkstream(f, "board-after-cas");
    }
  });
  await assert.rejects(publish(f, ctoContext, packet(), null, "packet-after-cas"), /no longer current|revised specification|authority changed/i);
  f.setAfterCas(async () => {});
  const stored = (await createTaskPacketStore(W, P, CTO, "ws-1", f.platform.state).current())!;
  assert.equal(stored.revision.revisionId, "packet-after-cas");
  assert.equal(stored.revision.packets[0]?.packet.taskId, "task-1");
  await assert.rejects(read(f, ctoContext), /no longer current|revised specification|delivery authority/i);

  f.runs.set(ctoContext.runId, { ...f.runs.get(ctoContext.runId)!, status: "succeeded" });
  await dispatchCtoWorkstream({ projectId: P, workstreamId: "ws-1", specRevision: 2,
    boardRevisionId: "board-after-cas" }, ctx(), f.platform);
  const next = (await f.deliveryStore().current())!.revision;
  const nextRead = (await read(f, ctx(C, next.runId!))).data as { currentSource: { specRevision: number };
    taskStates: Array<{ taskId: string; instruction: string; dependencies: string }> };
  assert.equal(nextRead.currentSource.specRevision, 2);
  assert.deepEqual(nextRead.taskStates, [{ taskId: "task-1", instruction: "historical", dependencies: "current" }]);
});

test("missing CAS is fail-closed; a lost committed head response remains readable without resending", async () => {
  const { f, ctoContext } = await delivered();
  type CompareAndSet = (key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue },
    value: JsonValue) => Promise<{ swapped: boolean }>;
  const state = f.platform.state as unknown as { compareAndSet?: CompareAndSet };
  const originalCas = state.compareAndSet;
  state.compareAndSet = undefined;
  await assert.rejects(publish(f, ctoContext), /compareAndSet|CAS|Unsupported Host/i);
  state.compareAndSet = originalCas;
  let lost = false;
  f.setAfterCas(async (input, value) => {
    if (!lost && input.stateKey.startsWith("task-packets-head")) {
      lost = true;
      throw new Error("Lost committed head response");
    }
  });
  await assert.rejects(publish(f, ctoContext), /Lost committed head response/);
  f.setAfterCas(async () => {});
  const reconciled = (await read(f, ctoContext)).data as { current: { revision: { packets: Array<{ packet: { taskId: string } }> } } };
  assert.equal(reconciled.current.revision.packets[0]?.packet.taskId, "task-1");
  assert.equal(f.sends, 1);
});

test("parallel independent task writers have one published head and one explicit conflict", async () => {
  const { f, ctoContext } = await delivered();
  const results = await Promise.all([
    publish(f, ctoContext, packet({ taskId: "parallel-a" }), null, "parallel-board-a"),
    publish(f, ctoContext, packet({ taskId: "parallel-b" }), null, "parallel-board-b"),
  ]);
  assert.deepEqual(results.map(result => (result.data as { status: string }).status).sort(), ["conflict", "published"]);
  const current = (await createTaskPacketStore(W, P, CTO, "ws-1", f.platform.state).current())!;
  assert.equal(current.sequence, 1);
  assert.equal(current.revision.packets.length, 1);
  assert.equal(f.sends, 1);
});
