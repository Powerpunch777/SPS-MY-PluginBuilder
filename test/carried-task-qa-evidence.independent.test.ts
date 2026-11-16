import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readCarriedTaskQaEvidence } from "../src/builder-gates/carried-task-qa-evidence.ts";
import { createWorkstreamVerificationPublication } from "../src/builder-gates/workstream-verification-publication.ts";
import { parseQaCarryForward, qaCarryForwardPin } from "../src/builder-gates/qa-carry-forward.ts";
import { taskPacketRecordDigest } from "../src/domain/task-packets.ts";
import type { RevisionState } from "../src/solution-revision-store.ts";
import { createCarriedTaskQaIndependentFixture } from "./fixtures/carried-task-qa-independent.ts";
import { createCurrentG5TaskInputFixture } from "./fixtures/g5-current-task-input-proof.ts";
import { CTO, W } from "./fixtures/cto-platform.ts";

const scope = { workspaceId: W, projectId: W, workstreamId: "ws-1", taskId: "task-dev" };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = (record: unknown) => taskPacketRecordDigest(record, W, CTO, "ws-1");
const input = (f: Awaited<ReturnType<typeof createCarriedTaskQaIndependentFixture>>) => ({ scope, ctoId: CTO,
  runContext: f.context, platform: f.f.platform });
const verify = async (f: Awaited<ReturnType<typeof createCarriedTaskQaIndependentFixture>>) =>
  f.verifyTool.handler({ projectId: W, ctoId: CTO, workstreamId: "ws-1" }, f.context, f.f.platform) as Promise<any>;

test("actual old QA/source producers and new approved G5/ACK/packet chain yield read-only carry and registered VERIFIED provenance", async () => {
  const f = await createCarriedTaskQaIndependentFixture(), before = structuredClone(f.f.values);
  assert.equal(f.prior.sequence < f.compared.sequence && f.compared.sequence < f.current.sequence, true);
  const read = await readCarriedTaskQaEvidence(input(f));
  assert.equal(read.status, "available", JSON.stringify(read)); if (read.status !== "available") return;
  const proof = parseQaCarryForward(read.value.carryForward.proof);
  assert.equal(proof.priorTaskBoardRevisionId, f.prior.revision.revisionId);
  assert.equal(proof.comparedTaskBoardRevisionId, f.compared.revision.revisionId);
  assert.equal(proof.currentTaskBoardRevisionId, f.current.revision.revisionId);
  assert.equal(proof.handoffSha256, hash(f.handoff));
  assert.equal(proof.task.prior, digest(f.prior.revision.packets.find(row => row.packet.taskId === scope.taskId)));
  assert.equal(proof.task.current, digest(read.value.implementationRecord));
  assert.equal(proof.qa.current, digest(read.value.qaRecord));
  assert.equal(read.value.report.revisionId, f.oldReport.revisionId);
  assert.equal(read.value.coreRun.id, f.oldReport.reference.binding.runId);
  assert.equal(read.value.coreRun.qaVerdict, "not-established");
  await read.check();
  assert.deepEqual(f.f.values, before, "carry inspection is read-only and leaves all old evidence unchanged");
  assert.equal(f.wakes.length, 0);
  const result = await verify(f);
  assert.equal(result.data.status, "published", JSON.stringify(result));
  assert.equal(f.wakes.length, 1, "one stored VERIFIED wake, not a Manager model execution");
  const publication = createWorkstreamVerificationPublication(f.f.state);
  const current = await publication.readLatestCurrent({ ...scope });
  assert.equal(current.status, "current", JSON.stringify(current)); if (current.status !== "current") return;
  const carried = current.snapshot.qaEvidence.find(row => row.carryForward?.taskId === scope.taskId)!;
  assert.deepEqual(carried.carryForward, proof);
  assert.equal(carried.report.revisionId, f.oldReport.revisionId);
  const carryPin = qaCarryForwardPin(proof, carried.report);
  assert(current.snapshot.sourcePins.some(pin => JSON.stringify(pin) === JSON.stringify(carryPin)));
  assert(current.snapshot.gateDecisions.find(gate => gate.gateId === "G6")!.evidenceRefs
    .some(pin => JSON.stringify(pin) === JSON.stringify(carryPin)));
  assert.equal(current.snapshot.sourcePins.find(pin => pin.sourceId === "builder-v1:task-packet:task-dev")!.sha256, proof.task.current);
  assert.equal(current.snapshot.sourcePins.find(pin => pin.sourceId === "builder-v1:task-packet:task-qa")!.sha256, proof.qa.current);
  assert.equal((await f.reportStore().current())!.revision.revisionId, f.oldReport.revisionId);
  const guarded = await publication.readCurrentEffectGuards({ ...scope, eventId: current.snapshot.eventId });
  assert.equal(guarded.status, "current"); if (guarded.status !== "current") return;
  assert(guarded.guards.some(guard => guard.stateKey.startsWith("workstream-verification-head.v1.")
    && (guard.expectedValue as any).revisionId === current.snapshot.eventId), "effect guards bind the VERIFIED journal head itself");
  for (const prefix of ["task-packets-head.v1.", "task-qa-reports-head.v1.", "task-protected-qa-runs-head.v1."]) {
    assert(guarded.guards.some(guard => guard.stateKey.startsWith(prefix)), prefix);
  }
  assert.equal(f.f.sends, 3, "fixture contains old, compared and current CTO dispatches only; no additional Worker/Manager run");
});

test("carried check re-reads the current authorized source rather than renewing old execution authority", async () => {
  const f = await createCarriedTaskQaIndependentFixture();
  const read = await readCarriedTaskQaEvidence(input(f));
  assert.equal(read.status, "available", JSON.stringify(read)); if (read.status !== "available") return;
  let deniedRead = false;
  (f.f.platform as any).localFolders.readWorkspaceSourceGitTipV1 = async () => {
    deniedRead = true; return { status: "denied", reason: "branch_not_authorized" };
  };
  await assert.rejects(read.check());
  assert.equal(deniedRead, true);
  assert.equal(f.wakes.length, 0);
});

test("changed QA plan and latest failed assessment cannot be carried or reach registered VERIFIED", async t => {
  for (const invalid of ["qa-plan", "latest-failed"] as const) await t.test(invalid, async () => {
    const f = await createCarriedTaskQaIndependentFixture({ qaPlanChanged: invalid === "qa-plan", latestFailed: invalid === "latest-failed" });
    assert.equal((await readCarriedTaskQaEvidence(input(f))).status, "unknown");
    assert.notEqual((await verify(f)).data.status, "published");
    assert.equal(f.wakes.length, 0);
    if (invalid === "latest-failed") assert.equal((await f.reportStore().current())!.revision.verdict, "failed");
  });
});

test("current Source/grant or CTO revocation blocks both carry and registered verification", async t => {
  for (const invalid of ["moved-source", "denied-grant", "cancelled-cto"] as const) await t.test(invalid, async () => {
    const f = await createCarriedTaskQaIndependentFixture();
    const folders = (f.f.platform as any).localFolders;
    if (invalid === "moved-source") {
      const get = folders.readWorkspaceSourceGitTipV1;
      folders.readWorkspaceSourceGitTipV1 = async (...args: unknown[]) => ({ ...await get(...args), commitSha: "f".repeat(40) });
    }
    if (invalid === "denied-grant") folders.readWorkspaceSourceGitTipV1 = async () => ({ status: "denied", reason: "branch_not_authorized" });
    if (invalid === "cancelled-cto") {
      const id = f.context.runId;
      f.f.runs.set(id, { ...f.f.runs.get(id)!, status: "cancelled", cancellationRequested: true, termination: "pending" });
    }
    assert.equal((await readCarriedTaskQaEvidence(input(f))).status, "unknown");
    let result: any;
    try { result = await verify(f); }
    catch { assert.equal(invalid, "cancelled-cto"); }
    if (result) assert.notEqual(result.data.status, "published");
    assert.equal(f.wakes.length, 0);
  });
});

test("actual Core receipt read interleave with QA/report/current Task head loss cannot publish a VERIFIED wake", async t => {
  for (const prefix of ["task-qa-reports-head.v1.", "task-protected-qa-runs-head.v1.", "task-packets-head.v1."]) await t.test(prefix, async () => {
    const f = await createCarriedTaskQaIndependentFixture();
    const host = f.f.platform as any, get = host.protectedTests.getRunV1;
    let injected = false;
    host.protectedTests.getRunV1 = async (...args: unknown[]) => {
      const result = await get(...args);
      const address = [...f.f.values.keys()].find(key => JSON.parse(key).stateKey.startsWith(prefix));
      assert(address); f.f.values.delete(address); injected = true;
      return result;
    };
    const result = await verify(f);
    assert.equal(injected, true, "the race must execute after the actual historical Core read");
    assert.notEqual(result.data.status, "published");
    assert.equal(f.wakes.length, 0);
  });
});

test("current Task head changes at the actual guarded VERIFIED publication boundary block publication and wake", async () => {
  const f = await createCarriedTaskQaIndependentFixture(), state = f.f.platform.state as typeof f.f.platform.state & RevisionState;
  const original = state.guardedCompareAndSetWithJobWakeV1!;
  assert.equal(typeof original, "function");
  let injected = false;
  state.guardedCompareAndSetWithJobWakeV1 = async (key, expected, value, wake) => {
    assert(key.stateKey.startsWith("workstream-verification-head.v1."));
    const address = [...f.f.values.keys()].find(key => JSON.parse(key).stateKey.startsWith("task-packets-head.v1."));
    assert(address); f.f.values.delete(address); injected = true;
    return original(key, expected, value, wake);
  };
  const result = await verify(f);
  assert.equal(injected, true, "the hook must run at the real guarded publication call");
  assert.equal(result.data.status, "conflict", JSON.stringify(result));
  assert.equal(f.wakes.length, 0);
  assert(![...f.f.values.keys()].some(key => JSON.parse(key).stateKey.startsWith("workstream-verification-head.v1.")));
});

test("Ptolemy real G5 fixture rejects missing ACK, old-source current packet and changed QA plan before historical evidence is considered", async t => {
  for (const variant of ["no-ack", "old-source", "qa-plan"] as const) await t.test(variant, async () => {
    const f = await createCurrentG5TaskInputFixture(variant);
    const read = await readCarriedTaskQaEvidence({ scope: { ...scope, taskId: "implementation" }, ctoId: CTO,
      runContext: { companyId: W, agentId: f.input.workstream.ctoAgentId, sessionId: f.input.workstream.ctoSessionId,
        runId: f.currentDelivery.runId! }, platform: f.f.platform });
    assert.equal(read.status, "unknown");
    if (read.status === "unknown") assert.equal(read.reason, "current-g5-task-input-proof-unavailable");
  });
});
