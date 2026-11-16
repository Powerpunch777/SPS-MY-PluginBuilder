import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readProtectedOutputArtifacts } from "../src/protected-test-output-artifacts.ts";
import { progressTool, validationFixture, validationTool } from "./fixtures/integration-manager-platform.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture() {
  const f = await validationFixture();
  const admitted = await validationTool().handler({ ...f.input, phase: "ci" }, f.managerContext, f.f.platform) as any;
  const reference = admitted.data.reference, run = f.runs.get(reference.runId);
  const bytes = '{"tests":1}', file = { path: "result.json", byteLength: Buffer.byteLength(bytes), sha256: sha(bytes) };
  run.status = "succeeded"; run.termination = "confirmed";
  run.receipt = { digest: sha("receipt"), status: "completed", stdoutSha256: sha(""), stderrSha256: sha(""),
    stdoutBytes: 0, stderrBytes: 0, processExitCode: 0, timedOut: false, cancelled: false, outputLimit: false,
    appContainerVerified: true, capabilitiesCount: 0, childTerminationConfirmed: true, jobEmpty: true,
    profileCleanupSucceeded: true, sandboxCleanupSucceeded: true, fixtureMustBeRetained: false,
    outputManifest: [file], outputBytes: file.byteLength, outputManifestSha256: sha(`F\0${file.path}\0${file.byteLength}\0${file.sha256}`) };
  const expected = { workspaceId: f.managerContext.companyId, runId: run.id, subjectKey: reference.subjectKey,
    approvalId: run.pins.approvalId, sourceId: run.pins.sourceId, commitSha: run.pins.commitSha,
    treeSha: run.pins.treeSha, planSha256: run.pins.planSha256 };
  const artifact = { id: "18181818-1818-4818-8818-181818181818", companyId: expected.workspaceId,
    pluginKey: "com.sonparkserver.my-plugin-builder", subjectKey: expected.subjectKey, runId: run.id,
    title: `Protected Test output: ${file.path}`, kind: "sps.protected-test-output-v1", referenceUrl: null, summary: null,
    data: { schemaVersion: 1, kind: "sps.protected-test-output-v1", ...file, contentBase64: Buffer.from(bytes).toString("base64"),
      runId: run.id, approvalId: run.pins.approvalId, sourceId: run.pins.sourceId, commitSha: run.pins.commitSha,
      treeSha: run.pins.treeSha, planSha256: run.pins.planSha256, inputTreeSha256: run.pins.inputTreeSha256 },
    createdAt: "2026-11-07T00:00:00.000Z", updatedAt: "2026-11-07T00:00:00.000Z" };
  let reads = 0, rows: unknown[] = [artifact];
  Object.assign(f.f.platform, { artifacts: { async list(input: unknown) {
    reads++; assert.deepEqual(input, { subjectKey: reference.subjectKey, runId: run.id, limit: 17 });
    return structuredClone(rows);
  } } });
  return { ...f, expected, artifact, run, file, setRows(value: unknown[]) { rows = value; }, get reads() { return reads; } };
}

test("actual-shaped Artifact bytes are tied to the receipt and surfaced through registered Manager progress without a QA verdict", async () => {
  const f = await fixture();
  const observed = await progressTool().handler({ workstreamId: "ws-1", eventId: f.eventId }, f.managerContext, f.f.platform) as any;
  const validation = observed.data.technicalValidation[0];
  assert.equal(validation.status, "passed"); assert.equal(validation.outputs.status, "matched");
  assert.equal(validation.outputs.files[0].artifactId, f.artifact.id);
  assert.deepEqual(validation.outputs.files[0], { artifactId: f.artifact.id, ...f.file });
  assert.equal(validation.outputs.qaVerdict, "not-established");
  assert.equal(observed.data.integrationStatus, "INTEGRATING");
  assert.doesNotMatch(JSON.stringify(observed), /contentBase64|tests.*:1/);
  assert.equal(f.enqueueCalls, 1); assert.equal(f.reads, 1);
});

test("matching kind, manifest metadata or valid base64 alone never authenticate output bytes", async () => {
  const f = await fixture();
  for (const mutation of [
    { contentBase64: Buffer.from("forged bytes").toString("base64") }, { contentBase64: f.artifact.data.contentBase64 + "\n" },
    { approvalId: "19191919-1919-4919-8919-191919191919" }, { inputTreeSha256: "d".repeat(64) },
    { commitSha: "e".repeat(40) }, { planSha256: "f".repeat(64) }, { path: "unapproved.json" },
  ]) {
    f.setRows([{ ...f.artifact, data: { ...f.artifact.data, ...mutation } }]);
    assert.equal((await readProtectedOutputArtifacts(f.expected, f.f.platform)).status, "unknown");
  }
  for (const mutation of [{ companyId: "19191919-1919-4919-8919-191919191919" }, { subjectKey: "another-subject" },
    { pluginKey: "another.plugin" }, { runId: "19191919-1919-4919-8919-191919191919" }]) {
    f.setRows([{ ...f.artifact, ...mutation }]);
    assert.equal((await readProtectedOutputArtifacts(f.expected, f.f.platform)).status, "unknown");
  }
  for (const rows of [[], [f.artifact, f.artifact], Array(17).fill(f.artifact)]) {
    f.setRows(rows); assert.equal((await readProtectedOutputArtifacts(f.expected, f.f.platform)).status, "unknown");
  }
});

test("missing APIs, legacy receipts, permission failures and changed authority remain distinct from matching output provenance", async () => {
  const f = await fixture();
  const platform = f.f.platform as any;
  assert.equal((await readProtectedOutputArtifacts(f.expected, { ...platform, artifacts: undefined })).status, "unsupported");
  const savedReceipt = structuredClone(f.run.receipt);
  for (const field of ["outputManifest", "outputBytes", "outputManifestSha256"]) delete f.run.receipt[field];
  assert.equal((await readProtectedOutputArtifacts(f.expected, platform)).status, "not-produced");
  f.run.receipt = savedReceipt;
  f.run.status = "cancelled";
  assert.equal((await readProtectedOutputArtifacts(f.expected, platform)).status, "not-ready");
  f.run.status = "succeeded";
  platform.artifacts.list = async () => { throw new Error("permission denied"); };
  assert.equal((await readProtectedOutputArtifacts(f.expected, platform)).status, "unknown");
  let observations = 0;
  platform.protectedTests.getRunV1 = async () => { observations++; return structuredClone({ ...f.run,
    ...(observations > 1 ? { status: "cancelled" } : {}) }); };
  platform.artifacts.list = async () => [structuredClone(f.artifact)];
  assert.equal((await readProtectedOutputArtifacts(f.expected, platform)).status, "unknown");
});

test("a denied current Git observation never preserves an earlier technical pass", async () => {
  const f = await fixture();
  (f.f.platform as any).localFolders.readWorkspaceSourceGitTipV1 = async () => { throw new Error("Source permission revoked"); };
  const observed = await progressTool().handler({ workstreamId: "ws-1", eventId: f.eventId }, f.managerContext, f.f.platform) as any;
  assert.equal(observed.data.technicalValidation[0].status, "unknown");
  assert.equal(observed.data.technicalValidation[0].outputs, null);
  assert.equal(f.reads, 0);
  assert.equal(f.enqueueCalls, 1);
});

test("source drift during Artifact lookup invalidates the current candidate observation", async () => {
  const f = await fixture(), platform = f.f.platform as any;
  const list = platform.artifacts.list;
  platform.artifacts.list = async (input: unknown) => { const rows = await list(input); f.moveCandidate(); return rows; };
  const observed = await progressTool().handler({ workstreamId: "ws-1", eventId: f.eventId }, f.managerContext, f.f.platform) as any;
  assert.equal(observed.data.technicalValidation[0].status, "stale");
  assert.equal(observed.data.technicalValidation[0].outputs, null);
  assert.equal(f.enqueueCalls, 1);
});
