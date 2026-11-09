import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { exactToolRecord, parseLeadToolContext } from "../lead-tool-authority.ts";
import { parseLeadAgentBinding } from "../domain/lead-agent.ts";
import { parseLeadSessions } from "../domain/lead-sessions.ts";
import { taskPacketRecordDigest } from "../domain/task-packets.ts";
import { readDesignBaseline } from "../design-baseline-tools.ts";
import { readWorkstreams } from "../workstream-tools.ts";
import { resolveCtoTaskAuthority } from "../task-packet-tools.ts";
import { createBaselineBodySource } from "../project-documents/baseline-body-source.ts";
import { createCurrentBaselineAssuranceProvider } from "../spec-assurance/current-baseline-provider.ts";
import { evaluateSpecCoverage } from "../spec-coverage/evaluator.ts";
import type { RevisionPublicationGuard, RevisionState } from "../solution-revision-store.ts";
import type { EvidencePin } from "./workstream-verification-consumer.ts";
import type { GateProofScope, GateProtectedTaskQaProof, GateSourceInventory } from "./workstream-verification.ts";
import { createWorkstreamVerificationPublication, type AuthorityReader, type GuardBinding } from "./workstream-verification-publication.ts";
import { readCurrentProtectedTaskQaEvidence } from "./protected-task-qa-evidence.ts";
import { readCarriedTaskQaEvidence } from "./carried-task-qa-evidence.ts";
import { qaCarryForwardPin } from "./qa-carry-forward.ts";
import { hasUndecidedTaskRequirement } from "./task-decision-scope.ts";

export const VERIFY_WORKSTREAM_TOOL_NAME = "builder.verify-workstream";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const keyId = (key: Pick<SpsStateKey, "namespace" | "stateKey">) => JSON.stringify([key.namespace ?? "default", key.stateKey]);

/** Only server-resolved current records enter this composition. No caller can
 * supply a verdict, evidence pin, authority reader, guard, or Core receipt. */
export function createCurrentWorkstreamVerificationAuthority(input: Readonly<{
  ctoId: string; runContext: unknown; platform: SpsPlatformInvocationContext;
}>): AuthorityReader {
  const context = parseLeadToolContext(input.runContext);
  return async scope => {
    if (scope.workspaceId !== context.companyId || scope.projectId !== context.companyId
      || context.projectId !== undefined && context.projectId !== scope.projectId) {
      return { status: "unavailable", reason: "verification-workspace-project-context-mismatch" };
    }
    const captured = new Map<string, RevisionPublicationGuard>();
    const state = input.platform.state as typeof input.platform.state & RevisionState;
    const tracked: RevisionState = { ...state, async get(key) {
      if (key.scopeKind !== "company" || key.scopeId !== scope.workspaceId) throw new Error("Verification read escaped its Workspace.");
      const value = await state.get(key);
      if (value !== null) {
        const identity = keyId(key), prior = captured.get(identity);
        if (prior && JSON.stringify(prior.expectedValue) !== JSON.stringify(value)) throw new Error("Verification source changed during read.");
        captured.set(identity, { stateKey: key.stateKey, ...(key.namespace === undefined ? {} : { namespace: key.namespace }), expectedValue: structuredClone(value) });
      }
      return value;
    } };
    const platform = { ...input.platform, state: tracked as typeof input.platform.state };
    try {
      const authority = await resolveCtoTaskAuthority(scope.projectId, input.ctoId, scope.workstreamId,
        input.runContext, platform, VERIFY_WORKSTREAM_TOOL_NAME);
      const board = await authority.store.current();
      const workstreamBoard = await readWorkstreams(scope.workspaceId, scope.projectId, platform);
      const workstream = workstreamBoard?.revision.workstreams
        .find(row => row.spec.id === scope.workstreamId);
      const baseline = await readDesignBaseline(scope.workspaceId, scope.projectId, platform);
      if (!board || !workstream || !baseline || digest(baseline.revision) !== workstream.baselineDigest
        || baseline.revision.revisionId !== workstream.sourceBaselineRevisionId) {
        return { status: "unavailable", reason: "verification-current-task-workstream-baseline-unavailable" };
      }
      const documents = createBaselineBodySource(scope.workspaceId, scope.projectId, tracked);
      const document = await documents.current();
      if (!document || document.revision.sourceBaselineRevisionId !== baseline.revision.revisionId) {
        return { status: "unavailable", reason: "verification-current-baseline-document-unavailable" };
      }
      const key = (stateKey: string) => ({ scopeKind: "company" as const, scopeId: scope.workspaceId,
        namespace: "sonpark.my-builder", stateKey });
      const lead = parseLeadAgentBinding(await tracked.get(key("lead-agent.v1")), scope.workspaceId);
      if (!lead.selectedAgentId) return { status: "unavailable", reason: "verification-current-lead-unavailable" };
      const sessions = parseLeadSessions(await tracked.get(key(`lead-sessions.v1.${lead.revision}`)), scope.workspaceId);
      if (sessions.agentId !== lead.selectedAgentId || sessions.selectionRevision !== lead.revision) {
        return { status: "unavailable", reason: "verification-current-lead-sessions-mismatch" };
      }
      const assurance = createCurrentBaselineAssuranceProvider({ ...scope, sessions, platform });
      const development = board.revision.packets.filter(row => row.packet.kind === "development");
      if (!development.length || development.length > 128) return { status: "unavailable", reason: "verification-task-inventory-out-of-bound" };
      const proofs = new Map<string, GateProtectedTaskQaProof>();
      const inventories = new Map<string, GateSourceInventory>();
      const decisionBlockedTasks = new Set<string>();
      const sourceBindings = new Map<string, string>();
      const checks: Array<() => Promise<void>> = [];
      const inputs = [];
      const headBinding = (prefix: string, revisionId: string): string => {
        const matches = [...captured].filter(([, guard]) => guard.stateKey.startsWith(`${prefix}-head.v1.`)
          && (guard.expectedValue as { revisionId?: unknown })?.revisionId === revisionId);
        if (matches.length !== 1) throw new Error("Verification content has no unique actual journal head.");
        return matches[0]![0];
      };
      for (const task of development) {
        const taskScope: GateProofScope = { ...scope, taskId: task.packet.taskId };
        const evidenceInput = { scope: taskScope, ctoId: input.ctoId, runContext: input.runContext, platform };
        const currentEvidence = await readCurrentProtectedTaskQaEvidence(evidenceInput);
        const carriedEvidence = currentEvidence.status === "available" || !workstream.change.g5Handoff
          ? null : await readCarriedTaskQaEvidence(evidenceInput);
        const evidence = carriedEvidence ?? currentEvidence;
        if (evidence.status !== "available") return { status: "unavailable", reason: evidence.reason };
        const { report, qaRecord, coreRun, implementationRecord } = evidence.value;
        const carryForward = carriedEvidence?.status === "available" ? carriedEvidence.value.carryForward : undefined;
        if (digest(implementationRecord) !== digest(task)) return { status: "unavailable", reason: "verification-implementation-task-mismatch" };
        checks.push(evidence.check);
        const qaId = qaRecord.packet.taskId, reference = report.reference, binding = reference.binding;
        const core = exactToolRecord(coreRun, ["schemaVersion", "kind", "id", "status", "termination", "pins", "receipt", "timestamps", "qaVerdict"]);
        const receipt = core.receipt as { digest: string };
        const runPin = { sourceId: `core:protected-test-run:${binding.runId}`, revisionId: binding.runId, sha256: digest(coreRun) };
        const receiptPin = { sourceId: `core:protected-test-receipt:${binding.runId}`, revisionId: receipt.digest, sha256: receipt.digest };
        const referencePin = { sourceId: `builder-v1:task-qa-run:${qaId}`, revisionId: reference.revisionId, sha256: digest(reference) };
        const reportPin = { sourceId: `builder-v1:task-qa-report:${qaId}`, revisionId: report.revisionId, sha256: digest(report) };
        const content: Array<{ pin: EvidencePin; head: string; sequence: number }> = [];
        const add = (pin: EvidencePin, prefix: string, revisionId: string) => {
          const head = headBinding(prefix, revisionId), prior = sourceBindings.get(pin.sourceId);
          if (prior && prior !== head) throw new Error("Conflicting verification source bindings.");
          const sequence = (captured.get(head)!.expectedValue as { sequence: number }).sequence;
          if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Verification journal sequence is unavailable.");
          sourceBindings.set(pin.sourceId, head); content.push({ pin, head, sequence });
        };
        add({ sourceId: `builder-v1:baseline:${baseline.revision.revisionId}`, revisionId: baseline.revision.revisionId,
          sha256: digest(baseline.revision) }, "design-baseline", baseline.revision.revisionId);
        add({ sourceId: `builder-v1:graph:${baseline.revision.graph.graphRevisionId}`, revisionId: baseline.revision.graph.graphRevisionId,
          sha256: digest(baseline.revision.graph) }, "design-baseline", baseline.revision.revisionId);
        add({ sourceId: `builder-v1:workstream:${scope.workstreamId}`, revisionId: String(workstream.spec.revision),
          sha256: digest(workstream) }, "workstreams", workstreamBoard!.revision.revisionId);
        for (const record of [task, qaRecord]) add({ sourceId: `builder-v1:task-packet:${record.packet.taskId}`,
          revisionId: `${record.packet.taskId}:${record.packet.revision}`, sha256: taskPacketRecordDigest(record, scope.projectId, input.ctoId, scope.workstreamId) },
        "task-packets", board.revision.revisionId);
        add(referencePin, "task-protected-qa-runs", reference.revisionId);
        add(reportPin, "task-qa-reports", report.revisionId);
        if (carryForward) add(qaCarryForwardPin(carryForward.proof, reportPin), "task-packets", board.revision.revisionId);
        // A terminal Core receipt is immutable. Its exact digest and run/source
        // binding are attested by the current authenticated QA report/reference.
        add(runPin, "task-qa-reports", report.revisionId);
        add(receiptPin, "task-qa-reports", report.revisionId);
        const baselineBodyPin = { sourceId: document.revision.documentId, revisionId: document.revision.documentRevisionId,
          sha256: document.revision.bodySha256 };
        sourceBindings.set(baselineBodyPin.sourceId, headBinding("project-document-baseline", document.revision.documentRevisionId));
        const proof: GateProtectedTaskQaProof = { provenance: { adapter: "builder.protected-task-qa-proof.v1", operation: "readCurrent" },
          scope: taskScope, status: "passed", taskRecordSha256: taskPacketRecordDigest(task, scope.projectId, input.ctoId, scope.workstreamId), qaRecord, report,
          authorRun: { runId: report.author.runId, status: "succeeded", cancellationRequested: false },
          runPin, receiptPin, referencePin, reportPin, ...(carryForward ? { carryForward } : {}) };
        const material = await assurance({ identity: { workspaceId: scope.workspaceId, projectId: scope.projectId,
          specRevisionId: baseline.revision.specification.revisionId, specDigest: digest(baseline.revision.specification) },
        requirementIds: task.packet.requirementIds });
        if (!material) return { status: "unavailable", reason: "verification-current-d3-material-unavailable" };
        if (hasUndecidedTaskRequirement(task.packet.requirementIds, material.itemDecisions)) {
          decisionBlockedTasks.add(task.packet.taskId);
          continue;
        }
        proofs.set(task.packet.taskId, proof);
        inventories.set(task.packet.taskId, { provenance: { adapter: "builder.workstream-source-inventory.v1", operation: "readCurrent" },
          scope: taskScope, complete: true, pins: content.map(row => row.pin), heads: content.map(({ pin, sequence }) => ({
            sourceId: pin.sourceId, revisionId: pin.revisionId, sequence, digest: pin.sha256 })) });
        inputs.push({ scope: taskScope, ctoId: input.ctoId, baselineRef: { documentId: document.revision.documentId,
          documentRevisionId: document.revision.documentRevisionId, bodySha256: document.revision.bodySha256 },
        workstream, taskRecord: task, coverage: evaluateSpecCoverage(material.coverageInput) });
      }
      return { status: "available", taskBoard: board.revision, inputs, readers: {
        sourceInventory: async scope => decisionBlockedTasks.has(scope.taskId)
          ? { status: "unknown", reason: "task-requirement-has-approved-undecided-item-decision" }
          : inventories.has(scope.taskId) ? { status: "available", value: inventories.get(scope.taskId)! }
          : { status: "unknown", reason: "verification-task-inventory-missing" },
        runtimeProof: async scope => decisionBlockedTasks.has(scope.taskId)
          ? { status: "unknown", reason: "task-requirement-has-approved-undecided-item-decision" }
          : proofs.has(scope.taskId) ? { status: "available", value: proofs.get(scope.taskId)! }
          : { status: "unknown", reason: "verification-task-runtime-missing" }, baselineBodySource: documents,
      }, async bindGuards(verified) {
        await authority.check();
        for (const check of checks) await check();
        for (const guard of captured.values()) {
          const current = await state.get({ scopeKind: "company", scopeId: scope.workspaceId,
            namespace: guard.namespace, stateKey: guard.stateKey });
          if (JSON.stringify(current) !== JSON.stringify(guard.expectedValue)) return null;
        }
        const sourceIds = new Set(verified.flatMap(row => row.sourcePins.map(pin => pin.sourceId)));
        if ([...sourceIds].some(sourceId => !sourceBindings.has(sourceId))) return null;
        const guards: GuardBinding[] = [...captured].filter(([, guard]) => !guard.stateKey.includes("-revision.v1."))
          .map(([identity, guard]) => ({ ...guard, sourceIds: [...sourceIds].filter(sourceId => sourceBindings.get(sourceId) === identity) }));
        if (guards.length < 1 || guards.length > 64 || Buffer.byteLength(JSON.stringify(guards), "utf8") > 200_000) return null;
        return guards;
      } };
    } catch { return { status: "unavailable", reason: "verification-current-authority-or-evidence-unavailable" }; }
  };
}

export async function verifyCurrentWorkstream(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "ctoId", "workstreamId"]);
  const context = parseLeadToolContext(runContext);
  if (input.projectId !== context.companyId || [input.ctoId, input.workstreamId].some(value => typeof value !== "string"
    || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value))) throw new TypeError("Exact current Workspace and CTO Workstream IDs are required.");
  const result = await createWorkstreamVerificationPublication(platform.state as typeof platform.state & RevisionState,
    createCurrentWorkstreamVerificationAuthority({ ctoId: input.ctoId as string, runContext, platform }))
    .publish({ workspaceId: context.companyId, projectId: input.projectId, workstreamId: input.workstreamId as string });
  return { content: "Stored current G4/G6 evidence only. VERIFIED publication queues its existing integration job atomically; it is not integration or final delivery approval.",
    data: result as unknown as JsonValue };
}
