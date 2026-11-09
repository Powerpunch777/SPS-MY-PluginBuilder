import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { parseQaCarryForward, qaCarryForwardPin } from "../src/builder-gates/qa-carry-forward.ts";
import { consumeVerifiedWorkstream, normalizeVerifiedWorkstreamSnapshot, validVerifiedWorkstreamSnapshot,
  type EvidencePin, type VerifiedWorkstreamSnapshot } from "../src/builder-gates/workstream-verification-consumer.ts";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", projectId: "carry-project", workstreamId: "ws-1", eventId: "carry-event-1" };
const pin = (sourceId: string, revisionId: string, sha256: string): EvidencePin => ({ sourceId, revisionId, sha256 });
const report = pin("builder-v1:task-qa-report:qa-one", "old-passing-report", "a".repeat(64));
const proof = () => ({ kind: "g5-task-qa-carry-forward-v1" as const, taskId: "dev-one", qaTaskId: "qa-one",
  handoffSha256: "b".repeat(64), priorTaskBoardRevisionId: "board-prior", comparedTaskBoardRevisionId: "board-compared",
  currentTaskBoardRevisionId: "board-current", task: { prior: "1".repeat(64), compared: "2".repeat(64), current: "3".repeat(64), inputsSha256: "4".repeat(64) },
  qa: { prior: "5".repeat(64), compared: "6".repeat(64), current: "7".repeat(64), inputsSha256: "8".repeat(64) } });

// Shape-only evidence fixture. These hashes do not attest an actual G5, QA execution or approval.
function snapshot(carry = proof(), reportPin = report): VerifiedWorkstreamSnapshot {
  const carryPin = qaCarryForwardPin(carry, reportPin);
  const dev = pin(`builder-v1:task-packet:${carry.taskId}`, `${carry.taskId}:3`, carry.task.current);
  const qa = pin(`builder-v1:task-packet:${carry.qaTaskId}`, `${carry.qaTaskId}:4`, carry.qa.current);
  return { ...scope, verificationStatus: "VERIFIED", sourcePins: [reportPin, qa, carryPin, dev],
    gateDecisions: [{ gateId: "G6", verdict: "PASS", evidenceRefs: [carryPin, reportPin] },
      { gateId: "G4", verdict: "PASS", evidenceRefs: [qa, dev] }],
    qaEvidence: [{ result: "passed", report: reportPin, carryForward: carry }] };
}
function legacySnapshot(): VerifiedWorkstreamSnapshot {
  const qa = pin("qa", "rev-1", "a".repeat(64)), task = pin("task", "rev-1", "b".repeat(64));
  return { ...scope, verificationStatus: "VERIFIED", sourcePins: [task, qa],
    gateDecisions: [{ gateId: "G6", verdict: "PASS", evidenceRefs: [qa] }, { gateId: "G4", verdict: "PASS", evidenceRefs: [task] }],
    qaEvidence: [{ result: "passed", report: qa }] };
}

test("strict proof parsing returns canonical detached own-data records without granting authority", () => {
  const input = proof(), parsed = parseQaCarryForward(input);
  assert.deepEqual(parsed, input);
  assert(Object.isFrozen(parsed)); assert(Object.isFrozen(parsed.task)); assert(Object.isFrozen(parsed.qa));
  input.task.current = "f".repeat(64);
  assert.equal(parsed.task.current, "3".repeat(64));
  const reordered: Record<string, unknown> = Object.fromEntries(Object.entries(proof()).reverse());
  reordered.task = Object.fromEntries(Object.entries(proof().task).reverse());
  assert.equal(JSON.stringify(parseQaCarryForward(reordered)), JSON.stringify(parsed));
  assert.deepEqual(parseQaCarryForward(Object.assign(Object.create(null), proof())), parsed);
  assert.deepEqual(Object.keys(parsed), ["kind", "taskId", "qaTaskId", "handoffSha256", "priorTaskBoardRevisionId",
    "comparedTaskBoardRevisionId", "currentTaskBoardRevisionId", "task", "qa"]);
});

test("malformed, repeated and unbounded proof data fails without executing accessors", async t => {
  const cases: Record<string, (value: any) => unknown> = {
    "wrong-kind": value => ({ ...value, kind: "carry-forward" }),
    "extra-field": value => ({ ...value, authority: true }),
    "missing-field": value => { delete value.handoffSha256; return value; },
    "same-task-roles": value => ({ ...value, qaTaskId: value.taskId }),
    "same-board-ids": value => ({ ...value, comparedTaskBoardRevisionId: value.priorTaskBoardRevisionId }),
    "same-current-board": value => ({ ...value, currentTaskBoardRevisionId: value.comparedTaskBoardRevisionId }),
    "same-task-digests": value => { value.task.compared = value.task.prior; return value; },
    "same-qa-digests": value => { value.qa.current = value.qa.compared; return value; },
    "uppercase-digest": value => ({ ...value, handoffSha256: "A".repeat(64) }),
    "short-digest": value => { value.task.inputsSha256 = "f"; return value; },
    "extra-nested": value => { value.qa.other = "x"; return value; },
    "oversize-id": value => ({ ...value, taskId: "x".repeat(161) }),
    "control-id": value => ({ ...value, taskId: "dev\n" }),
    "blank-id": value => ({ ...value, qaTaskId: " " }),
    "symbol": value => Object.assign(value, { [Symbol("extra")]: true }),
    "custom-prototype": value => Object.setPrototypeOf(value, { unexpected: true }),
    "inherited-field": value => Object.assign(Object.create({ kind: value.kind }), { ...value, kind: undefined }),
    "root-accessor": value => Object.defineProperty(value, "kind", { enumerable: true, get() { return assert.fail("getter must not execute"); } }),
    "nested-accessor": value => { Object.defineProperty(value.task, "prior", { enumerable: true, get() { return assert.fail("nested getter must not execute"); } }); return value; },
    "nonenumerable-field": value => Object.defineProperty(value, "taskId", { enumerable: false, value: value.taskId }),
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, () => assert.throws(() => parseQaCarryForward(mutate(proof()))));
  for (const value of [null, undefined, [], "proof"]) assert.throws(() => parseQaCarryForward(value));
});

test("carry pin uses exact UTF-8 Task identity and canonical proof/report tuple", () => {
  const input = proof(), parsed = parseQaCarryForward(input), actual = qaCarryForwardPin(input, report);
  assert.deepEqual(actual, { sourceId: `builder-v1:qa-carry:${sha(input.taskId)}`,
    revisionId: input.currentTaskBoardRevisionId, sha256: sha(JSON.stringify([parsed, report])) });
  assert.equal(actual.sourceId.length, "builder-v1:qa-carry:".length + 64);
  assert(Object.isFrozen(actual));
  const caseSensitive = { ...input, taskId: "Dev-One" };
  assert.notEqual(qaCarryForwardPin(caseSensitive, report).sourceId, actual.sourceId);
  const reorderedReport = { sha256: report.sha256, revisionId: report.revisionId, sourceId: report.sourceId };
  assert.deepEqual(qaCarryForwardPin(input, reorderedReport), actual);
  assert.notEqual(qaCarryForwardPin(input, { ...report, revisionId: "new-report" }).sha256, actual.sha256);
  assert.notEqual(qaCarryForwardPin(input, { ...report, sha256: "f".repeat(64) }).sha256, actual.sha256);
  assert.throws(() => qaCarryForwardPin(input, { ...report, sourceId: "builder-v1:task-qa-report:qa-other" }));
  assert.throws(() => qaCarryForwardPin(input, Object.defineProperty({ ...report }, "sha256", { enumerable: true,
    get() { return assert.fail("report getter must not execute"); } })));
});

test("valid snapshot binds current development/QA pins plus carry pin in source inventory and G6", () => {
  const value = snapshot();
  assert.equal(validVerifiedWorkstreamSnapshot(value, scope), true);
  const normalized = normalizeVerifiedWorkstreamSnapshot(value);
  assert.deepEqual(normalized.qaEvidence[0]!.carryForward, parseQaCarryForward(proof()));
  assert.equal(validVerifiedWorkstreamSnapshot(normalized, scope), true);
  assert.equal(sha(JSON.stringify(normalized)), sha(JSON.stringify(normalizeVerifiedWorkstreamSnapshot({ ...value,
    sourcePins: [...value.sourcePins].reverse(), gateDecisions: [...value.gateDecisions].reverse() }))));
  assert.notEqual(sha(JSON.stringify(normalized)), sha(JSON.stringify(normalizeVerifiedWorkstreamSnapshot(legacySnapshot()))));
});

test("missing/swapped/current-stale pins, orphan carries and malformed optional proof are rejected", async t => {
  const cases: Record<string, (value: any) => void> = {
    "missing-dev": value => { value.sourcePins = value.sourcePins.filter((pin: EvidencePin) => pin.sourceId !== "builder-v1:task-packet:dev-one"); value.gateDecisions[1].evidenceRefs = [value.sourcePins.find((pin: EvidencePin) => pin.sourceId === "builder-v1:task-packet:qa-one")]; },
    "missing-qa": value => { value.sourcePins = value.sourcePins.filter((pin: EvidencePin) => pin.sourceId !== "builder-v1:task-packet:qa-one"); value.gateDecisions[1].evidenceRefs = [value.sourcePins.find((pin: EvidencePin) => pin.sourceId === "builder-v1:task-packet:dev-one")]; },
    "old-dev-sha": value => { value.sourcePins.find((pin: EvidencePin) => pin.sourceId === "builder-v1:task-packet:dev-one").sha256 = proof().task.prior; },
    "old-qa-sha": value => { value.sourcePins.find((pin: EvidencePin) => pin.sourceId === "builder-v1:task-packet:qa-one").sha256 = proof().qa.compared; },
    "bad-task-revision": value => { value.sourcePins.find((pin: EvidencePin) => pin.sourceId === "builder-v1:task-packet:dev-one").revisionId = "dev-other:3"; },
    "noncanonical-revision": value => { value.sourcePins.find((pin: EvidencePin) => pin.sourceId === "builder-v1:task-packet:dev-one").revisionId = "dev-one:03"; },
    "missing-carry-source": value => { value.sourcePins = value.sourcePins.filter((pin: EvidencePin) => !pin.sourceId.startsWith("builder-v1:qa-carry:")); },
    "missing-carry-g6": value => { value.gateDecisions[0].evidenceRefs = [report]; },
    "carry-only-in-g4": value => { const carry = qaCarryForwardPin(proof(), report); value.gateDecisions[1].evidenceRefs.push(carry); value.gateDecisions[0].evidenceRefs = [report]; },
    "orphan-carry": value => { delete value.qaEvidence[0].carryForward; },
    "extra-orphan-carry": value => { value.sourcePins.push(pin(`builder-v1:qa-carry:${"f".repeat(64)}`, "board-current", "f".repeat(64))); },
    "carry-forward-undefined": value => { value.qaEvidence[0].carryForward = undefined; },
    "carry-forward-null": value => { value.qaEvidence[0].carryForward = null; },
    "carry-forward-extra": value => { value.qaEvidence[0].carryForward.authority = true; },
    "qa-entry-extra": value => { value.qaEvidence[0].authority = true; },
    "role-swap": value => { const prior = value.qaEvidence[0].carryForward.task; value.qaEvidence[0].carryForward.task = value.qaEvidence[0].carryForward.qa; value.qaEvidence[0].carryForward.qa = prior; },
    "report-swap": value => { const other = pin("builder-v1:task-qa-report:qa-other", report.revisionId, report.sha256); value.qaEvidence[0].report = other; value.sourcePins[0] = other; value.gateDecisions[0].evidenceRefs[1] = other; },
    "carry-accessor": value => { Object.defineProperty(value.qaEvidence[0], "carryForward", { enumerable: true, get() { return assert.fail("carry accessor must not execute"); } }); },
    "proof-accessor": value => { Object.defineProperty(value.qaEvidence[0].carryForward.task, "current", { enumerable: true, get() { return assert.fail("proof accessor must not execute"); } }); },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, () => {
    const value = structuredClone(snapshot()); mutate(value);
    assert.equal(validVerifiedWorkstreamSnapshot(value, scope), false);
  });
});

test("duplicate carry for a Task, QA role or cross-role identity is rejected even with a distinct report pin", () => {
  for (const duplicate of ["task", "qa", "cross-role"] as const) {
    const value = snapshot(), other = proof();
    other.taskId = duplicate === "task" ? "dev-one" : duplicate === "cross-role" ? "qa-one" : "dev-two";
    other.qaTaskId = duplicate === "qa" ? "qa-one" : "qa-two";
    const reportPin = pin(`builder-v1:task-qa-report:${other.qaTaskId}`, "other-report", "f".repeat(64));
    const addition = snapshot(other, reportPin);
    const existing = new Set(value.sourcePins.map(pin => pin.sourceId));
    const pins = addition.sourcePins.filter(pin => !existing.has(pin.sourceId));
    const combined = { ...value, sourcePins: [...value.sourcePins, ...pins],
      gateDecisions: value.gateDecisions.map(gate => gate.gateId === "G6"
        ? { ...gate, evidenceRefs: [...gate.evidenceRefs, ...addition.gateDecisions[0]!.evidenceRefs
          .filter(pin => !gate.evidenceRefs.some(prior => prior.sourceId === pin.sourceId))] } : gate),
      qaEvidence: [...value.qaEvidence, ...addition.qaEvidence] };
    assert.equal(validVerifiedWorkstreamSnapshot(combined, scope), false, duplicate);
  }
});

test("all provenance fields affect the carried snapshot hash; an old carry hash cannot bind altered provenance", () => {
  const original = snapshot(), originalHash = sha(JSON.stringify(normalizeVerifiedWorkstreamSnapshot(original)));
  for (const field of ["taskId", "qaTaskId", "handoffSha256", "priorTaskBoardRevisionId", "comparedTaskBoardRevisionId", "currentTaskBoardRevisionId",
    "task.prior", "task.compared", "task.current", "task.inputsSha256", "qa.prior", "qa.compared", "qa.current", "qa.inputsSha256"] as const) {
    const value = structuredClone(original), carried = value.qaEvidence[0]!.carryForward!;
    const [role, nested] = field.split(".");
    if (nested) (carried[role as "task" | "qa"] as any)[nested] = "e".repeat(64);
    else (carried as any)[field] = field.endsWith("RevisionId") ? `changed-${field}` : "e".repeat(64);
    assert.notEqual(sha(JSON.stringify(normalizeVerifiedWorkstreamSnapshot(value))), originalHash, field);
    assert.equal(validVerifiedWorkstreamSnapshot(value, scope), false, field);
  }
});

test("ordinary snapshots retain exact old normalized JSON and never gain an undefined carry-forward field", () => {
  const value = legacySnapshot(), normalized = normalizeVerifiedWorkstreamSnapshot(value);
  const expected = { eventId: scope.eventId, workspaceId: scope.workspaceId, projectId: scope.projectId, workstreamId: scope.workstreamId,
    verificationStatus: "VERIFIED", sourcePins: [pin("qa", "rev-1", "a".repeat(64)), pin("task", "rev-1", "b".repeat(64))],
    gateDecisions: [{ gateId: "G4", verdict: "PASS", evidenceRefs: [pin("task", "rev-1", "b".repeat(64))] },
      { gateId: "G6", verdict: "PASS", evidenceRefs: [pin("qa", "rev-1", "a".repeat(64))] }],
    qaEvidence: [{ result: "passed", report: pin("qa", "rev-1", "a".repeat(64)) }] };
  assert.equal(validVerifiedWorkstreamSnapshot(value, scope), true);
  assert.equal(JSON.stringify(normalized), JSON.stringify(expected));
  assert.equal(sha(JSON.stringify(normalized)), "b9302ebffc6f6bec8c01fe26521ae8164827d5e9e13345150071f14298400843",
    "exact normalized digest observed from the pre-change 2672b01 consumer");
  assert.equal(Object.hasOwn(normalized.qaEvidence[0]!, "carryForward"), false);
});

test("canonical carry provenance reaches Manager reservation digest and changed proof cannot dispatch under that prior reservation", async () => {
  const values = new Map<string, JsonValue>();
  const keyId = (key: SpsStateKey) => JSON.stringify(key);
  const state = { async get(key: SpsStateKey) { return structuredClone(values.get(keyId(key)) ?? null); },
    async compareAndSet(key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
      const prior = values.get(keyId(key));
      const swapped = expected.exists ? JSON.stringify(prior) === JSON.stringify(expected.value) : prior === undefined;
      if (swapped) values.set(keyId(key), structuredClone(value));
      return { swapped };
    } };
  let value = snapshot(), dispatches = 0;
  const read = async () => ({ status: "current" as const, snapshot: value });
  const reserved = await consumeVerifiedWorkstream(scope, state, read);
  assert.equal(reserved.status, "pending");
  assert.equal(reserved.evidenceDigest, sha(JSON.stringify(normalizeVerifiedWorkstreamSnapshot(value))));
  const changed = { ...proof(), handoffSha256: "e".repeat(64) };
  value = snapshot(changed);
  const result = await consumeVerifiedWorkstream(scope, state, read, {
    async dispatch() { dispatches++; },
    async readReceipt() { return { status: "uncertain", reason: "fixture" }; },
  });
  assert.equal(result.status, "stale"); assert.equal(dispatches, 0);
  assert.equal(result.evidenceDigest, reserved.evidenceDigest);
});
