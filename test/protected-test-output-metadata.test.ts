import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertProtectedOutputMetadata } from "../src/protected-test-output-metadata.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const fixture = () => {
  const outputManifest = [{ path: "dist/result.json", byteLength: 5, sha256: hash("bytes") }];
  return { outputManifest, outputBytes: 5,
    outputManifestSha256: hash(outputManifest.map(row => `F\0${row.path}\0${row.byteLength}\0${row.sha256}`).join("\n")) };
};

test("legacy receipts retain their exact empty output contract and new manifests carry no file bytes", () => {
  const legacy = { digest: hash("legacy") };
  assertProtectedOutputMetadata(legacy);
  assert.deepEqual(legacy, { digest: hash("legacy") });
  const receipt = fixture(), original = structuredClone(receipt);
  assertProtectedOutputMetadata(receipt);
  assert.deepEqual(receipt, original);
  assertProtectedOutputMetadata({ outputManifest: [], outputBytes: 0, outputManifestSha256: hash("") });
});

test("incomplete, changed and oversized output metadata is refused", () => {
  const receipt = fixture();
  for (const patch of [{ outputBytes: undefined }, { outputManifest: null }, { outputBytes: 0 },
    { outputManifestSha256: hash("different") }, { outputBytes: 49153 }, { outputManifest: Array(17).fill(receipt.outputManifest[0]) }]) {
    assert.throws(() => assertProtectedOutputMetadata({ ...receipt, ...patch }));
  }
  assert.throws(() => assertProtectedOutputMetadata({ outputManifest: [] }));
});

test("raw output bytes and unsafe or duplicate paths cannot enter a sanitized receipt", () => {
  const receipt = fixture(), entry = receipt.outputManifest[0]!;
  for (const path of ["../outside", "/absolute", "C:/absolute", "a\\b", "COM\u00b9.txt", "a/CON.txt", "a/**", "a.", "a//b", "a/../b"]) {
    assert.throws(() => assertProtectedOutputMetadata({ ...receipt, outputManifest: [{ ...entry, path }] }));
  }
  assert.throws(() => assertProtectedOutputMetadata({ ...receipt, outputManifest: [{ ...entry, contentBase64: "Ynl0ZXM=" }] }));
  assert.throws(() => assertProtectedOutputMetadata({ ...receipt, outputManifest: [entry, { ...entry, path: "DIST/result.json" }] }));
  assert.throws(() => assertProtectedOutputMetadata({ ...receipt, outputManifest: [entry, { ...entry, path: "a.json" }] }));
  assert.throws(() => assertProtectedOutputMetadata({ ...receipt, outputManifest: Array(2) }));
  let reads = 0;
  const accessor = [entry];
  Object.defineProperty(accessor, "0", { enumerable: true, get() { reads++; return entry; } });
  assert.throws(() => assertProtectedOutputMetadata({ ...receipt, outputManifest: accessor }));
  assert.equal(reads, 0);
});
