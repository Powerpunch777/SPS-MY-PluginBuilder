import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { A, C, CTO, P, R, S, W, ctx, digest, fixture, key, mapKey, now } from "./fixtures/cto-platform.ts";
import { createWorkstreamStore, readCtoWorkstream, acknowledgeWorkstream } from "../src/workstream-tools.ts";
import { createDesignBaselineStore } from "../src/design-baseline-tools.ts";
import { createTechnologyDecisionStore } from "../src/technology-decision-tools.ts";
import { dispatchCtoWorkstream, inspectCtoWorkstreamDelivery } from "../src/cto-workstream-delivery.ts";
import { createCtoDeliveryStore } from "../src/cto-delivery-store.ts";
import { CTO_SESSION_EXECUTION_POLICY } from "../src/session-execution-policy.ts";
import { ctoDeliveryRequestId } from "../src/domain/cto-deliveries.ts";

test("Lead admits one structured planning delivery to the registered CTO session with the pinned policy", async () => {
  const f = await fixture();
  const sent = await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  assert.equal((sent.data as { status: string }).status, "submitted");
  assert.equal(f.sends, 1);
  assert.deepEqual(f.sent[0]!.executionPolicy, CTO_SESSION_EXECUTION_POLICY);
  const event = JSON.parse(f.sent[0]!.prompt.split("\n")[1]!);
  assert.equal(event.type, "workstream.assigned"); assert.equal(event.instruction.spec.revision, 1);
  assert.equal(event.ctoId, CTO); assert.equal(event.instruction.receipt, null);
  assert.doesNotMatch(JSON.stringify(sent.data), /answer|requestedBy/);
  const again = await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  assert.equal((again.data as { status: string }).status, "existing"); assert.equal(f.sends, 1);
  const current = (await f.deliveryStore().current())!.revision;
  assert.equal(current.requestedBy.runId, R); assert.equal(current.instruction.spec.id, "ws-1");
  assert.equal((await f.deliveryStore().recent()).revisions.length, 3);
});

test("explicitly resuming a historical prepared intent retains its original two-tool policy", async () => {
  const f = await fixture();
  const requestId = ctoDeliveryRequestId(W, P, CTO, f.instruction);
  const policy = { mode: "plugin-tools-only-v1" as const,
    toolNames: ["builder.acknowledge-workstream", "builder.read-cto-workstream"] as const };
  await f.deliveryStore().publish({ expectedBaseRevisionId: null, revision: {
    schemaVersion: 1, workspaceId: W, projectId: P, ctoId: CTO, revisionId: `${requestId}:prepared`, requestId,
    boardRevisionId: "board-1", instruction: f.instruction, requestedBy: { agentId: A, sessionId: S, runId: R, selectionRevision: 1 },
    createdAt: now, phase: "prepared", runId: null, cancellationRequested: false, termination: "not_applicable",
    outputState: "not_ready", answer: null, executionPolicy: policy,
  } });
  await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  assert.deepEqual(f.sent[0]!.executionPolicy, policy);
  assert.doesNotMatch(f.sent[0]!.prompt, /builder\.read-cto-memory/);
  assert.equal(f.sends, 1);
});

test("wrong role/session, stale revision, unsupported mode and missing CAS cannot start a CTO run", async () => {
  for (const kind of ["role", "revision", "mode", "cas"] as const) {
    const f = await fixture(), before = f.writes;
    if (kind === "mode") f.platform.agents.sessions.describePolicySupport = async () => ({ schemaVersion: 1, modes: [], enforcement: "dispatch-and-run", readiness: "unknown", osIsolation: "not-certified" });
    if (kind === "cas") f.platform.state.compareAndSet = undefined;
    await assert.rejects(dispatchCtoWorkstream(kind === "revision" ? { ...f.params, specRevision: 2 } : f.params,
      kind === "role" ? ctx(C) : ctx(), f.platform));
    assert.equal(f.sends, 0); assert.equal(f.writes, before);
  }
});

test("a lost accepted send response is reconciled from the same Core request without another send", async () => {
  const f = await fixture();
  f.setAfterSend(async () => { throw new Error("Lost response"); });
  await assert.rejects(dispatchCtoWorkstream(f.params, ctx(), f.platform), /uncertain/);
  assert.equal((await f.deliveryStore().current())!.revision.phase, "uncertain");
  await f.inspect();
  assert.equal((await f.deliveryStore().current())!.revision.phase, "submitted");
  await dispatchCtoWorkstream(f.params, ctx(), f.platform); assert.equal(f.sends, 1);
});

test("a lost dispatching head reply retires the exact known-unsent marker without a later resend", async () => {
  const f = await fixture(); let crash = true;
  f.setAfterCas(async (input, value) => {
    if (crash && input.stateKey.startsWith("cto-delivery-head")) {
      const id = (value as { revisionId: string }).revisionId;
      const staged = [...f.values.values()].find(value => (value as { revision?: { revisionId: string } }).revision?.revisionId === id) as { revision?: { phase: string } };
      if (staged?.revision?.phase === "dispatching") { crash = false; throw new Error("Lost head reply"); }
    }
  });
  await assert.rejects(dispatchCtoWorkstream(f.params, ctx(), f.platform), /send was not called/);
  await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  assert.equal(f.sends, 0); assert.equal((await f.deliveryStore().current())!.revision.phase, "superseded");
});

test("a verified unsent prepared message resumes explicitly after a crash before dispatching", async () => {
  const f = await fixture(); let crash = true;
  f.setBeforeCas(async (input, value) => {
    if (crash && input.stateKey.startsWith("cto-delivery-revision") && (value as { revision?: { phase: string } }).revision?.phase === "dispatching") {
      crash = false; throw new Error("Before marking dispatch");
    }
  });
  await assert.rejects(dispatchCtoWorkstream(f.params, ctx(), f.platform), /send was not called/);
  assert.equal((await f.deliveryStore().current())!.revision.phase, "prepared");
  await dispatchCtoWorkstream(f.params, ctx(), f.platform); assert.equal(f.sends, 1);
});

test("the active CTO can receive and acknowledge only its exact Core-bound delivery run", async () => {
  const f = await fixture();
  f.setAfterSend(async runId => {
    const read = await readCtoWorkstream({ projectId: P, ctoId: CTO, workstreamId: "ws-1" }, ctx(C, runId), f.platform);
    assert.equal((read.data as { delivery: { currentInstruction: boolean } }).delivery.currentInstruction, true);
    await assert.rejects(readCtoWorkstream({ projectId: P, ctoId: CTO, workstreamId: "ws-1" }, ctx(C, randomUUID()), f.platform), /receipt|delivery/);
    await acknowledgeWorkstream({ projectId: P, ctoId: CTO, workstreamId: "ws-1", expectedBaseRevisionId: "board-1", revisionId: "board-ack",
      specRevision: 1, readiness: "ready", note: "Planning understood; no work performed." }, ctx(C, runId), f.platform);
  });
  await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  const board = (await createWorkstreamStore(W, P, f.state).current())!.revision;
  assert.equal(board.workstreams[0]!.receipt!.runId, f.sent.length && [...f.runs.keys()][0]);
  assert.equal((await f.deliveryStore().current())!.revision.phase, "submitted");
});

test("changed specifications stay separate from an earlier running delivery and cannot gain its receipt", async () => {
  const f = await fixture(); await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  const runId = [...f.runs.keys()][0]!;
  await createWorkstreamStore(W, P, f.state).publish({ expectedBaseRevisionId: "board-1", revision: { projectId: P, revisionId: "board-2",
    workstreams: [{ ...f.instruction, spec: { ...f.instruction.spec, revision: 2, goal: "Revised" }, change: { ...f.instruction.change, previousRevision: 1 } }] } });
  const old = await readCtoWorkstream({ projectId: P, ctoId: CTO, workstreamId: "ws-1" }, ctx(C, runId), f.platform);
  assert.equal((old.data as { workstream: { spec: { revision: number } } }).workstream.spec.revision, 1);
  assert.equal((old.data as { delivery: { currentInstruction: boolean } }).delivery.currentInstruction, false);
  const ack = await acknowledgeWorkstream({ projectId: P, ctoId: CTO, workstreamId: "ws-1", expectedBaseRevisionId: "board-2", revisionId: "bad-ack",
    specRevision: 2, readiness: "ready", note: "Wrong revision" }, ctx(C, runId), f.platform);
  assert.equal((ack.data as { status: string }).status, "conflict");
  const next = { ...f.params, boardRevisionId: "board-2", specRevision: 2 };
  await assert.rejects(dispatchCtoWorkstream(next, ctx(), f.platform), /active or uncertain/);
  f.runs.set(runId, { ...f.runs.get(runId)!, status: "succeeded", output: { state: "available", text: "Readiness reported." } });
  await dispatchCtoWorkstream(next, ctx(), f.platform);
  assert.equal(f.sends, 2); assert.notEqual(f.sent[0]!.requestId, f.sent[1]!.requestId);
  await assert.rejects(readCtoWorkstream({ projectId: P, ctoId: CTO, workstreamId: "ws-1" }, ctx(C, runId), f.platform), /delivery/);
});

test("cancellation keeps process termination pending and never creates a replacement run", async () => {
  const f = await fixture(); await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  await inspectCtoWorkstreamDelivery({ projectId: P, ctoId: CTO }, ctx(), f.platform, true);
  const current = (await f.deliveryStore().current())!.revision;
  assert.equal(current.phase, "cancelled"); assert.equal(current.termination, "pending");
  await inspectCtoWorkstreamDelivery({ projectId: P, ctoId: CTO }, ctx(), f.platform, true);
  assert.equal(f.cancelCalls, 1); assert.equal(f.sends, 1);
});

test("concurrent direct calls still admit only one request through the journal CAS", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([dispatchCtoWorkstream(f.params, ctx(), f.platform), dispatchCtoWorkstream(f.params, ctx(), f.platform)]);
  assert.ok(results.some(result => result.status === "fulfilled")); assert.equal(f.sends, 1);
});

test("a lost submitted-head reply is recovered from the published journal without a second provider call", async () => {
  const f = await fixture(); let lost = false;
  f.setAfterCas(async (input, value) => {
    if (lost || !input.stateKey.startsWith("cto-delivery-head")) return;
    const revisionId = (value as { revisionId: string }).revisionId;
    const entry = [...f.values.values()].find(value => (value as { revision?: { revisionId: string } }).revision?.revisionId === revisionId) as { revision?: { phase: string } };
    if (entry?.revision?.phase === "submitted") { lost = true; throw new Error("Lost accepted journal response"); }
  });
  await assert.rejects(dispatchCtoWorkstream(f.params, ctx(), f.platform), /uncertain/);
  assert.equal((await f.deliveryStore().current())!.revision.phase, "submitted");
  await f.inspect();
  await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  assert.equal(f.sends, 1);
});

test("changing the design source or registered CTO before admission prevents a provider call", async () => {
  for (const kind of ["baseline", "cto"] as const) {
    const f = await fixture();
    if (kind === "baseline") {
      await createDesignBaselineStore(W, P, f.state).publish({ expectedBaseRevisionId: "baseline-1",
        revision: { ...f.baseline, revisionId: "baseline-2" } });
    } else {
      f.setBeforeCas(async (input, value) => {
        if (input.stateKey.startsWith("cto-delivery-revision") && (value as { revision?: { phase: string } }).revision?.phase === "dispatching") {
          f.values.set(mapKey(f.registryKey), { schemaVersion: 1, workspaceId: W, projectId: P, revision: 2,
            ctos: [{ ...f.cto, status: "RETIRED" }] });
        }
      });
    }
    await assert.rejects(dispatchCtoWorkstream(f.params, ctx(), f.platform), /current|send was not called/);
    assert.equal(f.sends, 0);
  }
});

test("an unsent prepared intent can be retired without inventing a process cancellation", async () => {
  const f = await fixture();
  f.setBeforeCas(async (input, value) => {
    if (input.stateKey.startsWith("cto-delivery-revision") && (value as { revision?: { phase: string } }).revision?.phase === "dispatching") {
      throw new Error("Stop before dispatch");
    }
  });
  await assert.rejects(dispatchCtoWorkstream(f.params, ctx(), f.platform), /send was not called/);
  f.setBeforeCas(async () => {});
  await inspectCtoWorkstreamDelivery({ projectId: P, ctoId: CTO }, ctx(), f.platform, true);
  const retired = (await f.deliveryStore().current())!.revision;
  assert.equal(retired.phase, "superseded"); assert.equal(retired.runId, null);
  assert.equal(retired.cancellationRequested, false); assert.equal(retired.termination, "not_applicable");
  await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  assert.equal(f.sends, 0); assert.equal(f.cancelCalls, 0);
});

test("oversized provider answers are withheld and never exposed through the Lead delivery summary", async () => {
  const f = await fixture(); await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  const runId = [...f.runs.keys()][0]!;
  f.runs.set(runId, { ...f.runs.get(runId)!, status: "succeeded", output: { state: "available", text: "x".repeat(8193) } });
  const result = await f.inspect(), current = (await f.deliveryStore().current())!.revision;
  assert.equal(current.phase, "succeeded"); assert.equal(current.outputState, "withheld"); assert.equal(current.answer, null);
  assert.doesNotMatch(JSON.stringify(result.data), /answer|x{100}/);
});

test("another Workspace or project cannot read, cancel or create this delivery", async () => {
  const f = await fixture(); await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  const other = { ...ctx(), companyId: "66666666-6666-4666-8666-666666666666" };
  await assert.rejects(inspectCtoWorkstreamDelivery({ projectId: P, ctoId: CTO }, other, f.platform, true));
  await assert.rejects(dispatchCtoWorkstream(f.params, other, f.platform));
  const empty = await inspectCtoWorkstreamDelivery({ projectId: "other-project", ctoId: CTO }, ctx(), f.platform);
  assert.equal(empty.data, null); assert.equal(f.cancelCalls, 0); assert.equal(f.sends, 1);
});

test("a source change after marking dispatch retires only the known-unsent intent and frees the CTO lane", async () => {
  const f = await fixture(); let changed = false;
  f.setAfterCas(async (input, value) => {
    if (changed || !input.stateKey.startsWith("cto-delivery-head")) return;
    const revisionId = (value as { revisionId: string }).revisionId;
    const entry = [...f.values.values()].find(value => (value as { revision?: { revisionId: string } }).revision?.revisionId === revisionId) as { revision?: { phase: string } };
    if (entry?.revision?.phase !== "dispatching") return;
    changed = true;
    await createWorkstreamStore(W, P, f.state).publish({ expectedBaseRevisionId: "board-1", revision: { projectId: P, revisionId: "board-2",
      workstreams: [{ ...f.instruction, spec: { ...f.instruction.spec, revision: 2, goal: "New planning instruction" },
        change: { ...f.instruction.change, previousRevision: 1 } }] } });
  });
  await assert.rejects(dispatchCtoWorkstream(f.params, ctx(), f.platform), /send was not called/);
  assert.equal(f.sends, 0); assert.equal((await f.deliveryStore().current())!.revision.phase, "superseded");
  await dispatchCtoWorkstream({ ...f.params, boardRevisionId: "board-2", specRevision: 2 }, ctx(), f.platform);
  assert.equal(f.sends, 1); assert.equal((await f.deliveryStore().current())!.revision.instruction.spec.revision, 2);
});
