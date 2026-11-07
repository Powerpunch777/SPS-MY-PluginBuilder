import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { progressTool, validationFixture, validationTool } from "./fixtures/integration-manager-platform.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function completedFixture() {
  const f = await validationFixture();
  const admitted = await validationTool().handler({ ...f.input, phase: "ci" }, f.managerContext, f.f.platform) as any;
  const reference = admitted.data.reference;
  const run = f.runs.get(reference.runId);
  const bytes = "signed-output-fixture";
  const file = { path: "reports/result.json", byteLength: Buffer.byteLength(bytes), sha256: sha(bytes) };
  run.status = "succeeded";
  run.termination = "confirmed";
  run.receipt = { digest: sha("receipt"), status: "completed", stdoutSha256: sha("stdout"), stderrSha256: sha("stderr"),
    stdoutBytes: 0, stderrBytes: 0, processExitCode: 0, timedOut: false, cancelled: false, outputLimit: false,
    appContainerVerified: true, capabilitiesCount: 0, childTerminationConfirmed: true, jobEmpty: true,
    profileCleanupSucceeded: true, sandboxCleanupSucceeded: true, fixtureMustBeRetained: false,
    outputManifest: [file], outputBytes: file.byteLength,
    outputManifestSha256: sha(`F\0${file.path}\0${file.byteLength}\0${file.sha256}`) };
  const artifact = { id: "18181818-1818-4818-8818-181818181818", companyId: f.managerContext.companyId,
    pluginKey: "com.sonparkserver.my-plugin-builder", subjectKey: reference.subjectKey, runId: run.id,
    title: "Protected Test output", kind: "sps.protected-test-output-v1", referenceUrl: null, summary: null,
    data: { schemaVersion: 1, kind: "sps.protected-test-output-v1", ...file, contentBase64: Buffer.from(bytes).toString("base64"),
      runId: run.id, approvalId: run.pins.approvalId, sourceId: run.pins.sourceId, commitSha: run.pins.commitSha,
      treeSha: run.pins.treeSha, planSha256: run.pins.planSha256, inputTreeSha256: run.pins.inputTreeSha256 },
    createdAt: "2026-11-07T00:00:00.000Z", updatedAt: "2026-11-07T00:00:00.000Z" };
  let rows: unknown = [artifact];
  let artifactReads = 0;
  Object.assign(f.f.platform, { artifacts: { async list(input: unknown) {
    artifactReads++;
    assert.deepEqual(input, { subjectKey: reference.subjectKey, runId: run.id, limit: 17 });
    return rows;
  } } });
  return { ...f, reference, run, artifact, file, get artifactReads() { return artifactReads; }, setRows(value: unknown) { rows = value; } };
}

async function observe(f: Awaited<ReturnType<typeof completedFixture>>) {
  const result = await progressTool().handler({ workstreamId: "ws-1", eventId: f.eventId }, f.managerContext, f.f.platform) as any;
  return result.data.technicalValidation[0];
}

test("receipt accessors and sparse output manifests fail closed without invoking getters or reading artifacts", async t => {
  await t.test("receipt getter", async () => {
    const f = await completedFixture();
    let getterReads = 0;
    Object.defineProperty(f.run.receipt, "outputManifest", { enumerable: true, configurable: true, get() {
      getterReads++;
      return [];
    } });
    const validation = await observe(f);
    assert.equal(validation.status, "unknown");
    assert.equal(validation.outputs, null);
    assert.equal(getterReads, 0);
    assert.equal(f.artifactReads, 0);
  });

  await t.test("sparse receipt manifest", async () => {
    const f = await completedFixture();
    f.run.receipt.outputManifest = Array(1);
    const validation = await observe(f);
    assert.equal(validation.status, "unknown");
    assert.equal(validation.outputs, null);
    assert.equal(f.artifactReads, 0);
  });
});

test("sparse Artifact responses and row getters cannot become matched output provenance", async t => {
  await t.test("sparse Artifact array", async () => {
    const f = await completedFixture();
    f.setRows(Array(1));
    const validation = await observe(f);
    assert.equal(validation.status, "passed");
    assert.equal(validation.outputs.status, "unknown");
    assert.equal(validation.outputs.qaVerdict, "not-established");
  });

  await t.test("Artifact field getter", async () => {
    const f = await completedFixture();
    let getterReads = 0;
    const row = { ...f.artifact } as Record<string, unknown>;
    Object.defineProperty(row, "id", { enumerable: true, configurable: true, get() {
      getterReads++;
      return f.artifact.id;
    } });
    f.setRows([row]);
    const validation = await observe(f);
    assert.equal(validation.status, "passed");
    assert.equal(validation.outputs.status, "unknown");
    assert.equal(validation.outputs.qaVerdict, "not-established");
    assert.equal(getterReads, 0);
  });
});

test("in-place completion receipt mutation during Artifact read is detected by the immutable snapshot", async () => {
  const f = await completedFixture();
  const priorReceipt = f.run.receipt;
  Object.assign(f.f.platform, { artifacts: { async list() {
    Object.assign(priorReceipt, { status: "timed-out", processExitCode: 1 });
    return [f.artifact];
  } } });
  const validation = await observe(f);
  assert.equal(validation.status, "unknown");
  assert.equal(validation.outputs, null);
});

test("fresh Core read after Artifact retrieval detects a revoked terminal run", async () => {
  const f = await completedFixture();
  let reads = 0;
  (f.f.platform as any).protectedTests.getRunV1 = async () => {
    reads++;
    return structuredClone(reads >= 3 ? { ...f.run, status: "cancelled" } : f.run);
  };
  const validation = await observe(f);
  assert.equal(reads, 4);
  assert.equal(validation.status, "unknown");
  assert.equal(validation.outputs, null);
});

test("in-place run pin mutation during Artifact read cannot survive the completion snapshot", async () => {
  const f = await completedFixture();
  (f.f.platform as any).artifacts.list = async () => {
    f.run.pins.approvalId = "19191919-1919-4919-8919-191919191919";
    return [f.artifact];
  };
  const validation = await observe(f);
  assert.equal(validation.status, "unknown");
  assert.equal(validation.outputs, null);
});

test("Core run pins are rechecked before output lookup and mismatches cannot trigger Artifact reads", async () => {
  const f = await completedFixture();
  f.run.pins.commitSha = "9".repeat(40);
  const validation = await observe(f);
  assert.equal(validation.status, "unknown");
  assert.equal(validation.outputs, null);
  assert.equal(f.artifactReads, 0);
});

test("legacy contexts without the Platform Artifact facade stay unsupported without Runtime fallback", async () => {
  const f = await completedFixture();
  const platform = f.f.platform as any;
  let legacyReads = 0;
  platform.runtime = { artifacts: { async list() { legacyReads++; return [f.artifact]; } } };
  platform.artifacts = undefined;
  const validation = await observe(f);
  assert.equal(validation.status, "passed");
  assert.equal(validation.outputs.status, "unsupported");
  assert.equal(validation.outputs.qaVerdict, "not-established");
  assert.equal(legacyReads, 0);
});

test("an Artifact kind label alone never promotes the stored-output check", async () => {
  const f = await completedFixture();
  f.setRows([{ ...f.artifact, data: { kind: "sps.protected-test-output-v1" } }]);
  const validation = await observe(f);
  assert.equal(validation.status, "passed");
  assert.equal(validation.outputs.status, "unknown");
  assert.equal(validation.outputs.qaVerdict, "not-established");
  assert.equal(f.enqueueCalls, 1);
});
