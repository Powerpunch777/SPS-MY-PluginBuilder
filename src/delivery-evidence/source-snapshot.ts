import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { exactToolRecord } from "../lead-tool-authority.ts";

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA = /^[a-f0-9]{64}$/u;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const order = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right));
type Source = Readonly<{ sourceId: string; folderKey: string; branch: string; commitSha: string; treeSha: string }>;
type Entry = Readonly<{ path: string; type: "tree" | "blob"; mode: "040000" | "100644" | "100755";
  objectId: string; byteLength: number | null }>;
type Read = Readonly<{ status: "available"; source: Source; commitObjectBytes: Uint8Array;
  inventory: readonly Entry[]; manifestSha256: string; fileBytes: readonly Readonly<{ path: string; bytes: Uint8Array; sha256: string }>[] }>
  | Readonly<{ status: "unsupported" | "stale" | "unknown" }>;
type Reader = Readonly<{ localFolders?: {
  readWorkspaceSourceGitSnapshotV1?: (input: { sourceId: string; folderKey: string; branch: string;
    expectedCommit: string; expectedTree: string; paths: readonly string[] }) => Promise<unknown>;
  readWorkspaceSourceGitTipV1?: (sourceId: string, folderKey: string, branch: string) => Promise<unknown>;
} }>;

export function parseDeliverySourcePath(value: unknown): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 1024 || value.split("/").length > 64
    || /[\\\p{Cc}\p{Cf}<>:"|?*]/u.test(value) || value.split("/").some(part => !part || part === "." || part === ".."
      || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu.test(part))) {
    throw new TypeError("Invalid delivery source path.");
  }
  return value;
}

function dense(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError("Invalid delivery snapshot array.");
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Invalid delivery snapshot array item.");
    return descriptor.value;
  });
}

function bytes(value: Record<string, unknown>, maximum: number): Buffer {
  if (typeof value.contentBase64 !== "string" || value.contentBase64.length > Math.ceil(maximum / 3) * 4
    || !Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 0 || (value.byteLength as number) > maximum
    || typeof value.sha256 !== "string" || !SHA.test(value.sha256)) throw new TypeError("Invalid delivery snapshot bytes.");
  const result = Buffer.from(value.contentBase64, "base64");
  if (result.toString("base64") !== value.contentBase64 || result.length !== value.byteLength || hash(result) !== value.sha256) {
    throw new TypeError("Delivery snapshot bytes do not match their digest.");
  }
  return result;
}

function gitObject(kind: "commit" | "blob", value: Buffer, expected: string) {
  return OID.test(expected) && createHash(expected.length === 40 ? "sha1" : "sha256")
    .update(`${kind} ${value.length}\0`, "ascii").update(value).digest("hex") === expected;
}

/** Consume only the Host/SDK's scoped immutable-object API. The SDK validates the
 * full Git tree; this boundary pins business scope and rechecks selected bytes.
 * No snapshot or boolean supplied by an Agent/UI is accepted by this function. */
export async function readDeliverySourceSnapshot(expected: Source, requestedPaths: readonly string[],
  platform: SpsPlatformInvocationContext): Promise<Read> {
  const api = (platform as unknown as Reader).localFolders;
  if (typeof api?.readWorkspaceSourceGitSnapshotV1 !== "function" || typeof api.readWorkspaceSourceGitTipV1 !== "function") {
    return { status: "unsupported" };
  }
  try {
    const source = exactToolRecord(expected, ["sourceId", "folderKey", "branch", "commitSha", "treeSha"]) as unknown as Source;
    if (typeof source.sourceId !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(source.sourceId)
      || typeof source.folderKey !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(source.folderKey)
      || typeof source.branch !== "string" || !/^(?![/.])(?!.*(?:\.\.|\.lock(?:\/|$)|\/\.|\/\/|@\{))[A-Za-z0-9._/-]{1,240}(?<![./])$/u.test(source.branch)
      || !OID.test(source.commitSha) || !OID.test(source.treeSha) || source.commitSha.length !== source.treeSha.length) throw new TypeError("Invalid current delivery source.");
    const selected = dense(requestedPaths, 512).map(parseDeliverySourcePath).sort(order);
    if (!selected.length || new Set(selected.map(value => value.toLocaleLowerCase("en-US"))).size !== selected.length) throw new TypeError("Unique delivery source files are required.");
    const fileBytes: Array<{ path: string; bytes: Uint8Array; sha256: string }> = [];
    let inventory: readonly Entry[] = [], manifestSha256: string | null = null, commitObjectBytes: Buffer | null = null, total = 0;
    for (let offset = 0; offset < selected.length; offset += 64) {
      const paths = selected.slice(offset, offset + 64);
      const raw = await api.readWorkspaceSourceGitSnapshotV1({ sourceId: source.sourceId, folderKey: source.folderKey,
        branch: source.branch, expectedCommit: source.commitSha, expectedTree: source.treeSha, paths });
      const status = exactToolRecord(raw, ["status"], ["reason", "complete", "sourceId", "folderKey", "branch", "commitSha", "treeSha",
        "commitObject", "entries", "files", "manifestSha256", "observedAt"]);
      if (status.status === "stale") return { status: "stale" };
      if (status.status !== "current") return { status: "unknown" };
      const row = exactToolRecord(raw, ["status", "complete", "sourceId", "folderKey", "branch", "commitSha", "treeSha",
        "commitObject", "entries", "files", "manifestSha256", "observedAt"]);
      if (row.complete !== true || row.sourceId !== source.sourceId || row.folderKey !== source.folderKey || row.branch !== source.branch
        || row.commitSha !== source.commitSha || row.treeSha !== source.treeSha || typeof row.manifestSha256 !== "string" || !SHA.test(row.manifestSha256)
        || typeof row.observedAt !== "string" || !Number.isFinite(Date.parse(row.observedAt))) throw new TypeError("Delivery source snapshot is not current and complete.");
      const commit = exactToolRecord(row.commitObject, ["objectId", "byteLength", "sha256", "contentBase64"]);
      const objectBytes = bytes(commit, 256 * 1024), treeLine = Buffer.from(`tree ${source.treeSha}\n`, "ascii");
      if (commit.objectId !== source.commitSha || !gitObject("commit", objectBytes, source.commitSha)
        || !objectBytes.subarray(0, treeLine.length).equals(treeLine)) throw new TypeError("Delivery commit object or tree pin changed.");
      const pathsSeen = new Set<string>();
      const entries = dense(row.entries, 1536).map(value => {
        const entry = exactToolRecord(value, ["path", "type", "mode", "objectId", "byteLength"]);
        const relative = parseDeliverySourcePath(entry.path), folded = relative.toLocaleLowerCase("en-US");
        if (pathsSeen.has(folded) || typeof entry.objectId !== "string" || !OID.test(entry.objectId) || entry.objectId.length !== source.commitSha.length
          || entry.type === "tree" && (entry.mode !== "040000" || entry.byteLength !== null)
          || entry.type === "blob" && (!["100644", "100755"].includes(String(entry.mode)) || !Number.isSafeInteger(entry.byteLength) || (entry.byteLength as number) < 0)
          || entry.type !== "tree" && entry.type !== "blob") throw new TypeError("Invalid delivery source inventory.");
        pathsSeen.add(folded);
        return Object.freeze({ path: relative, type: entry.type, mode: entry.mode, objectId: entry.objectId, byteLength: entry.byteLength }) as Entry;
      });
      if (!entries.length || entries.some((entry, index) => index > 0 && order(entries[index - 1]!.path, entry.path) >= 0)
        || hash(JSON.stringify({ schemaVersion: 1, sourceId: source.sourceId, commitSha: source.commitSha,
          treeSha: source.treeSha, entries })) !== row.manifestSha256) throw new TypeError("Delivery source inventory digest changed.");
      if (manifestSha256 !== null && (manifestSha256 !== row.manifestSha256 || !commitObjectBytes!.equals(objectBytes))) return { status: "stale" };
      manifestSha256 = row.manifestSha256; commitObjectBytes = objectBytes; inventory = entries;
      const files = dense(row.files, 64), wanted = new Set(paths);
      if (files.length !== paths.length) throw new TypeError("Delivery source file inventory is incomplete.");
      for (const value of files) {
        const file = exactToolRecord(value, ["path", "mode", "objectId", "byteLength", "sha256", "contentBase64"]);
        const relative = parseDeliverySourcePath(file.path), entry = entries.find(item => item.path === relative);
        if (!wanted.delete(relative) || !entry || entry.type !== "blob" || entry.mode !== file.mode || entry.objectId !== file.objectId
          || entry.byteLength !== file.byteLength) throw new TypeError("Delivery source file is outside the exact requested tree.");
        const contents = bytes(file, 1024 * 1024);
        total += contents.length;
        if (total > 4 * 1024 * 1024 || !gitObject("blob", contents, entry.objectId)) throw new TypeError("Delivery source file object changed or exceeded its bound.");
        fileBytes.push(Object.freeze({ path: relative, bytes: contents, sha256: file.sha256 as string }));
      }
    }
    const tip = exactToolRecord(await api.readWorkspaceSourceGitTipV1(source.sourceId, source.folderKey, source.branch),
      ["status"], ["sourceId", "folderKey", "branch", "commitSha", "treeSha", "observedAt", "reason"]);
    if (tip.status !== "current") return { status: "unknown" };
    if (tip.sourceId !== source.sourceId || tip.folderKey !== source.folderKey || tip.branch !== source.branch
      || tip.commitSha !== source.commitSha || tip.treeSha !== source.treeSha) return { status: "stale" };
    return Object.freeze({ status: "available", source: Object.freeze({ ...source }), commitObjectBytes: commitObjectBytes!,
      inventory: Object.freeze(inventory), manifestSha256: manifestSha256!, fileBytes: Object.freeze(fileBytes.sort((a, b) => order(a.path, b.path))) });
  } catch { return { status: "unknown" }; }
}
