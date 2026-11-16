import { createHash } from "node:crypto";
import { exactToolRecord } from "./lead-tool-authority.ts";

export const PROTECTED_OUTPUT_RECEIPT_FIELDS = ["outputManifest", "outputBytes", "outputManifestSha256"] as const;

/** This checks only the Core receipt's sanitized output manifest. Actual file
 * bytes still require a scoped Artifact read and an independent hash check. */
export function assertProtectedOutputMetadata(receipt: Record<string, unknown>): void {
  if (!PROTECTED_OUTPUT_RECEIPT_FIELDS.some(field => Object.hasOwn(receipt, field))) return;
  if (!PROTECTED_OUTPUT_RECEIPT_FIELDS.every(field => Object.hasOwn(receipt, field))
    || !Array.isArray(receipt.outputManifest) || receipt.outputManifest.length > 16
    || Object.getPrototypeOf(receipt.outputManifest) !== Array.prototype
    || Reflect.ownKeys(receipt.outputManifest).length !== receipt.outputManifest.length + 1
    || !Number.isSafeInteger(receipt.outputBytes) || (receipt.outputBytes as number) < 0 || (receipt.outputBytes as number) > 48 * 1024
    || typeof receipt.outputManifestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(receipt.outputManifestSha256)) {
    throw new TypeError("Protected output metadata is incomplete or outside its bound.");
  }
  let total = 0, previous = "";
  const seen = new Set<string>(), tuples: string[] = [];
  for (let index = 0; index < receipt.outputManifest.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(receipt.outputManifest, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Protected output manifest must contain plain data entries.");
    const row = exactToolRecord(descriptor.value, ["path", "byteLength", "sha256"]);
    if (typeof row.path !== "string" || !row.path || row.path.length > 240 || row.path.split("/").length > 16
      || /[\\\p{Cc}\p{Cf}<>:"|?*]/u.test(row.path)
      || row.path.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/u.test(part)
        || /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu.test(part))
      || !Number.isSafeInteger(row.byteLength) || (row.byteLength as number) < 0 || (row.byteLength as number) > 48 * 1024
      || typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.sha256)
      || seen.has(row.path.toLocaleLowerCase("en-US")) || previous && previous >= row.path) {
      throw new TypeError("Protected output manifest has invalid or conflicting entries.");
    }
    seen.add(row.path.toLocaleLowerCase("en-US")); previous = row.path;
    total += row.byteLength as number;
    tuples.push(`F\0${row.path}\0${row.byteLength}\0${row.sha256}`);
  }
  if (total !== receipt.outputBytes || createHash("sha256").update(tuples.sort().join("\n")).digest("hex") !== receipt.outputManifestSha256) {
    throw new TypeError("Protected output manifest digest or byte count changed.");
  }
}
