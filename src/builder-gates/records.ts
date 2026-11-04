import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { lookupCurrentTaskPacketRecord } from "./registry.ts";
import type { BuilderGateRegistry, GateAuthorityRequest, RegistryLookup, StoredChecker,
  StoredGateScope, StoredGateSource, StoredQaEvidence } from "./registry.ts";
import type { EvidencePin, GateScopeSnapshot } from "./index.ts";
import type { TaskPacketTestPlan } from "../domain/task-packets.ts";
import { createRevisionJournal, type RevisionState } from "../solution-revision-store.ts";
import { resolveGateAuthority } from "./registry.ts";
import { markHostBoundRegistry } from "./provider-brand.ts";

const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const stableJson = (value: unknown) => JSON.stringify(value);
const id = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a nonblank bounded identifier.`);
  }
  return value;
};

function row(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a plain record.`);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError(`${label} has unknown or missing fields.`);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw new TypeError(`${label}.${key} must be a data field.`);
    result[key] = field.value;
  }
  return result;
}

function denseList(value: unknown, min: number, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${label} must be a standard array.`);
  const keys = Reflect.ownKeys(value), length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < min || length > max
    || keys.length !== length + 1 || !keys.includes("length")) throw new TypeError(`${label} must be a dense bounded array.`);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw new TypeError(`${label} must contain data values.`);
    result.push(field.value);
  }
  return result;
}

function parsePin(value: unknown, label: string): EvidencePin {
  const pin = row(value, ["sourceId", "revisionId", "sha256"], label);
  if (typeof pin.sha256 !== "string" || !HASH.test(pin.sha256)) throw new TypeError(`${label}.sha256 is invalid.`);
  return Object.freeze({ sourceId: id(pin.sourceId, `${label}.sourceId`), revisionId: id(pin.revisionId, `${label}.revisionId`), sha256: pin.sha256 });
}

function parseSnapshot(value: unknown, workspaceId: string, projectId: string): GateScopeSnapshot {
  const input = row(value, ["workspaceId", "projectId", "scopeId", "revisionId", "pins"], "scope snapshot");
  if (input.workspaceId !== workspaceId || input.projectId !== projectId) throw new TypeError("Scope snapshot identity is invalid.");
  const pins = denseList(input.pins, 1, 256, "scope pins").map((pin, index) => parsePin(pin, `pins[${index}]`));
  const sourceIds = pins.map(pin => pin.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) throw new TypeError("Scope snapshot contains duplicate source IDs.");
  return Object.freeze({ workspaceId, projectId, scopeId: id(input.scopeId, "scopeId"),
    revisionId: id(input.revisionId, "revisionId"), pins: Object.freeze(pins) });
}

function parseTestPlan(value: unknown): TaskPacketTestPlan {
  const input = row(value, ["environment", "steps", "expectedResults", "passCriteria"], "TestPlan");
  const list = (field: unknown, label: string) => {
    const values = denseList(field, 1, 32, `TestPlan.${label}`);
    if (values.some(item => typeof item !== "string" || !item.trim())) throw new TypeError(`TestPlan.${label} is invalid.`);
    return Object.freeze(values as string[]);
  };
  return Object.freeze({ environment: id(input.environment, "TestPlan.environment"),
    steps: list(input.steps, "steps"), expectedResults: list(input.expectedResults, "expectedResults"),
    passCriteria: list(input.passCriteria, "passCriteria") });
}

export type BuilderGateScopeRecord = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  projectId: string;
  scopeId: string;
  revisionId: string;
  snapshot: GateScopeSnapshot;
}>;

export type CheckerImplementationRecord = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  projectId: string;
  checkerId: string;
  checkerVersion: string;
  revisionId: string;
  implementation: EvidencePin;
  admissionStatus: "unknown";
}>;

export type ProductQaRecord = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  projectId: string;
  recordId: string;
  revisionId: string;
  admissionStatus: "unverified";
  target: GateScopeSnapshot;
  task: Readonly<{ ctoId: string; workstreamId: string; taskId: string; taskRevision: number }>;
  testPlan: TaskPacketTestPlan;
  run: Readonly<{ agentId: string; sessionId: string; runId: string }>;
  command: string;
  exitCode: number;
  result: "passed" | "failed";
  artifact: Readonly<{ sourceId: string; revisionId: string; sha256: string; text: string }>;
  sourcePins: readonly EvidencePin[];
}>;

/**
 * Typed A-owned integration seam. Implementations must read current Host-owned
 * source trace and admitted product-QA dispatch records; caller assertions or
 * CAO development QA are not implementations of this contract.
 */
export type BuilderGateRegistryDependencies = Readonly<{
  lookupCurrentRevision: NonNullable<BuilderGateRegistry["lookupCurrentRevision"]>;
  lookupSource: NonNullable<BuilderGateRegistry["lookupSource"]>;
  lookupCheckerAdmission: (record: CheckerImplementationRecord) => Promise<RegistryLookup<StoredChecker>>;
  lookupProductQaAdmission: (record: ProductQaRecord) => Promise<RegistryLookup<StoredQaEvidence>>;
}>;

function parseScopeRecord(value: unknown, workspaceId: string, projectId: string, scopeId: string): BuilderGateScopeRecord {
  const input = row(value, ["schemaVersion", "workspaceId", "projectId", "scopeId", "revisionId", "snapshot"], "gate scope record");
  if (input.schemaVersion !== 1 || input.workspaceId !== workspaceId || input.projectId !== projectId
    || input.scopeId !== scopeId) throw new TypeError("Gate scope record is cross-scope or unsupported.");
  const snapshot = parseSnapshot(input.snapshot, workspaceId, projectId);
  if (snapshot.scopeId !== scopeId || snapshot.revisionId !== input.revisionId) throw new TypeError("Gate scope snapshot does not match its record.");
  return Object.freeze({ schemaVersion: 1, workspaceId, projectId, scopeId,
    revisionId: id(input.revisionId, "revisionId"), snapshot });
}

function parseCheckerRecord(value: unknown, workspaceId: string, projectId: string, checkerId: string,
  checkerVersion: string): CheckerImplementationRecord {
  const input = row(value, ["schemaVersion", "workspaceId", "projectId", "checkerId", "checkerVersion", "revisionId", "implementation", "admissionStatus"], "checker record");
  if (input.schemaVersion !== 1 || input.workspaceId !== workspaceId || input.projectId !== projectId
    || input.checkerId !== checkerId || input.checkerVersion !== checkerVersion || input.admissionStatus !== "unknown") {
    throw new TypeError("Checker record is cross-scope or unsupported.");
  }
  return Object.freeze({ schemaVersion: 1, workspaceId, projectId, checkerId, checkerVersion,
    revisionId: id(input.revisionId, "revisionId"), implementation: parsePin(input.implementation, "implementation"), admissionStatus: "unknown" });
}

function parseQaRecord(value: unknown, workspaceId: string, projectId: string, recordId: string): ProductQaRecord {
  const input = row(value, ["schemaVersion", "workspaceId", "projectId", "recordId", "revisionId", "admissionStatus", "target", "task",
    "testPlan", "run", "command", "exitCode", "result", "artifact", "sourcePins"], "product QA record");
  if (input.schemaVersion !== 1 || input.workspaceId !== workspaceId || input.projectId !== projectId || input.recordId !== recordId
    || input.admissionStatus !== "unverified") {
    throw new TypeError("Product QA record is cross-scope or unsupported.");
  }
  const task = row(input.task, ["ctoId", "workstreamId", "taskId", "taskRevision"], "QA Task Packet identity");
  if (!Number.isSafeInteger(task.taskRevision) || (task.taskRevision as number) < 1) throw new TypeError("QA Task Packet revision is invalid.");
  const run = row(input.run, ["agentId", "sessionId", "runId"], "QA run identity");
  for (const field of ["agentId", "sessionId", "runId"] as const) if (typeof run[field] !== "string" || !UUID.test(run[field] as string)) {
    throw new TypeError(`QA run ${field} must be a canonical UUID.`);
  }
  const artifact = row(input.artifact, ["sourceId", "revisionId", "sha256", "text"], "QA artifact");
  if (artifact.sourceId !== `host-run-output:${run.runId}` || artifact.revisionId !== run.runId) {
    throw new TypeError("QA artifact identity must bind the exact Host run output.");
  }
  if (typeof artifact.sha256 !== "string" || !HASH.test(artifact.sha256) || typeof artifact.text !== "string"
    || artifact.text.length > 32_768 || sha256(artifact.text) !== artifact.sha256) throw new TypeError("QA artifact hash or content is invalid.");
  if (typeof input.command !== "string" || !input.command.trim() || input.command.length > 2_048
    || !Number.isSafeInteger(input.exitCode) || (input.result !== "passed" && input.result !== "failed")
    || input.result === "passed" && input.exitCode !== 0 || input.result === "failed" && input.exitCode === 0) {
    throw new TypeError("Product QA command/result is invalid.");
  }
  const target = parseSnapshot(input.target, workspaceId, projectId);
  const sourcePins = Object.freeze(denseList(input.sourcePins, 0, 256, "QA source pins")
    .map((pin, index) => parsePin(pin, `sourcePins[${index}]`)));
  if (sourcePins.length !== target.pins.length || sourcePins.some(pin => !target.pins.some(targetPin => targetPin.sourceId === pin.sourceId
    && targetPin.revisionId === pin.revisionId && targetPin.sha256 === pin.sha256))) {
    throw new TypeError("QA source pins must match the exact target scope.");
  }
  return Object.freeze({ schemaVersion: 1, workspaceId, projectId, recordId, revisionId: id(input.revisionId, "revisionId"),
    admissionStatus: "unverified",
    target, task: Object.freeze({ ctoId: id(task.ctoId, "task.ctoId"), workstreamId: id(task.workstreamId, "task.workstreamId"),
      taskId: id(task.taskId, "task.taskId"), taskRevision: task.taskRevision as number }),
    testPlan: parseTestPlan(input.testPlan), run: Object.freeze({ agentId: run.agentId as string,
      sessionId: run.sessionId as string, runId: run.runId as string }), command: input.command, exitCode: input.exitCode as number,
    result: input.result, artifact: Object.freeze({ sourceId: id(artifact.sourceId, "artifact.sourceId"),
      revisionId: id(artifact.revisionId, "artifact.revisionId"), sha256: artifact.sha256, text: artifact.text }), sourcePins });
}

type WithoutPlatform<T> = T extends GateAuthorityRequest ? Omit<T, "platform"> : never;
export type GateLibraryAuthority = WithoutPlatform<GateAuthorityRequest>;

/** Snapshot the SDK facade once so its authority-bearing state client cannot be swapped later. */
function capturePlatform(platform: unknown): SpsPlatformInvocationContext {
  const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object"
    && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const ownData = (value: Record<string, unknown>, key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Malformed SDK facade.");
    return descriptor.value;
  };
  if (!plain(platform)) throw new TypeError("The authenticated SDK context must be a plain record.");
  const context = platform;
  if (Reflect.ownKeys(context).length !== 3 || Reflect.ownKeys(context).some(key => !["events", "state", "agents"].includes(String(key)))) {
    throw new TypeError("Malformed SDK invocation context.");
  }
  const events = ownData(context, "events"), agents = ownData(context, "agents"), stateValue = ownData(context, "state");
  if (!plain(events) || typeof ownData(events, "emit") !== "function" || !plain(agents)) {
    throw new TypeError("Malformed SDK invocation context.");
  }
  const sessions = ownData(agents, "sessions");
  if (!plain(sessions) || typeof ownData(sessions, "getRun") !== "function") throw new TypeError("Malformed SDK agent facade.");
  if (!plain(stateValue)) throw new TypeError("The SDK state facade must be a plain record.");
  const state = stateValue;
  const stateKeys = Reflect.ownKeys(state);
  if (stateKeys.some(key => !["get", "set", "delete", "compareAndSet"].includes(String(key)))
    || !["get", "set", "delete"].every(key => Object.hasOwn(state, key))
    || ["get", "set", "delete"].some(key => typeof ownData(state, key) !== "function")
    || Object.hasOwn(state, "compareAndSet") && typeof ownData(state, "compareAndSet") !== "function") {
    throw new TypeError("Malformed SDK state facade.");
  }
  const call = (name: string) => {
    const method = ownData(state, name) as (...args: unknown[]) => unknown;
    return (...args: unknown[]) => Reflect.apply(method, state, args);
  };
  const capturedState = Object.freeze({ get: call("get"), set: call("set"), delete: call("delete"),
    ...(Object.hasOwn(state, "compareAndSet") ? { compareAndSet: call("compareAndSet") } : {}) });
  return Object.freeze({ events: events as SpsPlatformInvocationContext["events"],
    state: capturedState as unknown as SpsPlatformInvocationContext["state"],
    agents: agents as unknown as SpsPlatformInvocationContext["agents"] });
}

/**
 * Host-bound, code-owned gate record library. Every read/write uses the actual
 * SDK state facade and rechecks the existing Lead or CTO authority around CAS.
 * Stored records are immutable journal revisions; publication is not approval
 * and this library is not a Host/Runner enforcement point.
 */
export function createBuilderGateRecordLibrary(workspaceId: string, projectId: string,
  platform: SpsPlatformInvocationContext, authorityRequest: GateLibraryAuthority,
  dependencies?: BuilderGateRegistryDependencies) {
  if (!UUID.test(workspaceId)) throw new TypeError("A canonical Host Workspace ID is required.");
  id(projectId, "projectId");
  const capturedPlatform = capturePlatform(platform);
  const state = capturedPlatform.state;

  const authorize = () => resolveGateAuthority({ ...authorityRequest, platform: capturedPlatform } as GateAuthorityRequest).then(authority => {
    if (authority.workspaceId !== workspaceId
      || authorityRequest.kind === "cto" && authorityRequest.projectId !== projectId
      || authorityRequest.kind === "lead" && authorityRequest.runContext !== null
        && typeof authorityRequest.runContext === "object"
        && "projectId" in authorityRequest.runContext
        && authorityRequest.runContext.projectId !== projectId) {
      throw new Error("Current Host authority does not match this Builder record scope.");
    }
    return authority;
  });
  const authorizedState = (): RevisionState => ({
    get: async key => { const authority = await authorize(); const value = await state.get(key); await authority.check(); return value; },
    compareAndSet: state.compareAndSet ? async (...args) => {
      const authority = await authorize(); const receipt = await state.compareAndSet!(...args); await authority.check(); return receipt;
    } : undefined,
  });
  const journal = <T>(kind: "gate-scope" | "gate-checker" | "gate-product-qa", logicalId: string,
    parse: (value: unknown) => T, revisionId: (value: T) => string) => {
    const scopedProjectKey = `${kind}-${sha256(`${workspaceId}\u0000${projectId}\u0000${logicalId}`)}`;
    return createRevisionJournal(workspaceId, scopedProjectKey, authorizedState(), { prefix: kind, parse, revisionId });
  };
  const publish = async <T>(store: ReturnType<typeof createRevisionJournal<T>>, expectedBaseRevisionId: string | null, revision: T) => {
    const authority = await authorize();
    const result = await store.publish({ expectedBaseRevisionId, revision });
    await authority.check();
    return result;
  };

  async function readScope(scopeIdValue: string): Promise<RegistryLookup<StoredGateScope>> {
    try {
      const scopeId = id(scopeIdValue, "scopeId");
      const found = await journal("gate-scope", scopeId, value => parseScopeRecord(value, workspaceId, projectId, scopeId), value => value.revisionId).current();
      if (!found) return { status: "missing" };
      return { status: "found", value: Object.freeze({ snapshot: found.revision.snapshot, records: Object.freeze({}) }) };
    } catch { return { status: "unavailable", reason: "current-gate-scope-unavailable-or-unauthorized" }; }
  }

  async function publishedScope(scopeIdValue: string, revisionIdValue: string): Promise<RegistryLookup<StoredGateScope>> {
    try {
      const scopeId = id(scopeIdValue, "scopeId"), revisionId = id(revisionIdValue, "revisionId");
      const found = await journal("gate-scope", scopeId, value => parseScopeRecord(value, workspaceId, projectId, scopeId), value => value.revisionId)
        .publishedRevision(revisionId);
      if (!found) return { status: "missing" };
      return { status: "found", value: Object.freeze({ snapshot: found.revision.snapshot, records: Object.freeze({}) }) };
    } catch { return { status: "unavailable", reason: "published-gate-scope-unavailable-or-unauthorized" }; }
  }

  async function readCheckerRecord(checkerIdValue: string, checkerVersionValue: string): Promise<RegistryLookup<CheckerImplementationRecord>> {
    try {
      const checkerId = id(checkerIdValue, "checkerId"), checkerVersion = id(checkerVersionValue, "checkerVersion");
      const logicalId = `${checkerId}\u0000${checkerVersion}`;
      const found = await journal("gate-checker", logicalId,
        value => parseCheckerRecord(value, workspaceId, projectId, checkerId, checkerVersion), value => value.revisionId).current();
      if (!found) return { status: "missing" };
      return { status: "found", value: found.revision };
    } catch { return { status: "unavailable", reason: "current-checker-record-unavailable-or-unauthorized" }; }
  }

  async function readApprovedChecker(checkerIdValue: string, checkerVersionValue: string): Promise<RegistryLookup<StoredChecker>> {
    const record = await readCheckerRecord(checkerIdValue, checkerVersionValue);
    if (record.status !== "found") return record;
    if (!dependencies?.lookupCheckerAdmission) return { status: "unavailable", reason: "checker-admission-and-implementation-source-proof-not-wired" };
    try {
      const authority = await authorize();
      const admitted = await dependencies.lookupCheckerAdmission(record.value);
      await authority.check();
      return admitted;
    } catch { return { status: "unavailable", reason: "checker-admission-provider-unavailable-or-unauthorized" }; }
  }

  async function publishedChecker(checkerIdValue: string, checkerVersionValue: string, revisionIdValue: string): Promise<RegistryLookup<CheckerImplementationRecord>> {
    try {
      const checkerId = id(checkerIdValue, "checkerId"), checkerVersion = id(checkerVersionValue, "checkerVersion");
      const revisionId = id(revisionIdValue, "revisionId"), logicalId = `${checkerId}\u0000${checkerVersion}`;
      const found = await journal("gate-checker", logicalId,
        value => parseCheckerRecord(value, workspaceId, projectId, checkerId, checkerVersion), value => value.revisionId)
        .publishedRevision(revisionId);
      return found ? { status: "found", value: found.revision } : { status: "missing" };
    } catch { return { status: "unavailable", reason: "published-checker-record-unavailable-or-unauthorized" }; }
  }

  async function readProductQaRecord(target: GateScopeSnapshot): Promise<RegistryLookup<ProductQaRecord>> {
    try {
      const currentTarget = parseSnapshot(target, workspaceId, projectId);
      const recordId = `${currentTarget.scopeId}\u0000${currentTarget.revisionId}`;
      const found = await journal("gate-product-qa", recordId, value => parseQaRecord(value, workspaceId, projectId, recordId), value => value.revisionId).current();
      if (!found) return { status: "missing" };
      const report = found.revision;
      if (stableJson(report.target) !== stableJson(currentTarget)) return { status: "missing" };
      if (report.task.workstreamId !== currentTarget.scopeId) return { status: "missing" };
      const packet = await lookupCurrentTaskPacketRecord(workspaceId, projectId, report.task.ctoId, report.task.workstreamId,
        report.task.taskId, authorizedState());
      if (packet.status !== "found" || packet.value.packet.kind !== "qa" || packet.value.packet.revision !== report.task.taskRevision
        || stableJson(packet.value.packet.testPlan) !== stableJson(report.testPlan)) {
        return { status: "unavailable", reason: "current-admitted-qa-task-or-test-plan-unavailable" };
      }
      const runAuthority = await authorize();
      const run = await capturedPlatform.agents.sessions.getRun(report.run.sessionId, workspaceId, report.run.runId);
      await runAuthority.check();
      const execution = run.execution;
      if (run.runId !== report.run.runId || run.status !== "succeeded" || !execution || execution.companyId !== workspaceId
        || execution.agentId !== report.run.agentId || execution.sessionId !== report.run.sessionId
        || execution.runId !== report.run.runId || execution.phase !== "succeeded" || execution.cancellationRequested
        || execution.termination === "pending" || !run.output || run.output.state !== "available"
        || sha256(run.output.text) !== report.artifact.sha256 || run.output.text !== report.artifact.text) {
        return { status: "unavailable", reason: "host-product-qa-run-or-artifact-identity-unavailable" };
      }
      return { status: "found", value: report };
    } catch { return { status: "unavailable", reason: "product-qa-record-unavailable-or-unauthorized" }; }
  }

  async function readProductQa(target: GateScopeSnapshot): Promise<RegistryLookup<StoredQaEvidence>> {
    const record = await readProductQaRecord(target);
    if (record.status !== "found") return record;
    if (!dependencies?.lookupProductQaAdmission) return { status: "unavailable", reason: "product-qa-dispatch-admission-and-source-trace-not-wired" };
    try {
      const authority = await authorize();
      const admitted = await dependencies.lookupProductQaAdmission(record.value);
      await authority.check();
      return admitted;
    } catch { return { status: "unavailable", reason: "product-qa-admission-provider-unavailable-or-unauthorized" }; }
  }

  async function publishedProductQa(targetValue: GateScopeSnapshot, revisionIdValue: string): Promise<RegistryLookup<ProductQaRecord>> {
    try {
      const target = parseSnapshot(targetValue, workspaceId, projectId);
      const recordId = `${target.scopeId}\u0000${target.revisionId}`, revisionId = id(revisionIdValue, "revisionId");
      const found = await journal("gate-product-qa", recordId,
        value => parseQaRecord(value, workspaceId, projectId, recordId), value => value.revisionId).publishedRevision(revisionId);
      if (!found || stableJson(found.revision.target) !== stableJson(target)) return { status: "missing" };
      return { status: "found", value: found.revision };
    } catch { return { status: "unavailable", reason: "published-product-qa-record-unavailable-or-unauthorized" }; }
  }

  async function lookupStoredQaArtifact(sourceId: string, scopeId: string, revisionId: string): Promise<RegistryLookup<StoredGateSource>> {
    const scope = await readScope(scopeId);
    if (scope.status !== "found") return scope;
    const record = await readProductQaRecord(scope.value.snapshot);
    if (record.status !== "found") return record;
    const artifact = record.value.artifact;
    if (artifact.sourceId !== sourceId || artifact.revisionId !== revisionId) return { status: "missing" };
    return { status: "found", value: Object.freeze({ sourceId, scopeId, revisionId,
      bytes: new TextEncoder().encode(artifact.text) }) };
  }

  const registry: BuilderGateRegistry = markHostBoundRegistry(Object.freeze({
    lookupCurrentScope: (workspace, project, scope) => workspace === workspaceId && project === projectId
      ? readScope(scope) : Promise.resolve({ status: "missing" as const }),
    lookupChecker: readApprovedChecker,
    lookupIndependentQa: readProductQa,
    // A owns source trace/sourceId binding and shared callers. Never fabricate
    // an original-source lookup from a pin or from this record journal.
    lookupSource: async (sourceId, scopeId, revisionId): Promise<RegistryLookup<StoredGateSource>> => {
      try {
        if (sourceId.startsWith("host-run-output:")) {
          const report = await lookupStoredQaArtifact(sourceId, scopeId, revisionId);
          if (report.status === "found" || report.status === "unavailable") return report;
        }
        if (!dependencies?.lookupSource) return { status: "unavailable", reason: "a-owned-original-source-trace-not-wired" };
        const authority = await authorize(); const found = await dependencies.lookupSource(sourceId, scopeId, revisionId);
        await authority.check(); return found;
      } catch { return { status: "unavailable", reason: "source-trace-provider-unavailable-or-unauthorized" }; }
    },
    lookupCurrentRevision: async (scopeId, expected): Promise<RegistryLookup<EvidencePin>> => {
      if (!dependencies?.lookupCurrentRevision) return { status: "unavailable", reason: "a-owned-current-revision-source-binding-not-wired" };
      try { const authority = await authorize(); const found = await dependencies.lookupCurrentRevision(scopeId, expected);
        await authority.check(); return found; }
      catch { return { status: "unavailable", reason: "current-revision-source-binding-unavailable-or-unauthorized" }; }
    },
    resolveAuthority: request => resolveGateAuthority({ ...request, platform: capturedPlatform } as GateAuthorityRequest),
  }));

  return Object.freeze({
    registry,
    limitations: Object.freeze([
      "Gate scope snapshots, checker identity/version records, and product QA observations are persisted in Builder CAS journals; publishing them does not approve them.",
      "Checker approval and implementation source bytes require BuilderGateRegistryDependencies.lookupCheckerAdmission and lookupSource.",
      "Product QA is an actual Host run observation bound to the current QA Task Packet/TestPlan and exact output; independent admission requires lookupProductQaAdmission.",
      "Original source pins and current approved revision identity require A-owned lookupSource and lookupCurrentRevision dependencies.",
      "No shared Lead/CTO/QA caller is wired here; A must call this library at its existing publication/dispatch paths.",
    ]),
    async publishScope(expectedBaseRevisionId: string | null, snapshot: GateScopeSnapshot) {
      const parsed = parseSnapshot(snapshot, workspaceId, projectId);
      const store = journal("gate-scope", parsed.scopeId, value => parseScopeRecord(value, workspaceId, projectId, parsed.scopeId), value => value.revisionId);
      const revision: BuilderGateScopeRecord = Object.freeze({ schemaVersion: 1, workspaceId, projectId,
        scopeId: parsed.scopeId, revisionId: parsed.revisionId, snapshot: parsed });
      return publish(store, expectedBaseRevisionId, revision);
    },
    async publishChecker(expectedBaseRevisionId: string | null,
      value: Omit<CheckerImplementationRecord, "schemaVersion" | "workspaceId" | "projectId" | "admissionStatus">) {
      const checkerId = id(value.checkerId, "checkerId"), checkerVersion = id(value.checkerVersion, "checkerVersion");
      const logicalId = `${checkerId}\u0000${checkerVersion}`;
      const store = journal("gate-checker", logicalId, record => parseCheckerRecord(record, workspaceId, projectId, checkerId, checkerVersion), record => record.revisionId);
      const revision = parseCheckerRecord({ schemaVersion: 1, workspaceId, projectId, ...value, admissionStatus: "unknown" },
        workspaceId, projectId, checkerId, checkerVersion);
      return publish(store, expectedBaseRevisionId, revision);
    },
    async publishProductQa(expectedBaseRevisionId: string | null,
      value: Omit<ProductQaRecord, "schemaVersion" | "workspaceId" | "projectId" | "admissionStatus">) {
      const target = parseSnapshot(value.target, workspaceId, projectId);
      const recordId = `${target.scopeId}\u0000${target.revisionId}`;
      const store = journal("gate-product-qa", recordId, record => parseQaRecord(record, workspaceId, projectId, recordId), record => record.revisionId);
      const revision = parseQaRecord({ schemaVersion: 1, workspaceId, projectId, ...value, admissionStatus: "unverified", target },
        workspaceId, projectId, recordId);
      if (revision.task.workstreamId !== target.scopeId) throw new Error("Product QA Task Packet is outside the target Workstream scope.");
      // Confirm this is a real current QA TestPlan and a Host-owned successful
      // run before persisting. No CAO worker/test result is accepted here.
      const packet = await lookupCurrentTaskPacketRecord(workspaceId, projectId, revision.task.ctoId, revision.task.workstreamId,
        revision.task.taskId, authorizedState());
      if (packet.status !== "found" || packet.value.packet.kind !== "qa"
        || packet.value.packet.revision !== revision.task.taskRevision
        || stableJson(packet.value.packet.testPlan) !== stableJson(revision.testPlan)) {
        throw new Error("Product QA must bind the exact current QA Task Packet and CTO TestPlan.");
      }
      const runAuthority = await authorize();
      const run = await capturedPlatform.agents.sessions.getRun(revision.run.sessionId, workspaceId, revision.run.runId);
      await runAuthority.check();
      const execution = run.execution;
      if (run.runId !== revision.run.runId || run.status !== "succeeded" || !execution || execution.companyId !== workspaceId
        || execution.agentId !== revision.run.agentId || execution.sessionId !== revision.run.sessionId
        || execution.runId !== revision.run.runId || execution.phase !== "succeeded" || execution.cancellationRequested
        || execution.termination === "pending" || !run.output || run.output.state !== "available"
        || sha256(run.output.text) !== revision.artifact.sha256 || run.output.text !== revision.artifact.text) {
        throw new Error("Product QA requires the matching successful Host run and exact stored artifact output.");
      }
      return publish(store, expectedBaseRevisionId, revision);
    },
    async currentScope(scopeId: string) { return readScope(scopeId); },
    async publishedScope(scopeId: string, revisionId: string) { return publishedScope(scopeId, revisionId); },
    async currentCheckerRecord(checkerId: string, checkerVersion: string) { return readCheckerRecord(checkerId, checkerVersion); },
    async publishedChecker(checkerId: string, checkerVersion: string, revisionId: string) { return publishedChecker(checkerId, checkerVersion, revisionId); },
    async currentProductQaRecord(target: GateScopeSnapshot) { return readProductQaRecord(target); },
    async publishedProductQa(target: GateScopeSnapshot, revisionId: string) { return publishedProductQa(target, revisionId); },
  });
}

export type BuilderGateRecordLibrary = ReturnType<typeof createBuilderGateRecordLibrary>;

