import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { readDesignBaseline } from "../design-baseline-tools.ts";
import type { ApprovedSpecRevision, DeliveryTarget } from "../domain/specification-revisions.ts";
import { exactToolRecord } from "../lead-tool-authority.ts";
import { readIntegrationCandidate } from "./integration-candidate.ts";
import { parseDeliverySourcePath, readDeliverySourceSnapshot } from "./source-snapshot.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const MAX_FILES = 128;
type DeclaredFile = Readonly<{ path: string; source: "git" | "ci-output"; classification: string; target: DeliveryTarget;
  requirementIds: readonly string[] }>;
type ObservedFile = DeclaredFile & Readonly<{ byteLength: number; sha256: string; objectId: string | null; artifactId: string | null }>;

function readManifest(bytes: Uint8Array, spec: ApprovedSpecRevision): readonly DeclaredFile[] {
  if (!bytes.byteLength || bytes.byteLength > 64 * 1024) throw new TypeError("Delivery inventory manifest has an invalid size.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const manifest = exactToolRecord(JSON.parse(text), ["schemaVersion", "files"]);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_FILES) {
    throw new TypeError("A versioned, nonempty delivery inventory is required.");
  }
  const paths = new Set<string>(), targets = new Set<string>(), requirements = new Set(spec.requirements.map(item => item.id));
  const files = manifest.files.map(value => {
    const row = exactToolRecord(value, ["path", "source", "classification", "target", "requirementIds"]);
    const path = parseDeliverySourcePath(row.path), folded = path.toLocaleLowerCase("en-US");
    if (path.length > 200 || folded.split("/").includes(".git") || paths.has(folded)
      || row.source !== "git" && row.source !== "ci-output"
      || typeof row.classification !== "string" || !row.classification.trim() || row.classification.length > 120
      || /[\p{Cc}\p{Cf}]/u.test(row.classification)
      || typeof row.target !== "string" || !spec.targets.includes(row.target as DeliveryTarget)
      || !Array.isArray(row.requirementIds) || row.requirementIds.length < 1 || row.requirementIds.length > 32
      || new Set(row.requirementIds).size !== row.requirementIds.length
      || row.requirementIds.some(id => typeof id !== "string" || !requirements.has(id))) {
      throw new TypeError("Delivery file scope does not match the approved design.");
    }
    paths.add(folded);
    targets.add(row.target);
    return Object.freeze({ path, source: row.source, classification: row.classification, target: row.target as DeliveryTarget,
      requirementIds: Object.freeze(row.requirementIds as string[]) });
  });
  if (spec.targets.some(target => !targets.has(target))) throw new TypeError("Delivery inventory omits an approved target.");
  return Object.freeze(files);
}

/** Resolve only files declared at the Main-pinned manifest path. A Git tree or
 * successful CI run alone does not establish the list of deliverable files. */
export async function readDeliveryInventory(workspaceId: string, platform: SpsPlatformInvocationContext) {
  const unavailable = <Status extends "pending" | "stale" | "unsupported" | "unknown">(status: Status, reason: string) => ({ status, reason });
  const candidate = await readIntegrationCandidate(workspaceId, platform);
  if (candidate.status !== "observed") return candidate;
  const path = candidate.plan.deliveryInventoryPath;
  if (!path) return unavailable("pending", "delivery-inventory-path-not-planned");
  try {
    const baseline = (await readDesignBaseline(workspaceId, workspaceId, platform))?.revision;
    if (!baseline || baseline.revisionId !== candidate.plan.baselineRevisionId || hash(baseline) !== candidate.plan.baselineDigest) {
      return unavailable("stale", "delivery-inventory-design-changed");
    }
    const manifestRead = await readDeliverySourceSnapshot(candidate.candidate, [path], platform);
    if (manifestRead.status !== "available") return unavailable(manifestRead.status, "delivery-inventory-manifest-unavailable");
    const manifestFile = manifestRead.fileBytes[0]!;
    const files = readManifest(manifestFile.bytes, baseline.specification);
    const gitPaths = files.filter(file => file.source === "git").map(file => file.path);
    const gitRead = gitPaths.length ? await readDeliverySourceSnapshot(candidate.candidate, gitPaths, platform) : manifestRead;
    if (gitRead.status !== "available") return unavailable(gitRead.status, "delivery-inventory-git-files-unavailable");
    if (gitRead.manifestSha256 !== manifestRead.manifestSha256) return unavailable("stale", "delivery-inventory-source-tree-changed");
    const outputs = candidate.ci.outputs?.status === "matched" ? candidate.ci.outputs : null;
    const observed: ObservedFile[] = [];
    for (const file of files) {
      if (file.source === "git") {
        const content = gitRead.fileBytes.find(entry => entry.path === file.path);
        const entry = gitRead.inventory.find(entry => entry.path === file.path && entry.type === "blob");
        if (!content || !entry) return unavailable("unknown", "delivery-inventory-git-file-unconfirmed");
        observed.push({ ...file, byteLength: content.bytes.byteLength, sha256: content.sha256, objectId: entry.objectId, artifactId: null });
      } else {
        const artifact = outputs?.files.find(entry => entry.path === file.path);
        if (!artifact) return unavailable("unknown", "delivery-inventory-ci-artifact-unconfirmed");
        observed.push({ ...file, byteLength: artifact.byteLength, sha256: artifact.sha256, objectId: null, artifactId: artifact.artifactId });
      }
    }
    const latest = await readIntegrationCandidate(workspaceId, platform);
    const evidence = (value: typeof candidate) => [value.candidate, value.plan.revisionId, value.boardRevisionId,
      value.attempts.map(attempt => attempt.revisionId), value.ci, value.e2e, value.regression ?? null];
    if (latest.status !== "observed" || hash(evidence(latest)) !== hash(evidence(candidate))) {
      return unavailable("stale", "delivery-inventory-evidence-changed-during-read");
    }
    return { status: "observed" as const, candidate: candidate.candidate, planRevisionId: candidate.plan.revisionId,
      manifest: { path, sha256: manifestFile.sha256, sourceTreeManifestSha256: manifestRead.manifestSha256 },
      files: observed, deliveryAuthority: "not-established" as const };
  } catch {
    return unavailable("unknown", "delivery-inventory-manifest-invalid-or-unconfirmed");
  }
}
