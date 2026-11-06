import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { consumeVerifiedWorkstream, type ManagerDispatchPort, type ManagerDispatchReceiptRead,
  type ManagerDispatchRequest, type VerifiedSnapshotRead, type VerifiedSnapshotReader } from "../src/builder-gates/workstream-verification-consumer.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const scope = { workspaceId: WORKSPACE, projectId: "builder-project", workstreamId: "ws-core", eventId: "event-1" };
const pin = (sourceId: string) => ({ sourceId, revisionId: "rev-1", sha256: "a".repeat(64) });
const snapshot = {
  ...scope, verificationStatus: "VERIFIED" as const,
  sourcePins: [pin("baseline"), pin("workstream"), pin("task"), pin("qa")],
  gateDecisions: [
    { gateId: "G4" as const, verdict: "PASS" as const, evidenceRefs: [pin("task")] },
    { gateId: "G6" as const, verdict: "PASS" as const, evidenceRefs: [pin("qa")] },
  ],
  qaEvidence: [{ result: "passed" as const, report: pin("qa") }],
};
const current: VerifiedSnapshotRead = { status: "current", snapshot };

// TEST_FIXTURE_ONLY: all Host state, current-proof reads, Manager receipts, and dispatches are synthetic.
function fixture() {
  const values = new Map<string, JsonValue>();
  const keyId = (key: SpsStateKey) => `${key.scopeId}/${key.namespace}/${key.stateKey}`;
  const state = {
    async get(key: SpsStateKey) { return structuredClone(values.get(keyId(key)) ?? null); },
    async compareAndSet(key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
      const id = keyId(key), present = values.has(id), raw = values.get(id);
      const match = expected.exists ? present && JSON.stringify(raw) === JSON.stringify(expected.value) : !present;
      if (match) values.set(id, structuredClone(value));
      return { swapped: match };
    },
  };
  const dispatches: ManagerDispatchRequest[] = [];
  const receiptReads: string[] = [];
  let currentRead: VerifiedSnapshotRead = current;
  let readSequence: VerifiedSnapshotRead[] | null = null;
  let receiptReader: (requestId: string) => ManagerDispatchReceiptRead = () => ({ status: "uncertain", reason: "fixture-unconfigured" });
  let dispatchThrows = false;
  const readCurrent: VerifiedSnapshotReader = async () => {
    if (readSequence?.length) currentRead = readSequence.shift()!;
    return currentRead;
  };
  const manager: ManagerDispatchPort = {
    async dispatch(request) { dispatches.push(request); if (dispatchThrows) throw new Error("lost dispatch response"); },
    async readReceipt(requestId) { receiptReads.push(requestId); return receiptReader(requestId); },
  };
  const accepted = (requestId: string): ManagerDispatchReceiptRead => ({ status: "accepted", requestId,
    receiptId: "manager-receipt-1", runId: "manager-run-1" });
  const requestKey = () => {
    const key = [...values.keys()][0];
    const ledger = key ? values.get(key) as { events?: Array<{ requestId: string | null }> } : undefined;
    return ledger?.events?.[0]?.requestId ?? dispatches[0]?.requestId ?? "";
  };
  const legacyKey = `${WORKSPACE}/sonpark.my-builder/verified-consumption.v1.${createHash("sha256").update(`${scope.projectId}\0${scope.workstreamId}`, "utf8").digest("hex")}`;
  return {
    state, values, manager, dispatches, receiptReads, readCurrent,
    setCurrent(value: VerifiedSnapshotRead) { currentRead = value; readSequence = null; },
    setReadSequence(values: VerifiedSnapshotRead[]) { readSequence = [...values]; },
    setReceiptReader(value: (requestId: string) => ManagerDispatchReceiptRead) { receiptReader = value; },
    setDispatchThrows(value: boolean) { dispatchThrows = value; },
    accepted, requestKey, legacyKey,
  };
}

test("reserves exact current evidence, confirms acceptance by readback, and replays without redispatch", async () => {
  const f = fixture();
  f.setReceiptReader(requestId => f.accepted(requestId));
  const first = await consumeVerifiedWorkstream(scope, f.state, f.readCurrent, f.manager);
  assert.equal(first.status, "accepted");
  assert.equal(first.reason, "manager-acceptance-receipt-confirmed-not-completion");
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.dispatches[0]?.eventId, scope.eventId);
  assert.equal(f.dispatches[0]?.snapshot.verificationStatus, "VERIFIED");
  const ledger = [...f.values.values()][0] as { schemaVersion: number; events: Array<{ status: string; evidenceDigest: string; requestId: string; receipt: unknown }> };
  assert.equal(ledger.schemaVersion, 2);
  assert.equal(ledger.events[0]?.status, "accepted");
  assert.ok(ledger.events[0]?.evidenceDigest);
  assert.ok(ledger.events[0]?.receipt);
  f.setCurrent({ status: "current", snapshot: { ...snapshot,
    sourcePins: [...snapshot.sourcePins].reverse(), gateDecisions: [...snapshot.gateDecisions].reverse() } });
  const replay = await consumeVerifiedWorkstream(scope, f.state, f.readCurrent, f.manager);
  assert.equal(replay.status, "accepted");
  assert.equal(f.dispatches.length, 1);
  assert.equal(replay.evidenceDigest, first.evidenceDigest, "canonical evidence digest ignores harmless collection ordering");
  assert.equal(f.receiptReads.length, 2);
  assert.equal(JSON.stringify(ledger).includes("completed"), false, "acceptance must not claim Manager completion");
});

test("lost dispatch response stays pending/uncertain until authoritative readback; timeout alone never resends", async () => {
  const f = fixture();
  f.setDispatchThrows(true);
  f.setReceiptReader(() => ({ status: "pending", requestId: f.requestKey() }));
  const first = await consumeVerifiedWorkstream(scope, f.state, f.readCurrent, f.manager);
  assert.equal(first.status, "pending");
  assert.equal(f.dispatches.length, 1);

  f.setDispatchThrows(false);
  f.setReceiptReader(requestId => f.accepted(requestId));
  const replay = await consumeVerifiedWorkstream(scope, f.state, f.readCurrent, f.manager);
  assert.equal(replay.status, "accepted");
  assert.equal(f.dispatches.length, 1, "the confirmed receipt avoids a second effect");
});

test("uncertain timeout does not resend in-call; authoritative absence permits only a bounded same-key retry", async () => {
  const f = fixture();
  let readCount = 0;
  f.setDispatchThrows(true);
  f.setReceiptReader(requestId => ++readCount === 1 ? { status: "uncertain", reason: "read timeout" }
    : readCount === 2 ? { status: "not-found", authoritative: true } : f.accepted(requestId));
  const first = await consumeVerifiedWorkstream(scope, f.state, f.readCurrent, f.manager);
  assert.equal(first.status, "uncertain");
  assert.equal(f.dispatches.length, 1, "a timeout does not cause an immediate retry");

  f.setDispatchThrows(false);
  const second = await consumeVerifiedWorkstream(scope, f.state, f.readCurrent, f.manager);
  assert.equal(second.status, "accepted");
  assert.equal(f.dispatches.length, 2);
  assert.equal(f.dispatches[0]?.requestId, f.dispatches[1]?.requestId, "retries reuse the reservation idempotency key");

  const third = await consumeVerifiedWorkstream(scope, f.state, f.readCurrent, f.manager);
  assert.equal(third.status, "accepted");
  assert.equal(f.dispatches.length, 2);
});

test("stale evidence, revocation before effect, or changed evidence on replay never dispatches", async () => {
  const stale = fixture();
  stale.setCurrent({ status: "stale" });
  assert.equal((await consumeVerifiedWorkstream(scope, stale.state, stale.readCurrent, stale.manager)).status, "stale");
  assert.equal(stale.values.size, 0);
  assert.equal(stale.dispatches.length, 0);

  const revoked = fixture();
  revoked.setReadSequence([current, { status: "stale" }]);
  assert.equal((await consumeVerifiedWorkstream(scope, revoked.state, revoked.readCurrent, revoked.manager)).status, "stale");
  assert.equal(revoked.dispatches.length, 0, "evidence is reread immediately before the Manager effect");
  assert.ok(revoked.values.size, "the reservation remains for safe receipt reconciliation");

  const changed = fixture();
  changed.setDispatchThrows(true);
  changed.setReceiptReader(() => ({ status: "uncertain", reason: "lost response" }));
  assert.equal((await consumeVerifiedWorkstream(scope, changed.state, changed.readCurrent, changed.manager)).status, "uncertain");
  const changedSnapshot = { ...snapshot, sourcePins: [...snapshot.sourcePins, pin("additional-current-source")] };
  changed.setCurrent({ status: "current", snapshot: changedSnapshot });
  changed.setReceiptReader(() => ({ status: "not-found", authoritative: true }));
  const replay = await consumeVerifiedWorkstream(scope, changed.state, changed.readCurrent, changed.manager);
  assert.equal(replay.status, "stale");
  assert.equal(changed.dispatches.length, 1);
});

test("legacy consumed entries without an idempotency key remain uncertain and are never replayed", async () => {
  const f = fixture();
  f.values.set(f.legacyKey, { schemaVersion: 1, workspaceId: WORKSPACE, projectId: scope.projectId,
    workstreamId: scope.workstreamId, revision: 1, eventIds: [scope.eventId] });
  const result = await consumeVerifiedWorkstream(scope, f.state, f.readCurrent, f.manager);
  assert.equal(result.status, "uncertain");
  assert.equal(result.reason, "legacy-event-has-no-safe-idempotency-key");
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.receiptReads.length, 0);

  const oversized = fixture();
  const eventIds = Array.from({ length: 1000 }, (_, index) => `${String(index).padStart(4, "0")}-${"x".repeat(150)}`);
  oversized.values.set(oversized.legacyKey, { schemaVersion: 1, workspaceId: WORKSPACE, projectId: scope.projectId,
    workstreamId: scope.workstreamId, revision: 1000, eventIds });
  const bounded = await consumeVerifiedWorkstream(scope, oversized.state, oversized.readCurrent, oversized.manager);
  assert.equal(bounded.status, "unknown");
  assert.equal(bounded.reason, "manager-dispatch-ledger-capacity");
  assert.equal(oversized.dispatches.length, 0);
});

test("unavailable binding, malformed receipt, and CAS conflict never claim acceptance", async () => {
  const absentPort = fixture();
  assert.equal((await consumeVerifiedWorkstream(scope, absentPort.state, absentPort.readCurrent)).reason, "manager-dispatch-port-unavailable");
  assert.equal(absentPort.values.size, 0);

  const malformed = fixture();
  malformed.setReceiptReader(requestId => ({ status: "accepted", requestId: `${requestId}-wrong`, receiptId: "receipt", runId: "run" }));
  assert.equal((await consumeVerifiedWorkstream(scope, malformed.state, malformed.readCurrent, malformed.manager)).status, "uncertain");
  assert.equal(malformed.dispatches.length, 1);

  const contention = fixture();
  contention.state.compareAndSet = async () => ({ swapped: false });
  assert.equal((await consumeVerifiedWorkstream(scope, contention.state, contention.readCurrent, contention.manager)).status, "conflict");
  assert.equal(contention.dispatches.length, 0, "no effect occurs unless its exact reservation CAS succeeds");
});

test("malformed, duplicate, cross-scope, or unpinned G4/G6 evidence never reaches the port", async () => {
  const malformedSnapshots: unknown[] = [
    { ...snapshot, gateDecisions: [null, snapshot.gateDecisions[1]] },
    { ...snapshot, gateDecisions: [...snapshot.gateDecisions, snapshot.gateDecisions[1]] },
    { ...snapshot, qaEvidence: [] },
    { ...snapshot, qaEvidence: [...snapshot.qaEvidence, snapshot.qaEvidence[0]] },
    { ...snapshot, sourcePins: [...snapshot.sourcePins, snapshot.sourcePins[0]] },
    { ...snapshot, projectId: "other-project" },
    { ...snapshot, gateDecisions: [{ ...snapshot.gateDecisions[0], evidenceRefs: [pin("not-current")] }, snapshot.gateDecisions[1]] },
  ];
  for (const candidate of malformedSnapshots) {
    const f = fixture();
    const reader: VerifiedSnapshotReader = async () => ({ status: "current", snapshot: candidate as typeof snapshot });
    assert.equal((await consumeVerifiedWorkstream(scope, f.state, reader, f.manager)).status, "unknown");
    assert.equal(f.dispatches.length, 0);
    assert.equal(f.values.size, 0);
  }
});
