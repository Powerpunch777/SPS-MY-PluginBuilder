import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertProtectedOutputMetadata } from "../src/protected-test-output-metadata.ts";
import { progressTool, validationFixture, validationTool } from "./fixtures/integration-manager-platform.ts";

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const entry = (path: string, bytes = 1) => ({ path, byteLength: bytes, sha256: sha(`fixture:${path}`) });
function metadata(rows: unknown[], outputBytes = rows.reduce<number>((total, row) => total + (row as { byteLength: number }).byteLength, 0)):
  { outputManifest: unknown[]; outputBytes: number; outputManifestSha256: string } {
  return {
  outputManifest: rows,
  outputBytes,
  outputManifestSha256: sha(rows.map(row => {
    const file = row as { path: string; byteLength: number; sha256: string };
    return `F\0${file.path}\0${file.byteLength}\0${file.sha256}`;
  }).sort().join("\n")),
  };
}

test("rejects sparse, accessor-backed, decorated, and partial metadata without evaluating getters", () => {
  const valid = entry("result.json");
  const sparse = new Array(1);
  assert.throws(() => assertProtectedOutputMetadata(metadata(sparse, 0)));

  let reads = 0;
  const accessorArray = [valid];
  Object.defineProperty(accessorArray, "0", { enumerable: true, get() { reads++; return valid; } });
  const accessorReceipt = metadata([valid]);
  accessorReceipt.outputManifest = accessorArray;
  assert.throws(() => assertProtectedOutputMetadata(accessorReceipt));
  assert.equal(reads, 0);

  const decorated = [valid] as unknown[] & { extra?: unknown };
  decorated.extra = "unexpected";
  assert.throws(() => assertProtectedOutputMetadata(metadata(decorated)));

  const complete = metadata([valid]);
  for (let mask = 1; mask < 7; mask++) {
    const partial: Record<string, unknown> = {};
    const fields = ["outputManifest", "outputBytes", "outputManifestSha256"] as const;
    for (let bit = 0; bit < fields.length; bit++) if (mask & (1 << bit)) partial[fields[bit]] = complete[fields[bit]];
    assert.throws(() => assertProtectedOutputMetadata(partial));
  }
});

test("rejects digest/count disagreement, unsorted entries, case-fold collisions, and raw bytes", () => {
  const first = entry("a.json"), last = entry("z.json");
  const sorted = metadata([first, last]);
  assertProtectedOutputMetadata(sorted);
  assert.throws(() => assertProtectedOutputMetadata({ ...sorted, outputBytes: sorted.outputBytes + 1 }));
  assert.throws(() => assertProtectedOutputMetadata({ ...sorted, outputManifestSha256: sha("wrong inventory") }));
  assert.throws(() => assertProtectedOutputMetadata(metadata([last, first])));
  assert.throws(() => assertProtectedOutputMetadata(metadata([entry("dist/Result.txt"), entry("dist/result.txt")])));
  assert.throws(() => assertProtectedOutputMetadata(metadata([{ ...first, contentBase64: "c2VjcmV0" }])));
  assert.throws(() => assertProtectedOutputMetadata(metadata([{ ...first, contents: "raw bytes" }])));
});

test("accepts a legacy receipt without output metadata without promoting technical status to QA", async () => {
  const f = await validationFixture();
  const queued = await validationTool().handler({ ...f.input, phase: "ci" }, f.managerContext, f.f.platform) as any;
  const run = f.runs.get(queued.data.reference.runId);
  run.status = "succeeded";
  run.termination = "confirmed";
  run.receipt = { digest: sha("legacy receipt"), status: "completed", stdoutSha256: sha("stdout"), stderrSha256: null,
    stdoutBytes: 0, stderrBytes: 0, processExitCode: 0, timedOut: false, cancelled: false, outputLimit: false,
    appContainerVerified: true, capabilitiesCount: 0, childTerminationConfirmed: true, jobEmpty: true,
    profileCleanupSucceeded: true, sandboxCleanupSucceeded: true, fixtureMustBeRetained: false };
  assertProtectedOutputMetadata(run.receipt);

  const progress = await progressTool().handler({ workstreamId: "ws-1", eventId: f.eventId }, f.managerContext, f.f.platform) as any;
  assert.equal(progress.data.technicalValidation[0].status, "passed");
  assert.equal(progress.data.technicalValidation[0].qaVerdict, "not-established");
  assert.equal(progress.data.integrationStatus, "INTEGRATING");
  assert.equal(f.enqueueCalls, 1);
});
