import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createVerifiedWorkstreamManagerReadHandler, managerRequestUuidForLedgerKey } from "../src/builder-gates/integration-manager-job.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const MANAGER = "44444444-4444-4444-8444-444444444444";
const SESSION = "22222222-2222-4222-8222-222222222222";
const PREVIOUS_RUN = "33333333-3333-4333-8333-333333333333";
const CONTINUATION_RUN = "55555555-5555-4555-8555-555555555555";
const CORE_REQUEST = "66666666-6666-4666-8666-666666666666";
const PROTECTED_RUN = "77777777-7777-4777-8777-777777777777";
const RECEIPT_DIGEST = "a".repeat(64);
const SUBJECT_DIGEST = "b".repeat(64);
const TERMINAL_EVENT = `sps-protected-test-terminal-v1:${PROTECTED_RUN}:${RECEIPT_DIGEST}:${SUBJECT_DIGEST}:job`;
const WORKSTREAM = "ws-current";
const VERIFIED_EVENT = "verified-event-current";
const LEDGER_KEY = `verified-consumption.v1.${createHash("sha256").update(`${WORKSPACE}\0${WORKSTREAM}`, "utf8").digest("hex")}`;
const REQUEST_KEY = `builder-ws-dispatch-v1:${"e".repeat(64)}`;
const INITIAL_RECEIPT = managerRequestUuidForLedgerKey(REQUEST_KEY);

type Lineage = {
  schemaVersion: 1;
  kind: "protected-test-terminal-event";
  requestId: string;
  previousRunId: string;
  eventId: string;
  protectedRunId: string;
  receiptDigest: string;
  subjectKeySha256: string;
};

function lineage(overrides: Partial<Lineage> = {}): Lineage {
  return {
    schemaVersion: 1,
    kind: "protected-test-terminal-event",
    requestId: CORE_REQUEST,
    previousRunId: PREVIOUS_RUN,
    eventId: TERMINAL_EVENT,
    protectedRunId: PROTECTED_RUN,
    receiptDigest: RECEIPT_DIGEST,
    subjectKeySha256: SUBJECT_DIGEST,
    ...overrides,
  };
}

function fixture(options: {
  lineage?: unknown;
  runStatus?: string;
  cancellationRequested?: boolean;
  onSecondRun?: () => { status: string; cancellationRequested?: boolean };
  requestId?: string;
  requestRunId?: string;
  onRequest?: () => void;
  acceptedContinuation?: boolean;
  initialPending?: boolean;
  onSecondVerificationRead?: () => "current" | "stale" | "changed";
  onSecondAuthorityRead?: () => "session" | "task" | boolean;
} = {}) {
  const continuationReceipt = options.acceptedContinuation ? { receiptId: CORE_REQUEST, runId: CONTINUATION_RUN } : null;
  let stored: Record<string, unknown> = {
    schemaVersion: 2,
    workspaceId: WORKSPACE,
    projectId: WORKSPACE,
    workstreamId: WORKSTREAM,
    revision: 2,
    events: [{
      eventId: VERIFIED_EVENT,
      evidenceDigest: "d".repeat(64),
      requestId: REQUEST_KEY,
      status: options.initialPending ? "pending" : "accepted",
      dispatchAttempts: 1,
      receipt: options.initialPending ? null : { receiptId: INITIAL_RECEIPT, runId: "88888888-8888-4888-8888-888888888888" },
      continuations: [{
        terminalEventId: TERMINAL_EVENT,
        protectedRunId: PROTECTED_RUN,
        receiptDigest: RECEIPT_DIGEST,
        subjectKeySha256: SUBJECT_DIGEST,
        phase: "ci",
        requestId: `builder-ws-continuation-v1:${"c".repeat(64)}`,
        previousRunId: PREVIOUS_RUN,
        status: options.acceptedContinuation ? "accepted" : "pending",
        dispatchAttempts: 1,
        recoveryWakeCount: 0,
        receipt: continuationReceipt,
      }],
    }],
  };
  const snapshot = {
    eventId: VERIFIED_EVENT,
    workspaceId: WORKSPACE,
    projectId: WORKSPACE,
    workstreamId: WORKSTREAM,
    verificationStatus: "VERIFIED" as const,
    sourcePins: [],
    gateDecisions: [],
    qaEvidence: [],
  };
  const calls: string[] = [];
  let verificationReads = 0;
  let authorityReads = 0;
  const readCurrent = async () => {
    verificationReads++;
    if (verificationReads > 1) {
      const change = options.onSecondVerificationRead?.();
      if (change === "stale") return { status: "stale" as const, reason: "changed" };
      if (change === "changed") return { status: "current" as const, workstreamId: WORKSTREAM, snapshot: {
        ...snapshot, sourcePins: [{ sourceId: "source", revisionId: "changed", sha256: "f".repeat(64) }],
      } };
    }
    return { status: "current" as const, workstreamId: WORKSTREAM, snapshot };
  };
  const resolveAuthority = async () => {
    authorityReads++;
    const changed = authorityReads > 1 ? options.onSecondAuthorityRead?.() : undefined;
    if (changed === "session" || changed === false) {
      return { agentId: MANAGER, sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", taskKey: "integration-manager-task" };
    }
    if (changed === "task") {
      return { agentId: MANAGER, sessionId: SESSION, taskKey: "different-task-key" };
    }
    return { agentId: MANAGER, sessionId: SESSION, taskKey: "integration-manager-task" };
  };
  const platform = {
    state: { async get(key: { stateKey: string }) { return key.stateKey === LEDGER_KEY ? structuredClone(stored) : null; } },
    agents: { sessions: {
      async getRequest(_sessionId: string, _companyId: string, requestId: string) {
        calls.push(`request:${requestId}`);
        options.onRequest?.();
        const expected = options.requestId ?? CORE_REQUEST;
        return requestId === expected ? { requestId: expected, state: "submitted", runId: options.requestRunId ?? CONTINUATION_RUN } : null;
      },
      async getRun(_sessionId: string, _companyId: string, runId: string) {
        calls.push(`run:${runId}`);
        const runIndex = calls.filter(call => call === `run:${runId}`).length;
        const laterRun = runIndex > 1 ? options.onSecondRun?.() : undefined;
        return {
          runId: CONTINUATION_RUN,
          status: laterRun?.status ?? options.runStatus ?? "running",
          cancellationRequested: laterRun?.cancellationRequested ?? options.cancellationRequested ?? false,
          termination: "not_applicable",
          ...(options.lineage === undefined ? { systemEvent: lineage() } : { systemEvent: options.lineage }),
        };
      },
    } },
  };
  const handler = createVerifiedWorkstreamManagerReadHandler(resolveAuthority as never, readCurrent as never);
  return {
    handler,
    platform,
    calls,
    get stored() { return structuredClone(stored); },
    replaceContinuation(update: (continuation: Record<string, unknown>) => Record<string, unknown>) {
      const event = (stored.events as Array<Record<string, unknown>>)[0]!;
      const continuations = event.continuations as Array<Record<string, unknown>>;
      stored = { ...stored, events: [{ ...event, continuations: [update(continuations[0]!)] }] };
    },
    removeContinuation() {
      const event = (stored.events as Array<Record<string, unknown>>)[0]!;
      stored = { ...stored, events: [{ ...event, continuations: [] }] };
    },
    acceptInitialRequest() {
      const event = (stored.events as Array<Record<string, unknown>>)[0]!;
      stored = { ...stored, events: [{ ...event, status: "accepted",
        receipt: { receiptId: managerRequestUuidForLedgerKey(REQUEST_KEY), runId: CONTINUATION_RUN } }] };
    },
  };
}

function runContext(runId = CONTINUATION_RUN) {
  return { companyId: WORKSPACE, agentId: MANAGER, sessionId: SESSION, runId };
}

async function read(f: ReturnType<typeof fixture>) {
  return f.handler({ workstreamId: WORKSTREAM, eventId: VERIFIED_EVENT }, runContext(), f.platform as never);
}

test("pending continuation is readable only from exact Core request and active-run lineage without ledger promotion", async () => {
  const f = fixture();
  const result = await read(f);
  assert.equal((result.data as { eventId: string }).eventId, VERIFIED_EVENT);
  assert.deepEqual(f.calls, [`run:${CONTINUATION_RUN}`, `request:${CORE_REQUEST}`, `run:${CONTINUATION_RUN}`]);
  const stored = f.stored.events as Array<{ continuations: Array<{ status: string; receipt: unknown }> }>;
  assert.equal(stored[0]!.continuations[0]!.status, "pending");
  assert.equal(stored[0]!.continuations[0]!.receipt, null, "reading must never promote the continuation ledger");
});

for (const [label, changed] of [
  ["previous Run", { previousRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
  ["terminal event", { eventId: `${TERMINAL_EVENT}:different` }],
  ["protected Run", { protectedRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
  ["receipt digest", { receiptDigest: "f".repeat(64) }],
  ["subject digest", { subjectKeySha256: "f".repeat(64) }],
] as const) {
  test(`pending continuation rejects mismatched Core ${label} lineage`, async () => {
    const f = fixture({ lineage: lineage(changed) });
    await assert.rejects(read(f), /not authorized by an exact Core request receipt|reservation changed/u);
    assert.equal(f.calls.length, 1, "mismatched lineage is rejected before request receipt lookup");
  });
}

test("legacy Run DTO without systemEvent cannot authorize a pending continuation", async () => {
  const f = fixture({ lineage: null });
  await assert.rejects(read(f), /not authorized by an exact Core request receipt/u);
  assert.equal(f.calls.length, 1);
});

test("lineage DTO with unrecognized fields is not accepted as an exact Core projection", async () => {
  const f = fixture({ lineage: { ...lineage(), extra: true } });
  await assert.rejects(read(f), /not authorized by an exact Core request receipt/u);
  assert.equal(f.calls.length, 1);
});

test("substituted submitted request or Run is rejected", async t => {
  await t.test("request ID", async () => {
    const f = fixture({ lineage: lineage({ requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }) });
    await assert.rejects(read(f), /exact Core request receipt/u);
    assert.equal(f.calls.length, 2);
  });
  await t.test("request binds another Run", async () => {
    const f = fixture({ requestRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    await assert.rejects(read(f), /exact Core request receipt/u);
    assert.equal(f.calls.length, 2);
  });
});

test("pending continuation requires the same uncancelled active Core Run on reread", async t => {
  await t.test("not running", async () => {
    const f = fixture({ runStatus: "succeeded" });
    await assert.rejects(read(f), /active, non-cancelling/u);
    assert.equal(f.calls.length, 1);
  });
  await t.test("cancellation requested", async () => {
    const f = fixture({ cancellationRequested: true });
    await assert.rejects(read(f), /active, non-cancelling/u);
    assert.equal(f.calls.length, 1);
  });
  await t.test("Run ceases to be active during the request read", async () => {
    const f = fixture({ onSecondRun: () => ({ status: "succeeded" }) });
    await assert.rejects(read(f), /active, non-cancelling/u);
    assert.deepEqual(f.calls, [`run:${CONTINUATION_RUN}`, `request:${CORE_REQUEST}`, `run:${CONTINUATION_RUN}`]);
  });
});

test("current role, verification snapshot, and pending ledger are rechecked after Core reads", async t => {
  await t.test("Manager binding changed", async () => {
    const f = fixture({ onSecondAuthorityRead: () => "session" });
    await assert.rejects(read(f), /authority changed/u);
  });
  await t.test("Manager task binding changed", async () => {
    const f = fixture({ onSecondAuthorityRead: () => "task" });
    await assert.rejects(read(f), /authority changed/u);
  });
  await t.test("verified Task/source/plan snapshot changed", async () => {
    const f = fixture({ onSecondVerificationRead: () => "stale" });
    await assert.rejects(read(f), /Verified event changed/u);
  });
  await t.test("same event now points at another source/plan snapshot", async () => {
    const f = fixture({ onSecondVerificationRead: () => "changed" });
    await assert.rejects(read(f), /Verified event changed/u);
  });
  await t.test("continuation became terminal while the Core receipt was read", async () => {
    const f = fixture({ onRequest: () => f.replaceContinuation(current => ({ ...current, status: "manager-failed",
      managerTerminalStatus: "failed" })) });
    await assert.rejects(read(f), /reservation changed/u);
  });
});

test("accepted continuation receipt and identity are rechecked after Core reads", async t => {
  await t.test("failed terminal state", async () => {
    const f = fixture({ acceptedContinuation: true, onRequest: () => f.replaceContinuation(current => ({
      ...current, status: "manager-failed", managerTerminalStatus: "failed",
    })) });
    await assert.rejects(read(f), /reservation changed/u);
  });
  await t.test("receipt substituted", async () => {
    const f = fixture({ acceptedContinuation: true, onRequest: () => f.replaceContinuation(current => ({
      ...current, receipt: { receiptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", runId: CONTINUATION_RUN },
    })) });
    await assert.rejects(read(f), /reservation changed/u);
  });
  await t.test("selected continuation removed", async () => {
    const f = fixture({ acceptedContinuation: true, onRequest: () => f.removeContinuation() });
    await assert.rejects(read(f), /reservation changed/u);
  });
});

test("ordinary first Manager request may be accepted while its exact active Run is reading", async () => {
  const f = fixture({ initialPending: true, lineage: null, requestId: managerRequestUuidForLedgerKey(REQUEST_KEY),
    onRequest: () => f.acceptInitialRequest() });
  const result = await read(f);
  assert.equal((result.data as { eventId: string }).eventId, VERIFIED_EVENT);
});

test("only the unique current pending continuation can match a Run lineage", async () => {
  const f = fixture({ lineage: lineage({ eventId: `${TERMINAL_EVENT}:other` }) });
  await assert.rejects(read(f), /not authorized by an exact Core request receipt/u);
  assert.equal(f.calls.length, 1);
});
