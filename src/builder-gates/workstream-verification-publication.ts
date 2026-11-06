import { createHash } from "node:crypto";
import type { JsonValue } from "@sonparkserver/plugin-sdk/platform";
import { parseTaskPacketBoard, taskPacketRecordDigest, type TaskPacketBoard } from "../domain/task-packets.ts";
import { createRevisionJournal, type RevisionPublicationGuard, type RevisionState } from "../solution-revision-store.ts";
import { createWorkstreamVerificationProducer, type GateProofScope } from "./workstream-verification.ts";
import { normalizeVerifiedWorkstreamSnapshot, validVerifiedWorkstreamSnapshot,
  type VerifiedSnapshotReader, type VerifiedWorkstreamSnapshot } from "./workstream-verification-consumer.ts";

export const WORKSTREAM_VERIFIED_EVENT = "builder.workstream.verified";
export const WORKSTREAM_VERIFIED_JOB = "builder.integrate-verified-workstream";
const id = /^[^\u0000-\u001f\u007f]{1,160}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

type Producer = ReturnType<typeof createWorkstreamVerificationProducer>;
type VerificationInput = Parameters<Producer["verify"]>[0];
type Verified = NonNullable<Awaited<ReturnType<Producer["verify"]>>["snapshot"]>;
type GuardBinding = RevisionPublicationGuard & Readonly<{ sourceIds: readonly string[] }>;
type WorkstreamScope = Omit<GateProofScope, "taskId">;
type TaskPin = Readonly<{ taskId: string; taskRevision: number; taskRecordSha256: string }>;
type Stored = Readonly<{
  schemaVersion: 1;
  eventId: string;
  tasks: readonly TaskPin[];
  snapshot: VerifiedWorkstreamSnapshot;
  guards: readonly GuardBinding[];
}>;

type AuthorityReader = (scope: WorkstreamScope) => Promise<
  | Readonly<{ status: "unavailable"; reason: string }>
  | Readonly<{
      status: "available";
      taskBoard: TaskPacketBoard;
      inputs: readonly Omit<VerificationInput, "eventId">[];
      readers: Parameters<typeof createWorkstreamVerificationProducer>[0];
      bindGuards(verified: readonly Verified[]): Promise<readonly GuardBinding[] | null>;
    }>
>;

function validId(value: unknown): value is string {
  return typeof value === "string" && id.test(value) && Boolean(value.trim());
}

function evidenceEventId(snapshot: VerifiedWorkstreamSnapshot, tasks: readonly TaskPin[]) {
  return "builder-verified-v1:" + hash([tasks,
    normalizeVerifiedWorkstreamSnapshot({ ...snapshot, eventId: "" })]);
}

function journal(workspaceId: string, projectId: string, workstreamId: string, state: RevisionState) {
  return createRevisionJournal(workspaceId, hash([projectId, workstreamId]), state, {
    prefix: "workstream-verification", revisionId: (value: Stored) => value.eventId,
    parse(value: unknown): Stored {
      const row = value as Stored;
      if (!row || typeof row !== "object" || Object.keys(row).length !== 5 || row.schemaVersion !== 1
        || !Array.isArray(row.tasks) || !row.tasks.length || row.tasks.length > 128
        || row.tasks.some(task => !validId(task.taskId) || !Number.isSafeInteger(task.taskRevision) || task.taskRevision < 1
          || typeof task.taskRecordSha256 !== "string" || !sha256.test(task.taskRecordSha256))
        || new Set(row.tasks.map(task => task.taskId)).size !== row.tasks.length || !validId(row.eventId)
        || !validVerifiedWorkstreamSnapshot(row.snapshot, { workspaceId, projectId, workstreamId, eventId: row.eventId })
        || row.eventId !== evidenceEventId(row.snapshot, row.tasks)
        || !guardCoverage(row.guards, row.snapshot)) throw new TypeError("Invalid published Workstream verification.");
      return row;
    },
  });
}

function guardCoverage(guards: readonly GuardBinding[], snapshot: VerifiedWorkstreamSnapshot) {
  if (!Array.isArray(guards) || guards.length < 1 || guards.length > 64) return false;
  const keys = new Set<string>(), pins = new Set(snapshot.sourcePins.map(pin => pin.sourceId));
  for (const guard of guards) {
    if (!guard || !validId(guard.stateKey) || guard.namespace !== undefined && !validId(guard.namespace)
      || !Object.hasOwn(guard, "expectedValue") || guard.expectedValue === undefined || guard.expectedValue === null
      || !Array.isArray(guard.sourceIds) || guard.sourceIds.length === 0) return false;
    const key = (guard.namespace ?? "default") + "\0" + guard.stateKey;
    if (keys.has(key)) return false;
    keys.add(key);
    for (const sourceId of guard.sourceIds) if (!pins.delete(sourceId)) return false;
  }
  return pins.size === 0;
}

/** Server-side composition only. The authority reader must resolve persisted
 * evidence and bind every source to its actual guard. No route accepts these
 * readers, expected values, or a caller-supplied verification result. */
export function createWorkstreamVerificationPublication(state: RevisionState, readAuthority?: AuthorityReader) {
  const readCurrent: VerifiedSnapshotReader = async ({ workspaceId, projectId, workstreamId, eventId }) => {
    try {
      const store = journal(workspaceId, projectId, workstreamId, state);
      const head = await store.current();
      if (!head) return { status: "unknown", reason: "verified-head-unavailable" };
      if (head.revision.eventId !== eventId) {
        return await store.publishedRevision(eventId) ? { status: "stale" }
          : { status: "unknown", reason: "verified-event-not-published" };
      }
      const after = await store.currentGuarded(head.revision.guards.map(({ stateKey, namespace, expectedValue }) => ({
        stateKey, ...(namespace === undefined ? {} : { namespace }), expectedValue,
      })));
      if (after.status === "unsupported") return { status: "unknown", reason: "atomic-current-verification-unavailable" };
      if (after.status !== "current" || after.revision.eventId !== eventId) return { status: "stale" };
      return { status: "current", snapshot: after.revision.snapshot };
    } catch { return { status: "unknown", reason: "verified-head-or-guard-read-failed" }; }
  };

  async function publish(scope: WorkstreamScope) {
    const unknown = (reason: string) => ({ status: "unknown" as const, reason });
    if (typeof state.guardedCompareAndSetWithJobWakeV1 !== "function") return unknown("atomic-verification-wake-unavailable");
    if (!readAuthority) return unknown("verification-authority-unavailable");
    const target = Object.freeze({ workspaceId: scope.workspaceId, projectId: scope.projectId,
      workstreamId: scope.workstreamId });
    if (!uuid.test(target.workspaceId) || !Object.values(target).every(validId)) return unknown("invalid-verification-scope");
    const { workspaceId, projectId, workstreamId } = target;
    const store = journal(workspaceId, projectId, workstreamId, state);
    let eventId: string | undefined;
    try {
      const head = await store.current();
      const source = await readAuthority(target);
      if (source.status !== "available") return unknown(source.reason);
      if (!source.inputs.length || source.inputs.length > 128) return unknown("workstream-task-inventory-incomplete");
      const first = source.inputs[0]!;
      const board = parseTaskPacketBoard(source.taskBoard, projectId, first.ctoId, workstreamId);
      const development = board.packets.filter(record => record.packet.kind === "development");
      if (!development.length || development.length !== source.inputs.length
        || new Set(source.inputs.map(input => input.scope.taskId)).size !== development.length) return unknown("workstream-task-inventory-incomplete");
      const verified: Verified[] = [];
      const scopedNodes = new Set<string>();
      const currentWorkstream = hash(first.workstream);
      for (const input of source.inputs) {
        if (Object.keys(target).some(key => input.scope[key as keyof WorkstreamScope] !== target[key as keyof WorkstreamScope])
          || input.ctoId !== first.ctoId || hash(input.workstream) !== currentWorkstream) {
          return unknown("verification-authority-scope-mismatch");
        }
        const task = development.find(row => row.packet.taskId === input.scope.taskId);
        if (!task || taskPacketRecordDigest(input.taskRecord as typeof task, projectId, first.ctoId, workstreamId)
          !== taskPacketRecordDigest(task, projectId, first.ctoId, workstreamId)) return unknown("workstream-task-inventory-mismatch");
        if (task.dependencyPins.some(pin => {
          const dependency = board.packets.find(record => record.packet.taskId === pin.taskId);
          return !dependency || dependency.packet.revision !== pin.revision
            || taskPacketRecordDigest(dependency, projectId, first.ctoId, workstreamId) !== pin.recordSha256;
        })) return unknown("workstream-task-dependency-stale");
        const result = await createWorkstreamVerificationProducer(source.readers).verify({ ...input, eventId: "unpublished" });
        if (result.status !== "VERIFIED" || !result.snapshot) return unknown(result.reasons[0] ?? "workstream-not-verified");
        verified.push(result.snapshot);
        for (const node of task.packet.scopeNodeIds) scopedNodes.add(node);
      }
      if (first.workstream.spec.scopeNodeIds.some(node => !scopedNodes.has(node))) return unknown("workstream-node-coverage-incomplete");
      const pins = new Map<string, VerifiedWorkstreamSnapshot["sourcePins"][number]>();
      for (const proof of verified) for (const pin of proof.sourcePins) {
        const prior = pins.get(pin.sourceId);
        if (prior && hash(prior) !== hash(pin)) return unknown("workstream-verification-source-conflict");
        pins.set(pin.sourceId, pin);
      }
      const tasks = verified.map(proof => ({ taskId: proof.taskId, taskRevision: proof.taskRevision,
        taskRecordSha256: proof.taskRecordSha256 })).sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
      const merged: VerifiedWorkstreamSnapshot = { eventId: "unpublished", workspaceId, projectId, workstreamId,
        verificationStatus: "VERIFIED", sourcePins: [...pins.values()], gateDecisions: (["G4", "G6"] as const).map(gateId => {
          const refs = new Map(verified.flatMap(proof => proof.gateDecisions.filter(gate => gate.gateId === gateId)
            .flatMap(gate => gate.evidenceRefs)).map(pin => [hash(pin), pin]));
          return { gateId, verdict: "PASS", evidenceRefs: [...refs.values()] };
        }), qaEvidence: [...new Map(verified.flatMap(proof => proof.qaEvidence).map(qa => [hash(qa), qa])).values()] };
      if (!validVerifiedWorkstreamSnapshot(merged, { workspaceId, projectId, workstreamId, eventId: "unpublished" })) return unknown("invalid-verification-result");
      eventId = evidenceEventId(merged, tasks);
      const snapshot = normalizeVerifiedWorkstreamSnapshot({ ...merged, eventId });
      const previous = await store.publishedRevision(eventId);
      if (previous) return { status: "existing" as const, eventId };
      const bindings = await source.bindGuards(verified);
      if (!bindings || !guardCoverage(bindings, snapshot)) return unknown("atomic-source-guards-incomplete");
      const guards = structuredClone(bindings).map(binding => ({
        stateKey: binding.stateKey, ...(binding.namespace === undefined ? {} : { namespace: binding.namespace }),
        expectedValue: binding.expectedValue, sourceIds: [...binding.sourceIds].sort(),
      })).sort((a, b) => {
        const key = (guard: GuardBinding) => (guard.namespace ?? "default") + "\0" + guard.stateKey;
        return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
      });
      const revision: Stored = { schemaVersion: 1, eventId, tasks, snapshot, guards };
      const { status } = await store.publishGuardedWithJobWakeV1({
        expectedBaseRevisionId: head?.revision.eventId ?? null, revision,
      }, guards.map(({ stateKey, namespace, expectedValue }) => ({
        stateKey, ...(namespace === undefined ? {} : { namespace }), expectedValue,
      })), {
        name: WORKSTREAM_VERIFIED_EVENT, eventId, jobKey: WORKSTREAM_VERIFIED_JOB,
        payload: { schemaVersion: 1, workspaceId, projectId, workstreamId, eventId } satisfies JsonValue,
      });
      return { status, eventId };
    } catch {
      return eventId ? { status: "uncertain" as const, eventId, reason: "verification-publication-unconfirmed" }
        : unknown("verification-evidence-read-failed");
    }
  }
  return Object.freeze({ publish, readCurrent });
}
