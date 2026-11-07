import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { exactToolRecord } from "./lead-tool-authority.ts";
import { assertProtectedOutputMetadata, PROTECTED_OUTPUT_RECEIPT_FIELDS } from "./protected-test-output-metadata.ts";
import { parseProtectedRun } from "./task-protected-qa.ts";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const HEX = /^[a-f0-9]{64}$/u;
const GIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const PLUGIN = "com.sonparkserver.my-plugin-builder";

export type ProtectedOutputReference = Readonly<{ workspaceId: string; runId: string; subjectKey: string;
  approvalId: string; sourceId: string; commitSha: string; treeSha: string; planSha256: string }>;
type OutputFile = Readonly<{ artifactId: string; path: string; byteLength: number; sha256: string }>;
export type ProtectedOutputRead = Readonly<{ status: "matched"; manifestSha256: string; totalBytes: number;
  files: readonly OutputFile[]; qaVerdict: "not-established" }>
  | Readonly<{ status: "unsupported" | "not-ready" | "not-produced" | "unknown"; qaVerdict: "not-established" }>;
type Reader = Readonly<{ protectedTests?: { getRunV1?: (workspaceId: string, runId: string, subjectDigest: string) => Promise<unknown> };
  artifacts?: { list?: (input: { subjectKey: string; runId: string; limit: number }) => Promise<unknown> } }>;

function boundRun(raw: unknown, ref: ProtectedOutputReference) {
  const run = parseProtectedRun(raw);
  if (run.id !== ref.runId || run.pins.approvalId !== ref.approvalId || run.pins.sourceId !== ref.sourceId
    || run.pins.commitSha !== ref.commitSha || run.pins.treeSha !== ref.treeSha || run.pins.planSha256 !== ref.planSha256
    || run.pins.subjectKeySha256 !== sha(ref.subjectKey)) throw new Error("Protected output run pins changed.");
  return run;
}

/** Re-read Core authority around an exact scoped Artifact-byte check. A matching
 * file is output provenance only, never an authored QA verdict or delivery approval. */
export async function readProtectedOutputArtifacts(reference: ProtectedOutputReference,
  platform: SpsPlatformInvocationContext): Promise<ProtectedOutputRead> {
  const result = (status: "unsupported" | "not-ready" | "not-produced" | "unknown"): ProtectedOutputRead =>
    ({ status, qaVerdict: "not-established" });
  const host = platform as unknown as Reader;
  if (typeof host.protectedTests?.getRunV1 !== "function" || typeof host.artifacts?.list !== "function") return result("unsupported");
  try {
    const ref = exactToolRecord(reference, ["workspaceId", "runId", "subjectKey", "approvalId", "sourceId", "commitSha", "treeSha", "planSha256"]) as unknown as ProtectedOutputReference;
    if (![ref.workspaceId, ref.runId, ref.approvalId, ref.sourceId].every(id => UUID.test(id))
      || typeof ref.subjectKey !== "string" || !ref.subjectKey || ref.subjectKey.length > 160
      || /[\u0000-\u001f\u007f]/u.test(ref.subjectKey) || !GIT.test(ref.commitSha) || !GIT.test(ref.treeSha)
      || !HEX.test(ref.planSha256)) throw new Error("Protected output reference is invalid.");
    const raw = await host.protectedTests.getRunV1(ref.workspaceId, ref.runId, sha(ref.subjectKey));
    if (raw === null) return result("unknown");
    const run = boundRun(raw, ref);
    if (run.status !== "succeeded" || run.termination !== "confirmed" || run.receipt === null) return result("not-ready");
    const receipt = exactToolRecord(run.receipt, ["digest", "status", "stdoutSha256", "stderrSha256", "stdoutBytes", "stderrBytes",
      "processExitCode", "timedOut", "cancelled", "outputLimit", "appContainerVerified", "capabilitiesCount",
      "childTerminationConfirmed", "jobEmpty", "profileCleanupSucceeded", "sandboxCleanupSucceeded", "fixtureMustBeRetained"],
    PROTECTED_OUTPUT_RECEIPT_FIELDS);
    if (!HEX.test(String(receipt.digest)) || receipt.status !== "completed" || receipt.processExitCode !== 0
      || receipt.timedOut !== false || receipt.cancelled !== false || receipt.outputLimit !== false
      || receipt.appContainerVerified !== true || receipt.capabilitiesCount !== 0 || receipt.childTerminationConfirmed !== true
      || receipt.jobEmpty !== true || receipt.profileCleanupSucceeded !== true || receipt.sandboxCleanupSucceeded !== true
      || receipt.fixtureMustBeRetained !== false) return result("unknown");
    assertProtectedOutputMetadata(receipt);
    if (!Object.hasOwn(receipt, "outputManifest")) return result("not-produced");
    const manifest = receipt.outputManifest as Array<{ path: string; byteLength: number; sha256: string }>;
    const pins = exactToolRecord(run.pins, ["approvalId", "sourceId", "planSha256", "profileSha256", "commitSha", "treeSha",
      "manifestSha256", "inputTreeSha256", "nodeSha256", "subjectKeySha256", "timeoutMs"]);
    const rows = await host.artifacts.list({ subjectKey: ref.subjectKey, runId: ref.runId, limit: 17 });
    if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype || rows.length !== manifest.length
      || Reflect.ownKeys(rows).length !== rows.length + 1) return result("unknown");
    const files: OutputFile[] = [], ids = new Set<string>(), paths = new Set<string>();
    for (let index = 0; index < rows.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(rows, String(index));
      if (!entry?.enumerable || !Object.hasOwn(entry, "value")) return result("unknown");
      const row = exactToolRecord(entry.value, ["id", "companyId", "pluginKey", "subjectKey", "runId", "title", "kind",
        "referenceUrl", "summary", "data", "createdAt", "updatedAt"]);
      if (typeof row.id !== "string" || !UUID.test(row.id) || ids.has(row.id) || row.companyId !== ref.workspaceId
        || row.pluginKey !== PLUGIN || row.subjectKey !== ref.subjectKey || row.runId !== ref.runId
        || row.kind !== "sps.protected-test-output-v1") return result("unknown");
      const data = exactToolRecord(row.data, ["schemaVersion", "kind", "path", "byteLength", "sha256", "contentBase64",
        "runId", "approvalId", "sourceId", "commitSha", "treeSha", "planSha256", "inputTreeSha256"]);
      if (data.schemaVersion !== 1 || data.kind !== "sps.protected-test-output-v1" || data.runId !== ref.runId
        || data.approvalId !== ref.approvalId || data.sourceId !== ref.sourceId || data.commitSha !== ref.commitSha
        || data.treeSha !== ref.treeSha || data.planSha256 !== ref.planSha256 || data.inputTreeSha256 !== pins.inputTreeSha256
        || typeof data.path !== "string" || paths.has(data.path) || typeof data.contentBase64 !== "string"
        || data.contentBase64.length > 65536) return result("unknown");
      const expected = manifest.find(file => file.path === data.path);
      if (!expected || data.byteLength !== expected.byteLength || data.sha256 !== expected.sha256) return result("unknown");
      const bytes = Buffer.from(data.contentBase64, "base64");
      if (bytes.toString("base64") !== data.contentBase64 || bytes.length !== expected.byteLength || sha(bytes) !== expected.sha256) return result("unknown");
      ids.add(row.id); paths.add(data.path);
      files.push(Object.freeze({ artifactId: row.id, ...expected }));
    }
    const latest = await host.protectedTests.getRunV1(ref.workspaceId, ref.runId, sha(ref.subjectKey));
    boundRun(latest, ref);
    if (JSON.stringify(latest) !== JSON.stringify(raw)) return result("unknown");
    return Object.freeze({ status: "matched", manifestSha256: receipt.outputManifestSha256 as string,
      totalBytes: receipt.outputBytes as number, files: Object.freeze(files.sort((a, b) => a.path.localeCompare(b.path))),
      qaVerdict: "not-established" });
  } catch { return result("unknown"); }
}
