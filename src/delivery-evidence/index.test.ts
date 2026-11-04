import assert from "node:assert/strict";
import test from "node:test";
import type { PluginSpsArtifact, PluginSpsClient, PluginSpsModelRun, PluginSpsRun, SpsExecution } from "@sonparkserver/plugin-sdk/runtime";
import type { SpsAgentSessionRunResult } from "@sonparkserver/plugin-sdk/platform";
import type { CtoDelivery } from "../domain/cto-deliveries.ts";
import type { TaskPacketRecord } from "../domain/task-packets.ts";
import {
  adaptAgentSessionRun,
  adaptModelRun,
  adaptNodeRun,
  createDeliveryEvidenceManifest,
  lookupExecution,
  type ApprovedDeliverableContract,
  type DeliveryEvidenceInput,
  type DeliveryReceipt,
  type DeliveryReceiptKey,
  type DeliveryReceiptStore,
  type RequirementObservation,
  type SourceRevision,
} from "./index.ts";

const source: SourceRevision = { kind: "git-commit", value: "a".repeat(40) };
const packet: TaskPacketRecord = {
  packet: { projectId: "project-1", ctoId: "cto-1", workstreamId: "workstream-1", taskId: "task-1", revision: 3,
    kind: "development", title: "Implement delivery evidence", goal: "Build a typed evidence manifest",
    scopeNodeIds: ["node-1"], requirementIds: ["REQ-1"], dependencies: [], included: ["src/delivery-evidence"],
    excluded: ["Core changes"], constraints: ["No enforcement"], acceptance: ["Preserve provenance"],
    evidenceRequired: ["Actual run and artifact identity"], reuse: [],
    testPlan: { environment: "prepared Node", steps: ["run tests"], expectedResults: ["all pass"], passCriteria: ["exit 0"] } },
  source: { requestId: "a49e8013-c12c-478d-99df-854cd4257091", workstreamId: "workstream-1", specRevision: 8, instructionSha256: "b".repeat(64) },
  author: { agentId: "agent-1", sessionId: "session-1", runId: "packet-run-1" }, createdAtISO: "2026-11-04T00:00:00.000Z", dependencyPins: [],
};
const contract: ApprovedDeliverableContract = { reference: "approved-contract:rev-4", authority: "approved", requirements: [{ id: "source" }, { id: "verification" }] };
const artifact: PluginSpsArtifact = { id: "artifact-1", companyId: "company-1", pluginKey: "builder", subjectKey: "claimed-subject",
  runId: "qa-run-1", title: "QA result", kind: "test-result", referenceUrl: "https://example.invalid/artifacts/1",
  summary: "Caller claimed a passing run", data: {}, createdAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z" };

function observation(requirementId: string, status: RequirementObservation["status"], values: Partial<RequirementObservation> = {}): RequirementObservation {
  return { requirementId, status, sourceRevision: source, artifactIds: [], runId: null, provenance: "caller:qa-report", ...values };
}
function input(overrides: Partial<DeliveryEvidenceInput> = {}): DeliveryEvidenceInput { return { packet, sourceRevision: source, ...overrides }; }
function sdk(artifacts: PluginSpsArtifact[] = [artifact], execution: SpsExecution | null = null): PluginSpsClient {
  return {
    artifacts: { list: async () => artifacts },
    executions: { get: async () => execution },
  } as unknown as PluginSpsClient;
}
const receipt: DeliveryReceipt = { schemaVersion: 1, projectId: "project-1", workstreamId: "workstream-1", taskId: "task-1",
  taskRevision: 3, specRevision: 8, sourceRevision: source, companyId: "company-1", pluginKey: "builder",
  subjectKey: "approved-subject", runId: "qa-run-1" };
function receiptStore(value: DeliveryReceipt | null = receipt): DeliveryReceiptStore {
  return { record: async () => {}, getForTask: async (_key: DeliveryReceiptKey) => value };
}

test("missing contract and QA remain not-run; caller source identity is explicitly unverified", async () => {
  const manifest = await createDeliveryEvidenceManifest(input());
  assert.equal(manifest.enforcement, "none");
  assert.equal(manifest.sourceRevisionVerification, "unknown");
  assert.equal(manifest.scope.verification, "typed-record-only");
  assert.deepEqual(manifest.contract, { reference: null, authority: "missing" });
  assert.deepEqual(manifest.deliverables, []);
  assert.equal(manifest.qa.status, "not-run");
  assert.equal(manifest.qa.independentlyVerified, false);
  assert.equal(manifest.artifactLookup.status, "not-run");
});

test("forged passed observation, provenance, and command/exit zero stay claims with UNKNOWN status", async () => {
  const manifest = await createDeliveryEvidenceManifest(input({ contract,
    observations: [observation("verification", "passed", { provenance: "forged:independent-qa" })],
    qa: { targetSourceRevision: source, command: "node --test", exitCode: 0, status: "passed", observedAt: "2026-11-04T01:00:00.000Z", provenance: "forged:qa" },
  }));
  assert.equal(manifest.deliverables[1]?.status, "unknown");
  assert.equal(manifest.deliverables[1]?.claim?.status, "passed");
  assert.equal(manifest.deliverables[1]?.claim?.provenance, "forged:independent-qa");
  assert.equal(manifest.qa.status, "unknown");
  assert.deepEqual(manifest.qa.claim, { status: "passed", targetSourceRevision: source, command: "node --test", exitCode: 0,
    observedAt: "2026-11-04T01:00:00.000Z", provenance: "forged:qa" });
});

test("unknown authority does not create deliverable requirements or accept observations", async () => {
  const manifest = await createDeliveryEvidenceManifest(input({ contract: { ...contract, authority: "unknown" } }));
  assert.deepEqual(manifest.contract, { reference: "approved-contract:rev-4", authority: "unknown" });
  assert.deepEqual(manifest.deliverables, []);
});

test("wrong source, wrong contract scope, duplicate and empty provenance are rejected", async () => {
  await assert.rejects(createDeliveryEvidenceManifest(input({ contract, observations: [observation("source", "passed", {
    sourceRevision: { ...source, value: "c".repeat(40) },
  })] })), /claimed manifest source revision/u);
  await assert.rejects(createDeliveryEvidenceManifest(input({ contract, observations: [observation("outside", "passed")] })), /outside/u);
  await assert.rejects(createDeliveryEvidenceManifest(input({ contract, observations: [observation("source", "passed", { provenance: "  " })] })), /provenance/u);
  await assert.rejects(createDeliveryEvidenceManifest(input({ contract, observations: [observation("source", "passed"), observation("source", "failed")] })), /at most one/u);
  await assert.rejects(createDeliveryEvidenceManifest(input({ contract: { ...contract, requirements: [{ id: " " }] } })), /nonblank/u);
});

test("caller subject lookup is only an observation and cannot bind a deliverable", async () => {
  const manifest = await createDeliveryEvidenceManifest(input({ contract, artifactLookup: { companyId: "company-1", subjectKey: "claimed-subject", runId: "qa-run-1" },
    executionCompanyId: "company-1",
    observations: [observation("verification", "passed", { artifactIds: ["artifact-1"], runId: "qa-run-1", runLane: "model_request" })] }), sdk());
  assert.equal(manifest.artifactLookup.status, "observed");
  assert.equal(manifest.artifactLookup.subjectKeyClaim, "claimed-subject");
  assert.equal(manifest.artifacts[0]?.id, "artifact-1");
  assert.equal(manifest.artifacts[0]?.provenance, "sdk-artifact-list");
  assert.equal(manifest.artifacts[0]?.scopeVerification, "unknown");
  assert.equal(manifest.deliverables[1]?.status, "unknown");
  assert.equal(manifest.deliverables[1]?.bindingStatus, "unknown");
  assert.deepEqual(manifest.runLookups, [{ runId: "qa-run-1", lane: "model_request", status: "not-found", subjectKey: null, provenance: null }]);
  const absent = await createDeliveryEvidenceManifest(input({ contract, artifactLookup: { companyId: "company-1", subjectKey: "claimed-subject" },
    observations: [observation("verification", "passed", { artifactIds: ["absent"] })] }), sdk());
  assert.equal(absent.deliverables[1]?.bindingStatus, "unknown");
});

test("missing SDK provider and wrong artifact company/scope/run are not evidence", async () => {
  const missing = await createDeliveryEvidenceManifest(input({ artifactLookup: { companyId: "company-1", subjectKey: "claimed-subject" } }));
  assert.equal(missing.artifactLookup.status, "unknown");
  const filtered = await createDeliveryEvidenceManifest(input({ artifactLookup: { companyId: "company-1", subjectKey: "claimed-subject", runId: "qa-run-1" } }), sdk([
    { ...artifact, companyId: "other-company" }, { ...artifact, subjectKey: "wrong-subject" }, { ...artifact, runId: "wrong-run" },
  ]));
  assert.deepEqual(filtered.artifacts, []);
  const wrongRun = await createDeliveryEvidenceManifest(input({ contract, artifactLookup: { companyId: "company-1", subjectKey: "claimed-subject" },
    observations: [observation("verification", "passed", { artifactIds: ["artifact-1"], runId: "different-run" })] }), sdk());
  assert.equal(wrongRun.deliverables[1]?.bindingStatus, "unknown");
});

test("caller-injected matching receipt and artifact remain unverified claims", async () => {
  const boundArtifact = { ...artifact, subjectKey: receipt.subjectKey, pluginKey: receipt.pluginKey };
  const manifest = await createDeliveryEvidenceManifest(input({ contract, observations: [observation("verification", "passed", {
    artifactIds: [artifact.id], runId: receipt.runId,
  })] }), sdk([boundArtifact]), receiptStore());
  assert.equal(manifest.receipt.status, "unknown");
  assert.equal(manifest.receipt.runId, receipt.runId);
  assert.equal(manifest.artifactLookup.status, "observed");
  assert.equal(manifest.artifactLookup.subjectKeyClaim, receipt.subjectKey);
  assert.equal(manifest.artifactLookup.runIdClaim, receipt.runId);
  assert.equal(manifest.artifacts[0]?.scopeVerification, "unknown");
  assert.equal(manifest.deliverables[1]?.bindingStatus, "unknown");
  assert.equal(manifest.readiness.status, "unknown");
  assert.equal(manifest.readiness.requiredBinding, "unknown");
  assert.equal(manifest.readiness.independentQa, "unknown");
  assert.ok(manifest.readiness.reasons.includes("delivery-binding-producer-unavailable"));
  assert.ok(!manifest.readiness.reasons.includes("required-artifact-binding-incomplete"));
  assert.ok(manifest.readiness.reasons.includes("independent-qa-provider-unavailable"));
});

test("approved contract with no requirements keeps required binding unknown", async () => {
  const manifest = await createDeliveryEvidenceManifest(input({ contract: { ...contract, requirements: [] } }));
  assert.deepEqual(manifest.deliverables, []);
  assert.equal(manifest.readiness.requiredBinding, "unknown");
  assert.equal(manifest.readiness.status, "unknown");
  assert.ok(manifest.readiness.reasons.includes("approved-requirements-empty"));
  assert.ok(!manifest.readiness.reasons.includes("required-artifact-binding-incomplete"));
});

test("unavailable and empty injected receipt stores cannot prove missing bindings", async () => {
  const unavailable = await createDeliveryEvidenceManifest(input({ contract }));
  assert.equal(unavailable.receipt.status, "not-requested");
  assert.equal(unavailable.deliverables[0]?.status, "unknown");
  assert.equal(unavailable.readiness.status, "unknown");
  assert.equal(unavailable.readiness.requiredBinding, "unknown");

  const empty = await createDeliveryEvidenceManifest(input({ contract }), sdk(), receiptStore(null));
  assert.equal(empty.receipt.status, "unknown");
  assert.equal(empty.deliverables[0]?.status, "unknown");
  assert.equal(empty.readiness.status, "unknown");
  assert.equal(empty.readiness.requiredBinding, "unknown");
  assert.ok(empty.readiness.reasons.includes("delivery-binding-producer-unavailable"));

  const noRequirements = await createDeliveryEvidenceManifest(input({ contract: { ...contract, requirements: [] } }), sdk(), receiptStore(null));
  assert.equal(noRequirements.readiness.status, "unknown");
  assert.equal(noRequirements.readiness.requiredBinding, "unknown");
  assert.ok(noRequirements.readiness.reasons.includes("approved-requirements-empty"));
  assert.ok(!noRequirements.readiness.reasons.includes("delivery-binding-producer-unavailable"));

  const forged = await createDeliveryEvidenceManifest(input({ contract }), sdk(), receiptStore({ ...receipt, taskId: "other-task" }));
  assert.equal(forged.receipt.status, "mismatched");
  assert.equal(forged.artifactLookup.status, "not-run");
  assert.equal(forged.readiness.status, "unknown");
  assert.equal(forged.readiness.requiredBinding, "unknown");

  const stale = await createDeliveryEvidenceManifest(input({ contract }), sdk(), receiptStore({
    ...receipt, sourceRevision: { kind: "git-commit", value: "c".repeat(40) },
  }));
  assert.equal(stale.receipt.status, "mismatched");
  assert.notEqual(stale.readiness.status, "ready");
});

test("receipt artifact company, plugin, run, subject, and source mismatches cannot bind", async () => {
  for (const changed of [
    { companyId: "other-company" }, { pluginKey: "other-plugin" }, { runId: "other-run" }, { subjectKey: "other-subject" },
    ]) {
    const manifest = await createDeliveryEvidenceManifest(input({ contract, observations: [observation("verification", "passed", {
      artifactIds: [artifact.id], runId: receipt.runId,
    })] }), sdk([{ ...artifact, ...changed }]), receiptStore());
    assert.equal(manifest.deliverables[1]?.bindingStatus, "unknown");
    assert.notEqual(manifest.readiness.status, "ready");
  }
  const sourceMismatch = await createDeliveryEvidenceManifest(input({ contract, sourceRevision: { kind: "git-commit", value: "d".repeat(40) },
    observations: [observation("verification", "passed", { artifactIds: [artifact.id], runId: receipt.runId,
      sourceRevision: { kind: "git-commit", value: "d".repeat(40) } })] }), sdk([{ ...artifact, subjectKey: receipt.subjectKey }]), receiptStore());
  assert.equal(sourceMismatch.receipt.status, "mismatched");
  assert.equal(sourceMismatch.deliverables[1]?.bindingStatus, "unknown");
});

test("artifact provider exceptions and duplicate IDs fail closed as UNKNOWN", async () => {
  const broken = { artifacts: { list: async () => { throw new Error("provider unavailable"); } },
    executions: { get: async () => null } } as unknown as PluginSpsClient;
  const failed = await createDeliveryEvidenceManifest(input({ contract, artifactLookup: { companyId: "company-1", subjectKey: "caller-subject" } }), broken);
  assert.equal(failed.artifactLookup.status, "unknown");
  assert.equal(failed.artifactLookup.failure, "provider-error");
  const duplicate = await createDeliveryEvidenceManifest(input({ contract, artifactLookup: { companyId: "company-1", subjectKey: "claimed-subject" } }), sdk([artifact, artifact]));
  assert.equal(duplicate.artifactLookup.status, "unknown");
  assert.equal(duplicate.artifactLookup.failure, "ambiguous-artifact-id");
  assert.deepEqual(duplicate.artifacts, []);
  const receiptFailure = { ...receiptStore(), getForTask: async () => { throw new Error("receipt store unavailable"); } };
  const noReceipt = await createDeliveryEvidenceManifest(input({ contract }), sdk(), receiptFailure);
  assert.equal(noReceipt.receipt.status, "unknown");
  assert.equal(noReceipt.readiness.status, "unknown");
  assert.equal(noReceipt.readiness.requiredBinding, "unknown");
});

test("CTO delivery project, Workstream, and spec revision must match Task Packet", async () => {
  const delivery = { projectId: "project-1", revisionId: "delivery-rev", requestId: "request-1", runId: "run-1", phase: "succeeded",
    outputState: "available", instruction: { spec: { id: "workstream-1", revision: 8 } } } as unknown as CtoDelivery;
  assert.equal((await createDeliveryEvidenceManifest(input({ delivery }))).ctoDelivery?.revisionId, "delivery-rev");
  await assert.rejects(createDeliveryEvidenceManifest(input({ delivery: { ...delivery, instruction: { spec: { id: "other", revision: 8 } } } as unknown as CtoDelivery })), /does not match/u);
  await assert.rejects(createDeliveryEvidenceManifest(input({ delivery: { ...delivery, instruction: { spec: { id: "workstream-1", revision: 9 } } } as unknown as CtoDelivery })), /does not match/u);
});

test("Node run failures and lifecycle are retained; resume stays unsupported", () => {
  const base: PluginSpsRun = { id: "run-1", companyId: "company-1", pluginKey: "builder", subjectKey: "task-1", executionGrantId: "grant-1",
    nodeId: "node-1", runnerProfileId: "runner-1", workspaceSourceId: null, status: "running", exitCode: null, signal: null,
    timedOut: false, error: null, claimedAt: "2026-11-04T00:00:00.000Z", startedAt: "2026-11-04T00:00:01.000Z", finishedAt: null,
    createdAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:01.000Z" };
  assert.equal(adaptNodeRun(base).executionOutcome, "unknown");
  assert.equal(adaptNodeRun(base).resume, "unsupported");
  const passed = adaptNodeRun({ ...base, status: "succeeded", exitCode: 0, finishedAt: "2026-11-04T00:00:02.000Z" });
  assert.equal(passed.executionOutcome, "passed");
  const failed = adaptNodeRun({ ...base, status: "failed", exitCode: 17, error: "runner failed", timedOut: true });
  assert.equal(failed.executionOutcome, "failed");
  assert.equal(failed.failure.exitCode, 17);
  assert.equal(failed.failure.timedOut, true);
});

test("agent success without execution details stays unknown; cancellation and stop state remain visible", () => {
  const noDetails: SpsAgentSessionRunResult = { runId: "agent-run-1", status: "succeeded", cancellationRequested: false,
    termination: "confirmed", errorCode: null, error: null };
  assert.equal(adaptAgentSessionRun(noDetails).executionOutcome, "unknown");
  const stopped: SpsAgentSessionRunResult = { ...noDetails, status: "cancelled", cancellationRequested: true, termination: "pending" };
  const stoppedEvidence = adaptAgentSessionRun(stopped);
  assert.equal(stoppedEvidence.executionOutcome, "unknown");
  assert.equal(stoppedEvidence.cancellationRequested, true);
  assert.equal(stoppedEvidence.termination, "pending");
  assert.equal(stoppedEvidence.resume, "unsupported");
  const execution: SpsExecution = { lane: "agent_session", runId: "agent-run-1", companyId: "company-1", pluginKey: "builder",
    agentId: "agent-1", sessionId: "session-1", subjectKey: "claimed-subject", runtime: { kind: null, model: null, modelSource: "unavailable" },
    status: "succeeded", phase: "succeeded", cancellationRequested: false, termination: "confirmed", failure: null,
    createdAt: "2026-11-04T00:00:00.000Z", startedAt: "2026-11-04T00:00:01.000Z", finishedAt: "2026-11-04T00:00:02.000Z", elapsedMs: 1000,
    usage: { inputTokens: { value: null, provenance: "unavailable" }, cachedInputTokens: { value: null, provenance: "unavailable" },
      outputTokens: { value: null, provenance: "unavailable" }, costUsd: { value: null, provenance: "unavailable" }, currency: null,
      billingType: "unknown", costBasis: "unknown" } };
  assert.equal(adaptAgentSessionRun({ ...noDetails, execution }).executionOutcome, "passed");
  assert.equal(adaptAgentSessionRun({ ...noDetails, execution: { ...execution, lane: "node" } }).executionOutcome, "unknown");
  assert.equal(adaptAgentSessionRun({ ...noDetails, execution: { ...execution, runId: "other-run" } }).executionOutcome, "unknown");
});

test("model_request and PluginSpsModelRun are mapped only with matching SDK history; otherwise UNKNOWN", () => {
  const run: PluginSpsModelRun = { id: "model-run-1", companyId: "company-1", connectionId: "connection-1", status: "succeeded",
    externalEffects: "unknown", errorCode: null, cancellationRequested: false, cleanupPending: false, resultState: "available", result: null,
    createdAt: "2026-11-04T00:00:00.000Z", startedAt: "2026-11-04T00:00:01.000Z", finishedAt: "2026-11-04T00:00:02.000Z" };
  assert.equal(adaptModelRun(run).executionOutcome, "unknown");
  const history: SpsExecution = { lane: "model_request", runId: run.id, companyId: run.companyId, pluginKey: "builder", agentId: null,
    sessionId: null, subjectKey: "claimed-subject", runtime: { kind: "model", model: null, modelSource: "configured" }, status: "succeeded",
    phase: "succeeded", cancellationRequested: false, termination: "confirmed", failure: null, createdAt: run.createdAt,
    startedAt: run.startedAt, finishedAt: run.finishedAt, elapsedMs: 1000,
    usage: { inputTokens: { value: null, provenance: "unavailable" }, cachedInputTokens: { value: null, provenance: "unavailable" },
      outputTokens: { value: null, provenance: "unavailable" }, costUsd: { value: null, provenance: "unavailable" }, currency: null,
      billingType: "unknown", costBasis: "unknown" } };
  assert.equal(adaptModelRun(run, history).executionOutcome, "passed");
  assert.equal(adaptModelRun(run, { ...history, lane: "node" }).executionOutcome, "unknown");
  assert.equal(adaptModelRun(run, { ...history, companyId: "other-company" }).executionOutcome, "unknown");
  assert.equal(adaptModelRun({ ...run, cancellationRequested: true }).cancellationRequested, true);
});

test("typed execution lookup checks company, lane and run identity and preserves unavailable as null", async () => {
  assert.equal(await lookupExecution(sdk([], null), "company-1", "model_request", "run-1"), null);
  await assert.rejects(lookupExecution(sdk(), " ", "node", "run-1"), /companyId/u);
  const failedProvider = { executions: { get: async () => { throw new Error("history unavailable"); } } } as unknown as PluginSpsClient;
  assert.equal(await lookupExecution(failedProvider, "company-1", "agent_session", "run-1"), null);
});
