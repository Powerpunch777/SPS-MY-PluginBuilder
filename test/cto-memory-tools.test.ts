import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { JsonValue } from "@sonparkserver/plugin-sdk/platform";
import { readCtoMemory, updateCtoMemory } from "../src/cto-memory-tools.ts";
import { createCtoMemoryStore } from "../src/cto-memory-store.ts";
import { dispatchCtoWorkstream } from "../src/cto-workstream-delivery.ts";
import { createWorkstreamStore } from "../src/workstream-tools.ts";
import { ctoDeliveryRequestId } from "../src/domain/cto-deliveries.ts";
import { createCtoDeliveryStore } from "../src/cto-delivery-store.ts";
import { fixture, W, A, S, C, P, CTO, ctx, mapKey } from "./fixtures/cto-platform.ts";

const params = { projectId: P, ctoId: CTO, workstreamId: "ws-1" };
async function activeFixture() {
  const f = await fixture();
  await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  const runId = [...f.runs.keys()][0]!, requestId = f.sent[0]!.requestId;
  const context = ctx(C, runId);
  const entry = { id: "planning-note", kind: "context" as const, text: "Pinned planning context, not approval.", sourceRequestIds: [requestId] };
  const memory = { projectId: P, ctoId: CTO, revisionId: "memory-1", entries: [entry] };
  const store = createCtoMemoryStore(W, P, CTO, f.state);
  return { ...f, f, runId, requestId, context, entry, memory, store,
    read: () => readCtoMemory(params, context, f.platform),
    write: (revision = memory, expected: string | null = null) => updateCtoMemory({ ...params, expectedBaseRevisionId: expected, memory: revision }, context, f.platform) };
}

test("only the exact CTO run reads and stores its private memory with server-derived delivery provenance", async () => {
  const x = await activeFixture(), before = x.f.writes;
  const empty = await x.read();
  assert.equal((empty.data as { current: unknown }).current, null); assert.equal(x.f.writes, before);
  const result = await x.write();
  assert.equal((result.data as { status: string }).status, "published");
  const stored = (await x.store.current())!.revision;
  assert.deepEqual(stored.author, { agentId: A, sessionId: C, runId: x.runId });
  assert.equal(stored.sourceDigests[0]!.requestId, x.requestId);
  assert.equal(stored.sourceDigests[0]!.specRevision, 1);
  assert.equal(stored.sourceDigests[0]!.workstreamId, "ws-1");
  assert.match(stored.sourceDigests[0]!.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual((await x.read()).data && (await x.store.current())!.revision.memory, x.memory);
  assert.equal(x.f.sends, 1, "Memory operations must not schedule another provider run.");
});

test("Lead, another CTO session/run, Workspace or project cannot read private memory", async () => {
  const x = await activeFixture(); await x.write();
  let privateReads = 0;
  const original = x.platform.state.get;
  x.platform.state.get = async key => { if (key.stateKey.startsWith("cto-memory-")) privateReads++; return original(key); };
  for (const [input, context] of [
    [params, ctx(S)],
    [params, ctx(randomUUID(), x.runId)],
    [params, ctx(C, randomUUID())],
    [{ ...params, ctoId: "other-cto" }, x.context],
    [{ ...params, projectId: "other-project" }, x.context],
    [params, { ...x.context, companyId: randomUUID() }],
  ] as const) await assert.rejects(readCtoMemory(input, context, x.platform));
  assert.equal(privateReads, 0);
});

test("no delivery, a revoked Core receipt or cancelled/terminal run cannot read or update memory", async () => {
  for (const kind of ["missing", "receipt", "cancelled", "terminal"] as const) {
    const x = await activeFixture(), before = x.f.writes;
    if (kind === "missing") {
      for (const [key] of x.values) if (JSON.parse(key).stateKey.startsWith("cto-delivery-")) x.values.delete(key);
    } else if (kind === "receipt") x.receipts.delete(x.requestId);
    else x.runs.set(x.runId, { ...x.runs.get(x.runId)!, status: kind === "terminal" ? "succeeded" : "running",
      cancellationRequested: kind === "cancelled", termination: kind === "cancelled" ? "pending" : "not_applicable" });
    await assert.rejects(x.read()); await assert.rejects(x.write());
    assert.equal(x.f.writes, before);
  }
});

test("legacy two-tool delivery policies stay readable but cannot acquire private memory permissions", async () => {
  const x = await activeFixture(), delivery = (await x.deliveryStore().current())!.revision;
  await x.deliveryStore().publish({ expectedBaseRevisionId: delivery.revisionId, revision: { ...delivery, revisionId: "legacy-policy-record",
    executionPolicy: { mode: "plugin-tools-only-v1", toolNames: ["builder.acknowledge-workstream", "builder.read-cto-workstream"] } } });
  await assert.rejects(x.read(), /explicitly permitted/); await assert.rejects(x.write(), /explicitly permitted/);
});

test("unavailable source claims, extra tool fields and missing CAS cannot publish memory", async () => {
  const x = await activeFixture(), before = x.f.writes;
  await assert.rejects(x.write({ ...x.memory, entries: [{ ...x.entry, sourceRequestIds: [randomUUID()] }] }), /unavailable delivery/);
  await assert.rejects(updateCtoMemory({ ...params, expectedBaseRevisionId: null, memory: x.memory,
    sourceDigests: [] }, x.context, x.platform));
  x.platform.state.compareAndSet = undefined;
  await assert.rejects(x.write(), /CAS|conditional|compareAndSet/);
  assert.equal(x.f.writes, before);
});

test("stale and concurrent memory updates preserve one head instead of overwriting notes", async () => {
  const x = await activeFixture();
  const results = await Promise.all([x.write(), x.write({ ...x.memory, revisionId: "competing-memory" })]);
  assert.equal(results.filter(row => (row.data as { status: string }).status === "published").length, 1);
  assert.equal(results.filter(row => (row.data as { status: string }).status === "conflict").length, 1);
  const stored = await x.store.current(), writes = x.f.writes;
  const stale = await x.write({ ...x.memory, revisionId: "stale-memory" });
  assert.equal((stale.data as { status: string }).status, "conflict");
  assert.deepEqual(await x.store.current(), stored); assert.equal(x.f.writes, writes);
});

test("a lost memory head response remains readable without an automatic retry or repair", async () => {
  const x = await activeFixture(); let lost = false;
  x.setAfterCas(async input => {
    if (!lost && input.stateKey.startsWith("cto-memory-head")) { lost = true; throw new Error("Lost memory head response"); }
  });
  await assert.rejects(x.write(), /Lost memory head response/);
  assert.equal((await x.read()).data && (await x.store.current())!.revision.memory.revisionId, "memory-1");
  const before = x.f.writes;
  assert.equal((await x.write()).data && (await x.store.current())!.sequence, 1);
  assert.equal(x.f.writes, before);
});

test("retirement during publication is not reported as an atomic rollback", async () => {
  const x = await activeFixture();
  x.setAfterCas(async input => {
    if (input.stateKey.startsWith("cto-memory-head")) x.values.set(mapKey(x.registryKey), {
      schemaVersion: 1, workspaceId: W, projectId: P, revision: 2, ctos: [{ ...x.cto, status: "RETIRED" }],
    });
  });
  await assert.rejects(x.write(), /authority changed/);
  assert.equal((await x.store.current())!.revision.memory.revisionId, "memory-1", "A committed head is retained, not falsely rolled back.");
  await assert.rejects(x.read()); assert.equal(x.f.sends, 1);
});

test("a later CTO run restores its own notes but changed interpretations cannot borrow old provenance", async () => {
  const x = await activeFixture(); await x.write();
  x.runs.set(x.runId, { ...x.runs.get(x.runId)!, status: "succeeded" });
  await createWorkstreamStore(W, P, x.state).publish({ expectedBaseRevisionId: "board-1", revision: {
    projectId: P, revisionId: "board-2", workstreams: [{ ...x.instruction,
      spec: { ...x.instruction.spec, revision: 2, goal: "Updated planning scope" }, change: { ...x.instruction.change, previousRevision: 1 } }],
  } });
  await dispatchCtoWorkstream({ ...x.params, specRevision: 2, boardRevisionId: "board-2" }, ctx(), x.platform);
  const nextRun = [...x.runs.keys()].find(id => id !== x.runId)!, context = ctx(C, nextRun);
  const nextRequest = x.sent[1]!.requestId;
  const restored = await readCtoMemory(params, context, x.platform);
  assert.equal((restored.data as { current: { revision: { memory: { revisionId: string } } } }).current.revision.memory.revisionId, "memory-1");
  const memory = { ...x.memory, revisionId: "memory-2", entries: [x.entry,
    { id: "new-note", kind: "decision" as const, text: "Revised instruction is a new source, not new approval.", sourceRequestIds: [nextRequest] }] };
  await updateCtoMemory({ ...params, expectedBaseRevisionId: "memory-1", memory }, context, x.platform);
  const stored = (await x.store.current())!.revision;
  assert.deepEqual(stored.sourceDigests.map(row => row.requestId), [x.requestId, nextRequest]);
  const altered = { ...memory, revisionId: "bad-reinterpretation", entries: [{ ...x.entry, text: "Changed interpretation of unavailable old source" }] };
  await assert.rejects(updateCtoMemory({ ...params, expectedBaseRevisionId: "memory-2", memory: altered }, context, x.platform), /unavailable delivery/);
});

test("another CTO using the same Agent receives a separate empty private memory", async () => {
  const x = await activeFixture(); await x.write();
  const otherCto = "cto-two", sessionId = randomUUID(), runId = randomUUID();
  const registry = x.values.get(mapKey(x.registryKey)) as { ctos: JsonValue[] };
  x.values.set(mapKey(x.registryKey), { ...registry, revision: 2, ctos: [...registry.ctos,
    { ...x.cto, ctoId: otherCto, sessionId }] } as JsonValue);
  const instruction = { ...x.instruction, ctoSessionId: sessionId,
    spec: { ...x.instruction.spec, revision: 2, assignedCtoId: otherCto },
    change: { ...x.instruction.change, previousRevision: 1 } };
  await createWorkstreamStore(W, P, x.state).publish({ expectedBaseRevisionId: "board-1", revision: {
    projectId: P, revisionId: "other-owner-board", workstreams: [instruction],
  } });
  const first = (await x.deliveryStore().current())!.revision;
  const requestId = ctoDeliveryRequestId(W, P, otherCto, instruction);
  await createCtoDeliveryStore(W, P, otherCto, x.state).publish({ expectedBaseRevisionId: null, revision: {
    ...first, ctoId: otherCto, revisionId: "other-cto-delivery", instruction, requestId, runId,
  } });
  const getRequest = x.platform.agents.sessions.getRequest, getRun = x.platform.agents.sessions.getRun;
  x.platform.agents.sessions.getRequest = async (session, workspace, request) => session === sessionId
    ? (assert.equal(workspace, W), assert.equal(request, requestId), { requestId, state: "submitted", runId })
    : getRequest(session, workspace, request);
  x.platform.agents.sessions.getRun = async (session, workspace, run) => session === sessionId
    ? (assert.equal(workspace, W), assert.equal(run, runId), { ...x.runs.get(x.runId)!, runId })
    : getRun(session, workspace, run);
  const result = await readCtoMemory({ ...params, ctoId: otherCto }, ctx(sessionId, runId), x.platform);
  assert.equal((result.data as { current: unknown }).current, null);
  await assert.rejects(readCtoMemory(params, ctx(sessionId, runId), x.platform));
  assert.equal((await x.store.current())!.revision.memory.entries[0]!.text, x.entry.text);
});
