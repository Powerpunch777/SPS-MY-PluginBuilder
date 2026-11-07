import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readDeliveryInventory } from "../src/delivery-evidence/delivery-inventory.ts";
import { W, now } from "./fixtures/cto-platform.ts";
import { progressTool, validationFixture, validationTool } from "./fixtures/integration-manager-platform.ts";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const objectId = (type: string, bytes: Buffer) =>
  createHash("sha1").update(`${type} ${bytes.length}\0`, "ascii").update(bytes).digest("hex");
const manifestPath = "inventory.json";
const file = { path: "app.js", source: "git", classification: "source-launcher", target: "desktop", requirementIds: ["REQ-1"] };
const output = { path: "bundle.bin", source: "ci-output", classification: "build-bundle", target: "desktop", requirementIds: ["REQ-1"] };

// Exact Git object bytes and protected Run/Artifact DTOs, not live Core or CI.
async function setup(files = [file, output], includeArtifact = true) {
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, files }));
  const launcher = Buffer.from("export const ready = true;\n");
  const blobs = [[file.path, launcher], [manifestPath, manifest]] as const;
  const entries = blobs.map(([path, bytes]) => ({ path, type: "blob", mode: "100644", objectId: objectId("blob", bytes), byteLength: bytes.length }));
  const treeSha = objectId("tree", Buffer.concat(entries.flatMap(entry => [Buffer.from(`100644 ${entry.path}\0`), Buffer.from(entry.objectId, "hex")])));
  const commit = Buffer.from(`tree ${treeSha}\nauthor Test <test@example.invalid> 0 +0000\ncommitter Test <test@example.invalid> 0 +0000\n\nfixture\n`);
  const commitSha = objectId("commit", commit);
  const f = await validationFixture(true, false, true, { inventoryPath: manifestPath, commitSha, treeSha });
  const { localFolders } = f.f.platform as unknown as { localFolders: { readWorkspaceSourceGitSnapshotV1?: (input: { paths: string[] }) => Promise<unknown> } };
  const snapshotManifest = sha(JSON.stringify({ schemaVersion: 1, sourceId: f.plan.sourceId, commitSha, treeSha, entries }));
  localFolders.readWorkspaceSourceGitSnapshotV1 = async ({ paths }) => ({
    status: "current", complete: true, sourceId: f.plan.sourceId, folderKey: f.plan.folderKey, branch: f.plan.candidateBranch,
    commitSha, treeSha, manifestSha256: snapshotManifest, observedAt: now, entries,
    commitObject: { objectId: commitSha, sha256: sha(commit), byteLength: commit.length, contentBase64: commit.toString("base64") },
    files: blobs.filter(([path]) => paths.includes(path)).map(([path, bytes]) => ({
      path, mode: "100644", objectId: objectId("blob", bytes), byteLength: bytes.length, sha256: sha(bytes), contentBase64: bytes.toString("base64"),
    })),
  });
  for (const phase of ["ci", "e2e", "regression"] as const) {
    const result = await validationTool().handler({ ...f.input, phase }, f.managerContext, f.f.platform);
    const { reference } = result.data as unknown as { reference: { runId: string; subjectKey: string } };
    const run = f.runs.get(reference.runId);
    run.status = "succeeded"; run.termination = "confirmed";
    run.receipt = { digest: sha(`receipt-${phase}`), status: "completed", stdoutSha256: sha(""), stderrSha256: sha(""),
      stdoutBytes: 0, stderrBytes: 0, processExitCode: 0, timedOut: false, cancelled: false, outputLimit: false, appContainerVerified: true,
      capabilitiesCount: 0, childTerminationConfirmed: true, jobEmpty: true, profileCleanupSucceeded: true, sandboxCleanupSucceeded: true, fixtureMustBeRetained: false };
    if (phase !== "ci" || !includeArtifact) continue;
    const bytes = Buffer.from("ci bundle bytes"), row = { path: output.path, byteLength: bytes.length, sha256: sha(bytes) };
    run.receipt.outputManifest = [row];
    run.receipt.outputBytes = bytes.length;
    run.receipt.outputManifestSha256 = sha(`F\0${row.path}\0${row.byteLength}\0${row.sha256}`);
    Object.assign(f.f.platform, { artifacts: { async list() { return [{
      id: "18181818-1818-4818-8818-181818181818", companyId: W, pluginKey: "com.sonparkserver.my-plugin-builder",
      subjectKey: reference.subjectKey, runId: run.id, title: output.path, kind: "sps.protected-test-output-v1", referenceUrl: null, summary: null,
      data: { schemaVersion: 1, kind: "sps.protected-test-output-v1", ...row, contentBase64: bytes.toString("base64"),
        runId: run.id, approvalId: run.pins.approvalId, sourceId: f.plan.sourceId, commitSha, treeSha,
        planSha256: run.pins.planSha256, inputTreeSha256: run.pins.inputTreeSha256 }, createdAt: now, updatedAt: now,
    }]; } } });
  }
  return { f, commitSha, treeSha, launcher, manifest, localFolders, read: () => readDeliveryInventory(W, f.f.platform) };
}

test("Manager resolves only the declared candidate Git bytes and exact CI Artifact", async () => {
  const { f, commitSha, launcher, manifest } = await setup();
  const result = await progressTool().handler({ workstreamId: f.input.workstreamId, eventId: f.eventId, projection: "delivery-inventory" },
    f.managerContext, f.f.platform);
  const inventory = result.data as unknown as Awaited<ReturnType<typeof readDeliveryInventory>>;
  assert.equal(inventory.status, "observed");
  if (inventory.status !== "observed") return;
  assert.equal(inventory.candidate.commitSha, commitSha);
  assert.equal(inventory.manifest.sha256, sha(manifest));
  assert.deepEqual(inventory.files.map(item => [item.path, item.sha256, item.artifactId]), [
    [file.path, sha(launcher), null], [output.path, sha("ci bundle bytes"), "18181818-1818-4818-8818-181818181818"],
  ]);
  assert.equal(inventory.deliveryAuthority, "not-established");
  assert.doesNotMatch(JSON.stringify(inventory), /contentBase64|ci bundle bytes/u);
  assert.equal(f.enqueueCalls, 3, "inventory only reads existing evidence");
});

test("inventory refuses unknown targets, path collisions and unproven CI outputs", async t => {
  for (const [label, files, includeArtifact, reason] of [
    ["foreign target", [{ ...file, target: "web-api" }], true, "delivery-inventory-manifest-invalid-or-unconfirmed"],
    ["case collision", [file, { ...output, path: file.path.toUpperCase() }], true, "delivery-inventory-manifest-invalid-or-unconfirmed"],
    ["missing artifact", [output], false, "delivery-inventory-ci-artifact-unconfirmed"],
  ] as const) await t.test(label, async () => {
    const { read } = await setup([...files], includeArtifact);
    assert.deepEqual(await read(), { status: "unknown", reason });
  });
});

test("a candidate change during selected file reads never returns the old inventory", async () => {
  const { f, localFolders, read } = await setup();
  const original = localFolders.readWorkspaceSourceGitSnapshotV1!;
  localFolders.readWorkspaceSourceGitSnapshotV1 = async input => {
    const result = await original(input);
    if (input.paths.includes(file.path)) f.moveCandidate();
    return result;
  };
  assert.deepEqual(await read(), { status: "stale", reason: "delivery-inventory-git-files-unavailable" });
  assert.equal(f.enqueueCalls, 3);
});
