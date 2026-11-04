import type {
  PluginSpsArtifact,
  PluginSpsClient,
  PluginSpsModelRun,
  PluginSpsRun,
  SpsExecution,
  SpsExecutionLane,
} from "@sonparkserver/plugin-sdk/runtime";
import type { SpsAgentSessionRunResult } from "@sonparkserver/plugin-sdk/platform";
import type { CtoDelivery } from "../domain/cto-deliveries.ts";
import type { TaskPacketRecord } from "../domain/task-packets.ts";
import { createCtoDeliveryStore, workstreamInstructionDigest } from "../cto-delivery-store.ts";
import { createTaskPacketStore } from "../task-packet-tools.ts";
import type { RevisionState } from "../solution-revision-store.ts";
import type { SpsPlatformStateClient } from "@sonparkserver/plugin-sdk/platform";

export type EvidenceStatus = "missing" | "not-run" | "failed" | "passed" | "unknown";
export type SourceRevision = Readonly<{ kind: "git-commit" | "source-manifest" | "other"; value: string }>;

export type ApprovedDeliverableContract = Readonly<{
  reference: string;
  authority: "approved" | "unknown";
  requirements: readonly Readonly<{ id: string }>[];
}>;

/** Caller claims are retained for audit but never treated as independently verified evidence. */
export type RequirementObservation = Readonly<{
  requirementId: string;
  status: EvidenceStatus;
  sourceRevision: SourceRevision;
  artifactIds: readonly string[];
  runId: string | null;
  runLane?: SpsExecutionLane | null;
  provenance: string;
}>;

export type QaObservation = Readonly<{
  targetSourceRevision: SourceRevision;
  command: string | null;
  exitCode: number | null;
  status: "not-run" | "failed" | "passed";
  observedAt: string | null;
  provenance: string;
}>;

export type DeliveryInstructions = Readonly<{
  usage: string | null;
  installation: string | null;
  knownLimits: readonly string[];
  provenance: string | null;
}>;

export type ArtifactLookupRequest = Readonly<{
  companyId: string;
  /** SDK requires this query key; until an approved scope mapping exists it is an unverified caller claim. */
  subjectKey: string;
  runId?: string;
}>;

/**
 * Plugin-owned binding written by a future approved G4 dispatch adapter. SDK
 * artifacts do not carry TaskPacket or source-revision fields, so this record
 * is the only path for a consumer to bind those identities.
 */
export type DeliveryReceipt = Readonly<{
  schemaVersion: 1;
  projectId: string;
  workstreamId: string;
  taskId: string;
  taskRevision: number;
  specRevision: number;
  sourceRevision: SourceRevision;
  companyId: string;
  pluginKey: string;
  subjectKey: string;
  runId: string;
}>;

export type DeliveryReceiptKey = Readonly<Pick<DeliveryReceipt,
  "projectId" | "workstreamId" | "taskId" | "taskRevision" | "specRevision">>;

/** Implementations must read/write plugin-owned receipt storage populated by approved dispatch. */
export interface DeliveryReceiptStore {
  record(receipt: DeliveryReceipt): Promise<void>;
  getForTask(key: DeliveryReceiptKey): Promise<DeliveryReceipt | null>;
}

export type PersistedPlanningLookup = Readonly<{
  workspaceId: string;
  projectId: string;
  ctoId: string;
  workstreamId: string;
  taskId: string;
  taskRevision: number;
  state: Pick<SpsPlatformStateClient, "get" | "compareAndSet">;
}>;

/**
 * Reads the existing published Task Packet and CTO delivery journals. A match
 * establishes planning provenance only; the current contracts contain no G4
 * Worker dispatch receipt or artifact binding.
 */
export async function readPersistedPlanningRecords(input: PersistedPlanningLookup): Promise<Readonly<{
  status: "matched" | "missing" | "mismatched";
  packet: TaskPacketRecord | null;
  delivery: CtoDelivery | null;
  provenance: "builder-state-journals";
  dispatchEvidence: "unavailable";
}>> {
  nonblank(input.workspaceId, "workspaceId");
  nonblank(input.projectId, "projectId");
  nonblank(input.ctoId, "ctoId");
  nonblank(input.workstreamId, "workstreamId");
  nonblank(input.taskId, "taskId");
  if (!Number.isSafeInteger(input.taskRevision) || input.taskRevision < 1) throw new TypeError("taskRevision must be a positive safe integer.");
  const state: RevisionState = { get: key => input.state.get(key), compareAndSet: input.state.compareAndSet
    ? (key, expected, value) => input.state.compareAndSet!(key, expected, value) : undefined };
  const [packetBoard, currentDelivery] = await Promise.all([
    createTaskPacketStore(input.workspaceId, input.projectId, input.ctoId, input.workstreamId, state).current(),
    createCtoDeliveryStore(input.workspaceId, input.projectId, input.ctoId, state).current(),
  ]);
  const packet = packetBoard?.revision.packets.find(row => row.packet.taskId === input.taskId
    && row.packet.revision === input.taskRevision) ?? null;
  const otherTaskRevisionExists = packetBoard?.revision.packets.some(row => row.packet.taskId === input.taskId) ?? false;
  const delivery = currentDelivery?.revision ?? null;
  if (!packet || !delivery) return Object.freeze({ status: otherTaskRevisionExists || (packet !== null && delivery === null) ? "mismatched" : "missing",
    packet, delivery, provenance: "builder-state-journals", dispatchEvidence: "unavailable" });
  const linked = packet.packet.projectId === input.projectId && packet.packet.ctoId === input.ctoId
    && packet.packet.workstreamId === input.workstreamId
    && delivery.projectId === input.projectId && delivery.ctoId === input.ctoId
    && delivery.instruction.spec.id === input.workstreamId
    && packet.source.workstreamId === input.workstreamId
    && packet.source.specRevision === delivery.instruction.spec.revision
    && packet.source.requestId === delivery.requestId
    && packet.source.instructionSha256 === workstreamInstructionDigest(delivery.instruction);
  return Object.freeze({ status: linked ? "matched" : "mismatched", packet, delivery,
    provenance: "builder-state-journals", dispatchEvidence: "unavailable" });
}

export type DeliveryEvidenceInput = Readonly<{
  packet: TaskPacketRecord;
  delivery?: CtoDelivery | null;
  /** Claimed identity only: the available SDK has no source revision lookup. */
  sourceRevision: SourceRevision;
  contract?: ApprovedDeliverableContract | null;
  /** Distinguishes an unavailable lookup from a confirmed absence when no contract row exists. */
  contractAuthority?: "missing" | "unknown";
  observations?: readonly RequirementObservation[];
  artifactLookup?: ArtifactLookupRequest | null;
  /** SDK execution history is company-scoped; this ID remains an invocation claim. */
  executionCompanyId?: string | null;
  qa?: QaObservation | null;
  instructions?: DeliveryInstructions | null;
}>;

export type DeliveryEvidenceManifest = Readonly<{
  schemaVersion: 1;
  enforcement: "none";
  sourceRevision: SourceRevision;
  sourceRevisionVerification: "unknown";
  scope: Readonly<{
    projectId: string;
    workstreamId: string;
    taskId: string;
    taskRevision: number;
    specRevision: number;
    verification: "typed-record-only";
  }>;
  taskPacket: Readonly<{
    source: TaskPacketRecord["source"];
    author: TaskPacketRecord["author"];
    testPlan: TaskPacketRecord["packet"]["testPlan"];
  }>;
  ctoDelivery: null | Readonly<{
    revisionId: string;
    requestId: string;
    runId: string | null;
    phase: CtoDelivery["phase"];
    outputState: CtoDelivery["outputState"];
  }>;
  contract: Readonly<{ reference: string | null; authority: "missing" | "unknown" | "approved" }>;
  deliverables: readonly Readonly<{
    requirementId: string;
    status: EvidenceStatus;
    claim: null | Readonly<{
      status: EvidenceStatus;
      sourceRevision: SourceRevision;
      artifactIds: readonly string[];
      runId: string | null;
      runLane: SpsExecutionLane | null;
      provenance: string;
    }>;
    artifactIds: readonly string[];
    bindingStatus: "unknown";
    provenance: string | null;
  }>[];
  artifacts: readonly Readonly<{
    id: string;
    subjectKey: string;
    runId: string | null;
    title: string;
    kind: string;
    referenceUrl: string | null;
    summary: string | null;
    provenance: "sdk-artifact-list";
    scopeVerification: "unknown";
  }>[];
  artifactLookup: Readonly<{
    status: "not-run" | "observed" | "unknown";
    subjectKeyClaim: string | null;
    runIdClaim: string | null;
    provenance: "sdk-artifact-list" | null;
    failure: "provider-error" | "ambiguous-artifact-id" | null;
  }>;
  receipt: Readonly<{ status: "not-requested" | "missing" | "mismatched" | "unknown"; runId: string | null }>;
  readiness: Readonly<{
    status: "unknown" | "incomplete" | "ready";
    requiredBinding: "unknown" | "incomplete" | "complete";
    independentQa: "unknown" | "missing" | "passed";
    reasons: readonly string[];
  }>;
  runLookups: readonly Readonly<{
    runId: string;
    lane: SpsExecutionLane | null;
    status: "not-requested" | "not-found" | "looked-up" | "unknown";
    subjectKey: string | null;
    provenance: "sdk-execution-history" | null;
  }>[];
  instructions: Readonly<{
    usage: string | null;
    installation: string | null;
    knownLimits: readonly string[];
    provenance: string | null;
  }>;
  qa: Readonly<{
    status: EvidenceStatus;
    claim: null | Readonly<{
      status: QaObservation["status"];
      targetSourceRevision: SourceRevision;
      command: string | null;
      exitCode: number | null;
      observedAt: string | null;
      provenance: string;
    }>;
    independentlyVerified: false;
  }>;
}>;

export type RunEvidence = Readonly<{
  lane: "node" | "agent_session" | "model_request";
  runId: string;
  status: string;
  executionOutcome: EvidenceStatus;
  startedAt: string | null;
  finishedAt: string | null;
  failure: Readonly<{
    error: string | null;
    errorCode: string | null;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean | null;
  }>;
  cancellationRequested: boolean | null;
  termination: "not_applicable" | "pending" | "confirmed" | "unknown";
  resume: "unsupported";
}>;

function nonblank(value: string, label: string): string {
  if (!value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${label} must be nonblank and contain no ASCII control characters.`);
  return value;
}

function validateRevision(value: SourceRevision, label: string): SourceRevision {
  nonblank(value.kind, `${label}.kind`);
  nonblank(value.value, `${label}.value`);
  if (value.kind === "git-commit" && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.value)) {
    throw new TypeError(`${label}.value must be a full lowercase Git object ID.`);
  }
  if (value.kind !== "git-commit" && value.kind !== "source-manifest" && value.kind !== "other") {
    throw new TypeError(`${label}.kind is unsupported.`);
  }
  return Object.freeze({ kind: value.kind, value: value.value });
}

function sameRevision(left: SourceRevision, right: SourceRevision): boolean {
  return left.kind === right.kind && left.value === right.value;
}

/** Reads artifacts from the installed SDK. The DTO has no source or Task Packet binding. */
export async function lookupDeliveryArtifacts(client: PluginSpsClient, request: ArtifactLookupRequest): Promise<readonly PluginSpsArtifact[]> {
  nonblank(request.companyId, "artifactLookup.companyId");
  nonblank(request.subjectKey, "artifactLookup.subjectKey");
  if (request.runId !== undefined) nonblank(request.runId, "artifactLookup.runId");
  const rows = await client.artifacts.list(request.companyId, { subjectKey: request.subjectKey, ...(request.runId ? { runId: request.runId } : {}) });
  const matches = rows.filter(row => row.companyId === request.companyId && row.subjectKey === request.subjectKey
    && (request.runId === undefined || row.runId === request.runId));
  const ids = new Set<string>();
  for (const row of matches) {
    if (ids.has(row.id)) throw new TypeError(`Artifact lookup returned ambiguous duplicate ID ${row.id}.`);
    ids.add(row.id);
  }
  return Object.freeze(matches.map(row => Object.freeze({ ...row })));
}

export async function createDeliveryEvidenceManifest(input: DeliveryEvidenceInput, client?: PluginSpsClient,
  receipts?: DeliveryReceiptStore): Promise<DeliveryEvidenceManifest> {
  const { packet } = input;
  const sourceRevision = validateRevision(input.sourceRevision, "sourceRevision");
  const scope = Object.freeze({
    projectId: nonblank(packet.packet.projectId, "packet.projectId"),
    workstreamId: nonblank(packet.packet.workstreamId, "packet.workstreamId"),
    taskId: nonblank(packet.packet.taskId, "packet.taskId"),
    taskRevision: packet.packet.revision,
    specRevision: packet.source.specRevision,
    verification: "typed-record-only" as const,
  });
  if (!Number.isSafeInteger(scope.taskRevision) || scope.taskRevision < 1
    || !Number.isSafeInteger(scope.specRevision) || scope.specRevision < 1) {
    throw new TypeError("Task Packet revisions must be positive safe integers.");
  }

  const delivery = input.delivery ?? null;
  if (delivery && (delivery.projectId !== scope.projectId
    || delivery.instruction.spec.id !== scope.workstreamId
    || delivery.instruction.spec.revision !== scope.specRevision)) {
    throw new TypeError("CTO delivery does not match the Task Packet project, Workstream, and specification revision.");
  }

  const contract = input.contract ?? null;
  const authority = contract === null ? input.contractAuthority ?? "missing" : contract.authority;
  const reference = contract === null ? null : nonblank(contract.reference, "contract.reference");
  const requirements = authority === "approved" ? contract?.requirements ?? [] : [];
  const requirementIds = new Set<string>();
  for (const requirement of requirements) {
    const id = nonblank(requirement.id, "contract requirement id");
    if (requirementIds.has(id)) throw new TypeError("Contract requirement IDs must be unique.");
    requirementIds.add(id);
  }

  const observations = input.observations ?? [];
  const observationById = new Map<string, RequirementObservation>();
  for (const observation of observations) {
    if (!requirementIds.has(observation.requirementId)) throw new TypeError("Observation references a requirement outside the supplied approved contract.");
    if (observationById.has(observation.requirementId)) throw new TypeError("Each contract requirement may have at most one observation.");
    const observedRevision = validateRevision(observation.sourceRevision, "observation.sourceRevision");
    if (!sameRevision(observedRevision, sourceRevision)) throw new TypeError("Observation source revision does not match the claimed manifest source revision.");
    nonblank(observation.provenance, "observation.provenance");
    if (!Array.isArray(observation.artifactIds) || observation.artifactIds.some(id => !id.trim())
      || new Set(observation.artifactIds).size !== observation.artifactIds.length) {
      throw new TypeError("Observation artifact IDs must be nonblank and unique.");
    }
    if (observation.runId !== null) nonblank(observation.runId, "observation.runId");
    observationById.set(observation.requirementId, observation);
  }

  const request = input.artifactLookup ?? null;
  let receipt: DeliveryReceipt | null = null;
  let receiptStatus: DeliveryEvidenceManifest["receipt"]["status"] = receipts ? "unknown" : "not-requested";
  // A receipt store is injected by the caller today. There is no trusted G4
  // producer or persisted provenance available to establish that its contents
  // came from an actual dispatch.
  let receiptClaimMatches = false;
  let artifactLookupFailure: DeliveryEvidenceManifest["artifactLookup"]["failure"] = null;
  let artifactLookupStatus: DeliveryEvidenceManifest["artifactLookup"]["status"] = request ? "unknown" : "not-run";
  let artifactQuery: ArtifactLookupRequest | null = request;
  if (receipts) {
    const key: DeliveryReceiptKey = { projectId: scope.projectId, workstreamId: scope.workstreamId, taskId: scope.taskId,
      taskRevision: scope.taskRevision, specRevision: scope.specRevision };
    try {
      receipt = await receipts.getForTask(key);
      if (receipt) {
        const recordedSource = validateRevision(receipt.sourceRevision, "receipt.sourceRevision");
        const matchesPacket = receipt.schemaVersion === 1 && receipt.projectId === key.projectId && receipt.workstreamId === key.workstreamId
          && receipt.taskId === key.taskId && receipt.taskRevision === key.taskRevision && receipt.specRevision === key.specRevision
          && sameRevision(recordedSource, sourceRevision);
        for (const [label, value] of [["receipt.companyId", receipt.companyId], ["receipt.pluginKey", receipt.pluginKey],
          ["receipt.subjectKey", receipt.subjectKey], ["receipt.runId", receipt.runId]] as const) nonblank(value, label);
        if (matchesPacket) {
          receiptClaimMatches = true;
          receiptStatus = "unknown";
          artifactQuery = { companyId: receipt.companyId, subjectKey: receipt.subjectKey, runId: receipt.runId };
        } else {
          receiptStatus = "mismatched";
          artifactQuery = null;
        }
      }
    } catch {
      receipt = null;
      receiptStatus = "unknown";
      artifactQuery = null;
    }
  }
  let lookedUpArtifacts: readonly PluginSpsArtifact[] = [];
  if (artifactQuery && client) {
    try {
      lookedUpArtifacts = await lookupDeliveryArtifacts(client, artifactQuery);
      artifactLookupStatus = "observed";
    } catch (error) {
      artifactLookupFailure = error instanceof TypeError && error.message.includes("ambiguous duplicate ID")
        ? "ambiguous-artifact-id" : "provider-error";
      artifactLookupStatus = "unknown";
    }
  } else if (artifactQuery && !client) {
    artifactLookupStatus = "unknown";
    artifactLookupFailure = "provider-error";
  }
  if (receiptClaimMatches && !client) artifactLookupStatus = "unknown";
  const artifactById = new Map(lookedUpArtifacts.map(artifact => [artifact.id, artifact]));
  const runLookups: DeliveryEvidenceManifest["runLookups"][number][] = [];
  const seenRuns = new Set<string>();
  for (const observation of observations) {
    if (observation.runId === null || seenRuns.has(observation.runId)) continue;
    seenRuns.add(observation.runId);
    const lane = observation.runLane ?? null;
    const companyId = input.executionCompanyId ?? request?.companyId ?? null;
    let execution: SpsExecution | null = null;
    let lookupStatus: DeliveryEvidenceManifest["runLookups"][number]["status"] = "not-requested";
    if (client && lane && companyId) {
      try {
        const row = await client.executions.get(companyId, lane, observation.runId);
        execution = row?.companyId === companyId && row.lane === lane && row.runId === observation.runId ? row : null;
        lookupStatus = execution ? "looked-up" : "not-found";
      } catch {
        lookupStatus = "unknown";
      }
    }
    runLookups.push(Object.freeze({ runId: observation.runId, lane,
      status: lookupStatus,
      subjectKey: execution?.subjectKey ?? null, provenance: execution ? "sdk-execution-history" : null }));
  }
  for (const observation of observations) for (const id of observation.artifactIds) {
    const artifact = artifactById.get(id);
    if (artifact && observation.runId !== null && artifact.runId !== observation.runId) artifactLookupStatus = "unknown";
  }

  const deliverables = requirements.map(requirement => {
    const claim = observationById.get(requirement.id);
    return Object.freeze({
      requirementId: requirement.id,
      // No authoritative G4 producer/evidence source is available here, so a
      // missing caller observation cannot establish that the deliverable is absent.
      status: "unknown" as const,
      claim: claim ? Object.freeze({ status: claim.status, sourceRevision: validateRevision(claim.sourceRevision, "observation.sourceRevision"),
        artifactIds: Object.freeze([...claim.artifactIds]), runId: claim.runId, runLane: claim.runLane ?? null, provenance: claim.provenance }) : null,
      artifactIds: claim ? Object.freeze([...claim.artifactIds]) : Object.freeze([] as string[]),
      bindingStatus: "unknown" as const,
      provenance: claim?.provenance ?? null,
    });
  });

  const qa = input.qa ?? null;
  let qaClaim: DeliveryEvidenceManifest["qa"]["claim"] = null;
  if (qa) {
    const target = validateRevision(qa.targetSourceRevision, "qa.targetSourceRevision");
    if (!sameRevision(target, sourceRevision)) throw new TypeError("QA target source revision does not match the claimed manifest source revision.");
    if (qa.command !== null) nonblank(qa.command, "qa.command");
    nonblank(qa.provenance, "qa.provenance");
    if (qa.status === "passed" && (qa.exitCode !== 0 || qa.command === null)) {
      throw new TypeError("A caller-reported passing QA claim requires a command and exitCode 0.");
    }
    if (qa.status === "not-run" && qa.exitCode !== null) throw new TypeError("A not-run QA claim cannot have an exit code.");
    qaClaim = Object.freeze({ status: qa.status, targetSourceRevision: target, command: qa.command,
      exitCode: qa.exitCode, observedAt: qa.observedAt, provenance: qa.provenance });
  }

  const instructions = input.instructions ?? null;
  if (instructions) {
    for (const text of [instructions.usage, instructions.installation, ...instructions.knownLimits]) {
      if (text !== null) nonblank(text, "delivery instruction");
    }
    if (instructions.provenance !== null) nonblank(instructions.provenance, "instructions.provenance");
  }

  return Object.freeze({
    schemaVersion: 1,
    enforcement: "none",
    sourceRevision,
    sourceRevisionVerification: "unknown",
    scope,
    taskPacket: Object.freeze({ source: packet.source, author: packet.author, testPlan: packet.packet.testPlan }),
    ctoDelivery: delivery === null ? null : Object.freeze({ revisionId: delivery.revisionId, requestId: delivery.requestId,
      runId: delivery.runId, phase: delivery.phase, outputState: delivery.outputState }),
    contract: Object.freeze({ reference, authority }),
    deliverables: Object.freeze(deliverables),
    artifacts: Object.freeze(lookedUpArtifacts.map(artifact => Object.freeze({ id: artifact.id, subjectKey: artifact.subjectKey,
      runId: artifact.runId, title: artifact.title, kind: artifact.kind, referenceUrl: artifact.referenceUrl,
      summary: artifact.summary, provenance: "sdk-artifact-list" as const,
      scopeVerification: "unknown" as const }))),
    artifactLookup: Object.freeze({ status: artifactLookupStatus,
      subjectKeyClaim: receiptClaimMatches ? receipt?.subjectKey ?? null : request?.subjectKey ?? null,
      runIdClaim: receiptClaimMatches ? receipt?.runId ?? null : request?.runId ?? null,
      provenance: lookedUpArtifacts.length > 0 ? "sdk-artifact-list" as const : null, failure: artifactLookupFailure }),
    receipt: Object.freeze({ status: receiptStatus, runId: receiptClaimMatches ? receipt?.runId ?? null : null }),
    readiness: (() => {
      // Receipt and artifact inputs are caller-injected claims today. Without
      // an authoritative G4 producer, neither their presence nor absence can
      // prove whether required bindings are complete or missing.
      const requiredBinding = "unknown" as const;
      // This task has no independent QA result provider or real Host integration.
      const independentQa = "unknown" as const;
      const reasons: string[] = [];
      if (authority !== "approved") reasons.push("approved-deliverable-contract-unavailable");
      if (authority === "approved" && requirements.length === 0) reasons.push("approved-requirements-empty");
      if (authority === "approved" && requirements.length > 0) reasons.push("delivery-binding-producer-unavailable");
      reasons.push("independent-qa-provider-unavailable");
      return Object.freeze({ status: "unknown" as const,
        requiredBinding, independentQa, reasons: Object.freeze(reasons) });
    })(),
    runLookups: Object.freeze(runLookups),
    instructions: Object.freeze({ usage: instructions?.usage ?? null, installation: instructions?.installation ?? null,
      knownLimits: Object.freeze([...(instructions?.knownLimits ?? [])]), provenance: instructions?.provenance ?? null }),
    qa: Object.freeze({ status: qaClaim ? "unknown" as const : "not-run" as const, claim: qaClaim, independentlyVerified: false as const }),
  });
}

function adaptExecution(execution: SpsExecution | null, lane: SpsExecutionLane, runId: string): Pick<RunEvidence, "cancellationRequested" | "termination" | "startedAt" | "finishedAt"> {
  if (!execution || execution.lane !== lane || execution.runId !== runId) return { cancellationRequested: null, termination: "unknown", startedAt: null, finishedAt: null };
  return { cancellationRequested: execution.cancellationRequested, termination: execution.termination,
    startedAt: execution.startedAt, finishedAt: execution.finishedAt };
}

export function adaptNodeRun(run: PluginSpsRun, execution: SpsExecution | null = null): RunEvidence {
  const extra = adaptExecution(execution, "node", run.id);
  const executionOutcome: EvidenceStatus = run.timedOut || run.error !== null || (run.exitCode !== null && run.exitCode !== 0)
    || run.status === "failed" ? "failed"
    : run.status === "succeeded" && run.finishedAt !== null && run.exitCode === 0 ? "passed"
      : run.startedAt === null ? "not-run" : "unknown";
  return Object.freeze({ lane: "node", runId: run.id, status: run.status, executionOutcome,
    startedAt: extra.startedAt ?? run.startedAt, finishedAt: extra.finishedAt ?? run.finishedAt,
    failure: Object.freeze({ error: run.error, errorCode: null, exitCode: run.exitCode, signal: run.signal, timedOut: run.timedOut }),
    cancellationRequested: extra.cancellationRequested, termination: extra.termination, resume: "unsupported" });
}

export function adaptAgentSessionRun(run: SpsAgentSessionRunResult): RunEvidence {
  const execution = run.execution && run.execution.lane === "agent_session" && run.execution.runId === run.runId ? run.execution : null;
  const executionOutcome: EvidenceStatus = run.error !== null || run.errorCode !== null || run.status === "failed" ? "failed"
    : run.status === "queued" || run.status === "running" ? "not-run"
      : run.status === "succeeded" && execution?.phase === "succeeded" && execution.termination === "confirmed" ? "passed" : "unknown";
  return Object.freeze({ lane: "agent_session", runId: run.runId, status: run.status, executionOutcome,
    startedAt: execution?.startedAt ?? null, finishedAt: execution?.finishedAt ?? null,
    failure: Object.freeze({ error: run.error, errorCode: run.errorCode, exitCode: null, signal: null, timedOut: null }),
    cancellationRequested: execution?.cancellationRequested ?? run.cancellationRequested,
    termination: execution?.termination ?? run.termination, resume: "unsupported" });
}

export function adaptModelRun(run: PluginSpsModelRun, execution: SpsExecution | null = null): RunEvidence {
  const matchingExecution = execution?.lane === "model_request" && execution.runId === run.id
    && execution.companyId === run.companyId ? execution : null;
  const outcome: EvidenceStatus = run.status === "failed" ? "failed"
    : run.status === "queued" || run.status === "running" ? "not-run"
      : run.status === "succeeded" && run.resultState === "available" && matchingExecution?.phase === "succeeded"
        && matchingExecution.termination === "confirmed" ? "passed" : "unknown";
  return Object.freeze({ lane: "model_request", runId: run.id, status: run.status, executionOutcome: outcome,
    startedAt: matchingExecution?.startedAt ?? run.startedAt, finishedAt: matchingExecution?.finishedAt ?? run.finishedAt,
    failure: Object.freeze({ error: null, errorCode: run.errorCode, exitCode: null, signal: null, timedOut: null }),
    cancellationRequested: matchingExecution?.cancellationRequested ?? run.cancellationRequested,
    termination: matchingExecution?.termination ?? "unknown", resume: "unsupported" });
}

/** Typed historical lookup for supported SDK lanes; null remains unknown, never a pass. */
export async function lookupExecution(client: PluginSpsClient, companyId: string, lane: SpsExecutionLane, runId: string): Promise<SpsExecution | null> {
  nonblank(companyId, "companyId");
  nonblank(runId, "runId");
  try {
    const execution = await client.executions.get(companyId, lane, runId);
    return execution?.companyId === companyId && execution.lane === lane && execution.runId === runId ? execution : null;
  } catch {
    return null;
  }
}

export { prepareCurrentDeliveryEvidence } from "./current-preparation.ts";
export type { CurrentDeliveryPreparation, CurrentDeliveryPreparationProviders } from "./current-preparation.ts";
