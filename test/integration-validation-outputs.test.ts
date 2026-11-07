import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { progressTool, validationFixture, validationTool } from "./fixtures/integration-manager-platform.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

test("registered candidate observation accepts only the exact sanitized output metadata and never file bytes", async () => {
  const f = await validationFixture();
  const result = await validationTool().handler({ ...f.input, phase: "ci" }, f.managerContext, f.f.platform) as any;
  const run = f.runs.get(result.data.reference.runId);
  const file = { path: "result.json", byteLength: 5, sha256: hash("bytes") };
  run.status = "succeeded"; run.termination = "confirmed";
  run.receipt = { digest: hash("technical receipt"), status: "completed", stdoutSha256: hash("stdout"), stderrSha256: hash("stderr"),
    stdoutBytes: 0, stderrBytes: 0, processExitCode: 0, timedOut: false, cancelled: false, outputLimit: false,
    appContainerVerified: true, capabilitiesCount: 0, childTerminationConfirmed: true, jobEmpty: true,
    profileCleanupSucceeded: true, sandboxCleanupSucceeded: true, fixtureMustBeRetained: false,
    outputManifest: [file], outputBytes: 5, outputManifestSha256: hash(`F\0${file.path}\0${file.byteLength}\0${file.sha256}`) };
  const scope = { workstreamId: "ws-1", eventId: f.eventId };
  const observed = await progressTool().handler(scope, f.managerContext, f.f.platform) as any;
  assert.equal(observed.data.technicalValidation[0].status, "passed");
  assert.equal(observed.data.technicalValidation[0].qaVerdict, "not-established");
  assert.equal(observed.data.integrationStatus, "INTEGRATING");
  assert.equal(f.enqueueCalls, 1);
  run.receipt.outputManifest[0] = { ...file, contentBase64: "Ynl0ZXM=" };
  const rawBytes = await progressTool().handler(scope, f.managerContext, f.f.platform) as any;
  assert.equal(rawBytes.data.technicalValidation[0].status, "unknown");
  delete run.receipt.outputManifest[0].contentBase64;
  run.receipt.outputManifestSha256 = hash("forged output inventory");
  const changed = await progressTool().handler(scope, f.managerContext, f.f.platform) as any;
  assert.equal(changed.data.technicalValidation[0].status, "unknown");
  assert.equal(f.enqueueCalls, 1);
});
