import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { parseTaskWorkerRegistry, type TaskWorkerRecord } from "./domain/task-workers.ts";
import { parseTaskPacketRecord, taskPacketRecordDigest, type TaskPacketRecord } from "./domain/task-packets.ts";
import { assertSessionExecutionPolicySupport, TASK_WORKER_FILE_TOOL_NAMES,
  TASK_WORKER_SESSION_EXECUTION_POLICY } from "./session-execution-policy.ts";
import { hasConfirmedNotStartedSessionRequest } from "./session-request-diagnostic.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export { TASK_WORKER_FILE_TOOL_NAMES };
export const TASK_WORKER_EXECUTION_POLICY = TASK_WORKER_SESSION_EXECUTION_POLICY;

export type TaskWorkerFileBinding = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  projectId: string;
  ctoId: string;
  workstreamId: string;
  taskId: string;
  packetRevision: number;
  packetRecordSha256: string;
  role: "worker" | "qa";
  agentId: string;
  sessionId: string;
  source: TaskWorkerRecord["source"];
  sourceAccess: NonNullable<TaskPacketRecord["packet"]["sourceAccess"]>;
}>;

function plain(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a plain record.`);
  return value as Record<string, unknown>;
}

function assertCurrentPacket(input: Readonly<{
  workspaceId: string;
  projectId: string;
  ctoId: string;
  packet: TaskPacketRecord;
  currentPackets: readonly TaskPacketRecord[];
  worker: TaskWorkerRecord;
}>): string {
  const { workspaceId, projectId, ctoId, packet, currentPackets, worker } = input;
  if (!UUID.test(workspaceId) || !Array.isArray(currentPackets)) throw new TypeError("Task Worker scope is invalid.");
  parseTaskWorkerRegistry({ schemaVersion: 1, workspaceId, projectId, ctoId, revision: 1, records: [worker] },
    workspaceId, projectId, ctoId);
  const parsed = parseTaskPacketRecord(packet, projectId, ctoId, worker.workstreamId);
  const digest = taskPacketRecordDigest(parsed, projectId, ctoId, worker.workstreamId);
  const current = currentPackets.map(row => parseTaskPacketRecord(row, projectId, ctoId, worker.workstreamId));
  const head = current.find(row => row.packet.taskId === worker.taskId);
  if (!head || taskPacketRecordDigest(head, projectId, ctoId, worker.workstreamId) !== digest
    || digest !== worker.packetRecordSha256 || parsed.packet.revision !== worker.packetRevision
    || parsed.source.requestId !== worker.source.requestId || parsed.source.specRevision !== worker.source.specRevision
    || parsed.source.instructionSha256 !== worker.source.instructionSha256
    || (worker.role === "worker" ? parsed.packet.kind !== "development" : parsed.packet.kind !== "qa")) {
    throw new Error("Task Worker, exact current Task Packet, role, or Workstream source pins do not match.");
  }
  for (const pin of parsed.dependencyPins) {
    const target = current.find(row => row.packet.taskId === pin.taskId);
    if (!target || target.packet.revision !== pin.revision
      || taskPacketRecordDigest(target, projectId, ctoId, worker.workstreamId) !== pin.recordSha256) {
      throw new Error("Task Packet dependency pins are not current.");
    }
  }
  if (worker.role === "qa") {
    const qaPaths = new Set(parsed.packet.sourceAccess?.qaWritePaths.map(path => path.toLowerCase()) ?? []);
    for (const dependency of parsed.dependencyPins) {
      const implementation = current.find(row => row.packet.taskId === dependency.taskId)?.packet.sourceAccess?.writePaths ?? [];
      if (implementation.some(path => qaPaths.has(path.toLowerCase()))) {
        throw new Error("QA Task Worker file scope overlaps a pinned implementation write path.");
      }
    }
  }
  if (!parsed.packet.sourceAccess) throw new Error("Task Packet has no typed Host source and file scope.");
  return digest;
}

/** Binds exact current task/Worker pins to the CTO-published file scope. */
export function deriveTaskWorkerFileBinding(input: Readonly<{
  workspaceId: string;
  projectId: string;
  ctoId: string;
  packet: TaskPacketRecord;
  currentPackets: readonly TaskPacketRecord[];
  worker: TaskWorkerRecord;
}>): TaskWorkerFileBinding {
  const packetRecordSha256 = assertCurrentPacket(input);
  return Object.freeze({ schemaVersion: 1, workspaceId: input.workspaceId, projectId: input.projectId, ctoId: input.ctoId,
    workstreamId: input.worker.workstreamId, taskId: input.worker.taskId, packetRevision: input.worker.packetRevision,
    packetRecordSha256, role: input.worker.role, agentId: input.worker.agentId, sessionId: input.worker.sessionId,
    source: input.worker.source, sourceAccess: input.packet.packet.sourceAccess! });
}

type TaskWorkerSessionClient = {
  describePolicySupport?: (sessionId: string, companyId: string) => Promise<unknown>;
  sendMessage?: (sessionId: string, companyId: string, input: { prompt: string; reason?: string; requestId?: string;
    executionPolicy?: typeof TASK_WORKER_EXECUTION_POLICY }) => Promise<{ runId: string }>;
  getRequest?: (sessionId: string, companyId: string, requestId: string) => Promise<unknown>;
  getRun?: (sessionId: string, companyId: string, runId: string) => Promise<unknown>;
};

type TaskLocalFolders = {
  status?: (folderKey: string) => Promise<unknown>;
  matchWorkspaceSourceV1?: (folderKey: string, workspaceSourceId: string) => Promise<unknown>;
  readWorkspaceSourceTextV1?: (sourceId: string, folderKey: string, relativePath: string) => Promise<string>;
  writeWorkspaceSourceTextAtomicV1?: (sourceId: string, folderKey: string, relativePath: string, contents: string) => Promise<unknown>;
  deleteWorkspaceSourceFileV1?: (sourceId: string, folderKey: string, relativePath: string) => Promise<unknown>;
};

type ScopedPlatform = SpsPlatformInvocationContext & Readonly<{
  localFolders?: TaskLocalFolders;
  agents: SpsPlatformInvocationContext["agents"] & { sessions: TaskWorkerSessionClient };
  protectedTests?: Readonly<{ getRunV1?: (companyId: string, runId: string, subjectKeySha256: string) => Promise<unknown> }>;
}>;

function requireAllowedPath(binding: TaskWorkerFileBinding, operation: "read" | "write" | "delete", relativePath: string) {
  if (typeof relativePath !== "string" || !relativePath.trim() || relativePath.length > 1_024
    || /[\u0000-\u001f\u007f]/u.test(relativePath)) throw new TypeError("relativePath must be a bounded nonblank path.");
  const path = relativePath;
  const allowed = operation === "read" ? binding.sourceAccess.readPaths
    : binding.role === "worker" ? binding.sourceAccess.writePaths : binding.sourceAccess.qaWritePaths;
  if (!allowed.includes(path)) throw new Error(`Task Packet does not allow ${operation} access to this exact path.`);
  return path;
}

export function taskWorkerRequestId(binding: TaskWorkerFileBinding) {
  const bytes = Buffer.from(sha256(JSON.stringify(["builder-task-worker-session-v1", binding.workspaceId,
    binding.projectId, binding.ctoId, binding.workstreamId, binding.taskId, binding.packetRevision,
    binding.packetRecordSha256, binding.role, binding.agentId, binding.sessionId, binding.source,
    binding.sourceAccess])), "hex").subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type TaskWorkerRequest = Readonly<{ state: "submitted"; runId: string }>
  | Readonly<{ state: "pending" | "uncertain"; runId: null }>;

function parseTaskWorkerRequest(value: unknown, requestId: string): TaskWorkerRequest | null {
  if (value === null) return null;
  const row = plain(value, "Worker session request receipt");
  if (row.requestId === requestId) {
    if (row.state === "submitted" && typeof row.runId === "string" && UUID.test(row.runId)) {
      return { state: row.state, runId: row.runId };
    }
    if ((row.state === "pending" || row.state === "uncertain") && row.runId === null) {
      return { state: row.state, runId: null };
    }
  }
  throw new TypeError("Invalid Worker session request receipt.");
}

export type TaskWorkerDispatchResult = Readonly<{
  status: "submitted" | "existing";
  requestId: string;
  requestState: "pending" | "submitted";
  runId: string | null;
  executionStarted: null;
  completion: "not-established";
  qaVerdict: "not-established";
}> | Readonly<{ status: "unsupported" | "unknown"; reason: string; requestId: string;
  requestState: "not-attempted" | "unknown" | "uncertain" | "pending"; runId: string | null;
  executionStarted: false | null; completion: "not-established"; qaVerdict: "not-established" }>;

/** Starts one exact Worker or QA session request, limited to registered Task source file tools. */
export async function dispatchTaskWorkerSession(input: Readonly<{
  platform: SpsPlatformInvocationContext;
  binding: TaskWorkerFileBinding;
  packet: TaskPacketRecord;
  assertCurrent(): Promise<void>;
}>): Promise<TaskWorkerDispatchResult> {
  const requestId = taskWorkerRequestId(input.binding);
  const unknown = (reason: string, runId: string | null = null, requestState: "unknown" | "uncertain" | "pending" = "unknown",
    executionStarted: false | null = null): TaskWorkerDispatchResult => Object.freeze({
    status: "unknown", reason, requestId, requestState, runId, executionStarted, completion: "not-established", qaVerdict: "not-established",
  });
  const unsupported = (reason: string): TaskWorkerDispatchResult => Object.freeze({
    status: "unsupported", reason, requestId, requestState: "not-attempted", runId: null, executionStarted: false,
    completion: "not-established", qaVerdict: "not-established",
  });
  const packet = parseTaskPacketRecord(input.packet, input.binding.projectId, input.binding.ctoId, input.binding.workstreamId);
  if (taskPacketRecordDigest(packet, input.binding.projectId, input.binding.ctoId, input.binding.workstreamId)
    !== input.binding.packetRecordSha256 || packet.packet.revision !== input.binding.packetRevision
    || packet.packet.taskId !== input.binding.taskId || !packet.packet.sourceAccess
    || JSON.stringify(packet.packet.sourceAccess) !== JSON.stringify(input.binding.sourceAccess)) {
    throw new Error("Worker dispatch packet does not match the derived Task source binding.");
  }
  const platform = input.platform as ScopedPlatform;
  const sessions = platform.agents.sessions;
  const localFolders = platform.localFolders;
  if (typeof sessions.getRequest !== "function") return unsupported("worker-session-request-reader-unavailable");
  await input.assertCurrent();
  let prior: TaskWorkerRequest | null;
  try { prior = parseTaskWorkerRequest(await sessions.getRequest(input.binding.sessionId, input.binding.workspaceId, requestId), requestId); }
  catch { return unknown("worker-request-read-failed-or-invalid"); }
  await input.assertCurrent();
  if (prior && prior.runId === null && await hasConfirmedNotStartedSessionRequest({ sessions,
    sessionId: input.binding.sessionId, workspaceId: input.binding.workspaceId, requestId, assertCurrent: input.assertCurrent })) {
    return unknown("worker-request-confirmed-not-started-no-automatic-retry", null, prior.state, false);
  }
  if (prior?.state === "uncertain") return unknown("worker-request-state-uncertain", null, "uncertain");
  if (prior) {
    return Object.freeze({ status: "existing", requestId, requestState: prior.state, runId: prior.runId,
      executionStarted: null, completion: "not-established", qaVerdict: "not-established" });
  }
  if (typeof sessions.describePolicySupport !== "function" || typeof sessions.sendMessage !== "function"
    || typeof localFolders?.status !== "function"
    || typeof localFolders.matchWorkspaceSourceV1 !== "function" || typeof localFolders.readWorkspaceSourceTextV1 !== "function"
    || typeof localFolders.writeWorkspaceSourceTextAtomicV1 !== "function" || typeof localFolders.deleteWorkspaceSourceFileV1 !== "function") {
    return unsupported("task-worker-session-policy-or-local-folder-api-unavailable");
  }
  try {
    await assertSessionExecutionPolicySupport(input.platform, input.binding.sessionId, input.binding.workspaceId);
  } catch { return unsupported("restricted-worker-session-policy-unavailable"); }
  try { await assertTaskFolderAccess(localFolders, input.binding, "write"); }
  catch { return unsupported("task-worker-source-folder-not-current-and-writable"); }
  const prompt = [
    input.binding.role === "worker"
      ? "Implement only the exact assigned Builder Task Packet below, using writePaths for implementation changes."
      : "Perform only the independent QA task below, using qaWritePaths for test or configuration changes. Do not modify any pinned dependency's implementation write paths or evidence. Once builder.request-protected-task-qa confirms a queued execution and recorded Task reference, finish this AI turn normally without polling or claiming Task completion. The current Node must be released before protected execution can run. Only the system's real protected-test terminal event may automatically continue this pending QA; do not send a continue or DONE message to yourself. On continuation, re-read the exact protected result and assess every assigned acceptance/test-plan criterion before builder.publish-task-qa-report. If that Host continuation is unsupported, preserve the pending QA and report the missing support. Unsupported or uncertain execution is not QA PASS.",
    "Use only the task-scoped source file tools and exact paths in sourceAccess. After the assigned changes are ready to hand off, call builder.submit-task-source with the exact changed paths; the packet must explicitly pin branch and expectedHead. A conflict or unknown response is not permission to retry, switch branch, or guess a new head. Do not use generic test commands as protected QA, claim completion, or expand the authorized source root or file list.",
    "This dispatch is one idempotent attempt for this exact packet revision. If its result is uncertain, reconcile this same request; do not dispatch a replacement.",
    JSON.stringify({ packet, sourceBinding: { schemaVersion: input.binding.schemaVersion, projectId: input.binding.projectId,
      ctoId: input.binding.ctoId, workstreamId: input.binding.workstreamId, taskId: input.binding.taskId,
      packetRevision: input.binding.packetRevision, packetRecordSha256: input.binding.packetRecordSha256,
      role: input.binding.role, agentId: input.binding.agentId, sessionId: input.binding.sessionId,
      source: input.binding.source, sourceAccess: input.binding.sourceAccess } }),
  ].join("\n\n");
  await input.assertCurrent();
  let accepted: { runId: string };
  try {
    accepted = await sessions.sendMessage(input.binding.sessionId, input.binding.workspaceId,
      { requestId, reason: "builder-task-worker", prompt, executionPolicy: TASK_WORKER_EXECUTION_POLICY });
  } catch { return unknown("worker-session-dispatch-response-uncertain"); }
  if (!accepted || typeof accepted.runId !== "string" || !UUID.test(accepted.runId)) return unknown("worker-session-dispatch-receipt-invalid");
  try { await input.assertCurrent(); }
  catch { return unknown("task-authority-changed-after-worker-dispatch", accepted.runId); }
  try { await assertTaskFolderAccess(localFolders, input.binding, "write"); }
  catch { return unknown("task-source-folder-changed-after-worker-dispatch", accepted.runId); }
  try {
    const receipt = parseTaskWorkerRequest(await sessions.getRequest(input.binding.sessionId, input.binding.workspaceId, requestId), requestId);
    await input.assertCurrent();
    if (receipt?.state !== "submitted" || receipt.runId !== accepted.runId) {
      return unknown("worker-dispatch-receipt-does-not-confirm-the-exact-run", accepted.runId);
    }
  } catch { return unknown("worker-dispatch-receipt-read-failed", accepted.runId); }
  return Object.freeze({ status: "submitted", requestId, requestState: "submitted", runId: accepted.runId, executionStarted: null,
    completion: "not-established", qaVerdict: "not-established" });
}

export type TaskWorkerSessionObservation = Readonly<{
  status: "observed";
  requestId: string;
  runId: string;
  runStatus: string;
  termination: "not_applicable" | "pending" | "confirmed";
  outputState: "available" | "not_ready" | "withheld" | "unsupported";
  completion: "not-established";
  qaVerdict: "not-established";
}> | Readonly<{ status: "pending" | "unknown" | "unsupported"; reason: string; requestId: string;
  runId: string | null; completion: "not-established"; qaVerdict: "not-established" }>;

/** Reconciles only the deterministic request for this exact Worker session and task binding. */
export async function readTaskWorkerSessionRun(input: Readonly<{
  platform: SpsPlatformInvocationContext;
  binding: TaskWorkerFileBinding;
  assertCurrent(): Promise<void>;
}>): Promise<TaskWorkerSessionObservation> {
  const requestId = taskWorkerRequestId(input.binding);
  const unknown = (reason: string, runId: string | null = null): TaskWorkerSessionObservation => Object.freeze({
    status: "unknown", reason, requestId, runId, completion: "not-established", qaVerdict: "not-established",
  });
  const unsupported = (reason: string): TaskWorkerSessionObservation => Object.freeze({
    status: "unsupported", reason, requestId, runId: null, completion: "not-established", qaVerdict: "not-established",
  });
  const sessions = (input.platform as ScopedPlatform).agents.sessions;
  if (typeof sessions.getRequest !== "function" || typeof sessions.getRun !== "function") return unsupported("worker-session-result-reader-unavailable");
  try {
    await input.assertCurrent();
    const request = parseTaskWorkerRequest(await sessions.getRequest(input.binding.sessionId, input.binding.workspaceId, requestId), requestId);
    await input.assertCurrent();
    if (!request) return unknown("exact-worker-session-request-not-found");
    if (request.runId === null && await hasConfirmedNotStartedSessionRequest({ sessions,
      sessionId: input.binding.sessionId, workspaceId: input.binding.workspaceId, requestId, assertCurrent: input.assertCurrent })) {
      return unknown("worker-session-request-confirmed-not-started-no-automatic-retry");
    }
    if (request.state === "uncertain") return unknown("worker-session-request-state-uncertain");
    if (request.runId === null) return Object.freeze({ status: "pending", reason: "worker-session-request-has-no-run-id-yet",
      requestId, runId: null, completion: "not-established", qaVerdict: "not-established" });
    const raw = plain(await sessions.getRun(input.binding.sessionId, input.binding.workspaceId, request.runId), "Worker session Run");
    await input.assertCurrent();
    if (raw.runId !== request.runId || typeof raw.status !== "string"
      || !["queued", "running", "succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(raw.status)) {
      return unknown("worker-session-run-identity-or-status-invalid", request.runId);
    }
    if (raw.termination !== "not_applicable" && raw.termination !== "pending" && raw.termination !== "confirmed") {
      return unknown("worker-session-run-termination-invalid", request.runId);
    }
    let outputState: "available" | "not_ready" | "withheld" | "unsupported" = "unsupported";
    if (raw.output !== undefined) {
      const output = plain(raw.output, "Worker session output");
      if (output.state === "available" || output.state === "not_ready" || output.state === "withheld") outputState = output.state;
      else return unknown("worker-session-run-output-state-invalid", request.runId);
    }
    return Object.freeze({ status: "observed", requestId, runId: request.runId, runStatus: raw.status,
      termination: raw.termination, outputState, completion: "not-established", qaVerdict: "not-established" });
  } catch { return unknown("worker-session-run-read-or-current-authority-check-failed"); }
}

async function assertTaskFolderAccess(localFolders: TaskLocalFolders, binding: TaskWorkerFileBinding,
  operation: "read" | "write") {
  if (typeof localFolders.status !== "function" || typeof localFolders.matchWorkspaceSourceV1 !== "function") {
    throw new Error("Core Host folder status or Workspace Source matching is unavailable.");
  }
  const status = plain(await localFolders.status(binding.sourceAccess.folderKey), "Core local-folder status");
  if (status.folderKey !== binding.sourceAccess.folderKey || status.configured !== true || status.healthy !== true
    || (operation === "read" ? status.readable !== true : status.writable !== true)) {
    throw new Error("Core did not confirm the exact configured, healthy Host folder access.");
  }
  const match = plain(await localFolders.matchWorkspaceSourceV1(binding.sourceAccess.folderKey, binding.sourceAccess.sourceId),
    "Core Workspace Source match");
  if (match.folderKey !== binding.sourceAccess.folderKey || match.workspaceSourceId !== binding.sourceAccess.sourceId
    || match.match !== "same_root") throw new Error("Core local-folder alias does not match the pinned Workspace Source root.");
}

/** Uses the actual Workspace-bound Host folder API; packet paths narrow the configured folder grant. */
export async function readTaskWorkerSourceFile(input: Readonly<{
  platform: SpsPlatformInvocationContext;
  binding: TaskWorkerFileBinding;
  relativePath: string;
  assertCurrent(): Promise<void>;
}>): Promise<Readonly<{ status: "read"; text: string } | { status: "unsupported"; reason: string }>> {
  const relativePath = requireAllowedPath(input.binding, "read", input.relativePath);
  const localFolders = (input.platform as ScopedPlatform).localFolders;
  if (typeof localFolders?.status !== "function" || typeof localFolders.matchWorkspaceSourceV1 !== "function"
    || typeof localFolders.readWorkspaceSourceTextV1 !== "function") {
    return Object.freeze({ status: "unsupported", reason: "source-bound-workspace-file-read-unavailable" });
  }
  await input.assertCurrent();
  await assertTaskFolderAccess(localFolders, input.binding, "read");
  const text = await localFolders.readWorkspaceSourceTextV1(input.binding.sourceAccess.sourceId,
    input.binding.sourceAccess.folderKey, relativePath);
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 256 * 1024) throw new TypeError("Core returned an invalid or oversized source file.");
  await input.assertCurrent();
  await assertTaskFolderAccess(localFolders, input.binding, "read");
  return Object.freeze({ status: "read", text });
}

export async function writeTaskWorkerSourceFile(input: Readonly<{
  platform: SpsPlatformInvocationContext;
  binding: TaskWorkerFileBinding;
  relativePath: string;
  contents: string;
  assertCurrent(): Promise<void>;
}>): Promise<Readonly<{ status: "written" } | { status: "unsupported" | "unknown"; reason: string }>> {
  const relativePath = requireAllowedPath(input.binding, "write", input.relativePath);
  if (typeof input.contents !== "string" || Buffer.byteLength(input.contents, "utf8") > 256 * 1024) throw new TypeError("Task source contents exceed the bounded write limit.");
  const localFolders = (input.platform as ScopedPlatform).localFolders;
  if (typeof localFolders?.status !== "function" || typeof localFolders.matchWorkspaceSourceV1 !== "function"
    || typeof localFolders.writeWorkspaceSourceTextAtomicV1 !== "function") {
    return Object.freeze({ status: "unsupported", reason: "source-bound-workspace-file-write-unavailable" });
  }
  await input.assertCurrent();
  await assertTaskFolderAccess(localFolders, input.binding, "write");
  try {
    await localFolders.writeWorkspaceSourceTextAtomicV1(input.binding.sourceAccess.sourceId,
      input.binding.sourceAccess.folderKey, relativePath, input.contents);
  } catch { return Object.freeze({ status: "unknown", reason: "task-source-write-outcome-uncertain" }); }
  try { await input.assertCurrent(); }
  catch { return Object.freeze({ status: "unknown", reason: "task-source-authority-changed-after-write" }); }
  try { await assertTaskFolderAccess(localFolders, input.binding, "write"); }
  catch { return Object.freeze({ status: "unknown", reason: "task-source-folder-changed-after-write" }); }
  return Object.freeze({ status: "written" });
}

export async function deleteTaskWorkerSourceFile(input: Readonly<{
  platform: SpsPlatformInvocationContext;
  binding: TaskWorkerFileBinding;
  relativePath: string;
  assertCurrent(): Promise<void>;
}>): Promise<Readonly<{ status: "deleted" } | { status: "unsupported" | "unknown"; reason: string }>> {
  const relativePath = requireAllowedPath(input.binding, "delete", input.relativePath);
  const localFolders = (input.platform as ScopedPlatform).localFolders;
  if (typeof localFolders?.status !== "function" || typeof localFolders.matchWorkspaceSourceV1 !== "function"
    || typeof localFolders.deleteWorkspaceSourceFileV1 !== "function") {
    return Object.freeze({ status: "unsupported", reason: "source-bound-workspace-file-delete-unavailable" });
  }
  await input.assertCurrent();
  await assertTaskFolderAccess(localFolders, input.binding, "write");
  try {
    await localFolders.deleteWorkspaceSourceFileV1(input.binding.sourceAccess.sourceId,
      input.binding.sourceAccess.folderKey, relativePath);
  } catch { return Object.freeze({ status: "unknown", reason: "task-source-delete-outcome-uncertain" }); }
  try { await input.assertCurrent(); }
  catch { return Object.freeze({ status: "unknown", reason: "task-source-authority-changed-after-delete" }); }
  try { await assertTaskFolderAccess(localFolders, input.binding, "write"); }
  catch { return Object.freeze({ status: "unknown", reason: "task-source-folder-changed-after-delete" }); }
  return Object.freeze({ status: "deleted" });
}

export type TaskProtectedRunObservation = Readonly<{ status: "unsupported"; reason: string; qaVerdict: "not-established" }>;

/** The SDK reader is not task-bound until Core exposes the approved task/plan binding. */
export async function readTaskWorkerProtectedRun(input: Readonly<{
  platform: SpsPlatformInvocationContext;
  binding: TaskWorkerFileBinding;
  runId: string;
  assertCurrent(): Promise<void>;
}>): Promise<TaskProtectedRunObservation> {
  if (typeof input.runId !== "string" || !UUID.test(input.runId)) throw new TypeError("Protected Test run ID must be a canonical UUID.");
  void input.platform; void input.binding; void input.assertCurrent;
  return Object.freeze({ status: "unsupported", reason: "task-bound-protected-test-producer-and-approved-plan-binding-unavailable",
    qaVerdict: "not-established" });
}
