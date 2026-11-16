import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { workstreamInstructionDigest } from "../src/cto-delivery-store.ts";
import { taskPacketRecordDigest } from "../src/domain/task-packets.ts";
import { readCurrentG5TaskInputProof } from "../src/g5-change-impact-tools.ts";
import { CTO, W, mapKey } from "./fixtures/cto-platform.ts";
import { createCurrentG5TaskInputFixture as setup } from "./fixtures/g5-current-task-input-proof.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("current G5 proof separates old, pre-handoff and current packet digests without changing recorded inputs", async () => {
  const f = await setup(), before = structuredClone(f.f.values), proof = await f.read();
  assert.equal(proof.status, "available");
  if (proof.status !== "available") return;
  assert.equal(proof.value.handoffSha256, hash(f.handoff));
  assert.deepEqual([proof.value.priorTaskBoardRevisionId, proof.value.comparedTaskBoardRevisionId, proof.value.currentTaskBoardRevisionId],
    [f.prior.revision.revisionId, f.compared.revision.revisionId, f.current.revision.revisionId]);
  for (const [role, id] of [["task", "implementation"], ["qa", "qa"]] as const) {
    const expected = [f.prior, f.compared, f.current].map(board => taskPacketRecordDigest(
      board.revision.packets.find(row => row.packet.taskId === id)!, W, CTO, "ws-1"));
    assert.deepEqual([proof.value[role].prior, proof.value[role].compared, proof.value[role].current], expected);
    assert.equal(new Set(expected).size, 3);
    assert.match(proof.value[role].inputsSha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(f.input.workstream.change.g5Handoff!.impactSha256, f.handoff.impactSha256);
  assert.notEqual(f.prior.revision.packets[0]!.source.requestId, f.current.revision.packets[0]!.source.requestId);
  assert.equal(f.current.revision.packets[0]!.source.instructionSha256, workstreamInstructionDigest(f.input.workstream));
  await proof.check();
  assert.deepEqual(f.f.values, before, "proof and check are read-only; no report or Gate is promoted");
});

for (const variant of ["no-ack", "old-source", "linked-design", "qa-plan", "dependency-plan"] as const) {
  test(`current G5 proof is unknown for ${variant}`, async () => {
    const f = await setup(variant), before = structuredClone(f.f.values);
    assert.equal((await f.read()).status, "unknown");
    assert.deepEqual(f.f.values, before);
  });
}

test("current G5 check rejects new Task heads and an actual revoked CTO record", async () => {
  const f = await setup(), proof = await f.read();
  assert.equal(proof.status, "available");
  if (proof.status !== "available") return;
  await f.publishGroup(4, f.currentDelivery.runId!, f.current.revision.revisionId);
  await assert.rejects(proof.check);
  const latest = await setup(), second = await latest.read();
  assert.equal(second.status, "available");
  if (second.status !== "available") return;
  const registry = await latest.f.state.get(latest.f.registryKey) as { ctos: { status: string }[] };
  latest.f.values.set(mapKey(latest.f.registryKey), { ...registry, ctos: registry.ctos.map(row => ({ ...row, status: "RETIRED" })) });
  assert.equal((await latest.read()).status, "unknown");
  await assert.rejects(second.check);
});

test("a wrong current source request cannot borrow exact G5 and ACK records", async () => {
  const f = await setup();
  const result = await readCurrentG5TaskInputProof({ ...f.input, currentRequestId: f.prior.revision.packets[0]!.source.requestId });
  assert.equal(result.status, "unknown");
});

test("a boolean or a closed current CTO Run cannot supply current proof authority", async () => {
  const f = await setup();
  assert.equal((await readCurrentG5TaskInputProof({ ...f.input, assertCurrent: async () => true as never })).status, "unknown");
  const proof = await f.read();
  assert.equal(proof.status, "available");
  if (proof.status !== "available") return;
  const runId = f.currentDelivery.runId!;
  f.f.runs.set(runId, { ...f.f.runs.get(runId)!, status: "succeeded" });
  assert.equal((await f.read()).status, "unknown");
  await assert.rejects(proof.check);
});
