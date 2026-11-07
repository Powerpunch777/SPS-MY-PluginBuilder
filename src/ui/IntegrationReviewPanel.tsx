import { useState } from "react";
import { parseDeliveryPreparation, type DeliveryPreparation } from "../domain/delivery-preparation.ts";
import { parseMainG7Review, type MainG7Review } from "../domain/main-g7-review.ts";

export type IntegrationReviewPin = Readonly<{ sourceId: string; revisionId: string; sha256: string }>;
export type IntegrationReviewPacket = Readonly<{
  packetId: string;
  packetRevisionId: string;
  packetSha256: string;
  baseline: IntegrationReviewPin;
  uiRevision: IntegrationReviewPin;
  manifest: IntegrationReviewPin;
  integration: Readonly<{ branch: string; commitSha: string; build: IntegrationReviewPin;
    ciEvidence: readonly IntegrationReviewPin[]; e2eEvidence: readonly IntegrationReviewPin[]; regressionEvidence?: readonly IntegrationReviewPin[] }>;
  files: readonly Readonly<{ path: string; classification: string; size: number; sha256: string }>[];
  documents: readonly Readonly<{ kind: "installation-guide" | "user-guide" | "other"; pin: IntegrationReviewPin }>[];
  qaEvidence: readonly IntegrationReviewPin[];
  g6Evidence: readonly IntegrationReviewPin[];
  g7Evidence: readonly IntegrationReviewPin[];
  limits: readonly string[];
  changeHistory: readonly IntegrationReviewPin[];
  preparation?: DeliveryPreparation;
}>;
export type IntegrationReviewAttestation = Readonly<{
  packet: IntegrationReviewPacket;
  snapshotSha256: string;
  currentPinsSha256: string;
  attestedAt: string;
  mainLeadAgentId: string;
  mainLeadSelectionRevision: number;
  mainLeadRunId: string;
  mainLeadSessionId: string;
  mainReview?: MainG7Review;
}>;
export type IntegrationReviewRequest = Readonly<{
  packet: IntegrationReviewPacket;
  snapshotSha256: string;
  currentPinsSha256: string;
  requestedAt: string;
  attestationEventId: string;
  mainLeadAgentId: string;
  mainLeadSelectionRevision: number;
  mainLeadRunId: string;
  mainLeadSessionId: string;
  integrationReviewAgentId: string;
  integrationReviewRunId: string;
  integrationReviewSessionId: string;
}>;
export type IntegrationReviewDecision = Readonly<{
  action: "approve" | "request-changes" | "hold";
  userId: string;
  reason: string | null;
  decidedAt: string;
  sourceSnapshotSha256: string | null;
}>;
export type IntegrationReviewJournalEvent = Readonly<{
  eventId: string;
  expectedBaseRevisionId: string | null;
  kind: "main-attestation" | "approval-request" | "user-decision";
  requestId: string;
  attestation: IntegrationReviewAttestation | null;
  request: IntegrationReviewRequest | null;
  decision: IntegrationReviewDecision | null;
}>;
export type IntegrationReviewHistoryEntry = Readonly<{
  eventId: string;
  kind: IntegrationReviewJournalEvent["kind"] | "manager-packet";
  requestId: string;
  decision: IntegrationReviewDecision | null;
}>;

export type IntegrationReviewDeliveryDocument = Readonly<{
  kind: "installation-guide" | "user-guide" | "other";
  pin: IntegrationReviewPin;
  status: "available" | "stale" | "unknown" | "unavailable";
  path: string | null;
  body: string | null;
}>;

export type IntegrationReviewRunReceipt = Readonly<{
  verification: "verified";
  workspaceId: string;
  agentId: string;
  sessionId: string;
  runId: string;
}>;

export type IntegrationReviewSnapshotDTO = Readonly<{
  workspaceId: string;
  projectId: string;
  packet: IntegrationReviewPacket;
  currentPinsSha256: string;
  g6: "PASS" | "FAIL" | "UNKNOWN";
  g7: "PASS" | "FAIL" | "UNKNOWN";
  g7Preparation?: "PASS" | "FAIL" | "UNKNOWN";
  qa: "PASS" | "FAIL" | "UNKNOWN";
  integrationCodeAuthority: "verified" | "unknown";
  hostRuntimeAuthority: "verified" | "unknown";
}>;

export type IntegrationReviewDTO =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "unknown"; reason?: string }>
  | Readonly<{ status: "empty" }>
  | Readonly<{
    status: "ready";
    snapshot: IntegrationReviewSnapshotDTO;
    mainAttestation: IntegrationReviewJournalEvent | null;
    approvalRequest: IntegrationReviewJournalEvent | null;
    decision: IntegrationReviewJournalEvent | null;
    mainReceipt: IntegrationReviewRunReceipt | null;
    integrationReviewReceipt: IntegrationReviewRunReceipt | null;
    deliveryDocuments: readonly IntegrationReviewDeliveryDocument[];
    approvalEligibility: Readonly<{ status: "eligible" | "blocked" | "unknown"; reason?: string }>;
    history: readonly IntegrationReviewHistoryEntry[];
  }>;

export type IntegrationReviewPanelProps = Readonly<{
  view: IntegrationReviewDTO;
  error?: string | null;
  onApprove?: () => void | Promise<void>;
  onRequestChanges?: (reason: string) => void | Promise<void>;
  onHold?: (reason: string) => void | Promise<void>;
}>;

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value: unknown, fields: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  if (!plain(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (fields.some(key => !Object.hasOwn(value, key)) || keys.some(key => typeof key !== "string" || ![...fields, ...optional].includes(key))) return null;
  for (const key of keys as string[]) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) return null;
  }
  return value;
}
const isText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 2048;
const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

function validPin(value: unknown): value is IntegrationReviewPin {
  const row = exact(value, ["sourceId", "revisionId", "sha256"]);
  return Boolean(row && isText(row.sourceId) && isText(row.revisionId) && isDigest(row.sha256));
}
function validPins(value: unknown, allowEmpty = false): value is readonly IntegrationReviewPin[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(validPin)
    && new Set(value.map(pin => pin.sourceId)).size === value.length;
}
function validPacket(value: unknown): boolean {
  const row = exact(value, ["packetId", "packetRevisionId", "packetSha256", "baseline", "uiRevision", "manifest", "integration",
    "files", "documents", "qaEvidence", "g6Evidence", "g7Evidence", "limits", "changeHistory"], ["preparation"]);
  if (!row || !isText(row.packetId) || !isText(row.packetRevisionId) || !isDigest(row.packetSha256)
    || !validPin(row.baseline) || !validPin(row.uiRevision) || !validPin(row.manifest)
    || !Array.isArray(row.files) || !row.files.length || !Array.isArray(row.documents)
    || !Array.isArray(row.limits) || !row.limits.every(isText) || !validPins(row.qaEvidence)
    || !validPins(row.g6Evidence) || !validPins(row.g7Evidence) || !validPins(row.changeHistory, true)) return false;
  if (Object.hasOwn(row, "preparation")) {
    try { parseDeliveryPreparation(row.preparation); } catch { return false; }
  }
  const integration = exact(row.integration, ["branch", "commitSha", "build", "ciEvidence", "e2eEvidence"], ["regressionEvidence"]);
  if (!integration || !isText(integration.branch) || !isText(integration.commitSha) || !validPin(integration.build)
    || !validPins(integration.ciEvidence) || !validPins(integration.e2eEvidence)
    || Object.hasOwn(integration, "regressionEvidence") && !validPins(integration.regressionEvidence)) return false;
  const filePaths = new Set<string>();
  if (!row.files.every(fileValue => {
    const file = exact(fileValue, ["path", "classification", "size", "sha256"]);
    if (!file || !isText(file.path) || file.path.startsWith("/") || file.path.includes("\\")
      || file.path.split("/").some(part => !part || part === "..") || !isText(file.classification)
      || !Number.isSafeInteger(file.size) || (file.size as number) < 0 || !isDigest(file.sha256) || filePaths.has(file.path)) return false;
    filePaths.add(file.path);
    return true;
  })) return false;
  const documents = row.documents;
  return new Set(row.limits as string[]).size === row.limits.length && documents.every(documentValue => {
    const document = exact(documentValue, ["kind", "pin"]);
    return Boolean(document && ["installation-guide", "user-guide", "other"].includes(String(document.kind)) && validPin(document.pin));
  }) && documents.some(document => plain(document) && document.kind === "installation-guide")
    && documents.some(document => plain(document) && document.kind === "user-guide");
}
function validSnapshot(value: unknown): value is IntegrationReviewSnapshotDTO {
  const row = exact(value, ["workspaceId", "projectId", "packet", "integrationCodeAuthority", "hostRuntimeAuthority", "g6", "g7", "qa", "currentPinsSha256"], ["g7Preparation"]);
  return Boolean(row && isText(row.workspaceId) && isText(row.projectId) && validPacket(row.packet)
    && ["verified", "unknown"].includes(String(row.integrationCodeAuthority))
    && ["verified", "unknown"].includes(String(row.hostRuntimeAuthority))
    && ["PASS", "FAIL", "UNKNOWN"].includes(String(row.g6)) && ["PASS", "FAIL", "UNKNOWN"].includes(String(row.g7))
    && (!Object.hasOwn(row, "g7Preparation") || ["PASS", "FAIL", "UNKNOWN"].includes(String(row.g7Preparation)))
    && ["PASS", "FAIL", "UNKNOWN"].includes(String(row.qa)) && isDigest(row.currentPinsSha256));
}
function validDeliveryDocuments(value: unknown, packet: IntegrationReviewPacket): value is readonly IntegrationReviewDeliveryDocument[] {
  if (!Array.isArray(value) || value.length !== packet.documents.length) return false;
  return value.every((documentValue, index) => {
    const row = exact(documentValue, ["kind", "pin", "status", "path", "body"]);
    const target = packet.documents[index];
    if (!row || !target || row.kind !== target.kind || !validPin(row.pin)
      || row.pin.sourceId !== target.pin.sourceId || row.pin.revisionId !== target.pin.revisionId || row.pin.sha256 !== target.pin.sha256
      || !["available", "stale", "unknown", "unavailable"].includes(String(row.status))) return false;
    if (row.status !== "available") return row.path === null && row.body === null;
    return isText(row.path) && typeof row.body === "string" && Boolean(row.body.trim())
      && new TextEncoder().encode(row.body).byteLength <= 192 * 1024;
  });
}
function validEvent(value: unknown): value is IntegrationReviewJournalEvent {
  const row = exact(value, ["eventId", "expectedBaseRevisionId", "kind", "requestId", "attestation", "request", "decision"]);
  if (!row || !isText(row.eventId) || row.expectedBaseRevisionId !== null && !isText(row.expectedBaseRevisionId)
    || !isText(row.requestId)) return false;
  if (row.kind === "main-attestation" && row.attestation !== null && row.request === null && row.decision === null) {
    const attestation = exact(row.attestation, ["packet", "snapshotSha256", "currentPinsSha256", "attestedAt", "mainLeadAgentId",
      "mainLeadSelectionRevision", "mainLeadRunId", "mainLeadSessionId"], ["mainReview"]);
    if (attestation && Object.hasOwn(attestation, "mainReview")) {
      try { parseMainG7Review(attestation.mainReview, attestation.packet as IntegrationReviewPacket, attestation.currentPinsSha256 as string); }
      catch { return false; }
    }
    return Boolean(attestation && validPacket(attestation.packet) && isDigest(attestation.snapshotSha256) && isDigest(attestation.currentPinsSha256)
      && isText(attestation.attestedAt) && isText(attestation.mainLeadAgentId) && Number.isSafeInteger(attestation.mainLeadSelectionRevision)
      && (attestation.mainLeadSelectionRevision as number) >= 0 && isText(attestation.mainLeadRunId) && isText(attestation.mainLeadSessionId));
  }
  if (row.kind === "approval-request" && row.attestation === null && row.request !== null && row.decision === null) {
    const request = exact(row.request, ["packet", "snapshotSha256", "currentPinsSha256", "requestedAt", "attestationEventId", "mainLeadAgentId",
      "mainLeadSelectionRevision", "mainLeadRunId", "mainLeadSessionId", "integrationReviewAgentId", "integrationReviewRunId", "integrationReviewSessionId"]);
    return Boolean(request && validPacket(request.packet) && isDigest(request.snapshotSha256) && isDigest(request.currentPinsSha256)
      && isText(request.requestedAt) && isText(request.attestationEventId) && isText(request.mainLeadAgentId)
      && Number.isSafeInteger(request.mainLeadSelectionRevision) && (request.mainLeadSelectionRevision as number) >= 0
      && isText(request.mainLeadRunId) && isText(request.mainLeadSessionId) && isText(request.integrationReviewAgentId)
      && isText(request.integrationReviewRunId) && isText(request.integrationReviewSessionId));
  }
  if (row.kind === "user-decision" && row.attestation === null && row.request === null && row.decision !== null) {
    const decision = exact(row.decision, ["action", "userId", "reason", "decidedAt", "sourceSnapshotSha256"]);
    return Boolean(decision && ["approve", "request-changes", "hold"].includes(String(decision.action)) && isText(decision.userId)
      && (decision.reason === null || isText(decision.reason)) && isText(decision.decidedAt)
      && (decision.sourceSnapshotSha256 === null || isDigest(decision.sourceSnapshotSha256)));
  }
  return false;
}
function validReceipt(value: unknown): value is IntegrationReviewRunReceipt {
  const row = exact(value, ["verification", "workspaceId", "agentId", "sessionId", "runId"]);
  return Boolean(row && row.verification === "verified" && isText(row.workspaceId) && isText(row.agentId)
    && isText(row.sessionId) && isText(row.runId));
}
function validHistoryEntry(value: unknown): value is IntegrationReviewHistoryEntry {
  const row = exact(value, ["eventId", "kind", "requestId", "decision"]);
  if (!row || !isText(row.eventId) || !["manager-packet", "main-attestation", "approval-request", "user-decision"].includes(String(row.kind))
    || !isText(row.requestId)) return false;
  if (row.decision === null) return true;
  const decision = exact(row.decision, ["action", "userId", "reason", "decidedAt", "sourceSnapshotSha256"]);
  return Boolean(decision && ["approve", "request-changes", "hold"].includes(String(decision.action)) && isText(decision.userId)
    && (decision.reason === null || isText(decision.reason)) && isText(decision.decidedAt)
    && (decision.sourceSnapshotSha256 === null || isDigest(decision.sourceSnapshotSha256)));
}

/** Converts untrusted plugin-data JSON to a display-only contract. Malformed or incomplete data is always non-actionable. */
export function parseIntegrationReviewDTO(value: unknown): IntegrationReviewDTO {
  const statusRow = exact(value, ["status"], ["reason"]);
  if (statusRow?.status === "loading" && Reflect.ownKeys(statusRow).length === 1) return Object.freeze({ status: "loading" });
  if (statusRow?.status === "empty" && Reflect.ownKeys(statusRow).length === 1) return Object.freeze({ status: "empty" });
  if (statusRow?.status === "unknown" && (Reflect.ownKeys(statusRow).length === 1 || Reflect.ownKeys(statusRow).length === 2)
    && (!Object.hasOwn(statusRow, "reason") || statusRow.reason === undefined || isText(statusRow.reason))) {
    return Object.freeze({ status: "unknown", ...(isText(statusRow.reason) ? { reason: statusRow.reason } : {}) });
  }
  const ready = exact(value, ["status", "snapshot", "mainAttestation", "approvalRequest", "decision", "mainReceipt",
    "integrationReviewReceipt", "deliveryDocuments", "approvalEligibility", "history"]);
  const eligibility = ready && exact(ready.approvalEligibility, ["status"], ["reason"]);
  if (!ready || ready.status !== "ready" || !validSnapshot(ready.snapshot)
    || !validDeliveryDocuments(ready.deliveryDocuments, (ready.snapshot as IntegrationReviewSnapshotDTO).packet)
    || ready.mainAttestation !== null && !validEvent(ready.mainAttestation)
    || ready.approvalRequest !== null && !validEvent(ready.approvalRequest)
    || ready.decision !== null && !validEvent(ready.decision)
    || ready.mainReceipt !== null && !validReceipt(ready.mainReceipt)
    || ready.integrationReviewReceipt !== null && !validReceipt(ready.integrationReviewReceipt)
    || !eligibility || !["eligible", "blocked", "unknown"].includes(String(eligibility.status))
    || Object.hasOwn(eligibility, "reason") && eligibility.reason !== undefined && !isText(eligibility.reason)
    || !Array.isArray(ready.history) || !ready.history.every(validHistoryEntry)) {
    return Object.freeze({ status: "unknown", reason: "Final Review read data is incomplete or malformed." });
  }
  return Object.freeze({ status: "ready", snapshot: ready.snapshot, mainAttestation: ready.mainAttestation as IntegrationReviewJournalEvent | null,
    approvalRequest: ready.approvalRequest as IntegrationReviewJournalEvent | null, decision: ready.decision as IntegrationReviewJournalEvent | null,
    mainReceipt: ready.mainReceipt as IntegrationReviewRunReceipt | null,
    integrationReviewReceipt: ready.integrationReviewReceipt as IntegrationReviewRunReceipt | null,
    deliveryDocuments: Object.freeze([...(ready.deliveryDocuments as IntegrationReviewDeliveryDocument[])]),
    approvalEligibility: Object.freeze({ status: eligibility.status as "eligible" | "blocked" | "unknown",
      ...(isText(eligibility.reason) ? { reason: eligibility.reason } : {}) }),
    history: Object.freeze([...(ready.history as IntegrationReviewHistoryEntry[])]) });
}

const STYLE = `
.sps-integration-review{--ir-bg:#202020;--ir-panel:#262626;--ir-border:#414141;--ir-text:#ededed;--ir-muted:#b6b6b6;--ir-faint:#929292;--ir-ok:#a9d6b5;--ir-warn:#e2cc8c;--ir-bad:#e6a2a2;background:var(--ir-bg);padding:16px;color:var(--ir-text);font:13px/1.55 -apple-system,BlinkMacSystemFont,Pretendard,"Noto Sans KR","Malgun Gothic",sans-serif;letter-spacing:0;min-width:0;max-width:100%}
.sps-integration-review *{box-sizing:border-box;letter-spacing:0}
.sps-integration-review button,.sps-integration-review input{font:inherit;color:inherit}
.sps-integration-review button:focus-visible,.sps-integration-review input:focus-visible{outline:2px solid #ededed;outline-offset:2px}
.sps-integration-review button:disabled{cursor:not-allowed;opacity:.5}
.sps-ir-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;border-bottom:1px solid var(--ir-border);padding:0 0 14px}
.sps-ir-header h2{margin:0;font-size:18px;line-height:1.35}
.sps-ir-header p{margin:5px 0 0;color:var(--ir-muted)}
.sps-ir-badge{flex:none;border:1px solid var(--ir-border);border-radius:5px;padding:3px 7px;color:var(--ir-warn);font-size:11px;font-weight:700}
.sps-ir-section{margin-top:16px;min-width:0}
.sps-ir-section h3{margin:0 0 8px;font-size:14px}
.sps-ir-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:8px}
.sps-ir-item{min-width:0;border:1px solid var(--ir-border);border-radius:6px;background:var(--ir-panel);padding:9px 10px}
.sps-ir-item strong,.sps-ir-item small{display:block;overflow-wrap:anywhere}
.sps-ir-item strong{font-size:12px}
.sps-ir-item small{margin-top:3px;color:var(--ir-muted);font-size:11px}
.sps-ir-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
.sps-ir-table-wrap{overflow-x:auto;border:1px solid var(--ir-border);border-radius:6px}
.sps-ir-table{width:100%;min-width:680px;border-collapse:collapse;text-align:left;color:var(--ir-text)}
.sps-ir-table th,.sps-ir-table td{padding:8px 9px;border-bottom:1px solid var(--ir-border);vertical-align:top;overflow-wrap:anywhere}
.sps-ir-table th{color:var(--ir-muted);font-size:11px;font-weight:700}
.sps-ir-table tr:last-child td{border-bottom:0}
.sps-ir-list{display:grid;gap:6px;margin:0;padding:0;list-style:none}
.sps-ir-list li{border-left:2px solid #686868;padding:3px 8px;color:var(--ir-muted);overflow-wrap:anywhere}
.sps-ir-body{max-height:420px;overflow:auto;margin:8px 0 0;border:1px solid var(--ir-border);border-radius:5px;background:#1b1b1b;padding:10px;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}
.sps-ir-status{border:1px solid var(--ir-border);border-radius:6px;background:var(--ir-panel);padding:12px;color:var(--ir-muted)}
.sps-ir-status[role=alert]{color:var(--ir-bad)}
.sps-ir-gates{display:flex;flex-wrap:wrap;gap:6px}
.sps-ir-gate{border:1px solid var(--ir-border);border-radius:5px;padding:3px 7px;color:var(--ir-muted)}
.sps-ir-gate.is-pass{color:var(--ir-ok)}
.sps-ir-gate.is-fail{color:var(--ir-bad)}
.sps-ir-actions{display:grid;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid var(--ir-border)}
.sps-ir-reason{width:100%;min-height:38px;border:1px solid var(--ir-border);border-radius:5px;background:#181818;padding:8px}
.sps-ir-buttons{display:flex;flex-wrap:wrap;gap:7px}
.sps-ir-button{min-height:34px;border:1px solid #555;border-radius:5px;background:#303030;padding:6px 11px;cursor:pointer}
.sps-ir-button.is-primary{border-color:#b8b8b8;background:#ededed;color:#181818;font-weight:700}
.sps-ir-footer{margin-top:12px;color:var(--ir-faint);font-size:11px}
@media(max-width:560px){.sps-ir-header{display:grid}.sps-ir-badge{justify-self:start}.sps-ir-buttons{display:grid;grid-template-columns:1fr}.sps-ir-button{width:100%}}
`;

function pinLabel(pin: IntegrationReviewPin) { return `${pin.sourceId} · ${pin.revisionId}`; }
function digestLabel(value: string) { return `SHA-256 ${value}`; }
function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}
function isCurrentRequest(view: Extract<IntegrationReviewDTO, { status: "ready" }>) {
  const request = view.approvalRequest;
  return request?.kind === "approval-request" && request.request !== null && request.requestId === view.snapshot.packet.packetRevisionId
    && view.decision === null;
}
function hasAuthorizedReceipt(view: Extract<IntegrationReviewDTO, { status: "ready" }>) {
  const request = view.approvalRequest;
  if (!isCurrentRequest(view) || request?.request === null || request?.request === undefined) return false;
  const payload = request.request;
  const attestation = view.mainAttestation;
  const mainReceipt = view.mainReceipt;
  const reviewReceipt = view.integrationReviewReceipt;
  return attestation?.kind === "main-attestation" && attestation.attestation?.mainReview !== undefined
    && attestation.eventId === payload.attestationEventId && attestation.eventId === request.expectedBaseRevisionId
    && attestation.requestId === request.requestId
    && attestation.attestation.packet.packetRevisionId === payload.packet.packetRevisionId
    && attestation.attestation.packet.packetSha256 === payload.packet.packetSha256
    && attestation.attestation.snapshotSha256 === payload.snapshotSha256
    && attestation.attestation.currentPinsSha256 === payload.currentPinsSha256
    && attestation.attestation.mainLeadAgentId === payload.mainLeadAgentId
    && attestation.attestation.mainLeadSelectionRevision === payload.mainLeadSelectionRevision
    && attestation.attestation.mainLeadRunId === payload.mainLeadRunId
    && attestation.attestation.mainLeadSessionId === payload.mainLeadSessionId
    && payload.packet.packetRevisionId === view.snapshot.packet.packetRevisionId
    && payload.packet.packetSha256 === view.snapshot.packet.packetSha256
    && payload.snapshotSha256.length === 64 && payload.currentPinsSha256 === view.snapshot.currentPinsSha256
    && mainReceipt?.verification === "verified" && mainReceipt.workspaceId === view.snapshot.workspaceId
    && mainReceipt.agentId === payload.mainLeadAgentId && mainReceipt.runId === payload.mainLeadRunId
    && mainReceipt.sessionId === payload.mainLeadSessionId
    && payload.integrationReviewAgentId === payload.mainLeadAgentId
    && payload.integrationReviewSessionId !== payload.mainLeadSessionId
    && reviewReceipt?.verification === "verified" && reviewReceipt.workspaceId === view.snapshot.workspaceId
    && reviewReceipt.agentId === payload.integrationReviewAgentId && reviewReceipt.runId === payload.integrationReviewRunId
    && reviewReceipt.sessionId === payload.integrationReviewSessionId;
}

function PinCard({ label, pin }: { label: string; pin: IntegrationReviewPin }) {
  return <div className="sps-ir-item"><strong>{label}: {pinLabel(pin)}</strong><small className="sps-ir-mono">{digestLabel(pin.sha256)}</small></div>;
}

export function IntegrationReviewPanel({ view, error, onApprove, onRequestChanges, onHold }: IntegrationReviewPanelProps) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [actionComplete, setActionComplete] = useState(false);
  const ready = view.status === "ready" ? view : null;
  const receiptValid = ready !== null && hasAuthorizedReceipt(ready);
  const eligible = ready !== null && receiptValid && ready.approvalEligibility.status === "eligible";
  const hasDecisionActions = ready !== null && receiptValid;
  const reasonReady = reason.trim().length > 0 && reason.trim().length <= 200;

  async function act(callback: (() => void | Promise<void>) | undefined) {
    if (!callback || busy) return;
    setBusy(true); setActionError(false); setActionComplete(false);
    try { await callback(); setActionComplete(true); }
    catch { setActionError(true); }
    finally { setBusy(false); }
  }
  async function decide(callback: ((reason: string) => void | Promise<void>) | undefined) {
    const value = reason.trim();
    if (!callback || !value || value.length > 200 || busy) return;
    await act(() => callback(value));
  }

  return <section className="sps-integration-review" aria-labelledby="sps-ir-title">
    <style>{STYLE}</style>
    <header className="sps-ir-header">
      <div><h2 id="sps-ir-title">최종 검토·승인</h2><p>현재 납품 패키지와 승인 근거를 확인합니다.</p></div>
      <span className="sps-ir-badge">실제 고객 전달·배포와 별개</span>
    </header>
    {error ? <p className="sps-ir-status" role="alert">최종 검토 자료를 불러오지 못했습니다.</p>
      : view.status === "loading" ? <p className="sps-ir-status" role="status">최종 검토 자료를 불러오는 중입니다.</p>
      : view.status === "unknown" ? <p className="sps-ir-status" role="status">자료 또는 권위 연결을 확인할 수 없어 검토와 승인이 차단되었습니다.{view.reason ? ` ${view.reason}` : ""}</p>
      : view.status === "empty" ? <p className="sps-ir-status" role="status">현재 게시된 최종 검토 자료가 없습니다.</p>
      : <>
        <section className="sps-ir-section" aria-label="최종 패킷 식별">
          <h3>검토 대상 패킷 및 증거 상태</h3>
          {ready!.approvalEligibility.status !== "eligible" && <p className="sps-ir-status" role="status">
            {ready!.approvalEligibility.status === "unknown" ? "현재 Final Packet reader 또는 근거 권위를 확인할 수 없어 승인 차단 상태입니다."
              : "현재 승인 조건을 충족하지 못해 승인 차단 상태입니다."}
            {ready!.approvalEligibility.reason ? ` ${ready!.approvalEligibility.reason}` : ""}
          </p>}
          <div className="sps-ir-grid">
            <div className="sps-ir-item"><strong>패킷 revision</strong><small>{ready!.snapshot.packet.packetRevisionId}</small><small className="sps-ir-mono">{digestLabel(ready!.snapshot.packet.packetSha256)}</small></div>
            <div className="sps-ir-item"><strong>Workspace / Project</strong><small className="sps-ir-mono">{ready!.snapshot.workspaceId} / {ready!.snapshot.projectId}</small></div>
            <PinCard label="Baseline" pin={ready!.snapshot.packet.baseline} />
            <PinCard label="UI revision" pin={ready!.snapshot.packet.uiRevision} />
            <PinCard label="Manifest" pin={ready!.snapshot.packet.manifest} />
            <PinCard label="Build" pin={ready!.snapshot.packet.integration.build} />
          </div>
        </section>
        <section className="sps-ir-section" aria-label="통합 빌드와 QA">
          <h3>통합·QA 판정</h3>
          <div className="sps-ir-grid">
            <div className="sps-ir-item"><strong>Branch / commit</strong><small>{ready!.snapshot.packet.integration.branch} / <span className="sps-ir-mono">{ready!.snapshot.packet.integration.commitSha}</span></small></div>
          </div>
          <div className="sps-ir-gates" aria-label="현재 검증 게이트">
            {([ ["코드 권위", ready!.snapshot.integrationCodeAuthority], ["Host runtime 권위", ready!.snapshot.hostRuntimeAuthority],
              ["G6", ready!.snapshot.g6], ["G7 준비", ready!.snapshot.g7Preparation ?? "UNKNOWN"], ["G7 Main 점검", ready!.snapshot.g7], ["QA", ready!.snapshot.qa] ] as const).map(([name, state]) =>
              <span key={name} className={`sps-ir-gate ${state === "verified" || state === "PASS" ? "is-pass" : state === "FAIL" ? "is-fail" : ""}`}>{name}: {state}</span>)}
          </div>
          <div className="sps-ir-grid" style={{ marginTop: 8 }}>
            {[ ["CI evidence", ready!.snapshot.packet.integration.ciEvidence], ["E2E evidence", ready!.snapshot.packet.integration.e2eEvidence],
              ...(ready!.snapshot.packet.integration.regressionEvidence ? [["회귀 검증", ready!.snapshot.packet.integration.regressionEvidence]] : []),
              ["QA evidence", ready!.snapshot.packet.qaEvidence], ["G6 evidence", ready!.snapshot.packet.g6Evidence],
              ["G7 evidence", ready!.snapshot.packet.g7Evidence] ].map(([label, pins]) => <div className="sps-ir-item" key={label as string}>
                <strong>{label as string}</strong><ul className="sps-ir-list">{(pins as readonly IntegrationReviewPin[]).map(pin => <li key={`${pin.sourceId}:${pin.revisionId}`}>
                  {pinLabel(pin)}<br /><span className="sps-ir-mono">{digestLabel(pin.sha256)}</span>
                </li>)}</ul>
              </div>)}
          </div>
        </section>
        <section className="sps-ir-section" aria-label="납품 파일">
          <h3>납품 파일 · 정확 경로와 SHA-256</h3>
          <p className="sps-ir-status">현재 packet schema는 파일별 version, 접근 권한, 포함 사유를 제공하지 않습니다. 아래 revision은 파일 개별 버전이 아니라 포함된 패킷 revision입니다.</p>
          <div className="sps-ir-table-wrap"><table className="sps-ir-table"><thead><tr><th>경로</th><th>분류</th><th>크기</th><th>포함 패킷 revision</th><th>SHA-256</th></tr></thead>
            <tbody>{ready!.snapshot.packet.files.map(file => <tr key={file.path}><td className="sps-ir-mono">{file.path}</td><td>{file.classification}</td>
              <td>{formatBytes(file.size)}</td><td className="sps-ir-mono">{ready!.snapshot.packet.packetRevisionId}</td><td className="sps-ir-mono">{file.sha256}</td></tr>)}</tbody>
          </table></div>
        </section>
        <section className="sps-ir-section" aria-label="설치법과 사용법 문서">
          <h3>설치법·사용법</h3><p className="sps-ir-status">Packet에 고정된 정확한 문서 핀만 표시합니다. 본문 조회는 승인 여부나 QA 판정에 영향을 주지 않습니다.</p>
          <div className="sps-ir-grid">{ready!.snapshot.packet.documents.map(document => <PinCard
            key={`${document.kind}:${document.pin.sourceId}`} label={document.kind === "installation-guide" ? "설치법" : document.kind === "user-guide" ? "사용법" : "기타 문서"} pin={document.pin} />)}</div>
          <div className="sps-ir-grid" style={{ marginTop: 8 }}>{ready!.deliveryDocuments.map((document, index) => <article className="sps-ir-item"
            key={`${document.kind}:${document.pin.sourceId}:${document.pin.revisionId}`}>
            <strong>{document.kind === "installation-guide" ? "설치법 본문" : document.kind === "user-guide" ? "사용법 본문" : "기타 문서 본문"}</strong>
            {document.status === "available" ? <><small className="sps-ir-mono">{document.path}</small>
              <pre className="sps-ir-body">{document.body}</pre></>
              : <small role="status">{document.status === "stale" ? "Packet 핀 또는 현재 문서가 변경되어 본문을 표시하지 않습니다."
                : document.status === "unknown" ? "현재 문서 상태를 확인할 수 없어 본문을 표시하지 않습니다."
                  : "Packet과 정확히 일치하는 현재 문서를 찾지 못했습니다."}</small>}
          </article>)}</div>
        </section>
        <section className="sps-ir-section" aria-label="알려진 제한">
          <h3>알려진 제한</h3><ul className="sps-ir-list">{ready!.snapshot.packet.limits.map((limit, index) => <li key={`${index}:${limit}`}>{limit}</li>)}</ul>
        </section>
        {ready!.snapshot.packet.preparation && <section className="sps-ir-section" aria-label="지원 환경과 의존성">
          <h3>지원 환경·의존성</h3><p>패키지 버전 {ready!.snapshot.packet.preparation.packageVersion}</p>
          {ready!.snapshot.packet.preparation.targets.map(target => <article className="sps-ir-item" key={target.target}>
            <strong>{target.target}</strong><ul className="sps-ir-list">{target.environments.map(value => <li key={value}>{value}</li>)}</ul>
            <small>의존성: {target.dependencies.length ? target.dependencies.join(", ") : "선언된 추가 의존성 없음"}</small>
            <small className="sps-ir-mono">진입 파일: {target.entryPaths.join(", ")}</small>
            {target.supplementaryPaths.length > 0 && <small className="sps-ir-mono">부속 자료: {target.supplementaryPaths.join(", ")}</small>}
          </article>)}
        </section>}
        <section className="sps-ir-section" aria-label="변경 이력">
          <h3>변경 이력</h3>{ready!.snapshot.packet.changeHistory.length
            ? <ul className="sps-ir-list">{ready!.snapshot.packet.changeHistory.map(pin => <li key={`${pin.sourceId}:${pin.revisionId}`}>
              {pinLabel(pin)} · <span className="sps-ir-mono">{digestLabel(pin.sha256)}</span></li>)}</ul>
            : <p className="sps-ir-status">패킷에 별도 변경 이력이 고정되어 있지 않습니다.</p>}
          {ready!.snapshot.packet.preparation && <ul className="sps-ir-list">{ready!.snapshot.packet.preparation.changeNotes.map(note => <li key={note}>{note}</li>)}</ul>}
        </section>
        <section className="sps-ir-section" aria-label="검토 요청과 결정">
          <h3>검토 요청 · 결정 이력</h3>{ready!.history.length
            ? <ol className="sps-ir-list">{[...ready!.history].reverse().map(event => <li key={event.eventId}>
              {event.kind === "manager-packet" ? "Manager 패킷" : event.kind === "main-attestation" ? "Main 점검"
                : event.kind === "approval-request" ? "승인 요청" : `사용자 ${event.decision?.action ?? "결정"}`} · {event.requestId} · {event.eventId}
              {event.decision ? ` · ${event.decision.userId} · ${event.decision.decidedAt}` : ""}
              {event.decision?.reason ? ` · ${event.decision.reason}` : ""}
            </li>)}</ol>
            : <p className="sps-ir-status">검토 요청 이력이 없습니다.</p>}
          {ready!.approvalRequest?.request && <div className="sps-ir-item" style={{ marginTop: 8 }}>
            <strong>Main attestation · Integration Review 요청</strong>
            <small>Attestation {ready!.approvalRequest.request.attestationEventId} · {ready!.approvalRequest.request.requestedAt}</small>
            <small className="sps-ir-mono">Main Agent {ready!.approvalRequest.request.mainLeadAgentId} · selection {ready!.approvalRequest.request.mainLeadSelectionRevision} · Session {ready!.approvalRequest.request.mainLeadSessionId} · Run {ready!.approvalRequest.request.mainLeadRunId}</small>
            <small className="sps-ir-mono">Integration Review Agent {ready!.approvalRequest.request.integrationReviewAgentId} · Session {ready!.approvalRequest.request.integrationReviewSessionId} · Run {ready!.approvalRequest.request.integrationReviewRunId}</small>
          </div>}
        </section>
        <section className="sps-ir-section" aria-label="승인 가능 상태">
          <h3>사용자 검토 결정</h3>
          {ready!.mainAttestation?.attestation?.mainReview && <dl className="sps-ir-list">
            {ready!.mainAttestation.attestation.mainReview.checks.map(check => <div key={check.area} className="sps-ir-item">
              <dt>{({ "approved-design": "승인 설계 대조", deliverables: "납품 산출물", installation: "설치법", usage: "사용법", "validation-and-limits": "검증·제한사항" } as const)[check.area]}</dt>
              <dd>{check.summary}</dd><small className="sps-ir-mono">{check.evidenceSourceIds.join(" · ")}</small>
            </div>)}
          </dl>}
          {!isCurrentRequest(ready!) ? <p className="sps-ir-status">현재 결정 가능한 Main attestation과 Integration Review 승인 요청이 없거나 이미 결정되었습니다.</p>
            : !receiptValid ? <p className="sps-ir-status">Main attestation 또는 Main·Integration Review의 정확한 Workspace·Agent·Session·Run receipt 연결을 확인할 수 없어 결정을 차단했습니다.</p>
            : <p className="sps-ir-status">{ready!.approvalEligibility.status === "eligible" ? "현재 고정 근거와 필수 게이트가 적격입니다."
              : ready!.approvalEligibility.status === "unknown" ? "현재 근거 권위 또는 적격성을 확인할 수 없습니다." : "현재 근거 또는 필수 게이트가 적격하지 않습니다."}
              {ready!.approvalEligibility.reason ? ` ${ready!.approvalEligibility.reason}` : ""}</p>}
          {ready!.decision?.decision && <p className="sps-ir-status" role="status">결정 기록: {ready!.decision.decision.action}
            {ready!.decision.decision.reason ? ` · ${ready!.decision.decision.reason}` : ""}</p>}
          <div className="sps-ir-actions">
            <label htmlFor="sps-ir-reason">수정 요청 또는 보류 사유</label>
            <input id="sps-ir-reason" className="sps-ir-reason" value={reason} maxLength={200} onChange={event => setReason(event.currentTarget.value)}
              placeholder="이유를 입력하세요" disabled={!hasDecisionActions || busy} />
            <div className="sps-ir-buttons">
              <button className="sps-ir-button is-primary" type="button" disabled={!eligible || !onApprove || busy}
                onClick={() => void act(onApprove)}>최종 검토 승인</button>
              <button className="sps-ir-button" type="button" disabled={!hasDecisionActions || !onRequestChanges || !reasonReady || busy}
                onClick={() => void decide(onRequestChanges)}>수정 요청</button>
              <button className="sps-ir-button" type="button" disabled={!hasDecisionActions || !onHold || !reasonReady || busy}
                onClick={() => void decide(onHold)}>보류</button>
            </div>
            {actionError && <p className="sps-ir-status" role="alert">결정이 확인되지 않았습니다. 상태를 새로고침한 뒤 기존 요청을 확인하세요.</p>}
            {actionComplete && <p className="sps-ir-status" role="status">서버가 결정 callback을 완료했습니다. 결과 기록을 다시 불러와 확인하세요.</p>}
          </div>
        </section>
      </>}
    <footer className="sps-ir-footer">이 화면은 고정된 검토 근거를 표시합니다. 패킷 승인도 제품 설치·동작 QA·배포 승인을 대신하지 않습니다.</footer>
  </section>;
}
