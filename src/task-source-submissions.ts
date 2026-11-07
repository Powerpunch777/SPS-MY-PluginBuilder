import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import type { RevisionState } from "./solution-revision-store.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const asJson = (value: unknown) => value as JsonValue;

export type TaskSourceSubmissionBinding = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  projectId: string;
  ctoId: string;
  workstreamId: string;
  taskId: string;
  packetRevision: number;
  packetRecordSha256: string;
  dependencyPins: readonly Readonly<{ taskId: string; revision: number; recordSha256: string }>[];
  role: "worker" | "qa";
  agentId: string;
  sessionId: string;
  runId: string;
  source: Readonly<{ sourceId: string; folderKey: string; branch: string; expectedHead: string }>;
  readPaths: readonly string[];
  writePaths: readonly string[];
  qaWritePaths: readonly string[];
}>;

export type TaskSourceSubmission = Readonly<{
  schemaVersion: 1;
  submissionId: string;
  workspaceId: string;
  projectId: string;
  ctoId: string;
  workstreamId: string;
  taskId: string;
  packetRevision: number;
  packetRecordSha256: string;
  dependencyPins: TaskSourceSubmissionBinding["dependencyPins"];
  role: TaskSourceSubmissionBinding["role"];
  producer: Readonly<{ agentId: string; sessionId: string; runId: string }>;
  source: TaskSourceSubmissionBinding["source"];
  commitSha: string;
  treeSha: string;
  changedPaths: readonly string[];
  coreStatus: "committed" | "committed_index_reconciliation_required";
  authorityAfterCommit: "current" | "changed";
  submittedAt: string;
}>;

export type TaskSourceSubmissionResult =
  | Readonly<{ status: "submitted"; submission: TaskSourceSubmission; duplicateCommitPrevented: false }>
  | Readonly<{ status: "existing"; submission: TaskSourceSubmission; duplicateCommitPrevented: true }>
  | Readonly<{ status: "unchanged"; submissionId: string; headSha: string }>
  | Readonly<{ status: "conflict"; submissionId: string; reason: "branch_changed" | "head_changed"; actualHead: string | null }>
  | Readonly<{ status: "unknown"; submissionId: string; reason: string; commitSha: null; completion: "not-established"; qaVerdict: "not-established" }>
  | Readonly<{ status: "unsupported"; reason: string; completion: "not-established"; qaVerdict: "not-established" }>;

type TaskFolderStatus = Readonly<{ folderKey: string; configured: boolean; healthy: boolean; writable: boolean }>;
type TaskSourceMatch = Readonly<{ folderKey: string; workspaceSourceId: string; match: "same_root" | "different_root" | "unknown" }>;
type CoreCommitResult =
  | Readonly<{ status: "committed" | "committed_index_reconciliation_required"; commitSha: string; treeSha: string; changedPaths: readonly string[] }>
  | Readonly<{ status: "unchanged"; headSha: string }>
  | Readonly<{ status: "conflict"; reason: "branch_changed" | "head_changed"; actualHead: string | null }>;

type CommitPlatform = SpsPlatformInvocationContext & Readonly<{
  localFolders?: {
    status?: (folderKey: string) => Promise<unknown>;
    matchWorkspaceSourceV1?: (folderKey: string, sourceId: string) => Promise<unknown>;
    commitTaskFilesV1?: (input: { sourceId: string; folderKey: string; branch: string; expectedHead: string; paths: readonly string[] }) => Promise<unknown>;
  };
}>;

type ResolvedTaskAuthority = Readonly<{
  binding: TaskSourceSubmissionBinding;
  assertCurrent(): Promise<void>;
}>;

type SubmissionState = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  projectId: string;
  submissionId: string;
  bindingSha256: string;
  phase: "intent" | "outcome";
  producerRunId: string;
  outcome?: Readonly<{ status: "submitted"; submission: TaskSourceSubmission }>
    | Readonly<{ status: "unchanged"; headSha: string }>
    | Readonly<{ status: "conflict"; reason: "branch_changed" | "head_changed"; actualHead: string | null }>
    | Readonly<{ status: "rejected"; reason: string }>;
}>;

function exactRecord(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a plain record.`);
  const keys = Reflect.ownKeys(value), allowed = new Set(fields);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError(`${label} has unknown or missing fields.`);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`${label}.${key} must be an own data property.`);
    result[key] = descriptor.value;
  }
  return result;
}

function boundedId(value: unknown, label: string): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function parseBinding(value: unknown): TaskSourceSubmissionBinding {
  const row = exactRecord(value, ["schemaVersion", "workspaceId", "projectId", "ctoId", "workstreamId", "taskId", "packetRevision",
    "packetRecordSha256", "dependencyPins", "role", "agentId", "sessionId", "runId", "source", "readPaths", "writePaths", "qaWritePaths"], "Task source binding");
  const source = exactRecord(row.source, ["sourceId", "folderKey", "branch", "expectedHead"], "Task source contract");
  const dependencyPins = row.dependencyPins;
  const pathLists = [row.readPaths, row.writePaths, row.qaWritePaths];
  const uuidFields = [row.workspaceId, row.agentId, row.sessionId, row.runId];
  if (row.schemaVersion !== 1 || uuidFields.some(item => typeof item !== "string" || !UUID.test(item))
    || !boundedId(row.projectId, "projectId") || !boundedId(row.ctoId, "ctoId")
    || !boundedId(row.workstreamId, "workstreamId") || !boundedId(row.taskId, "taskId")
    || !Number.isSafeInteger(row.packetRevision) || (row.packetRevision as number) < 1
    || typeof row.packetRecordSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(row.packetRecordSha256)
    || (row.role !== "worker" && row.role !== "qa") || typeof source.sourceId !== "string" || !UUID.test(source.sourceId)
    || typeof source.folderKey !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(source.folderKey)
    || typeof source.branch !== "string" || source.branch.length > 240
    || !/^(?!\/)(?!.*(?:\.\.|\.lock(?:\/|$)|\/\.|\/\/|@\{))[A-Za-z0-9._/-]{1,240}(?<!\.)$/u.test(source.branch)
    || typeof source.expectedHead !== "string" || !SHA.test(source.expectedHead)) {
    throw new TypeError("Task source binding lacks an exact current packet, Worker, source, branch, or expected-head pin.");
  }
  if (!Array.isArray(dependencyPins) || dependencyPins.length > 64 || Reflect.ownKeys(dependencyPins).length !== dependencyPins.length + 1) {
    throw new TypeError("Task dependency pins are malformed.");
  }
  const pins = dependencyPins.map((item, index) => {
    const pin = exactRecord(item, ["taskId", "revision", "recordSha256"], `Task dependency pin ${index}`);
    if (!boundedId(pin.taskId, "dependency.taskId")
      || !Number.isSafeInteger(pin.revision) || (pin.revision as number) < 1
      || typeof pin.recordSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(pin.recordSha256)) throw new TypeError("Task dependency pin is invalid.");
    return Object.freeze({ taskId: pin.taskId, revision: pin.revision as number, recordSha256: pin.recordSha256 });
  });
  if (new Set(pins.map(pin => pin.taskId)).size !== pins.length) throw new TypeError("Task dependency pins must be unique.");
  for (const [index, paths] of pathLists.entries()) {
    if (!Array.isArray(paths) || paths.length > 128 || Reflect.ownKeys(paths).length !== paths.length + 1
      || paths.some(path => typeof path !== "string" || !path || path.length > 1_024 || path.startsWith("/")
        || path.includes("\\") || path.includes(":") || path.split("/").some(part => !part || part === "." || part === ".."))) {
      throw new TypeError(`Task source path set ${index} is malformed.`);
    }
    const strings = paths as string[];
    if (new Set(strings.map(path => path.toLowerCase())).size !== strings.length) throw new TypeError("Task source path sets cannot contain case-colliding paths.");
  }
  const readPaths = Object.freeze([...(row.readPaths as string[])]);
  const writePaths = Object.freeze([...(row.writePaths as string[])]);
  const qaWritePaths = Object.freeze([...(row.qaWritePaths as string[])]);
  if (new Set([...writePaths, ...qaWritePaths].map(path => path.toLowerCase())).size !== writePaths.length + qaWritePaths.length) {
    throw new TypeError("Worker and QA write paths must remain disjoint.");
  }
  return Object.freeze({ schemaVersion: 1, workspaceId: row.workspaceId as string, projectId: row.projectId as string,
    ctoId: row.ctoId as string, workstreamId: row.workstreamId as string, taskId: row.taskId as string,
    packetRevision: row.packetRevision as number, packetRecordSha256: row.packetRecordSha256 as string,
    dependencyPins: Object.freeze(pins), role: row.role, agentId: row.agentId as string, sessionId: row.sessionId as string,
    runId: row.runId as string, source: Object.freeze({ sourceId: source.sourceId as string, folderKey: source.folderKey as string,
      branch: source.branch as string, expectedHead: source.expectedHead as string }), readPaths, writePaths, qaWritePaths }) as TaskSourceSubmissionBinding;
}

function stateKey(kind: "intent" | "outcome", submissionId: string) {
  return { scopeKind: "company" as const, scopeId: "", namespace: "sonpark.my-builder", stateKey: `task-source-${kind}.v1.${submissionId}` };
}

function parseStoredSubmission(value: unknown, expected: Readonly<{ binding: TaskSourceSubmissionBinding; paths: readonly string[];
  submissionId: string; producerRunId: string }>): TaskSourceSubmission {
  const row = exactRecord(value, ["schemaVersion", "submissionId", "workspaceId", "projectId", "ctoId", "workstreamId", "taskId",
    "packetRevision", "packetRecordSha256", "dependencyPins", "role", "producer", "source", "commitSha", "treeSha",
    "changedPaths", "coreStatus", "authorityAfterCommit", "submittedAt"], "Task source submission");
  const binding = expected.binding;
  const producer = exactRecord(row.producer, ["agentId", "sessionId", "runId"], "Task submission producer");
  const source = exactRecord(row.source, ["sourceId", "folderKey", "branch", "expectedHead"], "Task submission source");
  if (row.schemaVersion !== 1 || row.submissionId !== expected.submissionId || row.workspaceId !== binding.workspaceId
    || row.projectId !== binding.projectId || row.ctoId !== binding.ctoId || row.workstreamId !== binding.workstreamId
    || row.taskId !== binding.taskId || row.packetRevision !== binding.packetRevision || row.packetRecordSha256 !== binding.packetRecordSha256
    || row.role !== binding.role || producer.agentId !== binding.agentId || producer.sessionId !== binding.sessionId
    || producer.runId !== expected.producerRunId || JSON.stringify(row.dependencyPins) !== JSON.stringify(binding.dependencyPins)
    || JSON.stringify(source) !== JSON.stringify(binding.source) || typeof row.commitSha !== "string" || !SHA.test(row.commitSha)
    || typeof row.treeSha !== "string" || !SHA.test(row.treeSha)
    || (row.coreStatus !== "committed" && row.coreStatus !== "committed_index_reconciliation_required")
    || (row.authorityAfterCommit !== "current" && row.authorityAfterCommit !== "changed")
    || typeof row.submittedAt !== "string" || !Number.isFinite(Date.parse(row.submittedAt))
    || !Array.isArray(row.changedPaths) || row.changedPaths.length < 1 || row.changedPaths.length > 64
    || row.changedPaths.some(path => typeof path !== "string" || !expected.paths.includes(path))) {
    throw new Error("Stored Task source submission does not match its immutable Task/Worker binding.");
  }
  return Object.freeze({ schemaVersion: 1, submissionId: expected.submissionId, workspaceId: binding.workspaceId,
    projectId: binding.projectId, ctoId: binding.ctoId, workstreamId: binding.workstreamId, taskId: binding.taskId,
    packetRevision: binding.packetRevision, packetRecordSha256: binding.packetRecordSha256,
    dependencyPins: binding.dependencyPins, role: binding.role,
    producer: Object.freeze({ agentId: binding.agentId, sessionId: binding.sessionId, runId: expected.producerRunId }),
    source: binding.source, commitSha: row.commitSha, treeSha: row.treeSha,
    changedPaths: Object.freeze([...(row.changedPaths as string[])]), coreStatus: row.coreStatus,
    authorityAfterCommit: row.authorityAfterCommit,
    submittedAt: row.submittedAt });
}

function parseSubmissionState(value: unknown, expected: Readonly<{ binding: TaskSourceSubmissionBinding; paths: readonly string[];
  workspaceId: string; projectId: string; submissionId: string; bindingSha256: string }>): SubmissionState {
  const statusDescriptor = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "phase") : undefined;
  const phase = statusDescriptor?.value;
  const row = exactRecord(value, phase === "intent"
    ? ["schemaVersion", "workspaceId", "projectId", "submissionId", "bindingSha256", "phase", "producerRunId"]
    : ["schemaVersion", "workspaceId", "projectId", "submissionId", "bindingSha256", "phase", "producerRunId", "outcome"],
  "Task source submission state");
  if (row.schemaVersion !== 1 || row.workspaceId !== expected.workspaceId || row.projectId !== expected.projectId
    || row.submissionId !== expected.submissionId || row.bindingSha256 !== expected.bindingSha256 || row.phase !== phase
    || typeof row.producerRunId !== "string" || !UUID.test(row.producerRunId)) {
    throw new Error("Task source submission state does not match the exact current request.");
  }
  if (phase === "intent") return Object.freeze({ schemaVersion: 1, workspaceId: expected.workspaceId,
    projectId: expected.projectId, submissionId: expected.submissionId, bindingSha256: expected.bindingSha256, phase,
    producerRunId: row.producerRunId });
  if (phase !== "outcome") throw new TypeError("Task source submission phase is invalid.");
  const rawOutcome = row.outcome;
  const outcomeStatus = rawOutcome && typeof rawOutcome === "object" ? Object.getOwnPropertyDescriptor(rawOutcome, "status")?.value : undefined;
  const outcomeRow = outcomeStatus === "submitted" ? exactRecord(rawOutcome, ["status", "submission"], "Task submission outcome")
    : outcomeStatus === "unchanged" ? exactRecord(rawOutcome, ["status", "headSha"], "Task submission outcome")
      : outcomeStatus === "conflict" ? exactRecord(rawOutcome, ["status", "reason", "actualHead"], "Task submission outcome")
        : outcomeStatus === "rejected" ? exactRecord(rawOutcome, ["status", "reason"], "Task submission outcome")
          : exactRecord(rawOutcome, [], "Task submission outcome");
  let outcome: SubmissionState["outcome"];
  if (outcomeStatus === "submitted") outcome = Object.freeze({ status: "submitted", submission: parseStoredSubmission(
    outcomeRow.submission, { binding: expected.binding, paths: expected.paths, submissionId: expected.submissionId,
      producerRunId: row.producerRunId }) });
  else if (outcomeStatus === "unchanged" && typeof outcomeRow.headSha === "string" && SHA.test(outcomeRow.headSha)) {
    outcome = Object.freeze({ status: "unchanged", headSha: outcomeRow.headSha });
  } else if (outcomeStatus === "conflict" && (outcomeRow.reason === "branch_changed" || outcomeRow.reason === "head_changed")
    && (outcomeRow.actualHead === null || typeof outcomeRow.actualHead === "string" && SHA.test(outcomeRow.actualHead))) {
    outcome = Object.freeze({ status: "conflict", reason: outcomeRow.reason, actualHead: outcomeRow.actualHead });
  } else if (outcomeStatus === "rejected" && typeof outcomeRow.reason === "string" && outcomeRow.reason.length <= 160) {
    outcome = Object.freeze({ status: "rejected", reason: outcomeRow.reason });
  } else throw new TypeError("Task source submission outcome is invalid.");
  return Object.freeze({ schemaVersion: 1, workspaceId: expected.workspaceId, projectId: expected.projectId,
    submissionId: expected.submissionId, bindingSha256: expected.bindingSha256, phase, producerRunId: row.producerRunId, outcome });
}

function parseCoreResult(value: unknown, requestedPaths: readonly string[]): CoreCommitResult {
  const status = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "status")?.value : undefined;
  if (status === "committed" || status === "committed_index_reconciliation_required") {
    const row = exactRecord(value, ["status", "commitSha", "treeSha", "changedPaths"], "Core Git commit result");
    if (typeof row.commitSha !== "string" || !SHA.test(row.commitSha) || typeof row.treeSha !== "string" || !SHA.test(row.treeSha)
      || !Array.isArray(row.changedPaths) || row.changedPaths.length < 1 || row.changedPaths.length > 64
      || row.changedPaths.some(path => typeof path !== "string" || !requestedPaths.includes(path))) {
      throw new TypeError("Core Git commit receipt does not match the requested Task paths.");
    }
    return Object.freeze({ status, commitSha: row.commitSha, treeSha: row.treeSha,
      changedPaths: Object.freeze([...(row.changedPaths as string[])]) });
  }
  if (status === "unchanged") {
    const row = exactRecord(value, ["status", "headSha"], "Core unchanged Git result");
    if (typeof row.headSha !== "string" || !SHA.test(row.headSha)) throw new TypeError("Core unchanged Git result has an invalid head.");
    return Object.freeze({ status, headSha: row.headSha });
  }
  if (status === "conflict") {
    const row = exactRecord(value, ["status", "reason", "actualHead"], "Core Git conflict result");
    if ((row.reason !== "branch_changed" && row.reason !== "head_changed")
      || !(row.actualHead === null || typeof row.actualHead === "string" && SHA.test(row.actualHead))) {
      throw new TypeError("Core Git conflict result is invalid.");
    }
    return Object.freeze({ status, reason: row.reason, actualHead: row.actualHead });
  }
  throw new TypeError("Core Git commit result is unsupported or malformed.");
}

function submissionId(binding: TaskSourceSubmissionBinding, paths: readonly string[]) {
  const { runId: _runId, ...stableBinding } = binding;
  return digest(JSON.stringify(["builder-task-source-submission-v1", stableBinding, paths]));
}

function stableBindingDigest(binding: TaskSourceSubmissionBinding) {
  const { runId: _runId, ...stableBinding } = binding;
  return digest(JSON.stringify(stableBinding));
}

function unknown(id: string, reason: string): TaskSourceSubmissionResult {
  return Object.freeze({ status: "unknown", submissionId: id, reason, commitSha: null,
    completion: "not-established", qaVerdict: "not-established" });
}

async function assertFolder(localFolders: NonNullable<CommitPlatform["localFolders"]>, binding: TaskSourceSubmissionBinding) {
  const status = exactRecord(await localFolders.status!(binding.source.folderKey), ["folderKey", "configured", "access", "readable", "writable",
    "healthy", "requiredDirectories", "requiredFiles", "missingDirectories", "missingFiles", "checkedAt"], "Core local folder status") as unknown as TaskFolderStatus;
  if (status.folderKey !== binding.source.folderKey || status.configured !== true || status.healthy !== true || status.writable !== true) {
    throw new Error("The exact Task source alias is not configured, healthy and writable.");
  }
  const match = exactRecord(await localFolders.matchWorkspaceSourceV1!(binding.source.folderKey, binding.source.sourceId),
    ["folderKey", "workspaceSourceId", "match"], "Core Workspace Source match") as unknown as TaskSourceMatch;
  if (match.folderKey !== binding.source.folderKey || match.workspaceSourceId !== binding.source.sourceId || match.match !== "same_root") {
    throw new Error("The declared Task source alias does not match the pinned Workspace Source root.");
  }
}

async function cas(state: RevisionState, key: ReturnType<typeof stateKey>, expected: { exists: false } | { exists: true; value: JsonValue }, value: unknown) {
  if (typeof state.compareAndSet !== "function") throw new Error("atomic state compareAndSet unavailable");
  return state.compareAndSet({ ...key, scopeId: key.scopeId || "" }, expected, asJson(value));
}

/**
 * Commits only a subset of the authoritative packet's role-specific paths. `resolveAuthority`
 * must derive the exact current Task/Worker from trusted Host run context; none of the branch,
 * expected-head, source, role, or identity fields are accepted from tool parameters.
 */
export async function submitTaskSourceFiles(input: Readonly<{
  runContext: unknown;
  paths: unknown;
  platform: SpsPlatformInvocationContext;
  state: RevisionState;
  resolveAuthority(runContext: unknown): Promise<ResolvedTaskAuthority>;
}>): Promise<TaskSourceSubmissionResult> {
  const platform = input.platform as CommitPlatform;
  const folders = platform.localFolders;
  if (typeof folders?.status !== "function" || typeof folders.matchWorkspaceSourceV1 !== "function"
    || typeof folders.commitTaskFilesV1 !== "function") {
    return Object.freeze({ status: "unsupported", reason: "task-source-git-commit-api-unavailable",
      completion: "not-established", qaVerdict: "not-established" });
  }
  if (typeof input.state.compareAndSet !== "function") return Object.freeze({ status: "unsupported",
    reason: "atomic-task-submission-journal-unavailable", completion: "not-established", qaVerdict: "not-established" });

  const authority = await input.resolveAuthority(input.runContext);
  const binding = parseBinding(authority.binding);
  const allowed = binding.role === "worker" ? binding.writePaths : binding.qaWritePaths;
  if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 64
    || Reflect.ownKeys(input.paths).length !== input.paths.length + 1
    || input.paths.some(path => typeof path !== "string" || !allowed.includes(path))
    || new Set(input.paths as string[]).size !== input.paths.length) {
    throw new TypeError("Submission paths must be a nonempty exact subset of the current role-specific Task write scope.");
  }
  const paths = Object.freeze([...(input.paths as string[])].sort());
  const id = submissionId(binding, paths);
  const bindingSha256 = stableBindingDigest(binding);
  const expectedState = { binding, paths, workspaceId: binding.workspaceId, projectId: binding.projectId,
    submissionId: id, bindingSha256 };
  const intentKey = { ...stateKey("intent", id), scopeId: binding.workspaceId };
  const outcomeKey = { ...stateKey("outcome", id), scopeId: binding.workspaceId };

  await authority.assertCurrent();
  let existingOutcome: JsonValue | null;
  try { existingOutcome = await input.state.get(outcomeKey); }
  catch { return unknown(id, "submission-outcome-read-failed"); }
  if (existingOutcome !== null) {
    const record = parseSubmissionState(existingOutcome, expectedState);
    if (record.phase !== "outcome" || !record.outcome) return unknown(id, "submission-outcome-invalid");
    if (record.outcome.status === "submitted") return Object.freeze({ status: "existing", submission: record.outcome.submission, duplicateCommitPrevented: true });
    if (record.outcome.status === "unchanged") return Object.freeze({ status: "unchanged", submissionId: id, headSha: record.outcome.headSha });
    if (record.outcome.status === "conflict") return Object.freeze({ status: "conflict", submissionId: id,
      reason: record.outcome.reason, actualHead: record.outcome.actualHead });
    return unknown(id, record.outcome.reason);
  }
  let existingIntent: JsonValue | null;
  try { existingIntent = await input.state.get(intentKey); }
  catch { return unknown(id, "submission-intent-read-failed"); }
  if (existingIntent !== null) {
    parseSubmissionState(existingIntent, expectedState);
    return unknown(id, "prior-commit-attempt-has-no-authoritative-outcome");
  }

  try { await assertFolder(folders, binding); }
  catch { return Object.freeze({ status: "unsupported", reason: "declared-task-source-alias-unavailable-or-mismatched",
    completion: "not-established", qaVerdict: "not-established" }); }
  await authority.assertCurrent();
  const intent: SubmissionState = Object.freeze({ schemaVersion: 1, workspaceId: binding.workspaceId,
    projectId: binding.projectId, submissionId: id, bindingSha256, phase: "intent", producerRunId: binding.runId });
  try {
    const receipt = await cas(input.state, intentKey, { exists: false }, intent);
    if (!receipt.swapped) return unknown(id, "another-producer-owns-the-exact-submission-attempt");
  } catch { return unknown(id, "submission-intent-write-unconfirmed-no-commit-attempted"); }

  const finish = async (outcome: NonNullable<SubmissionState["outcome"]>): Promise<boolean> => {
    const next: SubmissionState = Object.freeze({ schemaVersion: 1, workspaceId: binding.workspaceId,
      projectId: binding.projectId, submissionId: id, bindingSha256, phase: "outcome",
      producerRunId: binding.runId, outcome });
    try { return (await cas(input.state, outcomeKey, { exists: false }, next)).swapped; }
    catch { return false; }
  };
  try { await authority.assertCurrent(); await assertFolder(folders, binding); }
  catch {
    await finish({ status: "rejected", reason: "current-task-or-source-authority-changed-before-core-commit" });
    return unknown(id, "current-task-or-source-authority-changed-before-core-commit");
  }

  let result: CoreCommitResult;
  try {
    result = parseCoreResult(await folders.commitTaskFilesV1({ sourceId: binding.source.sourceId,
      folderKey: binding.source.folderKey, branch: binding.source.branch, expectedHead: binding.source.expectedHead, paths }), paths);
  } catch {
    await finish({ status: "rejected", reason: "core-commit-response-unknown" });
    return unknown(id, "core-commit-response-unknown-no-retry");
  }
  if (result.status === "conflict") {
    if (!await finish({ status: "conflict", reason: result.reason, actualHead: result.actualHead })) return unknown(id, "conflict-receipt-not-durably-recorded");
    return Object.freeze({ status: "conflict", submissionId: id, reason: result.reason, actualHead: result.actualHead });
  }
  if (result.status === "unchanged") {
    if (!await finish({ status: "unchanged", headSha: result.headSha })) return unknown(id, "unchanged-receipt-not-durably-recorded");
    return Object.freeze({ status: "unchanged", submissionId: id, headSha: result.headSha });
  }

  let authorityAfterCommit: TaskSourceSubmission["authorityAfterCommit"] = "current";
  try { await authority.assertCurrent(); await assertFolder(folders, binding); }
  catch { authorityAfterCommit = "changed"; }
  const submission: TaskSourceSubmission = Object.freeze({ schemaVersion: 1, submissionId: id,
    workspaceId: binding.workspaceId, projectId: binding.projectId, ctoId: binding.ctoId,
    workstreamId: binding.workstreamId, taskId: binding.taskId, packetRevision: binding.packetRevision,
    packetRecordSha256: binding.packetRecordSha256, dependencyPins: binding.dependencyPins, role: binding.role,
    producer: Object.freeze({ agentId: binding.agentId, sessionId: binding.sessionId, runId: binding.runId }),
    source: binding.source, commitSha: result.commitSha, treeSha: result.treeSha, changedPaths: result.changedPaths,
    coreStatus: result.status, authorityAfterCommit, submittedAt: new Date().toISOString() });
  if (!await finish({ status: "submitted", submission })) return unknown(id, "core-commit-known-but-source-submission-journal-unconfirmed");
  return Object.freeze({ status: "submitted", submission, duplicateCommitPrevented: false });
}
