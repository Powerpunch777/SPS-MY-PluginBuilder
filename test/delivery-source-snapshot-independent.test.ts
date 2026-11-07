import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readDeliverySourceSnapshot } from "../src/delivery-evidence/source-snapshot.ts";

const source: Readonly<{ sourceId: string; folderKey: string; branch: string; commitSha: string; treeSha: string }> =
  Object.freeze({ sourceId: "22222222-2222-4222-8222-222222222222", folderKey: "workspace",
  branch: "integration/current", commitSha: "", treeSha: "" });
const sha = (type: string, bytes: Buffer) => createHash("sha1").update(type + " " + bytes.length + "\0", "ascii").update(bytes).digest("hex");
function fixture() {
  const bytes = Buffer.from("delivery bytes\n");
  const blob = sha("blob", bytes);
  const treeBytes = Buffer.concat([Buffer.from("100644 packet.md\0"), Buffer.from(blob, "hex")]);
  const tree = sha("tree", treeBytes);
  const commitBytes = Buffer.from(["tree " + tree, "author Test <test@example.invalid> 0 +0000",
    "committer Test <test@example.invalid> 0 +0000", "", "fixture", ""].join("\n"));
  const commit = sha("commit", commitBytes);
  const currentSource = Object.freeze({ ...source, commitSha: commit, treeSha: tree });
  const entries = [{ path: "packet.md", type: "blob", mode: "100644", objectId: blob, byteLength: bytes.length }];
  const snapshot = { status: "current", complete: true, sourceId: currentSource.sourceId, folderKey: currentSource.folderKey,
    branch: currentSource.branch, commitSha: commit, treeSha: tree,
    commitObject: { objectId: commit, byteLength: commitBytes.length,
      sha256: createHash("sha256").update(commitBytes).digest("hex"), contentBase64: commitBytes.toString("base64") },
    entries, files: [{ path: "packet.md", mode: "100644", objectId: blob, byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), contentBase64: bytes.toString("base64") }],
    manifestSha256: createHash("sha256").update(JSON.stringify({ schemaVersion: 1, sourceId: currentSource.sourceId,
      commitSha: commit, treeSha: tree, entries })).digest("hex"), observedAt: "2026-11-07T00:00:00.000Z" };
  const tip = { status: "current", sourceId: currentSource.sourceId, folderKey: currentSource.folderKey,
    branch: currentSource.branch, commitSha: commit, treeSha: tree, observedAt: "2026-11-07T00:00:01.000Z" };
  const calls: Array<Record<string, unknown>> = [];
  const platform: { localFolders: {
    readWorkspaceSourceGitSnapshotV1(input: Record<string, unknown>): Promise<unknown>;
    readWorkspaceSourceGitTipV1(...args: string[]): Promise<unknown>;
  } } = { localFolders: {
    async readWorkspaceSourceGitSnapshotV1(input: Record<string, unknown>) { calls.push(input); return snapshot; },
    async readWorkspaceSourceGitTipV1(...args: string[]) { calls.push({ tipArgs: args }); return tip; },
  } };
  return { bytes, currentSource, snapshot, tip, calls, platform };
}

test("delivery consumer returns exact immutable bytes only after its final Source branch proof", async () => {
  const value = fixture();
  const result = await readDeliverySourceSnapshot(value.currentSource, ["packet.md"], value.platform as never);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.deepEqual(Buffer.from(result.commitObjectBytes), Buffer.from(value.snapshot.commitObject.contentBase64, "base64"));
  assert.deepEqual(Buffer.from(result.fileBytes[0]!.bytes), value.bytes);
  assert.deepEqual(result.inventory.map(entry => entry.path), ["packet.md"]);
  assert.deepEqual(value.calls[0], { sourceId: value.currentSource.sourceId, folderKey: value.currentSource.folderKey,
    branch: value.currentSource.branch, expectedCommit: value.currentSource.commitSha, expectedTree: value.currentSource.treeSha, paths: ["packet.md"] });
  assert.deepEqual(value.calls[1], { tipArgs: [value.currentSource.sourceId, value.currentSource.folderKey, value.currentSource.branch] });
});

test("delivery consumer does not infer snapshot support from a caller flag or old tip-only SDK", async () => {
  const value = fixture();
  assert.deepEqual(await readDeliverySourceSnapshot(value.currentSource, ["packet.md"], {
    approved: true, localFolders: { readWorkspaceSourceGitTipV1: async () => value.tip },
  } as never), { status: "unsupported" });
  assert.deepEqual(await readDeliverySourceSnapshot(value.currentSource, ["packet.md"], {
    localFolders: { readWorkspaceSourceGitSnapshotV1: async () => value.snapshot },
  } as never), { status: "unsupported" });
});

test("delivery consumer reports stale when the branch moves after the exact object snapshot", async () => {
  const value = fixture();
  const changed = { ...value.tip, commitSha: "a".repeat(40) };
  value.platform.localFolders.readWorkspaceSourceGitTipV1 = async () => changed;
  assert.deepEqual(await readDeliverySourceSnapshot(value.currentSource, ["packet.md"], value.platform as never), { status: "stale" });
});

test("delivery consumer withholds malformed bytes, wrong scope, and sparse requested paths", async () => {
  const value = fixture();
  const changed = structuredClone(value.snapshot);
  changed.files[0].contentBase64 = Buffer.from("substituted\n").toString("base64");
  value.platform.localFolders.readWorkspaceSourceGitSnapshotV1 = async () => changed;
  assert.deepEqual(await readDeliverySourceSnapshot(value.currentSource, ["packet.md"], value.platform as never), { status: "unknown" });
  value.platform.localFolders.readWorkspaceSourceGitSnapshotV1 = async () => ({ ...value.snapshot, sourceId: "33333333-3333-4333-8333-333333333333" });
  assert.deepEqual(await readDeliverySourceSnapshot(value.currentSource, ["packet.md"], value.platform as never), { status: "unknown" });
  const sparse = [] as string[];
  sparse.length = 1;
  assert.deepEqual(await readDeliverySourceSnapshot(value.currentSource, sparse, value.platform as never), { status: "unknown" });
});
