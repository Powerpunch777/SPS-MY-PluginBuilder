import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { parseWorkstreamBoard, parseWorkstreamChange, parseWorkstreamSpec, type WorkstreamRecord } from "./domain/workstreams.ts";
import { parseLeadAgentBinding } from "./domain/lead-agent.ts";
import { parseLeadSessions } from "./domain/lead-sessions.ts";
import { readLeadContexts } from "./lead-context-store.ts";
import { createDesignBaselineStore, readDesignBaseline } from "./design-baseline-tools.ts";
import { createTechnologyDecisionStore, readTechnologyDecisions } from "./technology-decision-tools.ts";
import { readProjectCtos } from "./project-cto-tools.ts";
import { exactToolRecord, parseLeadToolContext, requireLeadFormalPublicationAuthority, resolveLeadToolAuthority } from "./lead-tool-authority.ts";
import { createRevisionJournal, type RevisionState } from "./solution-revision-store.ts";
import { resolveCtoDeliveryRun, workstreamInstructionDigest } from "./cto-delivery-store.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const asJson = (value: unknown) => value as JsonValue;
function id(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError("A bounded Workstream identifier is required.");
  return value;
}
export function createWorkstreamStore(workspaceId: string, projectId: string, state: RevisionState) {
  return createRevisionJournal(workspaceId, projectId, state, { prefix: "workstreams",
    parse: value => parseWorkstreamBoard(value, projectId), revisionId: value => value.revisionId });
}
export async function readWorkstreams(workspaceId: string, projectId: string, platform: SpsPlatformInvocationContext) {
  return createWorkstreamStore(workspaceId, projectId, platform.state).current();
}
function guardedState(platform: SpsPlatformInvocationContext, check: () => Promise<void>): RevisionState {
  const state = platform.state as typeof platform.state & RevisionState;
  return { get: async key => { await check(); const result = await state.get(key); await check(); return result; },
    compareAndSet: state.compareAndSet ? async (...args) => {
      await check(); const result = await state.compareAndSet!(...args); await check(); return result;
    } : undefined };
}
function conflict(actualBaseRevisionId: string | null) {
  return { content: "Workstream state changed. Read the current board and reconcile without automatic retry. No execution was requested.",
    data: asJson({ status: "conflict", actualBaseRevisionId, executionStarted: false }) };
}

/** Stores a versioned instruction, not a dispatch or a grant to execute customer code. */
export async function publishWorkstream(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "expectedBaseRevisionId", "revisionId", "spec", "change"]);
  const projectId = id(input.projectId), revisionId = id(input.revisionId);
  const expectedBaseRevisionId = input.expectedBaseRevisionId === null ? null : id(input.expectedBaseRevisionId);
  const spec = parseWorkstreamSpec(input.spec, projectId), change = parseWorkstreamChange(input.change);
  const context = parseLeadToolContext(runContext);
  const authority = await resolveLeadToolAuthority(context, platform);
  requireLeadFormalPublicationAuthority(authority);
  const current = await readWorkstreams(context.companyId, projectId, platform);
  if ((current?.revision.revisionId ?? null) !== expectedBaseRevisionId) return conflict(current?.revision.revisionId ?? null);
  const old = current?.revision.workstreams.find(record => record.spec.id === spec.id);
  if (spec.revision !== (old?.spec.revision ?? 0) + 1 || change.previousRevision !== (old?.spec.revision ?? null)) {
    throw new Error("A Workstream needs its exact prior specification revision and the next revision number.");
  }
  const baseline = await readDesignBaseline(context.companyId, projectId, platform);
  const technology = await readTechnologyDecisions(context.companyId, projectId, platform);
  if (!baseline || !technology || spec.sourceSpecRevisionId !== baseline.revision.specification.revisionId
    || spec.technologyDecisionsRef !== technology.revision.register.revisionId
    || technology.revision.register.sourceBaselineRevisionId !== baseline.revision.revisionId
    || technology.revision.register.sourceSpecRevisionId !== baseline.revision.specification.revisionId
    || technology.revision.register.sourceGraphRevisionId !== baseline.revision.graph.graphRevisionId
    || technology.revision.baselineDigest !== digest(baseline.revision)) {
    throw new Error("Workstream publication requires the exact current design baseline and its current technology register.");
  }
  const nodes = new Set(baseline.revision.graph.entities.map(node => node.id));
  const contracts = new Set(baseline.revision.graph.entities.flatMap(node => node.contractRefs ?? [])
    .concat(baseline.revision.graph.relations.flatMap(edge => edge.contractRef ? [edge.contractRef] : [])));
  if (spec.scopeNodeIds.some(node => !nodes.has(node)) || spec.interfaceContracts.some(contract => !contracts.has(contract))) {
    throw new Error("Workstream scope and interface references must exist in the pinned Graph.");
  }
  const impactNodes = new Set([...nodes, ...(old?.spec.scopeNodeIds ?? [])]);
  const impactContracts = new Set([...contracts, ...(old?.spec.interfaceContracts ?? [])]);
  if (change.impactNodeIds.some(node => !impactNodes.has(node)) || change.impactInterfaceContracts.some(contract => !impactContracts.has(contract))) {
    throw new Error("Change impact references do not match the current or previous Workstream scope/contracts.");
  }
  const overlaps = (current?.revision.workstreams ?? []).filter(record => record.spec.id !== spec.id
    && record.spec.assignedCtoId !== spec.assignedCtoId && record.spec.scopeNodeIds.some(node => spec.scopeNodeIds.includes(node)));
  if (overlaps.length) return { content: "Each Graph node has one responsible CTO. Coordinate through interfaces/dependencies; that CTO can later divide internal work among its Workers. Another CTO already owns part of this scope. Existing state is unchanged and no execution was requested.",
    data: asJson({ status: "scope-conflict", workstreamIds: overlaps.map(record => record.spec.id), executionStarted: false }) };
  const registry = await readProjectCtos(context.companyId, projectId, platform);
  const cto = registry.ctos.find(record => record.ctoId === spec.assignedCtoId);
  if (!cto || cto.status === "RETIRED" || cto.sessionId === null) throw new Error("A registered non-retired CTO with an independent session is required.");
  const check = async () => {
    await authority.check();
    const latestCto = (await readProjectCtos(context.companyId, projectId, platform)).ctos.find(record => record.ctoId === cto.ctoId);
    if (JSON.stringify(latestCto) !== JSON.stringify(cto)) throw new Error("The assigned CTO identity changed. Read without automatic retry.");
    const latestBaseline = await readDesignBaseline(context.companyId, projectId, platform);
    const latestTechnology = await readTechnologyDecisions(context.companyId, projectId, platform);
    if (!latestBaseline || !latestTechnology || digest(latestBaseline.revision) !== digest(baseline.revision)
      || digest(latestTechnology.revision) !== digest(technology.revision)) throw new Error("The Workstream source design/technology changed. Read without automatic retry.");
    await authority.check();
  };
  const record: WorkstreamRecord = { spec, sourceBaselineRevisionId: baseline.revision.revisionId,
    baselineDigest: digest(baseline.revision), technologyDigest: digest(technology.revision),
    ctoAgentId: cto.agentId, ctoSessionId: cto.sessionId,
    author: { agentId: context.agentId, sessionId: context.sessionId, runId: context.runId, selectionRevision: authority.selectionRevision },
    createdAt: new Date().toISOString(), change, receipt: null };
  const board = parseWorkstreamBoard({ projectId, revisionId,
    workstreams: [...(current?.revision.workstreams ?? []).filter(item => item.spec.id !== spec.id), record] }, projectId);
  const result = await createWorkstreamStore(context.companyId, projectId, guardedState(platform, check)).publish({ expectedBaseRevisionId, revision: board });
  await check();
  return { content: result.status === "published" ? "Workstream instruction stored for the assigned CTO. Receipt is pending: no session message, provider run, Worker, code or completion was created. The source and technical authorization must be rechecked before any later execution."
    : "The board changed. Read and reconcile without automatic retry.", data: asJson({ ...result, executionStarted: false }) };
}

export async function resolveCtoAuthority(projectId: string, ctoId: string, context: ReturnType<typeof parseLeadToolContext>, platform: SpsPlatformInvocationContext) {
  const cto = (await readProjectCtos(context.companyId, projectId, platform)).ctos.find(record => record.ctoId === ctoId);
  if (!cto || cto.status === "RETIRED" || cto.sessionId === null || cto.agentId !== context.agentId || cto.sessionId !== context.sessionId) {
    throw new Error("Only this project's registered CTO and its independent session may receive this Workstream.");
  }
  const check = async () => {
    const latest = (await readProjectCtos(context.companyId, projectId, platform)).ctos.find(record => record.ctoId === ctoId);
    if (JSON.stringify(latest) !== JSON.stringify(cto)) throw new Error("CTO identity/session authority changed.");
    const key = (stateKey: string) => ({ scopeKind: "company" as const, scopeId: context.companyId, namespace: "sonpark.my-builder", stateKey });
    const raw = await platform.state.get(key("lead-agent.v1"));
    const lead = parseLeadAgentBinding(raw ?? { workspaceId: context.companyId, revision: 0, selectedAgentId: null }, context.companyId);
    if (lead.selectedAgentId === context.agentId) {
      const contexts = await readLeadContexts(context.companyId, platform);
      if (contexts !== null && Object.values(contexts.contexts).includes(context.sessionId)) {
        throw new Error("A Lead logical context cannot impersonate CTO receipt authority.");
      }
      const rawSessions = await platform.state.get(key(`lead-sessions.v1.${lead.revision}`));
      if (rawSessions !== null) {
        const sessions = parseLeadSessions(rawSessions, context.companyId);
        if (Object.values(sessions.sessions).includes(context.sessionId)) throw new Error("A Lead session cannot impersonate CTO receipt authority.");
      }
    }
  };
  await check();
  return { cto, check };
}
function assigned(record: WorkstreamRecord | undefined, cto: { ctoId: string; agentId: string; sessionId: string | null }) {
  if (!record || record.spec.assignedCtoId !== cto.ctoId || record.ctoAgentId !== cto.agentId || record.ctoSessionId !== cto.sessionId) {
    throw new Error("This Workstream is not assigned to the calling CTO identity/session.");
  }
  return record;
}
export async function readPinnedWorkstreamSources(workspaceId: string, projectId: string, record: WorkstreamRecord, platform: SpsPlatformInvocationContext) {
  const baseline = await createDesignBaselineStore(workspaceId, projectId, platform.state).publishedRevision(record.sourceBaselineRevisionId);
  const technology = await createTechnologyDecisionStore(workspaceId, projectId, platform.state).publishedRevision(record.spec.technologyDecisionsRef);
  if (!baseline || !technology || digest(baseline.revision) !== record.baselineDigest || digest(technology.revision) !== record.technologyDigest) {
    throw new Error("Pinned published Workstream sources are missing or inconsistent. No repair or substitution was attempted.");
  }
  return { baseline: baseline.revision, technology: technology.revision };
}
export async function readLeadWorkstreams(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId"]), projectId = id(input.projectId);
  const context = parseLeadToolContext(runContext), authority = await resolveLeadToolAuthority(context, platform);
  const current = await readWorkstreams(context.companyId, projectId, platform);
  await authority.check();
  return { content: "Versioned instructions and CTO-reported readiness, not execution or verified completion.", data: asJson({ projectId, current }) };
}
export async function readCtoWorkstream(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "ctoId", "workstreamId"]);
  const projectId = id(input.projectId), ctoId = id(input.ctoId), workstreamId = id(input.workstreamId);
  const context = parseLeadToolContext(runContext), authority = await resolveCtoAuthority(projectId, ctoId, context, platform);
  const board = await readWorkstreams(context.companyId, projectId, platform);
  const latest = assigned(board?.revision.workstreams.find(item => item.spec.id === workstreamId), authority.cto);
  const delivery = await resolveCtoDeliveryRun(context, projectId, ctoId, workstreamId, platform);
  const record = delivery?.instruction ?? latest;
  const sources = await readPinnedWorkstreamSources(context.companyId, projectId, record, platform);
  await authority.check();
  return { content: "Assigned versioned Workstream and published design/technology facts. Historical revisions are not automatically current. No other CTO private memory/transcript or execution permission is included.",
    data: asJson({ projectId, boardRevisionId: board!.revision.revisionId, workstream: record, sources,
      ...(delivery ? { delivery: { requestId: delivery.requestId, currentInstruction: workstreamInstructionDigest(latest) === workstreamInstructionDigest(record) } } : {}) }) };
}
export async function acknowledgeWorkstream(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "ctoId", "workstreamId", "expectedBaseRevisionId", "revisionId", "specRevision", "readiness", "note"]);
  const projectId = id(input.projectId), ctoId = id(input.ctoId), workstreamId = id(input.workstreamId);
  const expectedBaseRevisionId = id(input.expectedBaseRevisionId), revisionId = id(input.revisionId);
  if (typeof input.specRevision !== "number" || !Number.isSafeInteger(input.specRevision) || input.specRevision < 1
    || !["ready", "needs-clarification", "blocked"].includes(input.readiness as string)
    || typeof input.note !== "string" || !input.note.trim() || Buffer.byteLength(input.note, "utf8") > 4096) throw new TypeError("Exact specification revision and bounded CTO readiness/note are required.");
  const specRevision = input.specRevision, readiness = input.readiness as "ready" | "needs-clarification" | "blocked", note = input.note;
  const context = parseLeadToolContext(runContext), authority = await resolveCtoAuthority(projectId, ctoId, context, platform);
  const current = await readWorkstreams(context.companyId, projectId, platform);
  if (!current || current.revision.revisionId !== expectedBaseRevisionId) return conflict(current?.revision.revisionId ?? null);
  const record = assigned(current.revision.workstreams.find(item => item.spec.id === workstreamId), authority.cto);
  const delivery = await resolveCtoDeliveryRun(context, projectId, ctoId, workstreamId, platform);
  if (delivery && workstreamInstructionDigest(record) !== workstreamInstructionDigest(delivery.instruction)) return conflict(current.revision.revisionId);
  if (record.spec.revision !== specRevision) return conflict(current.revision.revisionId);
  await readPinnedWorkstreamSources(context.companyId, projectId, record, platform);
  if (record.receipt?.readiness === readiness && record.receipt.note === note) {
    await authority.check();
    return { content: "The same CTO readiness report is already recorded. It is not an execution or completion receipt.", data: asJson({ status: "unchanged", executionStarted: false }) };
  }
  const receipt = { revision: specRevision, agentId: context.agentId, sessionId: context.sessionId, runId: context.runId,
    createdAt: new Date().toISOString(), readiness, note };
  const board = parseWorkstreamBoard({ projectId, revisionId, workstreams: current.revision.workstreams.map(item => item.spec.id === workstreamId ? { ...item, receipt } : item) }, projectId);
  const result = await createWorkstreamStore(context.companyId, projectId, guardedState(platform, authority.check)).publish({ expectedBaseRevisionId, revision: board });
  await authority.check();
  return { content: result.status === "published" ? "CTO understanding/readiness report recorded for the exact assigned revision. No provider execution, Worker dispatch or verified completion is implied."
    : "The Workstream changed. Read without automatic retry.", data: asJson({ ...result, executionStarted: false }) };
}
