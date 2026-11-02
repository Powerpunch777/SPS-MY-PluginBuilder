import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey, SpsAgentSessionRunResult } from "@sonparkserver/plugin-sdk/platform";
import { createWorkstreamStore, readCtoWorkstream, acknowledgeWorkstream } from "../src/workstream-tools.ts";
import { createDesignBaselineStore } from "../src/design-baseline-tools.ts";
import { createTechnologyDecisionStore } from "../src/technology-decision-tools.ts";
import { dispatchCtoWorkstream, inspectCtoWorkstreamDelivery } from "../src/cto-workstream-delivery.ts";
import { createCtoDeliveryStore } from "../src/cto-delivery-store.ts";
import { CTO_SESSION_EXECUTION_POLICY } from "../src/session-execution-policy.ts";

const W = "11111111-1111-4111-8111-111111111111", A = "22222222-2222-4222-8222-222222222222";
const S = "33333333-3333-4333-8333-333333333333", C = "44444444-4444-4444-8444-444444444444";
const R = "55555555-5555-4555-8555-555555555555", P = "fixture-project", CTO = "cto-one";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const key = (stateKey: string): SpsStateKey => ({ scopeKind: "company", scopeId: W, namespace: "sonpark.my-builder", stateKey });
const mapKey = (input: SpsStateKey) => JSON.stringify(input);
const ctx = (sessionId = S, runId = R) => ({ companyId: W, agentId: A, sessionId, runId });
const now = "2026-11-02T01:02:03.004Z";

async function fixture() {
  const values = new Map<string, JsonValue>();
  let writes = 0, sends = 0, cancelCalls = 0;
  let beforeCas = async (_input: SpsStateKey, _value: JsonValue) => {};
  let afterCas = async (_input: SpsStateKey, _value: JsonValue) => {};
  let afterSend = async (_runId: string) => {};
  const receipts = new Map<string, { requestId: string; state: "submitted"; runId: string }>();
  const runs = new Map<string, SpsAgentSessionRunResult>();
  const sent: Array<{ sessionId: string; requestId: string; prompt: string; executionPolicy: unknown }> = [];
  const state = {
    async get(input: SpsStateKey) { return structuredClone(values.get(mapKey(input)) ?? null); },
    async set() { throw new Error("No state.set fallback"); },
    async compareAndSet(input: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
      await beforeCas(input, value);
      const old = values.get(mapKey(input));
      const swapped = expected.exists ? old !== undefined && JSON.stringify(old) === JSON.stringify(expected.value) : old === undefined;
      if (swapped) { writes++; values.set(mapKey(input), structuredClone(value)); await afterCas(input, value); }
      return { swapped };
    },
  };
  const sessions = {
    async describePolicySupport() { return { schemaVersion: 1, modes: ["plugin-tools-only-v1"], enforcement: "dispatch-and-run", readiness: "unknown", osIsolation: "not-certified" }; },
    async getRequest(sessionId: string, workspaceId: string, requestId: string) {
      assert.equal(workspaceId, W); assert.equal(sessionId, C);
      return structuredClone(receipts.get(requestId) ?? null);
    },
    async sendMessage(sessionId: string, workspaceId: string, options: { requestId: string; prompt: string; executionPolicy: unknown }) {
      assert.equal(workspaceId, W); assert.equal(sessionId, C);
      sends++; sent.push({ sessionId, ...options });
      const runId = randomUUID();
      receipts.set(options.requestId, { requestId: options.requestId, state: "submitted", runId });
      runs.set(runId, { runId, status: "running", cancellationRequested: false, termination: "not_applicable", error: null, errorCode: null,
        output: { state: "not_ready", text: null } });
      await afterSend(runId);
      return { runId };
    },
    async getRun(sessionId: string, workspaceId: string, runId: string) {
      assert.equal(sessionId, C); assert.equal(workspaceId, W);
      const value = runs.get(runId); if (!value) throw new Error("Unknown run"); return structuredClone(value);
    },
    async cancel(sessionId: string, workspaceId: string, runId: string) {
      assert.equal(sessionId, C); assert.equal(workspaceId, W); cancelCalls++;
      const value: SpsAgentSessionRunResult = { ...runs.get(runId)!, status: "cancelled", cancellationRequested: true,
        termination: "pending", output: { state: "withheld", text: null, reason: "not_successful" } };
      runs.set(runId, value); return structuredClone(value);
    },
  };
  const platform = { state, agents: { sessions } } as unknown as SpsPlatformInvocationContext;
  values.set(mapKey(key("lead-agent.v1")), { workspaceId: W, revision: 1, selectedAgentId: A });
  values.set(mapKey(key("lead-sessions.v1.1")), { workspaceId: W, selectionRevision: 1, agentId: A,
    sessions: { main: S, decisions: null, "cto-inbox": null } });
  const registryKey = key(`project-ctos.v1.${createHash("sha256").update(P).digest("hex")}`);
  const cto = { ctoId: CTO, displayName: "CTO", agentId: A, sessionId: C, status: "ACTIVE", createdAt: now,
    createdBy: { agentId: A, sessionId: S, runId: R, selectionRevision: 1 } };
  values.set(mapKey(registryKey), { schemaVersion: 1, workspaceId: W, projectId: P, revision: 1, ctos: [cto] });
  const baseline = { projectId: P, revisionId: "baseline-1", sourceDraftRevisionId: "draft-1", draftDigest: "a".repeat(64), createdAt: now,
    author: { agentId: A, sessionId: S, runId: R, selectionRevision: 1 },
    userDecision: { sourceId: `lead-turn:${R}`, sourceSha256: "b".repeat(64), interpretation: "Fixture planning decision" },
    specification: { projectId: P, revisionId: "spec-1", productTier: "S", requirements: [{ id: "REQ-1", description: "Feature", acceptanceCriteriaIds: ["AC-1"] }],
      targets: ["desktop"], dataPolicyRef: "local-policy", approvalEvidenceRef: `lead-turn:${R}` },
    graph: { approvedSpecRevisionId: "spec-1", graphRevisionId: "graph-1", entities: [{ id: "feature", kind: "feature", specRef: "REQ-1" }], relations: [], viewLayoutRef: "layout-1" } };
  const baselineStore = createDesignBaselineStore(W, P, state);
  await baselineStore.publish({ expectedBaseRevisionId: null, revision: baseline });
  const storedBaseline = (await baselineStore.current())!.revision;
  await createTechnologyDecisionStore(W, P, state).publish({ expectedBaseRevisionId: null, revision: {
    register: { projectId: P, revisionId: "tech-1", sourceBaselineRevisionId: "baseline-1", sourceSpecRevisionId: "spec-1", sourceGraphRevisionId: "graph-1", entries: [] },
    baselineDigest: digest(storedBaseline), author: baseline.author, createdAt: now } });
  const tech = (await createTechnologyDecisionStore(W, P, state).current())!.revision;
  const instruction = { spec: { projectId: P, id: "ws-1", revision: 1, sourceSpecRevisionId: "spec-1", assignedCtoId: CTO,
    title: "Feature", goal: "Plan the feature", scopeNodeIds: ["feature"], included: ["Feature"], excluded: [], dependencies: [], interfaceContracts: [],
    technologyDecisionsRef: "tech-1", reuseCandidates: [], acceptance: ["Test"], evidenceRequired: ["Evidence"], openQuestions: [] },
    sourceBaselineRevisionId: "baseline-1", baselineDigest: digest(storedBaseline), technologyDigest: digest(tech), ctoAgentId: A, ctoSessionId: C,
    author: baseline.author, createdAt: now, change: { previousRevision: null, reason: "Initial", diff: "Create", impactNodeIds: ["feature"], impactInterfaceContracts: [], impactTaskIds: [], effectiveFrom: "After receipt" }, receipt: null };
  await createWorkstreamStore(W, P, state).publish({ expectedBaseRevisionId: null, revision: { projectId: P, revisionId: "board-1", workstreams: [instruction] } });
  const params = { projectId: P, workstreamId: "ws-1", specRevision: 1, boardRevisionId: "board-1" };
  const inspect = () => inspectCtoWorkstreamDelivery({ projectId: P, ctoId: CTO }, ctx(), platform);
  const deliveryStore = () => createCtoDeliveryStore(W, P, CTO, state);
  return { platform, state, values, receipts, runs, sent, params, inspect, deliveryStore, instruction, baseline, registryKey, cto,
    get sends() { return sends; }, get writes() { return writes; }, get cancelCalls() { return cancelCalls; },
    setBeforeCas(hook: typeof beforeCas) { beforeCas = hook; }, setAfterCas(hook: typeof afterCas) { afterCas = hook; },
    setAfterSend(hook: typeof afterSend) { afterSend = hook; } };
}

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
