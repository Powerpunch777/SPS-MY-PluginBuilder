import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { consultationRequestBytes } from "../domain/consultation-file.ts";

export const MAX_BATCH_SOURCE_BYTES = 48 * 1024;
export const MAX_CONSULTATION_BATCHES = 1_000;
export const MAX_CONSULTATION_BATCH_INDEX_BYTES = 262_144;
export const MAX_CONSULTATION_CAS_WIRE_BYTES = 262_144;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type ConsultationBatchSummary = {
  id: string; sourceId: string; sha256: string; sourceName: string; suppliedAt: "UNKNOWN";
  lineCount: number; selectedFromLine: number; selectedThroughLine: number; status: "incomplete";
  sender: "UNKNOWN"; messageTimes: "UNKNOWN"; attachments: "UNKNOWN"; coverage: "UNKNOWN";
};
export type ConsultationBatch = ConsultationBatchSummary & { originalText: string; selectedText: string; createdAt: string };
export type ConsultationAnalysisSnapshot = Readonly<{
  workspaceId: string; projectId: string; requestId: string;
  sources: readonly Readonly<{ sourceId: string; sha256: string }>[];
  requestedAt: string;
}>;
export type ProjectConsultationSourceSummary = Readonly<ConsultationBatchSummary & { workspaceId: string; projectId: string }>;
export type ProjectConsultationSource = Readonly<ProjectConsultationSourceSummary & {
  originalText: string; selectedText: string; createdAt: string; receivedAt: string;
}>;
export type ProjectConsultationMessageSummary = Readonly<{
  workspaceId: string; projectId: string; sourceId: string; messageId: string; snapshotSourceId: string;
  sha256: string; receivedAt: string; receivedOrder: number; sourceOrder: number | null;
  orderStatus: "UNKNOWN" | "IN_ORDER" | "GAP" | "OUT_OF_ORDER"; coverage: "UNKNOWN" | "GAP" | "OUT_OF_ORDER";
  sender: string; sourceMessageAt: string | null;
}>;
export type ProjectConsultationMessage = Readonly<ProjectConsultationMessageSummary & { originalText: string }>;
const key = (workspaceId: string, stateKey: string) => ({ scopeKind: "company" as const,
  scopeId: workspaceId, namespace: "sonpark.my-builder", stateKey });
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const validProjectId = (value: unknown): value is string => typeof value === "string" && !!value.trim()
  && value.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(value);
const validSnapshotSourceId = (value: unknown): value is string => typeof value === "string"
  && (/^consultation-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    || /^consultation-message-[a-f0-9]{64}$/u.test(value));
function parseSummary(value: unknown): ConsultationBatchSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("상담 Batch 기록을 검증할 수 없습니다.");
  const row = value as Record<string, unknown>;
  const fields = ["id", "sourceId", "sha256", "sourceName", "suppliedAt", "lineCount", "selectedFromLine", "selectedThroughLine", "status", "sender", "messageTimes", "attachments", "coverage"];
  if (Object.keys(row).sort().join(",") !== [...fields].sort().join(",") || typeof row.id !== "string" || !UUID.test(row.id)
    || row.sourceId !== `consultation-${row.id}` || typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256)
    || typeof row.sourceName !== "string" || !row.sourceName.trim() || row.sourceName.length > 200 || row.suppliedAt !== "UNKNOWN"
    || !Number.isSafeInteger(row.lineCount) || (row.lineCount as number) < 1
    || !Number.isSafeInteger(row.selectedFromLine) || !Number.isSafeInteger(row.selectedThroughLine)
    || (row.selectedFromLine as number) < 1 || (row.selectedThroughLine as number) < (row.selectedFromLine as number)
    || (row.selectedThroughLine as number) > (row.lineCount as number) || row.status !== "incomplete"
    || row.sender !== "UNKNOWN" || row.messageTimes !== "UNKNOWN" || row.attachments !== "UNKNOWN" || row.coverage !== "UNKNOWN") {
    throw new TypeError("상담 Batch 기록을 검증할 수 없습니다.");
  }
  return row as ConsultationBatchSummary;
}

function parseBatch(value: unknown): ConsultationBatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("상담 Batch 원문 레코드를 검증할 수 없습니다.");
  const row = value as Record<string, unknown>;
  const fields = ["id", "sourceId", "sha256", "sourceName", "suppliedAt", "lineCount", "selectedFromLine", "selectedThroughLine", "status", "sender", "messageTimes", "attachments", "coverage", "originalText", "selectedText", "createdAt"];
  if (Object.keys(row).sort().join(",") !== [...fields].sort().join(",") || typeof row.originalText !== "string"
    || typeof row.selectedText !== "string" || typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt))) {
    throw new TypeError("상담 Batch 원문 레코드를 검증할 수 없습니다.");
  }
  const summaryValue = Object.fromEntries(Object.entries(row).filter(([name]) => name !== "originalText" && name !== "selectedText" && name !== "createdAt"));
  const summary = parseSummary(summaryValue);
  if (summary.sha256 !== sha256(row.originalText)) throw new Error("상담 Batch 원문 hash가 저장 기록과 다릅니다.");
  const preview = previewConsultationBatch({ id: summary.id, text: row.originalText, sourceName: summary.sourceName,
    fromLine: summary.selectedFromLine, throughLine: summary.selectedThroughLine });
  if (preview.lineCount !== summary.lineCount || preview.selectedText !== row.selectedText) {
    throw new Error("상담 Batch 원문·선택 범위 기록이 서로 다릅니다.");
  }
  return row as unknown as ConsultationBatch;
}

function sameBatchContent(left: ConsultationBatch, right: ConsultationBatch): boolean {
  return left.id === right.id && left.sourceId === right.sourceId && left.sha256 === right.sha256
    && left.sourceName === right.sourceName && left.suppliedAt === right.suppliedAt && left.lineCount === right.lineCount
    && left.selectedFromLine === right.selectedFromLine && left.selectedThroughLine === right.selectedThroughLine
    && left.status === right.status && left.sender === right.sender && left.messageTimes === right.messageTimes
    && left.attachments === right.attachments && left.coverage === right.coverage
    && left.originalText === right.originalText && left.selectedText === right.selectedText;
}

function projectIndexKey(workspaceId: string, projectId: string) {
  return key(workspaceId, `consultation-project.v1.${projectId}.index`);
}

function projectSourceKey(workspaceId: string, projectId: string, id: string) {
  return key(workspaceId, `consultation-project.v1.${projectId}.source.${id}`);
}

function projectMessageIndexKey(workspaceId: string, projectId: string) {
  return key(workspaceId, `consultation-project.v1.${projectId}.messages.index`);
}

function projectMessageRecordKey(workspaceId: string, projectId: string, sourceId: string, messageId: string) {
  const messageKey = sha256(`${sourceId}\u0000${messageId}`);
  return key(workspaceId, `consultation-project.v1.${projectId}.message.${messageKey}`);
}

function messageSnapshotSourceId(sourceId: string, messageId: string) {
  return `consultation-message-${sha256(`${sourceId}\u0000${messageId}`)}`;
}

function parseProjectConsultationMessageSummary(value: unknown, workspaceId: string, projectId: string): ProjectConsultationMessageSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Project consultation message receipt is invalid.");
  const row = value as Record<string, unknown>;
  const fields = ["workspaceId", "projectId", "sourceId", "messageId", "snapshotSourceId", "sha256", "receivedAt",
    "receivedOrder", "sourceOrder", "orderStatus", "coverage", "sender", "sourceMessageAt"];
  if (Object.keys(row).sort().join(",") !== [...fields].sort().join(",") || row.workspaceId !== workspaceId || row.projectId !== projectId
    || typeof row.sourceId !== "string" || !row.sourceId.trim() || row.sourceId.length > 160 || /[\u0000-\u001f\u007f]/u.test(row.sourceId)
    || typeof row.messageId !== "string" || !row.messageId.trim() || row.messageId.length > 160 || /[\u0000-\u001f\u007f]/u.test(row.messageId)
    || row.snapshotSourceId !== messageSnapshotSourceId(row.sourceId as string, row.messageId as string)
    || typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.sha256)
    || typeof row.receivedAt !== "string" || !Number.isFinite(Date.parse(row.receivedAt))
    || !Number.isSafeInteger(row.receivedOrder) || (row.receivedOrder as number) < 1
    || row.sourceOrder !== null && (!Number.isSafeInteger(row.sourceOrder) || (row.sourceOrder as number) < 1)
    || !["UNKNOWN", "IN_ORDER", "GAP", "OUT_OF_ORDER"].includes(row.orderStatus as string)
    || !["UNKNOWN", "GAP", "OUT_OF_ORDER"].includes(row.coverage as string)
    || typeof row.sender !== "string" || row.sender.length > 200
    || row.sourceMessageAt !== null && (typeof row.sourceMessageAt !== "string" || !Number.isFinite(Date.parse(row.sourceMessageAt)))) {
    throw new TypeError("Project consultation message receipt is invalid.");
  }
  return Object.freeze(row as unknown as ProjectConsultationMessageSummary);
}

function parseProjectConsultationMessage(value: unknown, workspaceId: string, projectId: string): ProjectConsultationMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Project consultation message source is invalid.");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "messageId,originalText,projectId,receivedAt,sender,sha256,sourceId,sourceMessageAt,sourceOrder,workspaceId"
    || row.workspaceId !== workspaceId || row.projectId !== projectId || typeof row.sourceId !== "string" || typeof row.messageId !== "string"
    || typeof row.originalText !== "string" || new TextEncoder().encode(row.originalText).byteLength > MAX_BATCH_SOURCE_BYTES
    || typeof row.receivedAt !== "string" || !Number.isFinite(Date.parse(row.receivedAt))
    || row.sourceOrder !== null && (!Number.isSafeInteger(row.sourceOrder) || (row.sourceOrder as number) < 1)
    || typeof row.sender !== "string" || row.sender.length > 200
    || row.sourceMessageAt !== null && (typeof row.sourceMessageAt !== "string" || !Number.isFinite(Date.parse(row.sourceMessageAt)))) {
    throw new TypeError("Project consultation message source is invalid.");
  }
  const summary = { workspaceId, projectId, sourceId: row.sourceId, messageId: row.messageId,
    snapshotSourceId: messageSnapshotSourceId(row.sourceId, row.messageId), sha256: row.sha256,
    receivedAt: row.receivedAt, receivedOrder: 1, sourceOrder: row.sourceOrder, orderStatus: "UNKNOWN", coverage: "UNKNOWN",
    sender: row.sender, sourceMessageAt: row.sourceMessageAt };
  const parsed = parseProjectConsultationMessageSummary(summary, workspaceId, projectId);
  if (parsed.sha256 !== sha256(row.originalText)) throw new Error("Project consultation message UTF-8 SHA-256 does not match its original text.");
  return Object.freeze({ ...parsed, originalText: row.originalText });
}

function parseProjectConsultationMessageIndex(value: JsonValue | null, workspaceId: string, projectId: string): ProjectConsultationMessageSummary[] {
  if (value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_CONSULTATION_BATCHES) throw new TypeError("Project message receipt index exceeds its bounded entry count.");
  const entries = value.map(entry => parseProjectConsultationMessageSummary(entry, workspaceId, projectId));
  if (entries.some((entry, index) => entry.receivedOrder !== index + 1)
    || new Set(entries.map(entry => `${entry.sourceId}\u0000${entry.messageId}`)).size !== entries.length) {
    throw new TypeError("Project message receipt index has invalid order or duplicate message IDs.");
  }
  return entries;
}

function parseProjectSourceSummary(value: unknown, workspaceId: string, projectId: string): ProjectConsultationSourceSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Project consultation index entry is invalid.");
  const row = value as Record<string, unknown>;
  if (row.workspaceId !== workspaceId || row.projectId !== projectId) throw new Error("Project consultation index scope mismatch.");
  const summary = Object.fromEntries(Object.entries(row).filter(([name]) => name !== "workspaceId" && name !== "projectId"));
  const parsed = parseSummary(summary);
  return Object.freeze({ ...parsed, workspaceId, projectId });
}

function parseProjectConsultationSource(value: unknown, workspaceId: string, projectId: string): ProjectConsultationSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Project consultation source is invalid.");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "batch,projectId,receivedAt,workspaceId"
    || row.workspaceId !== workspaceId || row.projectId !== projectId || typeof row.receivedAt !== "string"
    || !Number.isFinite(Date.parse(row.receivedAt)) || new Date(row.receivedAt).toISOString() !== row.receivedAt) {
    throw new TypeError("Project consultation source scope or receipt is invalid.");
  }
  const batch = parseBatch(row.batch);
  return Object.freeze({ ...batch, workspaceId, projectId, receivedAt: row.receivedAt });
}

function sameProjectSourceContent(left: ProjectConsultationSource, right: ConsultationBatch): boolean {
  return left.id === right.id && left.sourceId === right.sourceId && left.sha256 === right.sha256
    && left.sourceName === right.sourceName && left.lineCount === right.lineCount
    && left.selectedFromLine === right.selectedFromLine && left.selectedThroughLine === right.selectedThroughLine
    && left.originalText === right.originalText && left.selectedText === right.selectedText;
}

function casReceipt(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== 1 || Reflect.ownKeys(value)[0] !== "swapped") throw new TypeError("Host returned an invalid compareAndSet receipt.");
  const field = Object.getOwnPropertyDescriptor(value, "swapped");
  if (!field?.enumerable || !Object.hasOwn(field, "value") || typeof field.value !== "boolean") throw new TypeError("Host returned an invalid compareAndSet receipt.");
  return field.value;
}

async function compareAndSet(platform: SpsPlatformInvocationContext, target: ReturnType<typeof key>,
  expected: { exists: false } | { exists: true; value: JsonValue }, value: unknown): Promise<boolean> {
  if (typeof platform.state.compareAndSet !== "function") {
    throw new Error("Unsupported Host: atomic state.compareAndSet is required for consultation Batch storage.");
  }
  const wire = { ...target, expected, value };
  const serialized = JSON.stringify(wire);
  if (new TextEncoder().encode(serialized).byteLength > MAX_CONSULTATION_CAS_WIRE_BYTES) {
    throw new Error("Consultation state compareAndSet request exceeds the SDK 262144-byte UTF-8 wire limit; no write was attempted.");
  }
  try { return casReceipt(await platform.state.compareAndSet(target, expected, value as JsonValue)); }
  catch {
    throw new Error("Batch compareAndSet outcome is uncertain. Existing source data was retained; inspect Workspace state and retry only with the same Batch ID and exact input.");
  }
}

export function previewConsultationBatch(input: { id: string; text: string; sourceName: string; fromLine: number; throughLine: number }) {
  if (!UUID.test(input.id) || typeof input.text !== "string" || !input.text.trim()
    || new TextEncoder().encode(input.text).byteLength > MAX_BATCH_SOURCE_BYTES
    || typeof input.sourceName !== "string" || !input.sourceName.trim() || input.sourceName.length > 200) {
    throw new TypeError("상담 Batch에는 ID, 원문, 출처 이름이 필요하며 원문은 48 KiB 이하여야 합니다.");
  }
  const lines = input.text.split(/\r?\n/);
  if (!Number.isSafeInteger(input.fromLine) || !Number.isSafeInteger(input.throughLine)
    || input.fromLine < 1 || input.throughLine < input.fromLine || input.throughLine > lines.length) {
    throw new TypeError("선택한 원문 줄 범위를 확인해 주세요.");
  }
  const starts = [0];
  for (let index = 0; index < input.text.length; index += 1) if (input.text[index] === "\n") starts.push(index + 1);
  const start = starts[input.fromLine - 1]!;
  const nextStart = starts[input.throughLine];
  let end = nextStart ?? input.text.length;
  if (nextStart !== undefined) end -= input.text[end - 2] === "\r" ? 2 : 1;
  const selectedText = input.text.slice(start, end);
  if (consultationRequestBytes(selectedText) > MAX_BATCH_SOURCE_BYTES) throw new TypeError("선택 범위가 저장 요청의 48 KiB 한도를 넘습니다.");
  return { id: input.id, sha256: sha256(input.text), sourceName: input.sourceName,
    lineCount: lines.length, selectedFromLine: input.fromLine, selectedThroughLine: input.throughLine,
    selectedText, duplicateHashNeedsReview: false as boolean };
}

export async function readConsultationBatches(workspaceId: string, platform: SpsPlatformInvocationContext): Promise<ConsultationBatchSummary[]> {
  const value = await platform.state.get(key(workspaceId, "consultation-batches.v1"));
  if (value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_CONSULTATION_BATCHES) throw new TypeError("상담 Batch 목록을 검증할 수 없습니다.");
  return value.map(parseSummary);
}

export async function saveConsultationBatch(workspaceId: string, input: {
  id: string; sourceName: string; text: string; fromLine: number; throughLine: number; createdAt: string;
}, sourceId: string, platform: SpsPlatformInvocationContext): Promise<ConsultationBatch> {
  if (typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt))
    || new Date(input.createdAt).toISOString() !== input.createdAt) throw new TypeError("Batch creation time must be a canonical ISO timestamp.");
  const preview = previewConsultationBatch(input);
  if (sourceId !== `consultation-${input.id}`) throw new TypeError("Batch source ID does not match the requested Batch ID.");
  const summary: ConsultationBatchSummary = { id: input.id, sourceId, sha256: preview.sha256, sourceName: input.sourceName,
    suppliedAt: "UNKNOWN", lineCount: preview.lineCount, selectedFromLine: input.fromLine,
    selectedThroughLine: input.throughLine, status: "incomplete", sender: "UNKNOWN", messageTimes: "UNKNOWN",
    attachments: "UNKNOWN", coverage: "UNKNOWN" };
  const batch: ConsultationBatch = { id: input.id, sourceId, sha256: preview.sha256, sourceName: input.sourceName,
    suppliedAt: "UNKNOWN", lineCount: preview.lineCount, selectedFromLine: input.fromLine,
    selectedThroughLine: input.throughLine, status: "incomplete", sender: "UNKNOWN", messageTimes: "UNKNOWN",
    attachments: "UNKNOWN", coverage: "UNKNOWN", originalText: input.text, selectedText: preview.selectedText,
    createdAt: input.createdAt };
  const recordKey = key(workspaceId, `consultation-batch.v1.${input.id}`);
  let raw: JsonValue | null;
  try { raw = await platform.state.get(recordKey); }
  catch { throw new Error("Batch record lookup failed; no new record was written."); }
  let stored: ConsultationBatch | null = raw === null ? null : parseBatch(raw);
  if (stored && !sameBatchContent(stored, batch)) {
    throw new Error("Batch ID already stores different original text, selected range, or metadata; existing record was retained.");
  }
  const indexKey = key(workspaceId, "consultation-batches.v1");
  const initialSummaries = await readConsultationBatches(workspaceId, platform);
  const initialEntry = initialSummaries.find(item => item.id === input.id);
  if (initialEntry && JSON.stringify(initialEntry) !== JSON.stringify(summary)) {
    throw new Error("Workspace index conflicts with this immutable Batch ID; existing metadata and source were retained.");
  }
  if (!initialEntry && initialSummaries.length >= MAX_CONSULTATION_BATCHES) {
    throw new Error(raw === null ? "Workspace Batch index is full; this new Batch was not published and no source record was written."
      : "Workspace Batch index is full; existing raw record remains staged but unpublished. No index entry was removed.");
  }
  if (!initialEntry && Buffer.byteLength(JSON.stringify([summary, ...initialSummaries]), "utf8") > MAX_CONSULTATION_BATCH_INDEX_BYTES) {
    throw new Error(raw === null ? "Workspace Batch index reached the Host state limit; this new Batch was not published and no source record was written."
      : "Workspace Batch index reached the Host state limit; existing raw record remains staged but unpublished. No index entry was removed.");
  }
  if (raw === null) {
    const swapped = await compareAndSet(platform, recordKey, { exists: false }, batch);
    if (swapped) stored = batch;
    else {
      try { raw = await platform.state.get(recordKey); }
      catch { throw new Error("Batch ID conflict could not be inspected; existing data was not overwritten."); }
      if (raw === null) throw new Error("Batch record CAS conflicted but no record is visible; retry the same Batch ID and exact input.");
      stored = parseBatch(raw);
      if (!sameBatchContent(stored, batch)) throw new Error("Batch ID already stores different original text, selected range, or metadata; existing record was retained.");
    }
  }
  if (stored === null) throw new Error("Batch record is unavailable; no published index success is claimed.");
  for (let attempt = 0; attempt < 12; attempt += 1) {
    let index: JsonValue | null;
    try { index = await platform.state.get(indexKey); }
    catch { throw new Error("Batch source record is staged, but the Workspace index could not be read; retry the exact same Batch ID and input."); }
    const summaries = index === null ? [] : (() => {
      if (!Array.isArray(index) || index.length > MAX_CONSULTATION_BATCHES) throw new TypeError("Workspace Batch index cannot be validated; staged source record was retained.");
      return index.map(parseSummary);
    })();
    const indexed = summaries.find(item => item.id === input.id);
    if (indexed) {
      if (JSON.stringify(indexed) !== JSON.stringify(summary)) throw new Error("Workspace index conflicts with the immutable Batch record; both records were retained for review.");
      return stored;
    }
    if (summaries.length >= MAX_CONSULTATION_BATCHES) {
      throw new Error("Workspace Batch index became full during this save; the raw record is staged but not published. Existing entries were retained; retry the same ID only if capacity becomes available.");
    }
    const next = [summary, ...summaries];
    if (Buffer.byteLength(JSON.stringify(next), "utf8") > MAX_CONSULTATION_BATCH_INDEX_BYTES) {
      throw new Error("Workspace Batch index reached the Host state limit; the immutable source record is staged and no list entry was committed.");
    }
    const swapped = await compareAndSet(platform, indexKey, index === null ? { exists: false } : { exists: true, value: index }, next);
    if (swapped) return stored;
  }
  throw new Error("Workspace Batch index changed repeatedly; the immutable source record is staged and no index update is confirmed. Refresh, then retry the exact same Batch ID and input.");
}

export async function readProjectConsultationSources(workspaceId: string, projectId: string,
  platform: SpsPlatformInvocationContext): Promise<ProjectConsultationSourceSummary[]> {
  if (!UUID.test(workspaceId) || workspaceId !== workspaceId.toLowerCase() || !validProjectId(projectId)) {
    throw new TypeError("Project consultation listing requires a canonical Workspace UUID and bounded project ID.");
  }
  const value = await platform.state.get(projectIndexKey(workspaceId, projectId));
  if (value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_CONSULTATION_BATCHES) throw new TypeError("Project consultation index exceeds its bounded entry count.");
  const entries = value.map(entry => parseProjectSourceSummary(entry, workspaceId, projectId));
  if (new Set(entries.map(entry => entry.sourceId)).size !== entries.length) throw new TypeError("Project consultation index contains duplicate source IDs.");
  return entries;
}

/** Explicit non-UI receive boundary. Workspace-only legacy imports are never assigned to a project here. */
export async function receiveProjectConsultationSource(input: {
  workspaceId: string; projectId: string; id: string; sourceName: string; text: string;
  fromLine: number; throughLine: number;
}, platform: SpsPlatformInvocationContext): Promise<ProjectConsultationSource> {
  const { workspaceId, projectId } = input;
  if (!UUID.test(workspaceId) || workspaceId !== workspaceId.toLowerCase() || !validProjectId(projectId)) {
    throw new TypeError("Project consultation receipt requires an explicit canonical Workspace UUID and bounded project ID.");
  }
  const preview = previewConsultationBatch(input);
  const sourceId = `consultation-${input.id}`;
  const summary: ProjectConsultationSourceSummary = Object.freeze({
    id: input.id, sourceId, sha256: preview.sha256, sourceName: input.sourceName, suppliedAt: "UNKNOWN",
    lineCount: preview.lineCount, selectedFromLine: input.fromLine, selectedThroughLine: input.throughLine,
    status: "incomplete", sender: "UNKNOWN", messageTimes: "UNKNOWN", attachments: "UNKNOWN", coverage: "UNKNOWN",
    workspaceId, projectId,
  });
  const initialIndex = await readProjectConsultationSources(workspaceId, projectId, platform);
  const initialEntry = initialIndex.find(entry => entry.id === input.id);
  if (initialEntry && JSON.stringify(initialEntry) !== JSON.stringify(summary)) {
    throw new Error("Project source ID already has different content or metadata; existing project record was retained.");
  }
  if (!initialEntry && (initialIndex.length >= MAX_CONSULTATION_BATCHES
    || Buffer.byteLength(JSON.stringify([...initialIndex, summary]), "utf8") > MAX_CONSULTATION_BATCH_INDEX_BYTES)) {
    throw new Error("Project consultation index is full; no new project source was written.");
  }

  const recordKey = projectSourceKey(workspaceId, projectId, input.id);
  let raw: JsonValue | null;
  try { raw = await platform.state.get(recordKey); }
  catch { throw new Error("Project consultation source lookup failed; no new source was written."); }
  let source: ProjectConsultationSource | null = raw === null ? null : parseProjectConsultationSource(raw, workspaceId, projectId);
  const receivedAt = source?.receivedAt ?? new Date().toISOString();
  const { workspaceId: _workspaceId, projectId: _projectId, ...batchSummary } = summary;
  const batch: ConsultationBatch = { ...batchSummary, originalText: input.text, selectedText: preview.selectedText, createdAt: receivedAt };
  if (source && !sameProjectSourceContent(source, batch)) {
    throw new Error("Project source ID already stores different UTF-8 original text, selection or metadata; existing source was retained.");
  }
  if (source === null) {
    const storedValue = { workspaceId, projectId, receivedAt, batch };
    if (await compareAndSet(platform, recordKey, { exists: false }, storedValue)) {
      source = parseProjectConsultationSource(storedValue, workspaceId, projectId);
    } else {
      try { raw = await platform.state.get(recordKey); }
      catch { throw new Error("Project source CAS conflicted and stored content could not be inspected; retry the exact same ID and input."); }
      if (raw === null) throw new Error("Project source CAS conflicted but no record is visible; retry the exact same ID and input.");
      source = parseProjectConsultationSource(raw, workspaceId, projectId);
      if (!sameProjectSourceContent(source, batch)) throw new Error("Project source ID concurrently stored different content; existing source was retained.");
    }
  }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    let index: JsonValue | null;
    try { index = await platform.state.get(projectIndexKey(workspaceId, projectId)); }
    catch { throw new Error("Project source is durable but its index is unreadable; retry the exact same ID and input."); }
    const entries = index === null ? [] : (() => {
      if (!Array.isArray(index) || index.length > MAX_CONSULTATION_BATCHES) throw new TypeError("Project source is durable but its bounded index cannot be validated.");
      return index.map(entry => parseProjectSourceSummary(entry, workspaceId, projectId));
    })();
    const indexed = entries.find(entry => entry.id === input.id);
    if (indexed) {
      if (JSON.stringify(indexed) !== JSON.stringify(summary)) throw new Error("Project index conflicts with its immutable source record; both were retained for review.");
      return source!;
    }
    if (entries.length >= MAX_CONSULTATION_BATCHES) throw new Error("Project source is durable but the bounded index is full; no new index entry was confirmed.");
    const next = [...entries, summary];
    if (Buffer.byteLength(JSON.stringify(next), "utf8") > MAX_CONSULTATION_BATCH_INDEX_BYTES) {
      throw new Error("Project source is durable but the bounded index reached its serialized value limit.");
    }
    const swapped = await compareAndSet(platform, projectIndexKey(workspaceId, projectId),
      index === null ? { exists: false } : { exists: true, value: index }, next);
    if (swapped) return source!;
  }
  throw new Error("Project index changed repeatedly; its immutable source is durable but publication is unconfirmed. Retry the exact same ID and input.");
}

export async function readProjectConsultationMessages(workspaceId: string, projectId: string,
  platform: SpsPlatformInvocationContext): Promise<ProjectConsultationMessageSummary[]> {
  if (!UUID.test(workspaceId) || workspaceId !== workspaceId.toLowerCase() || !validProjectId(projectId)) {
    throw new TypeError("Project message listing requires a canonical Workspace UUID and bounded project ID.");
  }
  const value = await platform.state.get(projectMessageIndexKey(workspaceId, projectId));
  return parseProjectConsultationMessageIndex(value, workspaceId, projectId);
}

/** Persist one explicitly received Connector message. This function is not connected to a live Connector or UI. */
export async function receiveProjectConsultationMessage(input: {
  workspaceId: string; projectId: string; sourceId: string; messageId: string; text: string;
  sourceOrder?: number | null; sender?: string | null; sourceMessageAt?: string | null;
}, platform: SpsPlatformInvocationContext): Promise<ProjectConsultationMessage> {
  const { workspaceId, projectId } = input;
  if (!UUID.test(workspaceId) || workspaceId !== workspaceId.toLowerCase() || !validProjectId(projectId)
    || typeof input.sourceId !== "string" || !input.sourceId.trim() || input.sourceId.length > 160 || /[\u0000-\u001f\u007f]/u.test(input.sourceId)
    || typeof input.messageId !== "string" || !input.messageId.trim() || input.messageId.length > 160 || /[\u0000-\u001f\u007f]/u.test(input.messageId)
    || typeof input.text !== "string" || !input.text.trim() || new TextEncoder().encode(input.text).byteLength > MAX_BATCH_SOURCE_BYTES
    || input.sourceOrder !== undefined && input.sourceOrder !== null && (!Number.isSafeInteger(input.sourceOrder) || input.sourceOrder < 1)
    || input.sender !== undefined && input.sender !== null && (typeof input.sender !== "string" || input.sender.length > 200)
    || input.sourceMessageAt !== undefined && input.sourceMessageAt !== null
      && (typeof input.sourceMessageAt !== "string" || !Number.isFinite(Date.parse(input.sourceMessageAt)))) {
    throw new TypeError("Consultation message requires explicit scope and IDs, bounded UTF-8 text, and valid optional source metadata.");
  }
  const normalized = { workspaceId, projectId, sourceId: input.sourceId, messageId: input.messageId, originalText: input.text,
    sha256: sha256(input.text), receivedAt: new Date().toISOString(), sourceOrder: input.sourceOrder ?? null,
    sender: input.sender?.trim() || "UNKNOWN", sourceMessageAt: input.sourceMessageAt ?? null };
  const rawKey = projectMessageRecordKey(workspaceId, projectId, input.sourceId, input.messageId);
  let raw: JsonValue | null;
  try { raw = await platform.state.get(rawKey); }
  catch { throw new Error("Consultation message lookup failed; no message was written."); }
  let stored = raw === null ? null : parseProjectConsultationMessage(raw, workspaceId, projectId);
  if (stored && (stored.sourceId !== normalized.sourceId || stored.messageId !== normalized.messageId
    || stored.sha256 !== normalized.sha256 || stored.originalText !== normalized.originalText
    || stored.sourceOrder !== normalized.sourceOrder || stored.sender !== normalized.sender
    || stored.sourceMessageAt !== normalized.sourceMessageAt)) {
    throw new Error("Consultation message ID already stores different content or source metadata; existing original was retained.");
  }
  if (stored === null) {
    const rawValue = normalized;
    if (await compareAndSet(platform, rawKey, { exists: false }, rawValue)) {
      stored = parseProjectConsultationMessage(rawValue, workspaceId, projectId);
    } else {
      try { raw = await platform.state.get(rawKey); }
      catch { throw new Error("Consultation message CAS conflicted and stored content could not be inspected; retry the exact same message ID and input."); }
      if (raw === null) throw new Error("Consultation message CAS conflicted but no original is visible; retry the exact same message ID and input.");
      stored = parseProjectConsultationMessage(raw, workspaceId, projectId);
      if (stored.sha256 !== normalized.sha256 || stored.originalText !== normalized.originalText
        || stored.sourceOrder !== normalized.sourceOrder || stored.sender !== normalized.sender
        || stored.sourceMessageAt !== normalized.sourceMessageAt) {
        throw new Error("Consultation message ID concurrently stored different content or metadata; existing original was retained.");
      }
    }
  }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const target = projectMessageIndexKey(workspaceId, projectId);
    let current: JsonValue | null;
    try { current = await platform.state.get(target); }
    catch { throw new Error("Message original is durable but its receipt index is unreadable; retry the exact same message ID and input."); }
    const entries = parseProjectConsultationMessageIndex(current, workspaceId, projectId);
    const existing = entries.find(entry => entry.sourceId === input.sourceId && entry.messageId === input.messageId);
    if (existing) return Object.freeze({ ...existing, originalText: stored!.originalText });
    if (entries.length >= MAX_CONSULTATION_BATCHES) throw new Error("Message original is durable but the bounded receipt index is full; no receipt order was confirmed.");
    const previous = [...entries].reverse().find(entry => entry.sourceId === input.sourceId);
    let orderStatus: ProjectConsultationMessageSummary["orderStatus"] = "UNKNOWN";
    if (stored.sourceOrder !== null && previous?.sourceOrder !== null && previous?.sourceOrder !== undefined) {
      orderStatus = stored.sourceOrder === previous.sourceOrder + 1 ? "IN_ORDER"
        : stored.sourceOrder > previous.sourceOrder + 1 ? "GAP" : "OUT_OF_ORDER";
    }
    const coverage = orderStatus === "GAP" || orderStatus === "OUT_OF_ORDER" ? orderStatus : "UNKNOWN";
    const summary: ProjectConsultationMessageSummary = Object.freeze({ workspaceId, projectId, sourceId: input.sourceId,
      messageId: input.messageId, snapshotSourceId: messageSnapshotSourceId(input.sourceId, input.messageId),
      sha256: stored.sha256, receivedAt: stored.receivedAt, receivedOrder: entries.length + 1,
      sourceOrder: stored.sourceOrder, orderStatus, coverage, sender: stored.sender, sourceMessageAt: stored.sourceMessageAt });
    const next = [...entries, summary];
    if (Buffer.byteLength(JSON.stringify(next), "utf8") > MAX_CONSULTATION_BATCH_INDEX_BYTES) {
      throw new Error("Message original is durable but the bounded receipt index reached its serialized value limit.");
    }
    const expected = current === null ? { exists: false as const } : { exists: true as const, value: current };
    if (await compareAndSet(platform, target, expected, next)) return Object.freeze({ ...summary, originalText: stored.originalText });
  }
  throw new Error("Message receipt order changed repeatedly; its original is durable but the receipt index is unconfirmed. Retry the exact same message ID and input.");
}

export async function createConsultationAnalysisSnapshot(input: {
  workspaceId: string; projectId: string; requestId: string;
  sources: readonly { sourceId: string; sha256: string }[];
}, platform: SpsPlatformInvocationContext): Promise<ConsultationAnalysisSnapshot> {
  if (!UUID.test(input.workspaceId) || !validProjectId(input.projectId) || !UUID.test(input.requestId)
    || input.workspaceId !== input.workspaceId.toLowerCase()
    || input.requestId !== input.requestId.toLowerCase()
    || !Array.isArray(input.sources) || input.sources.length === 0 || input.sources.length > MAX_CONSULTATION_BATCHES) {
    throw new TypeError("Consultation analysis snapshot requires explicit Workspace, project, request IDs and a bounded nonempty source list.");
  }
  const summaries = await readProjectConsultationSources(input.workspaceId, input.projectId, platform);
  const messages = await readProjectConsultationMessages(input.workspaceId, input.projectId, platform);
  const sources = input.sources.map((source, index) => {
    if (!source || typeof source !== "object" || Object.keys(source).sort().join(",") !== "sha256,sourceId"
      || !validSnapshotSourceId(source.sourceId)
      || typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(source.sha256)) {
      throw new TypeError(`Analysis snapshot source ${index} has an invalid ID or UTF-8 SHA-256.`);
    }
    const match = summaries.find(row => row.sourceId === source.sourceId && row.sha256 === source.sha256)
      ?? messages.find(row => row.snapshotSourceId === source.sourceId && row.sha256 === source.sha256);
    if (!match) throw new Error(`Analysis snapshot source ${source.sourceId} is missing or its hash does not match this Workspace and project.`);
    return Object.freeze({ sourceId: source.sourceId, sha256: source.sha256.toLowerCase() });
  });
  if (new Set(sources.map(source => source.sourceId)).size !== sources.length) throw new TypeError("Analysis snapshot source IDs must be unique.");
  const target = key(input.workspaceId, `consultation-analysis.v1.${input.requestId}`);
  let raw: JsonValue | null;
  try { raw = await platform.state.get(target); }
  catch { throw new Error("Analysis snapshot lookup failed; no new request was written."); }
  if (raw !== null) {
    const existing = parseConsultationAnalysisSnapshot(raw);
    if (!sameConsultationAnalysisSnapshot(existing, input.workspaceId, input.projectId, input.requestId, sources)) {
      throw new Error("Analysis request ID already refers to a different Workspace, project or source ID/hash set; existing snapshot was retained.");
    }
    return existing;
  }
  const snapshot: ConsultationAnalysisSnapshot = Object.freeze({ workspaceId: input.workspaceId, projectId: input.projectId,
    requestId: input.requestId, sources: Object.freeze(sources), requestedAt: new Date().toISOString() });
  const wire = { ...target, expected: { exists: false }, value: snapshot };
  if (new TextEncoder().encode(JSON.stringify(wire)).byteLength > MAX_CONSULTATION_CAS_WIRE_BYTES) {
    throw new Error("Consultation analysis snapshot exceeds the SDK 262144-byte UTF-8 wire limit; no write was attempted.");
  }
  const swapped = await compareAndSet(platform, target, { exists: false }, snapshot);
  if (swapped) return snapshot;
  try { raw = await platform.state.get(target); }
  catch { throw new Error("Analysis snapshot CAS conflicted and its receipt could not be inspected; retry the same request ID and exact inputs."); }
  if (raw === null) throw new Error("Analysis snapshot CAS conflicted but no request is visible; retry the same request ID and exact inputs.");
  const stored = parseConsultationAnalysisSnapshot(raw);
  if (!sameConsultationAnalysisSnapshot(stored, input.workspaceId, input.projectId, input.requestId, sources)) {
    throw new Error("Analysis request ID was concurrently used with different content; stored snapshot was retained.");
  }
  return stored;
}

function parseConsultationAnalysisSnapshot(value: unknown): ConsultationAnalysisSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Stored consultation analysis snapshot is invalid.");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "projectId,requestId,requestedAt,sources,workspaceId"
    || typeof row.workspaceId !== "string" || !UUID.test(row.workspaceId) || row.workspaceId !== row.workspaceId.toLowerCase()
    || !validProjectId(row.projectId)
    || typeof row.requestId !== "string" || !UUID.test(row.requestId) || typeof row.requestedAt !== "string" || !Number.isFinite(Date.parse(row.requestedAt))
    || !Array.isArray(row.sources) || row.sources.length === 0 || row.sources.length > MAX_CONSULTATION_BATCHES) {
    throw new TypeError("Stored consultation analysis snapshot is invalid.");
  }
  const sources = row.sources.map(source => {
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new TypeError("Stored consultation analysis source is invalid.");
    const ref = source as Record<string, unknown>;
    if (Object.keys(ref).sort().join(",") !== "sha256,sourceId" || !validSnapshotSourceId(ref.sourceId)
      || typeof ref.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(ref.sha256)) {
      throw new TypeError("Stored consultation analysis source is invalid.");
    }
    return Object.freeze({ sourceId: ref.sourceId, sha256: ref.sha256 });
  });
  if (new Set(sources.map(source => source.sourceId)).size !== sources.length) throw new TypeError("Stored consultation analysis snapshot has duplicate sources.");
  return Object.freeze({ workspaceId: row.workspaceId, projectId: row.projectId, requestId: row.requestId,
    sources: Object.freeze(sources), requestedAt: row.requestedAt });
}

function sameConsultationAnalysisSnapshot(existing: ConsultationAnalysisSnapshot, workspaceId: string, projectId: string,
  requestId: string, sources: readonly { sourceId: string; sha256: string }[]): boolean {
  return existing.workspaceId === workspaceId && existing.projectId === projectId && existing.requestId === requestId
    && JSON.stringify(existing.sources) === JSON.stringify(sources);
}

export function validateBatchInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("유효하지 않은 Batch 확인입니다.");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "allowDuplicate,fromLine,id,sourceName,text,throughLine"
    || typeof row.id !== "string" || typeof row.sourceName !== "string" || typeof row.text !== "string"
    || typeof row.fromLine !== "number" || typeof row.throughLine !== "number" || typeof row.allowDuplicate !== "boolean") throw new TypeError("유효하지 않은 Batch 확인입니다.");
  return row as { id: string; sourceName: string; text: string; fromLine: number; throughLine: number; allowDuplicate: boolean };
}
