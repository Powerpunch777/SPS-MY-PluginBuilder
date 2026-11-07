import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createCurrentFinalEvidenceReader } from "./current-final-evidence.ts";
import { readCurrentIntegrationPacket } from "./integration-packet.ts";
import { createFinalPacketStore, finalPacketPinsDigest, type FinalAtomicApprovalCommitter,
  type FinalEvidenceReader, type FinalEvidenceSnapshot, type FinalPacketJournalEvent } from "./final-packet.ts";
import type { RevisionPublicationGuard, RevisionState } from "../solution-revision-store.ts";

type GuardedGitRefInput = Readonly<{ scopeKind: "company"; scopeId: string; namespace?: string; stateKey: string;
  sourceId: string; folderKey: string; branch: string; expectedCommit: string; expectedTree: string;
  expected: { exists: false } | { exists: true; value: JsonValue }; value: JsonValue;
  guards: readonly Readonly<{ namespace?: string; stateKey: string; expectedValue: JsonValue }>[] }>;
type GuardedGitRefResult =
  | Readonly<{ status: "committed"; proof: Readonly<{ sourceId: string; folderKey: string; branch: string; commitSha: string; treeSha: string }> }>
  | Readonly<{ status: "conflict"; reason: string }>
  | Readonly<{ status: "unsupported"; reason: string }>
  | Readonly<{ status: "unknown"; reason: string }>;
type GuardedGitRefState = { guardedGitRefCompareAndSetV1?: (input: GuardedGitRefInput) => Promise<GuardedGitRefResult> };
type CurrentManagerRead = Awaited<ReturnType<typeof readCurrentIntegrationPacket>>;
type TrustedAtomicApprovalDependencies = Readonly<{
  readCurrentEvidence?: (platform: SpsPlatformInvocationContext) => ReturnType<FinalEvidenceReader>;
  readCurrentManagerPacket?: (platform: SpsPlatformInvocationContext) => Promise<CurrentManagerRead>;
}>;
type AtomicApprovalStore = ReturnType<typeof createFinalPacketStore> & {
  publishApprovalDecisionGuarded?: (input: Readonly<{ expectedBaseRevisionId: string; decision: FinalPacketJournalEvent;
    guards: readonly RevisionPublicationGuard[] }>) => Promise<Readonly<{ status: "published" | "conflict" | "unsupported";
      sequence?: number; actualBaseRevisionId?: string | null; reason?: string }>>;
};

const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const json = (value: unknown) => JSON.stringify(value);
const equal = (left: unknown, right: unknown) => json(left) === json(right);

function cloneJson(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Approval guard must be JSON data.");
  return JSON.parse(serialized) as JsonValue;
}

function oid(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

function hostAdvertisesGitRefCas(value: unknown): boolean {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 3 || !["state", "contractVersion", "operations"].every(key => keys.includes(key))) return false;
    const field = (key: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError();
      return descriptor.value as unknown;
    };
    if (field("state") !== "reported" || field("contractVersion") !== "1.0") return false;
    const operations = field("operations");
    if (!Array.isArray(operations) || Object.getPrototypeOf(operations) !== Array.prototype || operations.length > 128
      || Reflect.ownKeys(operations).length !== operations.length + 1) return false;
    const seen = new Set<string>();
    for (let index = 0; index < operations.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(operations, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string"
        || descriptor.value.length > 80 || !/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/u.test(descriptor.value)
        || seen.has(descriptor.value)) return false;
      seen.add(descriptor.value);
    }
    return seen.has("state.guardedGitRefCompareAndSetV1");
  } catch { return false; }
}

function currentManagerPins(read: CurrentManagerRead) {
  if (read.status !== "available") throw new Error("The current Manager packet is unavailable or stale.");
  const candidate = read.packet.evidence.candidate;
  if (!candidate || typeof candidate.sourceId !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(candidate.sourceId)
    || typeof candidate.folderKey !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(candidate.folderKey)
    || typeof candidate.branch !== "string" || !candidate.branch || !oid(candidate.commitSha) || !oid(candidate.treeSha)
    || candidate.commitSha.length !== candidate.treeSha.length) throw new Error("The exact current Manager Git source tuple is unavailable.");
  return { sourceId: candidate.sourceId, folderKey: candidate.folderKey, branch: candidate.branch,
    commitSha: candidate.commitSha, treeSha: candidate.treeSha, eventId: read.eventId,
    packetRevisionId: read.packetRevisionId, packetSha256: read.packet.sha256 };
}

function validateSnapshot(snapshot: FinalEvidenceSnapshot, workspaceId: string, projectId: string, expectedSha256: string) {
  if (!snapshot || snapshot.workspaceId !== workspaceId || snapshot.projectId !== projectId
    || snapshot.provenance?.adapter !== "builder.final-packet-current-evidence.v1"
    || snapshot.provenance.operation !== "readCurrent" || !snapshot.packet
    || snapshot.integrationCodeAuthority !== "verified" || snapshot.hostRuntimeAuthority !== "verified"
    || snapshot.g6 !== "PASS" || snapshot.g7 !== "PASS" || snapshot.qa !== "PASS"
    || !oid(snapshot.packet.integration.commitSha)
    || !(snapshot.commitObjectBytes instanceof Uint8Array)
    || finalPacketPinsDigest(snapshot.packet) !== snapshot.currentPinsSha256
    || hash(json(snapshot)) !== expectedSha256) throw new Error("Raw Final Packet evidence changed or is not current.");
  const commitBytes = snapshot.commitObjectBytes;
  const algorithm = snapshot.packet.integration.commitSha.length === 40 ? "sha1" : "sha256";
  const commitHash = createHash(algorithm).update(Buffer.from(`commit ${commitBytes.byteLength}\0`, "ascii")).update(commitBytes).digest("hex");
  const body = { ...snapshot.packet } as Record<string, unknown>;
  delete body.packetSha256;
  if (commitHash !== snapshot.packet.integration.commitSha || hash(json(body)) !== snapshot.packet.packetSha256
    || !Array.isArray(snapshot.fileBytes) || snapshot.fileBytes.length !== snapshot.packet.files.length) {
    throw new Error("Raw Final Packet bytes do not match the packet pins.");
  }
  const bytesByPath = new Map<string, Uint8Array>();
  for (const item of snapshot.fileBytes) {
    if (!item || typeof item.path !== "string" || !(item.bytes instanceof Uint8Array) || bytesByPath.has(item.path)) {
      throw new Error("Final Packet file byte inventory is malformed.");
    }
    bytesByPath.set(item.path, item.bytes);
  }
  for (const file of snapshot.packet.files) {
    const bytes = bytesByPath.get(file.path);
    if (!bytes || bytes.byteLength !== file.size) {
      throw new Error("Final Packet file bytes are incomplete.");
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== file.sha256) throw new Error("Final Packet file bytes do not match their SHA-256 pins.");
  }
}

function pointerRevisionId(value: unknown): string | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid final-delivery journal head.");
  const descriptor = Object.getOwnPropertyDescriptor(value, "revisionId");
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string") {
    throw new TypeError("Invalid final-delivery journal head.");
  }
  return descriptor.value;
}

function createTrackedPlatform(platform: SpsPlatformInvocationContext, workspaceId: string,
  finalHeadKey: string, guardsByIdentity: Map<string, RevisionPublicationGuard>): SpsPlatformInvocationContext {
  const state = platform.state as typeof platform.state & RevisionState;
  const trackedState = { ...state, async get(key: SpsStateKey) {
    if (key.scopeKind !== "company" || key.scopeId !== workspaceId) throw new Error("Final approval evidence escaped its Workspace.");
    const value = await state.get(key);
    if (value !== null && !key.stateKey.includes("-revision.v1.") && key.stateKey !== finalHeadKey) {
      const identity = JSON.stringify([key.namespace ?? "default", key.stateKey]);
      const guard = { stateKey: key.stateKey, ...(key.namespace === undefined ? {} : { namespace: key.namespace }),
        expectedValue: cloneJson(value) };
      const prior = guardsByIdentity.get(identity);
      if (prior && !equal(prior.expectedValue, guard.expectedValue)) throw new Error("Mutable Final Packet evidence changed during the read.");
      guardsByIdentity.set(identity, guard);
    }
    return value;
  } };
  return { ...platform, state: trackedState };
}

/**
 * Reuses the existing final-delivery journal. Its immutable revision staging
 * remains unchanged; only the head CAS is routed through Core's user/Git guard.
 */
export function createFinalPacketAtomicApprovalCommitter(workspaceId: string, projectId: string,
  platform: SpsPlatformInvocationContext, hostSupport: unknown,
  trustedDependencies: TrustedAtomicApprovalDependencies = {}): FinalAtomicApprovalCommitter | undefined {
  if (!workspaceId || !projectId || workspaceId !== projectId) throw new TypeError("Final approval requires the authenticated Workspace project.");
  if (!hostAdvertisesGitRefCas(hostSupport)) return undefined;
  const rawState = platform.state as typeof platform.state & RevisionState;
  const stateKey = `final-delivery-head.v1.${hash(projectId)}`;
  return async input => {
    if (input.workspaceId !== workspaceId || input.projectId !== projectId || !input.requestId
      || !oid(input.requestSnapshotSha256) || !oid(input.currentSnapshotSha256)) throw new TypeError("Invalid exact Final Packet approval scope.");
    const decision = input.decision;
    if (decision.kind !== "user-decision" || decision.requestId !== input.requestId
      || decision.expectedBaseRevisionId !== input.expectedJournalRevisionId || decision.decision?.action !== "approve"
      || !decision.decision.userId || decision.decision.sourceSnapshotSha256 !== input.currentSnapshotSha256) {
      throw new TypeError("Only the exact authenticated approve decision can use the atomic writer.");
    }
    const publishedDecision = async () => {
      const history = await createFinalPacketStore(workspaceId, projectId, rawState).current();
      return history.revisions.find(item => item.revision.eventId === decision.eventId) ?? null;
    };
    const prior = await publishedDecision();
    if (prior) {
      if (!equal(prior.revision, decision)) throw new Error("Approval event ID is already bound to different immutable content.");
      return { status: "published", sequence: prior.sequence };
    }

    const guardsByIdentity = new Map<string, RevisionPublicationGuard>();
    const finalHeadKey = stateKey;
    const trackedPlatform = createTrackedPlatform(platform, workspaceId, finalHeadKey, guardsByIdentity);
    const readEvidence = trustedDependencies.readCurrentEvidence ?? createCurrentFinalEvidenceReader(workspaceId, trackedPlatform);
    const readManager = trustedDependencies.readCurrentManagerPacket ?? ((selected: SpsPlatformInvocationContext) =>
      readCurrentIntegrationPacket(workspaceId, selected));
    const [rawEvidence, manager] = await Promise.all([readEvidence(trackedPlatform), readManager(trackedPlatform)]);
    if (rawEvidence.status !== "available") throw new Error("Current raw Final Packet evidence is UNKNOWN.");
    validateSnapshot(rawEvidence.value, workspaceId, projectId, input.currentSnapshotSha256);
    if (manager.status !== "available") throw new Error("The current Manager packet is unavailable or stale.");
    const managerPins = currentManagerPins(manager);
    if (managerPins.commitSha !== rawEvidence.value.packet.integration.commitSha
      || managerPins.branch !== rawEvidence.value.packet.integration.branch) throw new Error("Current Manager packet and Final Packet Git pins disagree.");

    const state = trackedPlatform.state as typeof trackedPlatform.state & RevisionState;
    const journal = createFinalPacketStore(workspaceId, projectId, state) as AtomicApprovalStore;
    const history = await journal.current();
    const latest = history.revisions[0]?.revision;
    if (!latest || latest.kind !== "approval-request" || latest.eventId !== input.expectedJournalRevisionId
      || latest.requestId !== input.requestId || !latest.request
      || latest.request.snapshotSha256 !== input.requestSnapshotSha256
      || latest.request.snapshotSha256 !== input.currentSnapshotSha256
      || latest.request.packet.packetRevisionId !== rawEvidence.value.packet.packetRevisionId
      || latest.request.packet.packetSha256 !== rawEvidence.value.packet.packetSha256
      || latest.request.currentPinsSha256 !== rawEvidence.value.currentPinsSha256) return { status: "stale" };
    const attestation = history.revisions.find(item => item.revision.kind === "main-attestation"
      && item.revision.eventId === latest.request!.attestationEventId)?.revision;
    if (!attestation?.attestation?.mainReview || attestation.requestId !== input.requestId
      || attestation.attestation.snapshotSha256 !== latest.request.snapshotSha256
      || attestation.attestation.currentPinsSha256 !== rawEvidence.value.currentPinsSha256
      || attestation.attestation.packet.packetSha256 !== rawEvidence.value.packet.packetSha256) return { status: "stale" };

    const managerEvent = history.revisions.find(item => item.revision.kind === "manager-packet"
      && item.revision.eventId === managerPins.eventId)?.revision;
    if (!managerEvent?.managerPacket || managerEvent.requestId !== managerPins.packetRevisionId
      || managerEvent.managerPacket.sha256 !== managerPins.packetSha256
      || !equal(managerEvent.managerPacket.evidence.candidate, manager.packet.evidence.candidate)) return { status: "stale" };

    const guards = [...guardsByIdentity.values()];
    if (!guards.length || guards.length > 64 || Buffer.byteLength(json(guards), "utf8") > 200_000) {
      throw new Error("Atomic approval state-head guard set is unavailable or exceeds its bound.");
    }
    for (const guard of guards) {
      const current = await rawState.get({ scopeKind: "company", scopeId: workspaceId,
        ...(guard.namespace === undefined ? {} : { namespace: guard.namespace }), stateKey: guard.stateKey });
      if (current === null || !equal(current, guard.expectedValue)) return { status: "stale" };
    }
    const rawHead = await rawState.get({ scopeKind: "company", scopeId: workspaceId, namespace: "sonpark.my-builder", stateKey });
    if (pointerRevisionId(rawHead) !== input.expectedJournalRevisionId) return { status: "stale" };

    const guardedState = { ...state, guardedCompareAndSet: async (key: Parameters<NonNullable<RevisionState["guardedCompareAndSet"]>>[0],
      expected: Parameters<NonNullable<RevisionState["guardedCompareAndSet"]>>[1], value: JsonValue) => {
      const call = (platform.state as typeof platform.state & GuardedGitRefState).guardedGitRefCompareAndSetV1;
      if (typeof call !== "function") throw new Error("Core guarded Git-ref approval operation is unsupported; no plain-CAS fallback is permitted.");
      const request: GuardedGitRefInput = { ...key, sourceId: managerPins.sourceId, folderKey: managerPins.folderKey,
        branch: managerPins.branch, expectedCommit: managerPins.commitSha, expectedTree: managerPins.treeSha,
        expected, value, guards: guards.map(guard => ({ ...guard })) };
      const result = await call.call(platform.state, request);
      if (result.status === "committed") {
        if (result.proof.sourceId !== managerPins.sourceId || result.proof.folderKey !== managerPins.folderKey
          || result.proof.branch !== managerPins.branch || result.proof.commitSha !== managerPins.commitSha
          || result.proof.treeSha !== managerPins.treeSha) throw new Error("Core returned a mismatched Git-ref commit proof.");
        return { status: "committed" as const };
      }
      if (result.status === "conflict") return { status: "conflict" as const };
      throw new Error(`Core guarded Git-ref approval did not commit (${result.status}:${result.reason}).`);
    } };
    const guardedJournal = createFinalPacketStore(workspaceId, projectId, guardedState) as AtomicApprovalStore;
    if (typeof guardedJournal.publishApprovalDecisionGuarded !== "function") {
      throw new Error("The existing final-delivery journal does not expose its atomic approval writer adapter.");
    }
    try {
      const published = await guardedJournal.publishApprovalDecisionGuarded({ expectedBaseRevisionId: input.expectedJournalRevisionId,
        decision, guards });
      if (published.status === "conflict") {
        const reconciled = await publishedDecision();
        if (reconciled && equal(reconciled.revision, decision)) return { status: "published", sequence: reconciled.sequence };
        return { status: "stale" };
      }
      if (published.status !== "published" || !Number.isSafeInteger(published.sequence) || published.sequence! < 1) {
        const reason = "reason" in published ? published.reason : published.status;
        throw new Error(`Atomic approval head write is unsupported (${reason}).`);
      }
      const persisted = await publishedDecision();
      if (!persisted || persisted.sequence !== published.sequence || !equal(persisted.revision, decision)) {
        throw new Error("Atomic approval publication could not be confirmed from the existing journal.");
      }
      return { status: "published", sequence: persisted.sequence };
    } catch (error) {
      try {
        const reconciled = await publishedDecision();
        if (reconciled && equal(reconciled.revision, decision)) return { status: "published", sequence: reconciled.sequence };
      } catch { /* Preserve the original unknown outcome. */ }
      throw error;
    }
  };
}
