import { randomUUID } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext, SpsAgentSessionRunResult } from "@sonparkserver/plugin-sdk/platform";
import { parseCtoDelivery, ctoDeliveryRequestId, type CtoDelivery } from "./domain/cto-deliveries.ts";
import { parseWorkstreamBoard } from "./domain/workstreams.ts";
import { createCtoDeliveryStore, workstreamInstructionDigest } from "./cto-delivery-store.ts";
import { readProjectCtos } from "./project-cto-tools.ts";
import { readWorkstreams, readPinnedWorkstreamSources } from "./workstream-tools.ts";
import { readDesignBaseline } from "./design-baseline-tools.ts";
import { readTechnologyDecisions } from "./technology-decision-tools.ts";
import { exactToolRecord, parseLeadToolContext, resolveLeadToolAuthority } from "./lead-tool-authority.ts";
import { assertSessionExecutionPolicySupport, CTO_SESSION_EXECUTION_POLICY } from "./session-execution-policy.ts";
import type { RevisionState } from "./solution-revision-store.ts";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted", "timed_out"]);
const json = (value: unknown) => value as JsonValue;
function id(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError("A bounded delivery scope ID is required.");
  return value;
}
function currentStore(workspaceId: string, projectId: string, ctoId: string, platform: SpsPlatformInvocationContext,
  check: () => Promise<void>) {
  const guarded: RevisionState = {
    get: async key => { await check(); const value = await platform.state.get(key); await check(); return value; },
    compareAndSet: platform.state.compareAndSet ? async (...args) => {
      await check(); const receipt = await platform.state.compareAndSet!(...args); await check(); return receipt;
    } : undefined,
  };
  return createCtoDeliveryStore(workspaceId, projectId, ctoId, guarded);
}
function active(value: CtoDelivery) {
  return value.phase !== "superseded" && (!TERMINAL.has(value.phase) || value.cancellationRequested && value.termination !== "confirmed");
}
function summary(value: CtoDelivery) {
  return { ctoId: value.ctoId, requestId: value.requestId, workstreamId: value.instruction.spec.id,
    specRevision: value.instruction.spec.revision, phase: value.phase, runId: value.runId,
    cancellationRequested: value.cancellationRequested, termination: value.termination, createdAt: value.createdAt };
}
async function save(store: ReturnType<typeof createCtoDeliveryStore>, previous: CtoDelivery | null, value: CtoDelivery) {
  const result = await store.publish({ expectedBaseRevisionId: previous?.revisionId ?? null, revision: value });
  if (result.status !== "published") throw new Error("CTO delivery changed. Read the existing receipt without automatically resending.");
  return result.revision;
}
const revision = (value: CtoDelivery, patch: Partial<CtoDelivery>) => parseCtoDelivery({ ...value, ...patch, revisionId: randomUUID() },
  value.workspaceId, value.projectId, value.ctoId);

async function observe(value: CtoDelivery, platform: SpsPlatformInvocationContext, check: () => Promise<void>) {
  await check();
  if (value.phase === "prepared" || value.phase === "superseded") return value;
  let runId = value.runId;
  const receipt = await platform.agents.sessions.getRequest(value.instruction.ctoSessionId, value.workspaceId, value.requestId);
  await check();
  if (!receipt || receipt.requestId !== value.requestId || receipt.state !== "submitted" || !receipt.runId) {
    if (runId !== null) throw new Error("Previously accepted CTO request no longer has its exact Core receipt.");
    return value.phase === "uncertain" ? value : revision(value, { phase: "uncertain" });
  }
  if (runId !== null && runId !== receipt.runId) throw new Error("CTO delivery run identity changed.");
  runId = receipt.runId;
  const run = await platform.agents.sessions.getRun(value.instruction.ctoSessionId, value.workspaceId, runId);
  await check();
  if (run.runId !== runId || !["queued", "running", "cancelling", ...TERMINAL].includes(run.status)) throw new Error("Invalid CTO run observation.");
  const phase = TERMINAL.has(run.status) ? run.status as CtoDelivery["phase"] : "submitted";
  const reported = run.output;
  const answer = phase === "succeeded" && reported?.state === "available"
    && Buffer.byteLength(reported.text, "utf8") <= 8192 ? reported.text : null;
  const outputState: CtoDelivery["outputState"] = answer !== null ? "available" : reported === undefined ? "unsupported"
    : reported.state === "withheld" || reported.state === "available" ? "withheld" : "not_ready";
  const patch = { phase, runId, cancellationRequested: run.cancellationRequested, termination: run.termination, answer, outputState };
  if (Object.entries(patch).every(([key, field]) => value[key as keyof CtoDelivery] === field)) return value;
  return revision(value, patch);
}

function prompt(delivery: CtoDelivery) {
  const event = { type: delivery.instruction.spec.revision === 1 ? "workstream.assigned" : "workstream.revised",
    schemaVersion: 1, requestId: delivery.requestId, workspaceId: delivery.workspaceId, projectId: delivery.projectId,
    ctoId: delivery.ctoId, boardRevisionId: delivery.boardRevisionId, instruction: delivery.instruction };
  const text = `Builder structured Workstream planning event:\n${JSON.stringify(event)}\n`
    + "Read the exact assigned instruction and pinned sources with builder.read-cto-workstream, then record your understanding/readiness using builder.acknowledge-workstream. "
    + "This run is restricted to these planning tools. Do not generate code, run commands, read/write local files, use other tools, create Workers or claim implementation/QA/delivery. "
    + "A readiness report is not execution approval. If the current specification changed, report the conflict instead of acknowledging a newer revision. "
    + "Unknown write results require read reconciliation, never an automatic retry. Retain questions and blocks honestly.";
  if (Buffer.byteLength(text, "utf8") > 48 * 1024) throw new Error("The structured CTO instruction exceeds the Core message bound.");
  return text;
}

/** A workflow delivery receipt over Core's existing keyed session admission, not a new scheduler. */
export async function dispatchCtoWorkstream(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "workstreamId", "specRevision", "boardRevisionId"]);
  const projectId = id(input.projectId), workstreamId = id(input.workstreamId), boardRevisionId = id(input.boardRevisionId);
  if (!Number.isSafeInteger(input.specRevision) || (input.specRevision as number) < 1) throw new TypeError("An exact Workstream revision is required.");
  const context = parseLeadToolContext(runContext), authority = await resolveLeadToolAuthority(context, platform);
  const board = await readWorkstreams(context.companyId, projectId, platform);
  const source = board?.revision.workstreams.find(item => item.spec.id === workstreamId);
  if (!source || source.spec.revision !== input.specRevision || board!.revision.revisionId !== boardRevisionId) {
    throw new Error("The requested Workstream board/revision changed. Read before explicitly dispatching.");
  }
  const instruction = parseWorkstreamBoard({ projectId, revisionId: boardRevisionId,
    workstreams: [{ ...source, receipt: null }] }, projectId).workstreams[0]!;
  const ctoId = instruction.spec.assignedCtoId;
  const target = (await readProjectCtos(context.companyId, projectId, platform)).ctos.find(item => item.ctoId === ctoId);
  if (!target || target.status === "RETIRED" || target.agentId !== instruction.ctoAgentId || target.sessionId !== instruction.ctoSessionId) {
    throw new Error("The assigned CTO identity/session is unavailable; no replacement was created.");
  }
  const check = async () => {
    await authority.check();
    const cto = (await readProjectCtos(context.companyId, projectId, platform)).ctos.find(item => item.ctoId === ctoId);
    if (JSON.stringify(cto) !== JSON.stringify(target)) throw new Error("CTO identity changed during delivery.");
    const current = await readWorkstreams(context.companyId, projectId, platform);
    const record = current?.revision.workstreams.find(item => item.spec.id === workstreamId);
    if (!record || workstreamInstructionDigest(record) !== workstreamInstructionDigest(instruction)) throw new Error("Workstream instruction changed during delivery.");
    await authority.check();
  };
  const checkSources = async () => {
    const pinned = await readPinnedWorkstreamSources(context.companyId, projectId, instruction, platform);
    const baseline = await readDesignBaseline(context.companyId, projectId, platform);
    const technology = await readTechnologyDecisions(context.companyId, projectId, platform);
    if (JSON.stringify(baseline?.revision) !== JSON.stringify(pinned.baseline)
      || JSON.stringify(technology?.revision) !== JSON.stringify(pinned.technology)) throw new Error("The Workstream's design or technology is no longer current.");
    await check();
  };
  const store = currentStore(context.companyId, projectId, ctoId, platform, check);
  let current = (await store.current())?.revision ?? null;
  if (current && current.phase !== "prepared") {
    const observed = await observe(current, platform, check);
    if (observed !== current) current = await save(store, current, observed);
  }
  const requestId = ctoDeliveryRequestId(context.companyId, projectId, ctoId, instruction);
  if (current?.requestId === requestId && current.phase !== "prepared") {
    return { content: "Existing CTO delivery observed without another send. Provider state is not implementation or readiness acceptance.",
      data: json({ status: "existing", delivery: summary(current), automaticallyResent: false }) };
  }
  if (current?.phase === "prepared" && current.requestId !== requestId) {
    current = await save(store, current, revision(current, { phase: "superseded" }));
  }
  if (current && active(current) && current.requestId !== requestId) throw new Error("This CTO has an active or uncertain delivery. Observe it; do not create a replacement request.");
  if (!current || current.requestId !== requestId) {
    const old = await store.publishedRevision(`${requestId}:prepared`);
    if (old) {
      const seen = await observe(old.revision.phase === "prepared" ? revision(old.revision, { phase: "dispatching" }) : old.revision, platform, check);
      return { content: "Historical delivery found; no second send was attempted.",
        data: json({ status: "existing", delivery: summary(seen), automaticallyResent: false }) };
    }
    await assertSessionExecutionPolicySupport(platform, target.sessionId!, context.companyId);
    await check();
    if (await platform.agents.sessions.getRequest(target.sessionId!, context.companyId, requestId) !== null) {
      throw new Error("Core already knows this request but the Builder intent is missing. Review without resending.");
    }
    await check();
    await checkSources();
    const prepared = parseCtoDelivery({ schemaVersion: 1, workspaceId: context.companyId, projectId, ctoId,
      revisionId: `${requestId}:prepared`, requestId, boardRevisionId, instruction,
      requestedBy: { agentId: context.agentId, sessionId: context.sessionId, runId: context.runId, selectionRevision: authority.selectionRevision },
      executionPolicy: CTO_SESSION_EXECUTION_POLICY, createdAt: new Date().toISOString(), phase: "prepared", runId: null,
      cancellationRequested: false, termination: "not_applicable", outputState: "not_ready", answer: null }, context.companyId, projectId, ctoId);
    prompt(prepared);
    current = await save(store, current, prepared);
  }
  await assertSessionExecutionPolicySupport(platform, target.sessionId!, context.companyId);
  await checkSources();
  const dispatching = revision(current, { phase: "dispatching" });
  let providerInvoked = false;
  try {
    current = await save(store, current, dispatching);
    await checkSources();
    providerInvoked = true;
    const accepted = await platform.agents.sessions.sendMessage(current.instruction.ctoSessionId, context.companyId,
      { requestId, prompt: prompt(current), reason: "builder-workstream-planning", executionPolicy: current.executionPolicy });
    await check();
    current = await save(store, current, revision(current, { phase: "submitted", runId: accepted.runId }));
  } catch {
    if (!providerInvoked) {
      // Only this call's exact marker is safe to retire. A changed instruction
      // must not prevent recording that Core's send method was never invoked.
      const retirement = currentStore(context.companyId, projectId, ctoId, platform, authority.check);
      await (async () => {
        const recorded = (await retirement.current())?.revision;
        if (recorded?.revisionId === dispatching.revisionId && recorded.phase === "dispatching") {
          await save(retirement, recorded, revision(recorded, { phase: "superseded" }));
        }
      })().catch(() => undefined);
      throw new Error("Core CTO send was not called. Read the stored intent; do not automatically resend.");
    }
    // A stale/failed save leaves dispatching or uncertain; neither is resent.
    await save(store, current, revision(current, { phase: "uncertain", runId: null })).catch(() => undefined);
    throw new Error("CTO delivery outcome is uncertain. Read the same request; do not automatically resend.");
  }
  return { content: "The exact Workstream planning event was admitted to the registered CTO session. No code, Workers, QA or delivery completion is implied.",
    data: json({ status: "submitted", delivery: summary(current), automaticallyResent: false }) };
}

export async function inspectCtoWorkstreamDelivery(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext,
  cancel = false) {
  const input = exactToolRecord(params, ["projectId", "ctoId"]), projectId = id(input.projectId), ctoId = id(input.ctoId);
  const context = parseLeadToolContext(runContext), authority = await resolveLeadToolAuthority(context, platform);
  const store = currentStore(context.companyId, projectId, ctoId, platform, authority.check);
  let current = (await store.current())?.revision ?? null;
  if (!current) return { content: "No recorded CTO delivery.", data: null };
  if (cancel) {
    if (current.phase === "prepared") {
      current = await save(store, current, revision(current, { phase: "superseded" }));
      return { content: "Unsent prepared delivery retired. No provider process was cancelled or started.",
        data: json({ delivery: summary(current), automaticallyResent: false }) };
    }
    if (current.phase === "superseded") return { content: "This delivery was retired before sending.", data: json({ delivery: summary(current), automaticallyResent: false }) };
    const observed = await observe(current, platform, authority.check);
    if (observed !== current) current = await save(store, current, observed);
    if (!current.runId) throw new Error("Uncertain delivery has no verified run to cancel. Observe without resending.");
    if (!TERMINAL.has(current.phase) && !current.cancellationRequested) {
      const result: SpsAgentSessionRunResult = await platform.agents.sessions.cancel(current.instruction.ctoSessionId, context.companyId, current.runId);
      await authority.check();
      if (result.runId !== current.runId) throw new Error("Cancellation returned a different CTO run.");
    }
  }
  const observed = await observe(current, platform, authority.check);
  if (observed !== current) current = await save(store, current, observed);
  return { content: "Core provider state only. Readiness, implementation, tests and delivery acceptance remain separate Builder facts.",
    data: json({ delivery: summary(current), automaticallyResent: false }) };
}
