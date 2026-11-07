import { createHash } from "node:crypto";
import { exactToolRecord } from "./lead-tool-authority.ts";
import { createRevisionJournal, type RevisionState } from "./solution-revision-store.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const sha = /^[a-f0-9]{64}$/u;
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
export type TaskQaReferenceScope = Readonly<{ workspaceId: string; projectId: string; ctoId: string; workstreamId: string; qaTaskId: string }>;
export type TaskQaRunBinding = Readonly<{
  implementationTaskId: string; implementationRevision: number; implementationDigest: string;
  qaRevision: number; qaDigest: string; qaAgentId: string; qaSessionId: string;
  sourceId: string; folderKey: string; branch: string; commitSha: string; treeSha: string;
  acceptanceId: string; submissionId: string; approvalId: string; planSha256: string;
  requestId: string; subjectKey: string; subjectKeySha256: string; runId: string;
}>;
export type TaskQaRunReference = Readonly<{ schemaVersion: 1; revisionId: string;
  scope: TaskQaReferenceScope; binding: TaskQaRunBinding }>;
type ReferenceTarget = Omit<TaskQaReferenceScope, "qaTaskId"> & Readonly<{
  implementation: { packet: { taskId: string; revision: number } }; implementationDigest: string;
  qa: { packet: { taskId: string; revision: number } }; qaDigest: string;
  qaWorker: { agentId: string; sessionId: string }; source: { sourceId: string; folderKey: string; branch: string };
  commitSha: string; treeSha: string; acceptanceId: string; submissionId: string; approvalId: string; planSha256: string;
  requestId: string; subjectKey: string; subjectKeySha256: string; assertCurrent(): Promise<void>;
}>;
const scopeFields = ["workspaceId", "projectId", "ctoId", "workstreamId", "qaTaskId"] as const;
const bindingFields = ["implementationTaskId", "implementationRevision", "implementationDigest", "qaRevision", "qaDigest",
  "qaAgentId", "qaSessionId", "sourceId", "folderKey", "branch", "commitSha", "treeSha", "acceptanceId", "submissionId",
  "approvalId", "planSha256", "requestId", "subjectKey", "subjectKeySha256", "runId"] as const;

function scope(value: unknown): TaskQaReferenceScope {
  const row = exactToolRecord(value, scopeFields);
  if (typeof row.workspaceId !== "string" || !uuid.test(row.workspaceId)
    || scopeFields.some(field => { const value = row[field]; return typeof value !== "string" || !value.trim() || value.length > 160
      || /[\u0000-\u001f\u007f]/u.test(value); })) throw new TypeError("Invalid protected QA reference scope.");
  return Object.freeze(Object.fromEntries(scopeFields.map(field => [field, row[field]]))) as TaskQaReferenceScope;
}
export const parseTaskQaReferenceScope = scope;

function binding(value: unknown): TaskQaRunBinding {
  const row = exactToolRecord(value, bindingFields);
  if (typeof row.implementationTaskId !== "string" || !row.implementationTaskId.trim() || row.implementationTaskId.length > 160
    || [row.implementationRevision, row.qaRevision].some(item => !Number.isSafeInteger(item) || (item as number) < 1)
    || [row.implementationDigest, row.qaDigest, row.acceptanceId, row.submissionId, row.planSha256, row.subjectKeySha256]
      .some(item => typeof item !== "string" || !sha.test(item))
    || [row.qaAgentId, row.qaSessionId, row.sourceId, row.approvalId, row.runId].some(item => typeof item !== "string" || !uuid.test(item))
    || [row.commitSha, row.treeSha].some(item => typeof item !== "string" || !oid.test(item))
    || typeof row.folderKey !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(row.folderKey)
    || typeof row.branch !== "string" || !/^(?!\/)(?!.*(?:\.\.|\.lock(?:\/|$)|\/\.|\/\/|@\{))[A-Za-z0-9._/-]{1,240}(?<!\.)$/u.test(row.branch)
    || typeof row.requestId !== "string" || !/^[A-Za-z0-9._:-]{8,200}$/u.test(row.requestId)
    || typeof row.subjectKey !== "string" || !row.subjectKey.trim() || row.subjectKey.length > 240
    || row.subjectKeySha256 !== createHash("sha256").update(row.subjectKey, "utf8").digest("hex")) {
    throw new TypeError("Invalid exact Task-to-Core-run reference.");
  }
  return Object.freeze(Object.fromEntries(bindingFields.map(field => [field, row[field]]))) as TaskQaRunBinding;
}

function reference(rawScope: unknown, rawBinding: unknown): TaskQaRunReference {
  const normalizedScope = scope(rawScope), normalizedBinding = binding(rawBinding);
  const body = { schemaVersion: 1 as const, scope: normalizedScope, binding: normalizedBinding };
  return Object.freeze({ ...body, revisionId: `task-qa-run-v1:${hash(body)}` });
}

export function parseTaskQaRunReference(value: unknown): TaskQaRunReference {
  const row = exactToolRecord(value, ["schemaVersion", "revisionId", "scope", "binding"]);
  const parsed = reference(row.scope, row.binding);
  if (row.schemaVersion !== 1 || row.revisionId !== parsed.revisionId) throw new TypeError("Invalid immutable QA run reference.");
  return parsed;
}

/** Only immutable business references live here. Core remains the run-status authority. */
export function createTaskQaRunReferenceStore(rawScope: TaskQaReferenceScope, state: RevisionState) {
  const selected = scope(rawScope);
  const journal = createRevisionJournal(selected.workspaceId, hash(selected), state, {
    prefix: "task-protected-qa-runs", revisionId: (value: TaskQaRunReference) => value.revisionId,
    parse(value: unknown): TaskQaRunReference {
      const parsed = parseTaskQaRunReference(value);
      if (JSON.stringify(parsed.scope) !== JSON.stringify(selected)) {
        throw new TypeError("Stored QA run reference does not match its immutable scope or content.");
      }
      return parsed;
    },
  });
  return Object.freeze({ ...journal,
    async findRun(runId: string) {
      if (!uuid.test(runId)) throw new TypeError("A Core run UUID is required.");
      let cursor: string | null = null;
      let found: TaskQaRunReference | null = null;
      for (let pageIndex = 0; pageIndex < 64; pageIndex++) {
        const page = await journal.publishedPage(cursor, 50);
        for (const { revision } of page.revisions) if (revision.binding.runId === runId) {
          if (found && found.revisionId !== revision.revisionId) return { status: "conflict" as const };
          found = revision;
        }
        cursor = page.nextCursor;
        if (cursor === null) return found ? { status: "found" as const, reference: found } : { status: "not-found" as const };
      }
      return { status: "unknown" as const, reason: "qa-reference-history-exceeds-query-bound" };
    },
  });
}

/** Called only after the production resolver validates a real Core receipt and current QA authority. */
export async function recordTaskQaRunReference(state: RevisionState, target: ReferenceTarget, runId: string) {
  await target.assertCurrent();
  const selected = scope({ workspaceId: target.workspaceId, projectId: target.projectId, ctoId: target.ctoId,
    workstreamId: target.workstreamId, qaTaskId: target.qa.packet.taskId });
  const value = reference(selected, { implementationTaskId: target.implementation.packet.taskId,
    implementationRevision: target.implementation.packet.revision, implementationDigest: target.implementationDigest,
    qaRevision: target.qa.packet.revision, qaDigest: target.qaDigest, qaAgentId: target.qaWorker.agentId,
    qaSessionId: target.qaWorker.sessionId, ...target.source, commitSha: target.commitSha, treeSha: target.treeSha,
    acceptanceId: target.acceptanceId, submissionId: target.submissionId, approvalId: target.approvalId,
    planSha256: target.planSha256, requestId: target.requestId, subjectKey: target.subjectKey,
    subjectKeySha256: target.subjectKeySha256, runId });
  const store = createTaskQaRunReferenceStore(selected, state);
  const prior = await store.findRun(runId);
  await target.assertCurrent();
  if (prior.status === "found") return prior.reference.revisionId === value.revisionId
    ? { status: "existing" as const, reference: prior.reference } : { status: "conflict" as const };
  if (prior.status !== "not-found") return prior;
  const current = await store.current();
  await target.assertCurrent();
  try {
    const result = await store.publish({ expectedBaseRevisionId: current?.revision.revisionId ?? null, revision: value });
    if (result.status !== "published") return { status: "conflict" as const };
  } catch {
    // The reply may have been lost after head CAS. Never repeat a Core execution.
    const saved = await store.publishedRevision(value.revisionId).catch(() => null);
    return saved ? { status: "existing" as const, reference: saved.revision }
      : { status: "unknown" as const, reason: "qa-reference-publication-outcome-unknown" };
  }
  try { await target.assertCurrent(); }
  catch { return { status: "stale" as const, reference: value }; }
  return { status: "recorded" as const, reference: value };
}
