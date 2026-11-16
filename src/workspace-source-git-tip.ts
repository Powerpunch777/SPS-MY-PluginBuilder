import { exactToolRecord } from "./lead-tool-authority.ts";

const currentFields = ["sourceId", "folderKey", "branch", "commitSha", "treeSha", "observedAt"] as const;

export function readWorkspaceSourceGitTipProof(value: unknown) {
  const row = exactToolRecord(value, ["status"], ["reason", ...currentFields]);
  if (row.status === "unknown" || row.status === "denied") {
    if (Object.keys(row).length !== 2 || typeof row.reason !== "string" || !row.reason) {
      throw new TypeError("Invalid unavailable Host Git tip proof.");
    }
    return { status: row.status } as const;
  }
  if (row.status !== "current" || Object.hasOwn(row, "reason") || currentFields.some(key => typeof row[key] !== "string" || !row[key])) {
    throw new TypeError("Invalid current Host Git tip proof.");
  }
  return { status: "current", sourceId: row.sourceId, folderKey: row.folderKey, branch: row.branch,
    commitSha: row.commitSha, treeSha: row.treeSha, observedAt: row.observedAt } as const;
}
