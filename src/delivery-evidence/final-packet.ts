import { createHash } from "node:crypto";
import type { SpsActionContext, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { exactToolRecord, parseLeadToolContext, requireLeadFormalPublicationAuthority, resolveLeadToolAuthority } from "../lead-tool-authority.ts";
import { createRevisionJournal, type RevisionPublicationGuard, type RevisionState } from "../solution-revision-store.ts";
import { INTEGRATION_PACKET_EVENT, INTEGRATION_PACKET_MAIN_JOB, integrationPacketDigest, type IntegrationPacketEvidence } from "./integration-packet-evidence.ts";

const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[^\u0000-\u001f\u007f]{1,200}$/u;
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const json = (value: unknown) => JSON.stringify(value);
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) freeze(item);
    Object.freeze(value);
  }
  return value;
};

export type FinalPacketPin = Readonly<{ sourceId: string; revisionId: string; sha256: string }>;
export type FinalPacketDocument = Readonly<{ kind: "installation-guide" | "user-guide" | "other"; pin: FinalPacketPin }>;
export type FinalPacketFile = Readonly<{ path: string; classification: string; size: number; sha256: string }>;
export type FinalPacket = Readonly<{
  packetId: string;
  packetRevisionId: string;
  packetSha256: string;
  baseline: FinalPacketPin;
  uiRevision: FinalPacketPin;
  manifest: FinalPacketPin;
  integration: Readonly<{ branch: string; commitSha: string; build: FinalPacketPin;
    ciEvidence: readonly FinalPacketPin[]; e2eEvidence: readonly FinalPacketPin[] }>;
  files: readonly FinalPacketFile[];
  documents: readonly FinalPacketDocument[];
  qaEvidence: readonly FinalPacketPin[];
  g6Evidence: readonly FinalPacketPin[];
  g7Evidence: readonly FinalPacketPin[];
  limits: readonly string[];
  changeHistory: readonly FinalPacketPin[];
}>;
export type FinalEvidenceSnapshot = Readonly<{
  provenance: Readonly<{ adapter: "builder.final-packet-current-evidence.v1"; operation: "readCurrent" }>;
  workspaceId: string;
  projectId: string;
  packet: FinalPacket;
  commitObjectBytes: Uint8Array;
  fileBytes: readonly Readonly<{ path: string; bytes: Uint8Array }>[];
  integrationCodeAuthority: "verified" | "unknown";
  hostRuntimeAuthority: "verified" | "unknown";
  g6: "PASS" | "FAIL" | "UNKNOWN";
  g7: "PASS" | "FAIL" | "UNKNOWN";
  qa: "PASS" | "FAIL" | "UNKNOWN";
  currentPinsSha256: string;
}>;
/**
 * The trusted server-bound implementation must re-read current source and gate
 * records, verify packet/file/document bytes against their SHA-256 pins, and
 * return UNKNOWN when any authority or complete inventory is unavailable.
 */
export type FinalEvidenceReader = () => Promise<Readonly<{ status: "available"; value: FinalEvidenceSnapshot }>
  | Readonly<{ status: "unknown"; reason: string }>>;

export type FinalPacketJournalEvent = Readonly<{
  eventId: string;
  expectedBaseRevisionId: string | null;
  kind: "manager-packet" | "main-attestation" | "approval-request" | "user-decision";
  requestId: string;
  attestation: Readonly<{ packet: FinalPacket; snapshotSha256: string; currentPinsSha256: string; attestedAt: string;
    mainLeadAgentId: string; mainLeadSelectionRevision: number; mainLeadRunId: string; mainLeadSessionId: string }>| null;
  request: Readonly<{ packet: FinalPacket; snapshotSha256: string; currentPinsSha256: string; requestedAt: string;
    attestationEventId: string; mainLeadAgentId: string; mainLeadSelectionRevision: number; mainLeadRunId: string; mainLeadSessionId: string;
    integrationReviewAgentId: string; integrationReviewRunId: string; integrationReviewSessionId: string }>| null;
  decision: Readonly<{ action: "approve" | "request-changes" | "hold"; userId: string; reason: string | null;
    decidedAt: string; sourceSnapshotSha256: string | null }>| null;
  managerPacket?: Readonly<{ evidence: IntegrationPacketEvidence; sha256: string; agentId: string; sessionId: string; runId: string }>;
}>;
export type FinalAtomicApprovalCommitter = (input: Readonly<{ workspaceId: string; projectId: string; requestId: string;
  expectedJournalRevisionId: string | null; requestSnapshotSha256: string; currentSnapshotSha256: string;
  decision: FinalPacketJournalEvent }>) => Promise<Readonly<{ status: "published"; sequence: number } | { status: "stale" }>>;

function record(value: unknown, required: readonly string[]): Record<string, unknown> {
  const row = exactToolRecord(value, required);
  return row;
}
function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value) || !value.trim()) throw new TypeError(`Invalid ${label}.`);
  return value;
}
function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`Invalid ${label}.`);
  return value;
}
function selectionRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("Invalid Lead selection revision.");
  return value as number;
}
function pin(value: unknown): FinalPacketPin {
  const row = record(value, ["sourceId", "revisionId", "sha256"]);
  return Object.freeze({ sourceId: id(row.sourceId, "sourceId"), revisionId: id(row.revisionId, "revisionId"), sha256: digest(row.sha256, "pin sha256") });
}
function pins(value: unknown, label: string, allowEmpty = false): readonly FinalPacketPin[] {
  if (!Array.isArray(value) || !allowEmpty && value.length === 0) throw new TypeError(`${label} must be ${allowEmpty ? "an array" : "non-empty"}.`);
  const result = value.map(pin);
  if (new Set(result.map(item => item.sourceId)).size !== result.length) throw new TypeError(`${label} contains duplicate sources.`);
  return Object.freeze(result);
}
function packet(value: unknown): FinalPacket {
  const row = record(value, ["packetId", "packetRevisionId", "packetSha256", "baseline", "uiRevision", "manifest", "integration",
    "files", "documents", "qaEvidence", "g6Evidence", "g7Evidence", "limits", "changeHistory"]);
  if (!Array.isArray(row.files) || !row.files.length || !Array.isArray(row.documents) || !Array.isArray(row.limits)
    || !Array.isArray(row.changeHistory)) throw new TypeError("Final Packet contents are incomplete.");
  const files = row.files.map(item => {
    const file = record(item, ["path", "classification", "size", "sha256"]);
    const path = id(file.path, "file path");
    if (path.startsWith("/") || path.includes("\\") || path.split("/").some(part => part === ".." || !part)) throw new TypeError("Final Packet file path must be relative and normalized.");
    if (!Number.isSafeInteger(file.size) || (file.size as number) < 0) throw new TypeError("Invalid file size.");
    return Object.freeze({ path, classification: id(file.classification, "file classification"), size: file.size as number, sha256: digest(file.sha256, "file sha256") });
  });
  if (new Set(files.map(file => file.path)).size !== files.length) throw new TypeError("Final Packet file paths must be unique.");
  const documents = row.documents.map(item => {
    const doc = record(item, ["kind", "pin"]);
    if (doc.kind !== "installation-guide" && doc.kind !== "user-guide" && doc.kind !== "other") throw new TypeError("Invalid delivery document kind.");
    return Object.freeze({ kind: doc.kind, pin: pin(doc.pin) });
  });
  if (!documents.some(doc => doc.kind === "installation-guide") || !documents.some(doc => doc.kind === "user-guide")) {
    throw new TypeError("Installation and user guides must both be pinned.");
  }
  const integration = record(row.integration, ["branch", "commitSha", "build", "ciEvidence", "e2eEvidence"]);
  const integrationInfo = Object.freeze({ branch: id(integration.branch, "integration branch"),
    commitSha: id(integration.commitSha, "integration commit"), build: pin(integration.build),
    ciEvidence: pins(integration.ciEvidence, "CI evidence"), e2eEvidence: pins(integration.e2eEvidence, "E2E evidence") });
  const limits = row.limits.map(item => id(item, "known limit"));
  if (new Set(limits).size !== limits.length) throw new TypeError("Known limits must be unique.");
  const parsed = { packetId: id(row.packetId, "packetId"), packetRevisionId: id(row.packetRevisionId, "packetRevisionId"),
    packetSha256: digest(row.packetSha256, "packet sha256"), baseline: pin(row.baseline), uiRevision: pin(row.uiRevision),
    manifest: pin(row.manifest), integration: integrationInfo, files: Object.freeze(files), documents: Object.freeze(documents),
    qaEvidence: pins(row.qaEvidence, "QA evidence"), g6Evidence: pins(row.g6Evidence, "G6 evidence"),
    g7Evidence: pins(row.g7Evidence, "G7 evidence"), limits: Object.freeze(limits), changeHistory: pins(row.changeHistory, "change history", true) };
  const { packetSha256, ...content } = parsed;
  if (packetSha256 !== hash(json(content))) throw new TypeError("Final Packet content hash does not match its exact contents.");
  return Object.freeze(parsed);
}

function currentPinsDigest(value: FinalPacket): string {
  const all: FinalPacketPin[] = [value.baseline, value.uiRevision, value.manifest, value.integration.build,
    ...value.integration.ciEvidence, ...value.integration.e2eEvidence, ...value.documents.map(document => document.pin),
    ...value.qaEvidence, ...value.g6Evidence, ...value.g7Evidence, ...value.changeHistory,
    ...value.files.map(file => ({ sourceId: `file:${file.path}`, revisionId: value.packetRevisionId, sha256: file.sha256 }))];
  all.sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.revisionId.localeCompare(b.revisionId) || a.sha256.localeCompare(b.sha256));
  if (new Set(all.map(item => `${item.sourceId}\0${item.revisionId}`)).size !== all.length) throw new TypeError("Final Packet pin identity is duplicated.");
  return hash(json(all));
}
function verifyPacketBytes(snapshot: FinalEvidenceSnapshot, value: FinalPacket): boolean {
  try {
    const algorithm = value.integration.commitSha.length === 40 ? "sha1" : value.integration.commitSha.length === 64 ? "sha256" : null;
    if (!algorithm || !/^[a-f0-9]+$/u.test(value.integration.commitSha) || !(snapshot.commitObjectBytes instanceof Uint8Array)) return false;
    const commitHeader = Buffer.from(`commit ${snapshot.commitObjectBytes.byteLength}\0`, "ascii");
    const actualCommitSha = createHash(algorithm).update(commitHeader).update(snapshot.commitObjectBytes).digest("hex");
    if (actualCommitSha !== value.integration.commitSha) return false;
    if (!Array.isArray(snapshot.fileBytes) || snapshot.fileBytes.length !== value.files.length) return false;
    const byPath = new Map<string, Uint8Array>();
    for (const item of snapshot.fileBytes) {
      if (!item || typeof item.path !== "string" || !(item.bytes instanceof Uint8Array) || byPath.has(item.path)) return false;
      byPath.set(item.path, item.bytes);
    }
    return value.files.every(file => {
      const bytes = byPath.get(file.path);
      return bytes !== undefined && bytes.byteLength === file.size
        && createHash("sha256").update(bytes).digest("hex") === file.sha256;
    });
  } catch { return false; }
}
function parseEvent(value: unknown): FinalPacketJournalEvent {
  const row = exactToolRecord(value, ["eventId", "expectedBaseRevisionId", "kind", "requestId", "attestation", "request", "decision"], ["managerPacket"]);
  const eventId = id(row.eventId, "eventId");
  const expectedBaseRevisionId = row.expectedBaseRevisionId === null ? null : id(row.expectedBaseRevisionId, "expected base revision");
  const requestId = id(row.requestId, "requestId");
  if (row.kind === "manager-packet" && row.attestation === null && row.request === null && row.decision === null) {
    const payload = record(row.managerPacket, ["evidence", "sha256", "agentId", "sessionId", "runId"]);
    const body = record(payload.evidence, ["workspaceId", "projectId", "candidate", "candidateEvidenceSha256", "plan", "baseline", "ui",
      "boardRevisionId", "workstreams", "tasks", "scope", "validation", "buildOutputs", "manifest", "files", "documentRevisionId",
      "documents", "finalReadiness", "deliveryAuthority"]);
    const sha256 = digest(payload.sha256, "integration packet digest");
    if (body.finalReadiness !== "main-g7-required" || body.deliveryAuthority !== "not-established"
      || integrationPacketDigest(body) !== sha256 || requestId !== `integration-packet-v1:${sha256}`
      || eventId !== managerEventId(requestId, expectedBaseRevisionId)) throw new TypeError("Invalid Manager packet identity.");
    return freeze({ eventId, expectedBaseRevisionId, kind: "manager-packet", requestId,
      managerPacket: { evidence: body as unknown as IntegrationPacketEvidence, sha256, agentId: id(payload.agentId, "Manager Agent"),
        sessionId: id(payload.sessionId, "Manager session"), runId: id(payload.runId, "Manager run") },
      attestation: null, request: null, decision: null });
  }
  if (Object.hasOwn(row, "managerPacket")) throw new TypeError("Unexpected Manager packet payload.");
  if (row.kind === "main-attestation" && row.attestation && row.request === null && row.decision === null) {
    const attestation = record(row.attestation, ["packet", "snapshotSha256", "currentPinsSha256", "attestedAt", "mainLeadAgentId",
      "mainLeadSelectionRevision", "mainLeadRunId", "mainLeadSessionId"]);
    const parsedPacket = packet(attestation.packet);
    if (parsedPacket.packetRevisionId !== requestId) throw new TypeError("Attestation must bind the exact immutable packet revision.");
    const attestedAt = id(attestation.attestedAt, "attestation timestamp");
    if (!Number.isFinite(Date.parse(attestedAt))) throw new TypeError("Invalid attestation timestamp.");
    return Object.freeze({ eventId, expectedBaseRevisionId, kind: row.kind, requestId,
      attestation: Object.freeze({ packet: parsedPacket, snapshotSha256: digest(attestation.snapshotSha256, "snapshot sha256"),
        currentPinsSha256: digest(attestation.currentPinsSha256, "current pins sha256"), attestedAt,
        mainLeadAgentId: id(attestation.mainLeadAgentId, "Main Lead Agent"),
        mainLeadSelectionRevision: selectionRevision(attestation.mainLeadSelectionRevision), mainLeadRunId: id(attestation.mainLeadRunId, "Main Lead run"),
        mainLeadSessionId: id(attestation.mainLeadSessionId, "Main Lead session") }), request: null, decision: null });
  }
  if (row.kind === "approval-request" && row.attestation === null && row.request && row.decision === null) {
    const request = record(row.request, ["packet", "snapshotSha256", "currentPinsSha256", "requestedAt", "attestationEventId",
      "mainLeadAgentId", "mainLeadSelectionRevision", "mainLeadRunId", "mainLeadSessionId", "integrationReviewAgentId", "integrationReviewRunId", "integrationReviewSessionId"]);
    const parsedPacket = packet(request.packet);
    if (parsedPacket.packetRevisionId !== requestId) throw new TypeError("Request ID must equal the immutable packet revision.");
    const requestedAt = id(request.requestedAt, "request timestamp");
    if (!Number.isFinite(Date.parse(requestedAt))) throw new TypeError("Invalid request timestamp.");
    return Object.freeze({ eventId, expectedBaseRevisionId, kind: row.kind, requestId, attestation: null,
      request: Object.freeze({ packet: parsedPacket, snapshotSha256: digest(request.snapshotSha256, "snapshot sha256"),
        currentPinsSha256: digest(request.currentPinsSha256, "current pins sha256"), requestedAt,
        attestationEventId: id(request.attestationEventId, "Main attestation event ID"),
        mainLeadAgentId: id(request.mainLeadAgentId, "Main Lead Agent"),
        mainLeadSelectionRevision: selectionRevision(request.mainLeadSelectionRevision), mainLeadRunId: id(request.mainLeadRunId, "Main Lead run"),
        mainLeadSessionId: id(request.mainLeadSessionId, "Main Lead session"),
        integrationReviewAgentId: id(request.integrationReviewAgentId, "Integration Review Agent"),
        integrationReviewRunId: id(request.integrationReviewRunId, "Integration Review run"),
        integrationReviewSessionId: id(request.integrationReviewSessionId, "Integration Review session") }), decision: null });
  }
  if (row.kind === "user-decision" && row.attestation === null && row.request === null && row.decision) {
    const decision = record(row.decision, ["action", "userId", "reason", "decidedAt", "sourceSnapshotSha256"]);
    if (decision.action !== "approve" && decision.action !== "request-changes" && decision.action !== "hold") throw new TypeError("Invalid user decision.");
    const reason = decision.reason === null ? null : id(decision.reason, "decision reason");
    if (decision.action !== "approve" && !reason) throw new TypeError("A reason is required for changes or hold.");
    const decidedAt = id(decision.decidedAt, "decision timestamp");
    if (!Number.isFinite(Date.parse(decidedAt))) throw new TypeError("Invalid decision timestamp.");
    const sourceSnapshotSha256 = decision.sourceSnapshotSha256 === null ? null : digest(decision.sourceSnapshotSha256, "decision source snapshot sha256");
    if (decision.action === "approve" && sourceSnapshotSha256 === null) throw new TypeError("Approval must bind the exact current evidence snapshot.");
    return Object.freeze({ eventId, expectedBaseRevisionId, kind: row.kind, requestId, attestation: null, request: null,
      decision: Object.freeze({ action: decision.action, userId: id(decision.userId, "authenticated user"), reason, decidedAt, sourceSnapshotSha256 }) });
  }
  throw new TypeError("Invalid Final Packet journal event.");
}

function managerEventId(requestId: string, parent: string | null) {
  return `integration-packet-event-v1:${hash(json([requestId, parent]))}`;
}

function eligible(snapshot: FinalEvidenceSnapshot, workspaceId: string, projectId: string): boolean {
  try {
    const parsedPacket = packet(snapshot.packet);
    return snapshot.provenance?.adapter === "builder.final-packet-current-evidence.v1" && snapshot.provenance.operation === "readCurrent"
      && snapshot.workspaceId === workspaceId && snapshot.projectId === projectId
      && snapshot.integrationCodeAuthority === "verified" && snapshot.hostRuntimeAuthority === "verified"
      && snapshot.g6 === "PASS" && snapshot.g7 === "PASS" && snapshot.qa === "PASS"
      && SHA256.test(snapshot.currentPinsSha256) && parsedPacket.packetRevisionId.length > 0
      && currentPinsDigest(parsedPacket) === snapshot.currentPinsSha256 && verifyPacketBytes(snapshot, parsedPacket);
  } catch { return false; }
}

/**
 * Builder adapter boundary for a trusted server-bound reader. Provenance fields
 * serialize the adapter contract; they are not authority. No reader is wired by
 * this module, and an unregistered reader remains UNKNOWN.
 */
export function createFinalPacketStore(workspaceId: string, projectId: string, state: RevisionState,
  readCurrentEvidence?: FinalEvidenceReader, commitApprovalAtomically?: FinalAtomicApprovalCommitter) {
  const journal = createRevisionJournal<FinalPacketJournalEvent>(workspaceId, projectId, state, { prefix: "final-delivery",
    parse(value) {
      const event = parseEvent(value);
      const packet = event.managerPacket?.evidence;
      if (packet && (packet.workspaceId !== workspaceId || packet.projectId !== projectId)) throw new Error("Foreign Manager packet.");
      return event;
    }, revisionId: event => event.eventId });
  async function evidence() {
    if (!readCurrentEvidence) return null;
    try {
      const read = await readCurrentEvidence();
      return read?.status === "available" ? read.value : null;
    } catch { return null; }
  }
  async function currentAttestation(requestId: string) {
    const history = await journal.recent(50);
    return history.revisions.find(item => item.revision.kind === "main-attestation" && item.revision.requestId === requestId)?.revision ?? null;
  }
  async function currentRequest(requestId: string) {
    const history = await journal.recent(50);
    return history.revisions.find(item => item.revision.kind === "approval-request" && item.revision.requestId === requestId)?.revision ?? null;
  }
  return Object.freeze({
    async current() { return journal.recent(50); },
    async headRevisionId() { return (await journal.current())?.revision.eventId ?? null; },
    async currentManagerPacket() {
      return (await journal.recent(50)).revisions.find(item => item.revision.kind === "manager-packet") ?? null;
    },
    async publishManagerPacket(input: Readonly<{ evidence: IntegrationPacketEvidence; sha256: string; expectedBaseRevisionId: string | null;
      author: { agentId: string; sessionId: string; runId: string }; guards: readonly RevisionPublicationGuard[] }>) {
      const requestId = `integration-packet-v1:${input.sha256}`;
      const previous = (await journal.recent(50)).revisions.find(item => item.revision.kind === "manager-packet");
      if (previous?.revision.requestId === requestId) return { status: "existing" as const, eventId: previous.revision.eventId,
        packetRevisionId: requestId, sequence: previous.sequence };
      const expected = input.expectedBaseRevisionId;
      const eventId = managerEventId(requestId, expected);
      const staged = await journal.stagedRevision(eventId, expected);
      if (staged.status === "conflict") return { status: "conflict" as const, actualBaseRevisionId: staged.actualBaseRevisionId };
      const revision = staged.status === "staged" ? staged.revision : parseEvent({ eventId, expectedBaseRevisionId: expected,
        kind: "manager-packet", requestId, managerPacket: { evidence: input.evidence, sha256: input.sha256, ...input.author },
        attestation: null, request: null, decision: null });
      if (Buffer.byteLength(json(revision), "utf8") > 128 * 1024) return { status: "unsupported" as const, reason: "integration-packet-record-bound" };
      const result = await journal.publishGuardedWithJobWakeV1({ expectedBaseRevisionId: expected, revision }, input.guards,
        { name: INTEGRATION_PACKET_EVENT, eventId, jobKey: INTEGRATION_PACKET_MAIN_JOB,
          payload: { workspaceId, projectId, packetRevisionId: requestId, packetSha256: input.sha256 } });
      return result.status === "published" ? { status: "published" as const, eventId, packetRevisionId: requestId, sequence: result.sequence } : result;
    },
    async reviewEvidence() {
      const current = await evidence();
      if (!current || current.workspaceId !== workspaceId || current.projectId !== projectId) return null;
      const { packet: content, integrationCodeAuthority, hostRuntimeAuthority, g6, g7, qa, currentPinsSha256 } = current;
      const parsed = packet(content);
      if (currentPinsDigest(parsed) !== currentPinsSha256 || !verifyPacketBytes(current, parsed)) return null;
      return { snapshot: { workspaceId, projectId, packet: parsed, integrationCodeAuthority, hostRuntimeAuthority,
        g6, g7, qa, currentPinsSha256 }, snapshotSha256: hash(json(current)),
        eligible: eligible(current, workspaceId, projectId) && Boolean(commitApprovalAtomically) };
    },
    async attestFinalPacket(input: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
      const row = exactToolRecord(input, ["eventId", "requestId", "expectedBaseRevisionId"]);
      const eventId = id(row.eventId, "eventId"), requestId = id(row.requestId, "requestId");
      const expected = row.expectedBaseRevisionId === null ? null : id(row.expectedBaseRevisionId, "expected base revision");
      const authority = await toolAuthority(runContext, platform);
      requireLeadFormalPublicationAuthority(authority);
      await authority.check();
      const first = await evidence();
      if (!first || !eligible(first, workspaceId, projectId)) return Object.freeze({ status: "blocked" as const, reason: "authoritative-final-packet-or-required-gates-unknown-or-ineligible" });
      if (first.packet.packetRevisionId !== requestId) return Object.freeze({ status: "blocked" as const, reason: "attestation-must-bind-current-packet-revision" });
      if (await journal.publishedRevision(eventId)) return Object.freeze({ status: "blocked" as const, reason: "attestation-event-id-already-published" });
      if ((await journal.recent(50)).revisions.some(item => item.revision.kind === "main-attestation" && item.revision.requestId === requestId)) {
        return Object.freeze({ status: "blocked" as const, reason: "packet-revision-already-has-an-immutable-main-attestation" });
      }
      const event = parseEvent({ eventId, expectedBaseRevisionId: expected, kind: "main-attestation", requestId,
        attestation: { packet: first.packet, snapshotSha256: hash(json(first)), currentPinsSha256: first.currentPinsSha256,
          attestedAt: new Date().toISOString(), mainLeadAgentId: authority.context.agentId, mainLeadSelectionRevision: authority.selectionRevision,
          mainLeadRunId: authority.context.runId,
          mainLeadSessionId: authority.context.sessionId }, request: null, decision: null });
      const beforeWrite = await evidence();
      await authority.check();
      if (!beforeWrite || !eligible(beforeWrite, workspaceId, projectId) || hash(json(beforeWrite)) !== event.attestation!.snapshotSha256
        || beforeWrite.packet.integration.commitSha !== first.packet.integration.commitSha
        || beforeWrite.packet.files.length !== first.packet.files.length
        || beforeWrite.packet.files.some((file, index) => file.path !== first.packet.files[index]?.path
          || file.sha256 !== first.packet.files[index]?.sha256 || file.size !== first.packet.files[index]?.size)) {
        return Object.freeze({ status: "blocked" as const, reason: "final-packet-or-required-gates-changed-before-attestation" });
      }
      const result = await journal.publish({ expectedBaseRevisionId: expected, revision: event });
      return result.status === "published" ? Object.freeze({ status: "attested" as const, sequence: result.sequence, attestation: event })
        : Object.freeze({ status: "conflict" as const, actualRevisionId: result.actualBaseRevisionId });
    },
    async publishApprovalRequest(input: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
      const row = exactToolRecord(input, ["eventId", "requestId", "expectedBaseRevisionId", "attestationEventId"]);
      const eventId = id(row.eventId, "eventId"), requestId = id(row.requestId, "requestId");
      const expected = row.expectedBaseRevisionId === null ? null : id(row.expectedBaseRevisionId, "expected base revision");
      const attestationEventId = id(row.attestationEventId, "Main attestation event ID");
      const authority = await toolAuthority(runContext, platform);
      if (authority.channel !== "integration-review") throw new Error("Only the current Lead Integration Review session may post the user approval request.");
      await authority.check();
      const attestation = await currentAttestation(requestId);
      if (!attestation?.attestation || attestation.eventId !== attestationEventId) {
        return Object.freeze({ status: "blocked" as const, reason: "exact-current-main-attestation-not-found" });
      }
      if (authority.context.agentId !== attestation.attestation.mainLeadAgentId
        || authority.selectionRevision !== attestation.attestation.mainLeadSelectionRevision) {
        return Object.freeze({ status: "blocked" as const, reason: "main-attestation-is-not-from-the-current-same-lead-selection" });
      }
      const head = (await journal.current())?.revision ?? null;
      if (head?.kind !== "main-attestation" || head.eventId !== attestationEventId || head.eventId !== expected) {
        return Object.freeze({ status: "conflict" as const, actualRevisionId: head?.eventId ?? null });
      }
      const current = await evidence();
      if (!current || !eligible(current, workspaceId, projectId) || hash(json(current)) !== attestation.attestation.snapshotSha256
        || current.packet.packetRevisionId !== requestId) {
        return Object.freeze({ status: "blocked" as const, reason: "attested-packet-or-required-gates-stale-unavailable-or-unknown" });
      }
      if (await journal.publishedRevision(eventId)) return Object.freeze({ status: "blocked" as const, reason: "request-event-id-already-published" });
      const event = parseEvent({ eventId, expectedBaseRevisionId: expected, kind: "approval-request", requestId, attestation: null,
        request: { packet: attestation.attestation.packet, snapshotSha256: attestation.attestation.snapshotSha256,
          currentPinsSha256: attestation.attestation.currentPinsSha256, requestedAt: new Date().toISOString(),
          attestationEventId, mainLeadAgentId: attestation.attestation.mainLeadAgentId,
          mainLeadSelectionRevision: attestation.attestation.mainLeadSelectionRevision, mainLeadRunId: attestation.attestation.mainLeadRunId,
          mainLeadSessionId: attestation.attestation.mainLeadSessionId, integrationReviewAgentId: authority.context.agentId,
          integrationReviewRunId: authority.context.runId, integrationReviewSessionId: authority.context.sessionId }, decision: null });
      await authority.check();
      const afterCheck = await evidence();
      if (!afterCheck || !eligible(afterCheck, workspaceId, projectId) || hash(json(afterCheck)) !== event.request!.snapshotSha256) {
        return Object.freeze({ status: "blocked" as const, reason: "attested-packet-or-required-gates-changed-before-request" });
      }
      const result = await journal.publish({ expectedBaseRevisionId: expected, revision: event });
      return result.status === "published" ? Object.freeze({ status: "published" as const, sequence: result.sequence, request: event })
        : Object.freeze({ status: "conflict" as const, actualRevisionId: result.actualBaseRevisionId });
    },
    async respond(input: unknown, context: Pick<SpsActionContext, "companyId" | "actor"> & { state: RevisionState },
      authorizeNewDecision?: () => Promise<void>) {
      if (context.actor.type !== "user" || context.actor.companyId !== context.companyId || !context.actor.userId?.trim()
        || context.companyId !== workspaceId) throw new Error("Final Packet decisions require an authenticated Workspace user action.");
      if (context.state !== state) throw new Error("Final Packet action state does not match the Workspace-bound journal.");
      const row = exactToolRecord(input, ["eventId", "requestId", "expectedBaseRevisionId", "action"], ["reason"]);
      const eventId = id(row.eventId, "eventId"), requestId = id(row.requestId, "requestId");
      const expected = row.expectedBaseRevisionId === null ? null : id(row.expectedBaseRevisionId, "expected base revision");
      if (row.action !== "approve" && row.action !== "request-changes" && row.action !== "hold") throw new TypeError("Invalid user decision.");
      const reason = row.reason === undefined || row.reason === null ? null : id(row.reason, "decision reason");
      if (row.action !== "approve" && reason === null) throw new TypeError("A reason is required for changes or hold.");
      const prior = await journal.publishedRevision(eventId);
      if (prior) {
        const { revision, sequence } = prior;
        const decision = revision.decision;
        if (revision.kind !== "user-decision" || !decision || revision.requestId !== requestId
          || revision.expectedBaseRevisionId !== expected || decision.userId !== context.actor.userId
          || decision.action !== row.action || decision.reason !== reason) {
          throw new Error("The decision event ID is already bound to different immutable content.");
        }
        // A receipt for an existing write is not a fresh approval or eligibility check.
        return Object.freeze({ status: "recorded" as const, sequence, decision, replayed: true as const });
      }
      await authorizeNewDecision?.();
      const request = await currentRequest(requestId);
      if (!request?.request) throw new Error("The exact immutable approval request is not currently published.");
      const history = await journal.recent(50);
      if (history.revisions.some(item => item.revision.kind === "user-decision" && item.revision.requestId === requestId)) {
        throw new Error("This immutable approval request already has a user decision.");
      }
      const latest = history.revisions[0] ?? null;
      if (latest?.revision.kind !== "approval-request" || latest.revision.requestId !== requestId) {
        throw new Error("Only the current pending approval request can receive a user decision.");
      }
      if ((latest?.revision.eventId ?? null) !== expected) return Object.freeze({ status: "conflict" as const, actualRevisionId: latest?.revision.eventId ?? null });
      let approvalSnapshot: FinalEvidenceSnapshot | null = null;
      if (row.action === "approve") {
        approvalSnapshot = await evidence();
        if (!approvalSnapshot || !eligible(approvalSnapshot, workspaceId, projectId) || hash(json(approvalSnapshot)) !== request.request.snapshotSha256
          || approvalSnapshot.packet.packetRevisionId !== request.request.packet.packetRevisionId) {
          throw new Error("The approved packet, required gates, or source pins are stale, unavailable, or UNKNOWN.");
        }
      }
      const event = parseEvent({ eventId, expectedBaseRevisionId: expected, kind: "user-decision", requestId, attestation: null, request: null,
        decision: { action: row.action, userId: context.actor.userId, reason, decidedAt: new Date().toISOString(),
          sourceSnapshotSha256: approvalSnapshot ? hash(json(approvalSnapshot)) : null } });
      if (row.action === "approve") {
        if (!commitApprovalAtomically) throw new Error("Atomic current-evidence approval writer is not registered; approval remains unavailable.");
        const currentSnapshotSha256 = event.decision!.sourceSnapshotSha256!;
        const receipt = await commitApprovalAtomically({ workspaceId, projectId, requestId,
          expectedJournalRevisionId: expected, requestSnapshotSha256: request.request.snapshotSha256,
          currentSnapshotSha256, decision: event });
        if (receipt?.status === "stale") throw new Error("Atomic approval rejected the stale Final Packet or evidence snapshot.");
        if (receipt?.status !== "published" || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) {
          throw new Error("Atomic approval writer returned an invalid publication receipt.");
        }
        const persisted = await journal.publishedRevision(eventId);
        if (!persisted || persisted.sequence !== receipt.sequence || json(persisted.revision) !== json(event)) {
          throw new Error("Atomic approval receipt did not match the stored user decision.");
        }
        return Object.freeze({ status: "recorded" as const, sequence: receipt.sequence, decision: event.decision });
      }
      const result = await journal.publish({ expectedBaseRevisionId: expected, revision: event });
      return result.status === "published" ? Object.freeze({ status: "recorded" as const, sequence: result.sequence, decision: event.decision })
        : Object.freeze({ status: "conflict" as const, actualRevisionId: result.actualBaseRevisionId });
    },
  });

  async function toolAuthority(runContext: unknown, platform: SpsPlatformInvocationContext) {
    const context = parseLeadToolContext(runContext);
    if (context.companyId !== workspaceId || context.projectId !== undefined && context.projectId !== projectId) {
      throw new Error("Final review requires the authenticated Workspace project.");
    }
    return resolveLeadToolAuthority(context, platform);
  }
}
