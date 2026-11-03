import { createHash, randomUUID } from "node:crypto";
import { defineSpsPlatformContract } from "@sonparkserver/plugin-sdk/platform";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import type { BuilderSnapshot, BuilderLeadSessions } from "./domain/model.ts";
import { createEmptyBuilderSnapshot, parseBuilderSnapshot } from "./domain/snapshot.ts";
import { parseLeadAgentBinding, parseLeadAgentOptions } from "./domain/lead-agent.ts";
import { LEAD_CHANNELS, parseLeadSessions } from "./domain/lead-sessions.ts";
import { LEAD_CONTEXTS, parseLeadContexts } from "./domain/lead-contexts.ts";
import { beginLeadContextPreparation, readLeadContexts, writeLeadContextProgress, writeLeadContexts } from "./lead-context-store.ts";
import type { LeadChannel, LeadConversationId } from "./domain/model.ts";
import { createLeadConversationStore, readLeadUserSource } from "./lead-conversations.ts";
import { createSolutionRevisionStore, type RevisionState } from "./solution-revision-store.ts";
import { READ_SOLUTION_TOOL, PROPOSE_DESIGN_TOOL, READ_DESIGN_DRAFT_TOOL, READ_DESIGN_SOURCES_TOOL, READ_LEAD_MEMORY_TOOL, UPDATE_LEAD_MEMORY_TOOL, RESOLVE_DESIGN_QUESTION_TOOL, CREATE_CTO_TOOL, LIST_CTOS_TOOL, PUBLISH_DESIGN_BASELINE_TOOL, READ_DESIGN_BASELINE_TOOL } from "./tool-declarations.mjs";
import { publishDesignBaseline, readLeadDesignBaseline, readDesignBaseline } from "./design-baseline-tools.ts";
import { PUBLISH_TECHNOLOGY_DECISIONS_TOOL, READ_TECHNOLOGY_DECISIONS_TOOL } from "./tool-declarations.mjs";
import { publishTechnologyDecisions, readLeadTechnologyDecisions, readTechnologyDecisions } from "./technology-decision-tools.ts";
import { PUBLISH_WORKSTREAM_TOOL, READ_WORKSTREAMS_TOOL, READ_CTO_WORKSTREAM_TOOL, ACKNOWLEDGE_WORKSTREAM_TOOL } from "./workstream-tool-declarations.mjs";
import { publishWorkstream, readLeadWorkstreams, readCtoWorkstream, acknowledgeWorkstream, readWorkstreams } from "./workstream-tools.ts";
import { DISPATCH_CTO_WORKSTREAM_TOOL, READ_CTO_WORKSTREAM_DELIVERY_TOOL, CANCEL_CTO_WORKSTREAM_DELIVERY_TOOL } from "./delivery-tool-declarations.mjs";
import { dispatchCtoWorkstream, inspectCtoWorkstreamDelivery } from "./cto-workstream-delivery.ts";
import { READ_CTO_MEMORY_TOOL, UPDATE_CTO_MEMORY_TOOL } from "./cto-memory-tool-declarations.mjs";
import { readCtoMemory, updateCtoMemory } from "./cto-memory-tools.ts";
import { SUBMIT_CTO_QUESTION_TOOL, READ_CTO_QUESTIONS_TOOL, READ_CTO_INTAKE_TOOL, READ_OWN_CTO_QUESTION_TOOL, REVIEW_CTO_QUESTION_TOOL } from "./cto-question-tool-declarations.mjs";
import { submitCtoQuestion, readCtoQuestions, readOwnCtoQuestion, readUserCtoQuestions, reviewCtoQuestion } from "./cto-question-tools.ts";
import { dispatchQuestionToLead, readBoundCtoIntake } from "./cto-intake-delivery.ts";
import { ANSWER_CTO_QUESTION_TOOL, READ_CTO_QUESTION_ANSWER_TOOL, ACKNOWLEDGE_CTO_QUESTION_ANSWER_TOOL } from "./cto-question-reply-tool-declarations.mjs";
import { answerCtoQuestion, readCtoQuestionAnswer, acknowledgeCtoQuestionAnswer } from "./cto-question-reply-tools.ts";
import { READ_CTO_TASK_PACKETS_TOOL, PUBLISH_CTO_TASK_PACKET_TOOL } from "./task-packet-tool-declarations.mjs";
import { readCtoTaskPackets, publishCtoTaskPacket } from "./task-packet-tools.ts";
import { createProjectCto, listProjectCtos, readProjectCtos } from "./project-cto-tools.ts";
import { parseQuestionContext } from "./domain/question-context.ts";
import { resolveDesignQuestion } from "./design-decision-tools.ts";
import { readLeadMemory, updateLeadMemory } from "./lead-memory-tools.ts";
import { createLeadMemoryStore } from "./lead-memory-store.ts";
import { exactToolRecord, parseLeadToolContext, resolveLeadToolAuthority } from "./lead-tool-authority.ts";
import { parseDesignDraft } from "./domain/design-drafts.ts";
import { createDesignDraftStore, type AuthoredDesignDraft } from "./design-draft-store.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_IMPORT_REQUEST_BYTES = 48 * 1024;
const MAX_INITIAL_SNAPSHOT_BYTES = 192 * 1024;
const queues = new Map<string, Promise<unknown>>();

function workspaceId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError("A trusted SPS Workspace is required.");
  return value;
}

function key(companyId: string) {
  return { scopeKind: "company" as const, scopeId: workspaceId(companyId), namespace: "sonpark.my-builder", stateKey: "snapshot.v1" };
}

export async function readBuilderSnapshot(companyId: string, platform: SpsPlatformInvocationContext): Promise<BuilderSnapshot> {
  const value = await platform.state.get(key(companyId));
  return value === null ? createEmptyBuilderSnapshot(companyId) : parseBuilderSnapshot(value, companyId);
}

// A dedicated Core Workspace Worker owns writes. This serializes its handlers;
// it is not a cross-process database transaction or a replacement execution queue.
async function serialize<T>(companyId: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(companyId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(companyId, current);
  try { return await current; } finally { if (queues.get(companyId) === current) queues.delete(companyId); }
}

export async function importConsultation(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  workspaceId(companyId);
  if (Object.keys(params).sort().join(",") !== "requestId,text" || typeof params.requestId !== "string"
    || !UUID.test(params.requestId) || typeof params.text !== "string" || !params.text.trim()
    || Buffer.byteLength(JSON.stringify(params), "utf8") > MAX_IMPORT_REQUEST_BYTES) {
    throw new TypeError("Consultation import requires one request ID and selected text within a 48 KiB request.");
  }
  const requestId = params.requestId;
  const text = params.text;
  return serialize(companyId, async () => {
    const snapshot = await readBuilderSnapshot(companyId, platform);
    const messageId = `consultation-${requestId}`;
    const existing = snapshot.messages.find(message => message.id === messageId);
    if (existing) {
      if (existing.text !== text || existing.role !== "user" || existing.channel !== "main") {
        throw new Error("The import request ID already refers to different input.");
      }
      return { saved: true, analysisStarted: false, revision: snapshot.revision };
    }
    const now = new Date().toISOString();
    snapshot.messages.push({ id: messageId, channel: "main", actorId: null, role: "user", text, createdAt: now, runId: null });
    snapshot.activity.push({ id: randomUUID(), actorId: null, label: "Consultation text imported", createdAt: now, evidenceRef: null });
    snapshot.revision += 1;
    const validated = parseBuilderSnapshot(snapshot, companyId);
    // Keep this initial record readable through bounded Native UI responses.
    // Paginated conversations/revisions replace this record before AI execution.
    if (Buffer.byteLength(JSON.stringify(validated), "utf8") > MAX_INITIAL_SNAPSHOT_BYTES) {
      throw new TypeError("The initial Builder record is full; existing input has not been changed.");
    }
    await platform.state.set(key(companyId), validated as unknown as JsonValue);
    return { saved: true, analysisStarted: false, revision: validated.revision };
  });
}

function leadAgentKey(companyId: string) {
  return { ...key(companyId), stateKey: "lead-agent.v1" };
}

async function readLeadAgentBinding(companyId: string, platform: SpsPlatformInvocationContext) {
  const value = await platform.state.get(leadAgentKey(companyId));
  return parseLeadAgentBinding(value === null ? { workspaceId: companyId, revision: 0, selectedAgentId: null } : value, companyId);
}

export async function readLeadAgentOptions(companyId: string, platform: SpsPlatformInvocationContext) {
  workspaceId(companyId);
  const binding = await readLeadAgentBinding(companyId, platform);
  const rows = await platform.agents.list({ companyId, limit: 100 });
  if (!Array.isArray(rows) || rows.length > 100) throw new TypeError("Invalid Host Agent list.");
  const agents = rows.map(row => {
    if (!row || row.companyId !== companyId) throw new TypeError("Host Agent belongs to a different Workspace.");
    // Never return adapter configuration, credentials or filesystem paths to UI.
    return { id: row.id, name: row.name, status: row.status };
  });
  return parseLeadAgentOptions({ ...binding, agents }, companyId);
}

export async function selectLeadAgent(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  workspaceId(companyId);
  if (Object.keys(params).sort().join(",") !== "agentId,expectedRevision"
    || params.agentId !== null && (typeof params.agentId !== "string" || !UUID.test(params.agentId))
    || !Number.isSafeInteger(params.expectedRevision) || (params.expectedRevision as number) < 0) {
    throw new TypeError("Lead Agent selection requires an Agent ID and the displayed revision.");
  }
  return serialize(companyId, async () => {
    const stored = await platform.state.get(leadAgentKey(companyId));
    const current = parseLeadAgentBinding(stored === null
      ? { workspaceId: companyId, revision: 0, selectedAgentId: null }
      : stored, companyId);
    if (current.revision !== params.expectedRevision) throw new Error("Lead Agent selection changed. Refresh before saving.");
    if (params.agentId !== null) {
      const options = await readLeadAgentOptions(companyId, platform);
      const agent = options.agents.find(agent => agent.id === params.agentId);
      if (!agent || !["idle", "running"].includes(agent.status)) throw new Error("Select an available Agent from this Workspace.");
    }
    if (current.selectedAgentId === params.agentId) return { saved: true, executionStarted: false, revision: current.revision };
    const updated = parseLeadAgentBinding({ ...current, selectedAgentId: params.agentId, revision: current.revision + 1 }, companyId);
    const state = platform.state as typeof platform.state & {
      compareAndSet?: (key: ReturnType<typeof leadAgentKey>, expected: { exists: false } | { exists: true; value: JsonValue },
        value: JsonValue) => Promise<unknown>;
    };
    if (!("compareAndSet" in platform.state) || typeof state.compareAndSet !== "function") {
      throw new Error("Unsupported Host: atomic state.compareAndSet is required to select a Lead Agent.");
    }
    const receipt = await state.compareAndSet(leadAgentKey(companyId), stored === null
      ? { exists: false }
      : { exists: true, value: stored }, updated as unknown as JsonValue);
    const receiptDescriptor = receipt && typeof receipt === "object" && !Array.isArray(receipt)
      && Object.getPrototypeOf(receipt) === Object.prototype && Reflect.ownKeys(receipt).length === 1
      && Reflect.ownKeys(receipt)[0] === "swapped"
      ? Object.getOwnPropertyDescriptor(receipt, "swapped")
      : undefined;
    if (!receiptDescriptor || !receiptDescriptor.enumerable || !("value" in receiptDescriptor)
      || typeof receiptDescriptor.value !== "boolean") {
      throw new TypeError("Invalid Host state.compareAndSet receipt.");
    }
    if (!receiptDescriptor.value) {
      throw new Error("Lead Agent selection changed. Refresh before saving.");
    }
    return { saved: true, executionStarted: false, revision: updated.revision };
  });
}

async function leadSessionsFor(companyId: string, binding: Awaited<ReturnType<typeof readLeadAgentBinding>>,
  platform: SpsPlatformInvocationContext): Promise<BuilderLeadSessions> {
  const stored = binding.selectedAgentId === null ? null : await platform.state.get({
    ...key(companyId), stateKey: `lead-sessions.v1.${binding.revision}`,
  });
  const value = parseLeadSessions(stored ?? { workspaceId: companyId, selectionRevision: binding.revision,
    agentId: binding.selectedAgentId, sessions: { main: null, "cto-inbox": null, decisions: null } }, companyId);
  if (value.selectionRevision !== binding.revision || value.agentId !== binding.selectedAgentId) {
    throw new Error("Lead session selection does not match the saved Agent.");
  }
  return value;
}

async function assertLeadSelection(companyId: string, binding: Awaited<ReturnType<typeof readLeadAgentBinding>>,
  platform: SpsPlatformInvocationContext) {
  const current = await readLeadAgentBinding(companyId, platform);
  if (current.revision !== binding.revision || current.selectedAgentId !== binding.selectedAgentId) {
    throw new Error("Lead Agent selection changed. Refresh before preparing sessions.");
  }
}

export async function readLeadSessions(companyId: string, platform: SpsPlatformInvocationContext) {
  workspaceId(companyId);
  const binding = await readLeadAgentBinding(companyId, platform);
  const result = await leadSessionsFor(companyId, binding, platform);
  await assertLeadSelection(companyId, binding, platform);
  return result;
}

export async function prepareLeadSessions(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  workspaceId(companyId);
  if (Object.keys(params).sort().join(",") !== "agentId,expectedRevision"
    || typeof params.agentId !== "string" || !UUID.test(params.agentId)
    || !Number.isSafeInteger(params.expectedRevision) || (params.expectedRevision as number) < 0) {
    throw new TypeError("Lead session preparation requires the displayed Agent selection.");
  }
  return serialize(companyId, async () => {
    const binding = await readLeadAgentBinding(companyId, platform);
    if (binding.revision !== params.expectedRevision || binding.selectedAgentId !== params.agentId) {
      throw new Error("Lead Agent selection changed. Refresh before preparing sessions.");
    }
    const options = await readLeadAgentOptions(companyId, platform);
    if (!options.agents.some(agent => agent.id === params.agentId && ["idle", "running"].includes(agent.status))) {
      throw new Error("Select an available Agent from this Workspace.");
    }
    let current = await leadSessionsFor(companyId, binding, platform);
    const stateKey = { ...key(companyId), stateKey: `lead-sessions.v1.${binding.revision}` };
    for (const channel of LEAD_CHANNELS) {
      await assertLeadSelection(companyId, binding, platform);
      const knownId = current.sessions[channel];
      // Core owns atomic key recovery; never emulate ensure with create/list or send.
      const result = await platform.agents.sessions.ensure(params.agentId as string, companyId, {
        taskKey: `plugin:com.sonparkserver.my-plugin-builder:session:lead:${binding.revision}:${channel}`,
        ...(knownId === null ? {} : { expectedSessionId: knownId }),
      });
      if (!result || Object.keys(result).sort().join(",") !== "created,sessionId" || typeof result.created !== "boolean"
        || typeof result.sessionId !== "string" || !UUID.test(result.sessionId)
        || knownId !== null && (result.sessionId !== knownId || result.created !== false)) throw new Error("Invalid Host session ensure result.");
      await assertLeadSelection(companyId, binding, platform);
      const updated = parseLeadSessions({ ...current, sessions: { ...current.sessions, [channel]: result.sessionId } }, companyId);
      if (knownId === null) await platform.state.set(stateKey, updated as unknown as JsonValue);
      current = updated;
    }
    await assertLeadSelection(companyId, binding, platform);
    return { saved: true, executionStarted: false, sessionsReady: true };
  });
}

/** A separate, explicit v2 start. The v1 action above remains unchanged. */
export async function prepareLeadContexts(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  workspaceId(companyId);
  if (Object.keys(params).sort().join(",") !== "agentId,expectedRevision,requestId"
    || typeof params.agentId !== "string" || !UUID.test(params.agentId)
    || !Number.isSafeInteger(params.expectedRevision) || (params.expectedRevision as number) < 1
    || typeof params.requestId !== "string" || !UUID.test(params.requestId)) {
    throw new TypeError("Lead context preparation requires an explicit request ID and the displayed Lead selection.");
  }
  const agentId = params.agentId;
  const expectedRevision = params.expectedRevision as number;
  const requestId = params.requestId;
  return serialize(companyId, async () => {
    const binding = await readLeadAgentBinding(companyId, platform);
    if (binding.revision !== expectedRevision || binding.selectedAgentId !== agentId) {
      throw new Error("Lead Agent selection changed. Refresh before starting Lead contexts.");
    }
    const options = await readLeadAgentOptions(companyId, platform);
    if (!options.agents.some(agent => agent.id === agentId && ["idle", "running"].includes(agent.status))) {
      throw new Error("Select an available Agent from this Workspace.");
    }
    let current = await beginLeadContextPreparation(companyId, agentId, expectedRevision, requestId, platform);
    if (current.status === "ready") {
      await assertLeadSelection(companyId, binding, platform);
      return { saved: true, requestId: current.requestId, status: "ready", contextsReady: true };
    }

    for (const context of LEAD_CONTEXTS) {
      const knownId = current.contexts[context];
      if (knownId !== null) continue;
      if (current.pendingContext !== context) {
        throw new Error("Lead context preparation has an unresolved request. Refresh its exact saved state before continuing.");
      }
      if (current.status === "uncertain") {
        throw new Error("Host session ensure is unresolved. No retry was attempted because the SDK does not guarantee recovery by taskKey; reconcile this exact context before continuing.");
      }
      await assertLeadSelection(companyId, binding, platform);
      // Persist the in-flight boundary before calling Host. If the worker or
      // response is lost, a later invocation must not guess that taskKey
      // recovery returns the same session: the public SDK does not promise it.
      current = parseLeadContexts({ ...current, status: "uncertain" }, companyId);
      await writeLeadContextProgress(companyId, current,
        LEAD_CONTEXTS.flatMap(name => current.contexts[name] === null ? [] : [current.contexts[name]!]), platform);
      let result: { created: boolean; sessionId: string };
      try {
        // taskKey identifies this Host operation; it is not a documented
        // recovery guarantee. Never accept a caller-provided session ID.
        result = await platform.agents.sessions.ensure(agentId, companyId, {
          taskKey: `plugin:com.sonparkserver.my-plugin-builder:session:lead:v2:${expectedRevision}:${context}`,
        });
        if (!result || Object.keys(result).sort().join(",") !== "created,sessionId"
          || typeof result.created !== "boolean" || typeof result.sessionId !== "string" || !UUID.test(result.sessionId)
          || Object.values(current.contexts).some(id => id?.toLowerCase() === result.sessionId.toLowerCase())) {
          throw new Error("Invalid or duplicate Host session ensure result.");
        }
      } catch {
        throw new Error("Host session ensure is unresolved. The exact context was kept; no automatic retry was attempted.");
      }
      await assertLeadSelection(companyId, binding, platform);
      const contexts = { ...current.contexts, [context]: result.sessionId };
      const index = LEAD_CONTEXTS.indexOf(context);
      if (index === LEAD_CONTEXTS.length - 1) {
        current = parseLeadContexts({ ...current, status: "ready", pendingContext: null, contexts }, companyId);
        await writeLeadContexts(companyId, current,
          LEAD_CONTEXTS.map(name => current.contexts[name]!), platform);
      } else {
        current = parseLeadContexts({ ...current, status: "preparing", pendingContext: LEAD_CONTEXTS[index + 1], contexts }, companyId);
        await writeLeadContextProgress(companyId, current,
          LEAD_CONTEXTS.flatMap(name => current.contexts[name] === null ? [] : [current.contexts[name]!]), platform);
      }
    }
    await assertLeadSelection(companyId, binding, platform);
    const saved = await readLeadContexts(companyId, platform);
    if (!saved || saved.requestId !== requestId || saved.status !== "ready") {
      throw new Error("Lead context preparation did not reach a durable ready state.");
    }
    return { saved: true, requestId, status: saved.status, contextsReady: true };
  });
}

function conversationInput(params: Record<string, unknown>, extra: readonly string[] = [], optional: readonly string[] = []) {
  const hasChannel = Object.hasOwn(params, "channel"), hasContext = Object.hasOwn(params, "contextId");
  const identity = hasContext ? "contextId" : "channel";
  const keys = [identity, ...extra];
  if (hasChannel === hasContext || keys.some(key => !Object.hasOwn(params, key))
    || Object.keys(params).some(key => ![...keys, ...optional].includes(key))) {
    throw new TypeError("Lead conversation requires one supported channel/context ID and exact fields.");
  }
  const value = params[identity];
  const allowed = identity === "contextId" ? LEAD_CONTEXTS : LEAD_CHANNELS;
  if (typeof value !== "string" || !allowed.includes(value as never)) throw new TypeError("Unsupported Lead conversation channel/context.");
  return value as LeadConversationId;
}

async function withConversation<T>(companyId: string, channel: LeadConversationId, platform: SpsPlatformInvocationContext,
  action: (store: ReturnType<typeof createLeadConversationStore>) => Promise<T>) {
  workspaceId(companyId);
  return serialize(companyId, async () => {
    const binding = await readLeadAgentBinding(companyId, platform);
    const logical = LEAD_CONTEXTS.includes(channel as typeof LEAD_CONTEXTS[number]);
    const sessions = logical ? await readLeadContexts(companyId, platform) : await leadSessionsFor(companyId, binding, platform);
    if (!sessions || logical && !("contexts" in sessions && sessions.status === "ready")) throw new Error("The selected Lead conversation is not ready.");
    const check = async () => {
      await assertLeadSelection(companyId, binding, platform);
      if (logical) {
        const current = await readLeadContexts(companyId, platform);
        if (!current || !("contexts" in sessions) || JSON.stringify(current) !== JSON.stringify(sessions)) {
          throw new Error("Lead context binding changed. Refresh without automatically resending.");
        }
      } else {
        const current = await leadSessionsFor(companyId, binding, platform);
        if (!("sessions" in sessions) || LEAD_CHANNELS.some(legacyChannel => current.sessions[legacyChannel] !== sessions.sessions[legacyChannel])) {
          throw new Error("Lead session binding changed. Refresh without automatically resending.");
        }
      }
    };
    await check();
    const beforeDispatch = async (questionContext?: import("./domain/question-context.ts").QuestionContext) => {
      await check();
      const options = await readLeadAgentOptions(companyId, platform);
      if (!options.agents.some(agent => agent.id === binding.selectedAgentId && ["idle", "running"].includes(agent.status))) {
        throw new Error("The selected Lead Agent is unavailable. Existing history has been kept.");
      }
      if (questionContext) {
        const current = await readCurrentDesignDraft(companyId, questionContext.projectId, platform);
        if (!current || current.revision.draft.revisionId !== questionContext.draftRevisionId
          || !current.revision.draft.questions.some(question => question.id === questionContext.questionId)
          || current.revision.decisions?.some(decision => decision.questionId === questionContext.questionId)) {
          throw new Error("The selected question or design revision changed. Refresh before answering.");
        }
      }
      await check();
      if (!logical) return;
      const [baseline, currentDraft, userQuestions, sharedMemory] = await Promise.all([
        readDesignBaseline(companyId, companyId, platform),
        readCurrentDesignDraft(companyId, companyId, platform),
        readUserCtoQuestions(companyId, companyId, platform),
        createLeadMemoryStore(companyId, companyId, platform.state).current(),
      ]);
      const references = {
        workspaceId: companyId,
        approvedBaseline: baseline ? {
          revisionId: baseline.revision.revisionId,
          specificationRevisionId: baseline.revision.specification.revisionId,
          graphRevisionId: baseline.revision.graph.graphRevisionId,
          userDecision: baseline.revision.userDecision.interpretation.slice(0, 2_000),
          requirements: baseline.revision.specification.requirements.slice(0, 40)
            .map(requirement => ({ id: requirement.id, description: requirement.description.slice(0, 512) })),
          omittedRequirementCount: Math.max(0, baseline.revision.specification.requirements.length - 40),
        } : null,
        currentDesignDraft: currentDraft ? {
          revisionId: currentDraft.revision.draft.revisionId,
          decisions: currentDraft.revision.decisions?.slice(-40).map(decision => ({
            questionId: decision.questionId, answerSourceId: decision.answerSourceId,
            answerText: decision.answerText.slice(0, 512), appliedDraftRevisionId: decision.appliedDraftRevisionId,
          })) ?? [],
          openQuestions: currentDraft.revision.draft.questions.filter(question => !currentDraft.revision.decisions
            ?.some(decision => decision.questionId === question.id)).slice(0, 20)
            .map(question => ({ id: question.id, text: question.text.slice(0, 512) })),
        } : null,
        userDecisionQuestions: userQuestions?.board.questions.slice(-32).map(question => ({
          id: question.proposal.id, title: question.proposal.title, context: question.proposal.context.slice(0, 512),
          disposition: question.review?.disposition ?? null, rationale: question.review?.rationale.slice(0, 512) ?? null,
        })) ?? [],
        sharedProjectMemory: sharedMemory?.revision.memory.entries.slice(0, 40).map(entry => ({
          id: entry.id, kind: entry.kind, text: entry.text.slice(0, 512), sourceIds: entry.sourceIds,
        })) ?? [],
      };
      const encoded = JSON.stringify(references);
      return Buffer.byteLength(encoded, "utf8") <= 14 * 1024 ? encoded
        : JSON.stringify({ workspaceId: companyId, baselineRevisionId: baseline?.revision.revisionId ?? null,
          draftRevisionId: currentDraft?.revision.draft.revisionId ?? null,
          userDecisionQuestionRevisionId: userQuestions?.board.revisionId ?? null,
          note: "Reference summary exceeded the bounded prompt context; read exact records with the provided Builder tools." });
    };
    return action(createLeadConversationStore(platform, sessions, check, beforeDispatch));
  });
}

export async function readLeadConversation(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  const channel = conversationInput(params, ["cursor"], ["channel", "contextId"]);
  if (params.cursor !== null && (typeof params.cursor !== "string" || !UUID.test(params.cursor))) throw new TypeError("Invalid conversation cursor.");
  return withConversation(companyId, channel, platform, store => store.page(channel, params.cursor as string | null));
}
export async function sendLeadMessage(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  const channel = conversationInput(params, ["requestId", "text"], ["channel", "contextId", "questionContext"]);
  if (channel === "cto-inbox") throw new Error("The internal Lead intake channel does not accept user messages.");
  if (["background_planning", "question_intake"].includes(channel)) throw new Error("This Lead context does not accept direct user messages.");
  const questionContext = Object.hasOwn(params, "questionContext") ? parseQuestionContext(params.questionContext) : undefined;
  if ((questionContext && channel !== "decisions" && channel !== "question_discussion")
    || channel === "question_discussion" && !questionContext) throw new Error("Question Discussion messages require their exact question and design Revision context.");
  if (typeof params.requestId !== "string" || !UUID.test(params.requestId) || typeof params.text !== "string") throw new TypeError("Invalid Lead message.");
  return withConversation(companyId, channel, platform, store => store.send(channel, params.requestId as string, params.text as string, questionContext));
}
export async function refreshLeadConversation(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  const channel = conversationInput(params);
  return withConversation(companyId, channel, platform, store => store.refresh(channel));
}
export async function cancelLeadMessage(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  const channel = conversationInput(params);
  return withConversation(companyId, channel, platform, store => store.cancel(channel));
}
export async function resumePreparedLeadMessage(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  const channel = conversationInput(params, ["requestId"]);
  if (["cto-inbox", "background_planning", "question_intake"].includes(channel) || typeof params.requestId !== "string" || !UUID.test(params.requestId)) throw new TypeError("Invalid prepared message.");
  return withConversation(companyId, channel, platform, store => store.resumePrepared(channel, params.requestId as string));
}

function userActionInput(params: Record<string, unknown>, context: { companyId: string; actor: { type: string; companyId: string } }) {
  if (context.actor.type !== "user" || context.actor.companyId !== context.companyId) {
    throw new Error("Builder settings and input require an authenticated user action.");
  }
  if (Object.hasOwn(params, "companyId") && params.companyId !== context.companyId) {
    throw new Error("Action metadata must match the trusted Workspace.");
  }
  const input = { ...params };
  delete input.companyId;
  return input;
}

/** Called only by the registered tool with Host-verified run metadata, never a UI action. */
export async function readLeadSolution(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId"]);
  const context = parseLeadToolContext(runContext);
  if (typeof input.projectId !== "string" || !input.projectId.trim() || input.projectId.length > 160
    || /[\u0000-\u001f\u007f]/.test(input.projectId)) throw new TypeError("A bounded Builder project ID is required.");
  const companyId = context.companyId as string;
  const projectId = input.projectId;
  return serialize(companyId, async () => {
    const { check } = await resolveLeadToolAuthority(context, platform);
    await check();
    const baseline = await readDesignBaseline(companyId, projectId, platform);
    const solution = baseline ? { sequence: baseline.sequence, revision: baseline.revision.graph }
      : await createSolutionRevisionStore(companyId, projectId, platform.state).current();
    await check();
    return { content: solution === null ? "No stored solution revision exists for this Builder project."
      : "Stored solution revision. Customer approval and delivery have not been verified by this read.",
    data: { projectId, solution } as unknown as JsonValue };
  });
}

/** Persist only an unapproved proposal. The model interprets sources; this
 * boundary verifies that the cited user input actually belongs to this scope. */
export async function proposeLeadDesign(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "expectedBaseRevisionId", "draft"]);
  const context = parseLeadToolContext(runContext);
  if (typeof input.projectId !== "string") throw new TypeError("A Builder project ID is required.");
  const draft = parseDesignDraft(input.draft, input.projectId);
  const expectedBaseRevisionId = input.expectedBaseRevisionId;
  if (expectedBaseRevisionId !== null && (typeof expectedBaseRevisionId !== "string" || !expectedBaseRevisionId.trim()
    || expectedBaseRevisionId.length > 160 || /[\u0000-\u001f\u007f]/.test(expectedBaseRevisionId))) {
    throw new TypeError("An exact prior draft revision ID or null is required.");
  }
  return serialize(context.companyId, async () => {
    const authority = await resolveLeadToolAuthority(context, platform);
    await authority.check();
    const snapshot = await readBuilderSnapshot(context.companyId, platform);
    const sourceDigests = [];
    for (const id of draft.sourceIds) {
      const source = id.startsWith("lead-turn:")
        ? await readLeadUserSource(id.slice("lead-turn:".length), authority.conversationSessions, platform)
        : snapshot.messages.find(message => message.id === id && message.role === "user" && message.channel === "main");
      if (!source || typeof source.text !== "string" || !source.text.trim()) {
        throw new Error("The draft cites unavailable user input in this Workspace/Lead selection.");
      }
      sourceDigests.push({ id, sha256: createHash("sha256").update(source.text, "utf8").digest("hex") });
    }
    await authority.check();
    const state = platform.state as typeof platform.state & RevisionState;
    const guardedState = {
      get: async (key: Parameters<typeof state.get>[0]) => {
        await authority.check(); const value = await state.get(key); await authority.check(); return value;
      },
      compareAndSet: state.compareAndSet ? async (...args: Parameters<NonNullable<typeof state.compareAndSet>>) => {
        await authority.check(); const result = await state.compareAndSet!(...args); await authority.check(); return result;
      } : undefined,
    };
    const authored: AuthoredDesignDraft = { status: "draft", selectionRevision: authority.selectionRevision,
      author: { agentId: context.agentId, sessionId: context.sessionId, runId: context.runId },
      sourceDigests, createdAt: new Date().toISOString(), draft };
    const store = createDesignDraftStore(context.companyId, draft.projectId,
      { selectionRevision: authority.selectionRevision, agentId: context.agentId }, guardedState);
    const current = await store.current();
    const result = await store.publish({ expectedBaseRevisionId, revision: { ...authored,
      ...(current?.revision.decisions ? { decisions: current.revision.decisions } : {}) } });
    await authority.check();
    return { content: result.status === "published" ? "Design draft stored. It is not customer approval, execution authorization, QA acceptance or delivery."
      : "Design draft changed. Read the current draft before proposing a new revision; do not automatically retry.",
    data: result as unknown as JsonValue };
  });
}

export async function readCurrentDesignDraft(companyId: string, projectId: string, platform: SpsPlatformInvocationContext) {
  workspaceId(companyId);
  const binding = await readLeadAgentBinding(companyId, platform);
  if (!binding.selectedAgentId) return null;
  const current = await createDesignDraftStore(companyId, projectId,
    { selectionRevision: binding.revision, agentId: binding.selectedAgentId }, platform.state).current();
  await assertLeadSelection(companyId, binding, platform);
  return current;
}

export async function readLeadDesignDraft(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId"]);
  const context = parseLeadToolContext(runContext);
  if (typeof input.projectId !== "string" || !input.projectId.trim() || input.projectId.length > 160
    || /[\u0000-\u001f\u007f]/.test(input.projectId)) throw new TypeError("A Builder project ID is required.");
  const projectId = input.projectId;
  return serialize(context.companyId, async () => {
    const authority = await resolveLeadToolAuthority(context, platform);
    await authority.check();
    const current = await readCurrentDesignDraft(context.companyId, projectId, platform);
    await authority.check();
    return { content: "Current unapproved design draft. No approval, execution or delivery is implied.",
      data: { projectId, current } as unknown as JsonValue };
  });
}

export async function readLeadDesignSources(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["channel", "cursor"]);
  const context = parseLeadToolContext(runContext);
  if (!["consultation", "main", "decisions"].includes(input.channel as string)
    || input.cursor !== null && typeof input.cursor !== "string") throw new TypeError("A supported user-input channel and cursor are required.");
  const channel = input.channel as "consultation" | "main" | "decisions";
  const cursor = input.cursor as string | null;
  return serialize(context.companyId, async () => {
    const authority = await resolveLeadToolAuthority(context, platform);
    await authority.check();
    let source: { id: string; text: string; questionContext?: import("./domain/question-context.ts").QuestionContext } | null = null;
    let nextCursor: string | null = null;
    if (channel === "consultation") {
      const snapshot = await readBuilderSnapshot(context.companyId, platform);
      const sources = snapshot.messages.filter(message => message.role === "user" && message.channel === "main"
        && /^consultation-[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$/.test(message.id)).reverse();
      const index = cursor === null ? 0 : sources.findIndex(message => message.id === cursor);
      if (index < 0) throw new Error("The consultation source cursor is unavailable in this Workspace.");
      const message = sources[index];
      source = message ? { id: message.id, text: message.text } : null;
      nextCursor = sources[index + 1]?.id ?? null;
    } else {
      if (cursor !== null && (!UUID.test(cursor) || cursor !== cursor.toLowerCase())) throw new TypeError("Invalid user-message cursor.");
      const conversationId = authority.contexts
        ? channel === "main" ? "user_conversation" : "question_discussion"
        : channel;
      const sourceSessions = authority.conversationSessions;
      if (authority.contexts
        ? !authority.contexts.contexts[conversationId as typeof LEAD_CONTEXTS[number]]
        : !authority.sessions?.sessions[channel]) throw new Error("This Lead input context is not prepared.");
      const page = await createLeadConversationStore(platform, sourceSessions, authority.check).page(conversationId, cursor);
      const turn = page.turns[0];
      source = turn ? { id: `lead-turn:${turn.requestId}`, text: turn.text,
        ...(turn.questionContext ? { questionContext: turn.questionContext } : {}) } : null;
      nextCursor = turn?.previousRequestId ?? null;
    }
    await authority.check();
    return { content: "User-provided source page only. Not an approval or instruction to execute code.",
      data: { workspaceId: context.companyId, projectId: context.companyId, channel,
        sources: source ? [source] : [], nextCursor } as unknown as JsonValue };
  });
}

export async function readSharedLeadMemory(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => readLeadMemory(params, context, platform));
}

export async function updateSharedLeadMemory(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => updateLeadMemory(params, context, platform, readBuilderSnapshot));
}

export async function resolveLeadDesignQuestion(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => resolveDesignQuestion(params, context, platform, readBuilderSnapshot));
}

export async function createLeadCto(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => createProjectCto(params, context, platform));
}
export async function readLeadCtos(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => listProjectCtos(params, context, platform));
}
export async function publishLeadDesignBaseline(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => publishDesignBaseline(params, context, platform));
}
export async function readLeadBaseline(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => readLeadDesignBaseline(params, context, platform));
}
export async function publishLeadTechnologyDecisions(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => publishTechnologyDecisions(params, context, platform));
}
export async function readLeadTechnologyRegister(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => readLeadTechnologyDecisions(params, context, platform));
}
export async function publishLeadWorkstream(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => publishWorkstream(params, context, platform));
}
export async function readWorkstreamBoardAsLead(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => readLeadWorkstreams(params, context, platform));
}
export async function readAssignedCtoWorkstream(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => readCtoWorkstream(params, context, platform));
}
export async function acknowledgeAssignedWorkstream(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => acknowledgeWorkstream(params, context, platform));
}
export async function dispatchLeadWorkstream(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => dispatchCtoWorkstream(params, runContext, platform));
}
export async function readLeadWorkstreamDelivery(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => inspectCtoWorkstreamDelivery(params, runContext, platform));
}
export async function cancelLeadWorkstreamDelivery(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => inspectCtoWorkstreamDelivery(params, runContext, platform, true));
}
export async function readAssignedCtoMemory(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => readCtoMemory(params, context, platform));
}
export async function updateAssignedCtoMemory(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => updateCtoMemory(params, context, platform));
}
export async function readAssignedCtoTaskPackets(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => readCtoTaskPackets(params, context, platform));
}
export async function publishAssignedCtoTaskPacket(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => publishCtoTaskPacket(params, context, platform));
}
export async function submitAssignedCtoQuestion(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, async () => {
    const result = await submitCtoQuestion(params, context, platform);
    const data = result.data as { status: string; questionId: string };
    if (!["published", "existing"].includes(data.status)) return result;
    const { aiDispatched: _storageOnlyFlag, ...proposalReceipt } = result.data as Record<string, JsonValue>;
    const input = exactToolRecord(params, ["projectId", "ctoId", "workstreamId", "expectedBaseRevisionId", "revisionId", "proposal"]);
    try {
      const intake = await dispatchQuestionToLead({ projectId: input.projectId, ctoId: input.ctoId,
        workstreamId: input.workstreamId, questionId: data.questionId }, context, platform);
      return { content: "The CTO proposal is stored. " + intake.content,
        data: { ...proposalReceipt, intake: intake.data, userQuestionCreated: false } as JsonValue };
    } catch {
      // Storage may already have committed; an unknown send must never trigger a replacement.
      return { content: "The CTO proposal is stored, but Lead delivery is unconfirmed. Observe the saved request; do not automatically repeat submission or treat this as a user decision.",
        data: { ...proposalReceipt, intake: { status: "unconfirmed", automaticallyResent: false }, userQuestionCreated: false } as JsonValue };
    }
  });
}
export async function readCtoQuestionIntake(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => readCtoQuestions(params, context, platform));
}
export async function readOwnCtoQuestionReceipt(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => readOwnCtoQuestion(params, context, platform));
}
export async function readBoundCtoQuestionIntake(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => readBoundCtoIntake(params, context, platform));
}
export async function answerCtoQuestionIntake(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => answerCtoQuestion(params, context, platform));
}
export async function readCtoQuestionAnswerForCto(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => readCtoQuestionAnswer(params, context, platform));
}
export async function acknowledgeCtoQuestionAnswerForCto(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => acknowledgeCtoQuestionAnswer(params, context, platform));
}
export async function reviewCtoQuestionIntake(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(runContext);
  return serialize(context.companyId, () => reviewCtoQuestion(params, context, platform));
}

export function createBuilderPlatform() {
  return defineSpsPlatformContract({
    capabilities: ["plugin.state.read", "plugin.state.write", "agent.tools.register", "agents.read", "agent.sessions.create",
      "agent.sessions.send", "agent.sessions.read", "agent.sessions.cancel"],
    tools: [{ name: READ_SOLUTION_TOOL.name, declaration: { displayName: READ_SOLUTION_TOOL.displayName,
      description: READ_SOLUTION_TOOL.description, parametersSchema: READ_SOLUTION_TOOL.parametersSchema },
    handler: (params, context, platform) => readLeadSolution(params, context, platform) },
    { name: PROPOSE_DESIGN_TOOL.name, declaration: { displayName: PROPOSE_DESIGN_TOOL.displayName,
      description: PROPOSE_DESIGN_TOOL.description, parametersSchema: PROPOSE_DESIGN_TOOL.parametersSchema },
    handler: (params, context, platform) => proposeLeadDesign(params, context, platform) },
    { name: READ_DESIGN_DRAFT_TOOL.name, declaration: { displayName: READ_DESIGN_DRAFT_TOOL.displayName,
      description: READ_DESIGN_DRAFT_TOOL.description, parametersSchema: READ_DESIGN_DRAFT_TOOL.parametersSchema },
    handler: (params, context, platform) => readLeadDesignDraft(params, context, platform) },
    { name: READ_DESIGN_SOURCES_TOOL.name, declaration: { displayName: READ_DESIGN_SOURCES_TOOL.displayName,
      description: READ_DESIGN_SOURCES_TOOL.description, parametersSchema: READ_DESIGN_SOURCES_TOOL.parametersSchema },
    handler: (params, context, platform) => readLeadDesignSources(params, context, platform) },
    { name: READ_LEAD_MEMORY_TOOL.name, declaration: { displayName: READ_LEAD_MEMORY_TOOL.displayName,
      description: READ_LEAD_MEMORY_TOOL.description, parametersSchema: READ_LEAD_MEMORY_TOOL.parametersSchema },
    handler: (params, context, platform) => readSharedLeadMemory(params, context, platform) },
    { name: UPDATE_LEAD_MEMORY_TOOL.name, declaration: { displayName: UPDATE_LEAD_MEMORY_TOOL.displayName,
      description: UPDATE_LEAD_MEMORY_TOOL.description, parametersSchema: UPDATE_LEAD_MEMORY_TOOL.parametersSchema },
    handler: (params, context, platform) => updateSharedLeadMemory(params, context, platform) },
    { name: RESOLVE_DESIGN_QUESTION_TOOL.name, declaration: { displayName: RESOLVE_DESIGN_QUESTION_TOOL.displayName,
      description: RESOLVE_DESIGN_QUESTION_TOOL.description, parametersSchema: RESOLVE_DESIGN_QUESTION_TOOL.parametersSchema },
    handler: (params, context, platform) => resolveLeadDesignQuestion(params, context, platform) },
    { name: CREATE_CTO_TOOL.name, declaration: { displayName: CREATE_CTO_TOOL.displayName,
      description: CREATE_CTO_TOOL.description, parametersSchema: CREATE_CTO_TOOL.parametersSchema },
      handler: (params, context, platform) => createLeadCto(params, context, platform) },
    { name: LIST_CTOS_TOOL.name, declaration: { displayName: LIST_CTOS_TOOL.displayName,
      description: LIST_CTOS_TOOL.description, parametersSchema: LIST_CTOS_TOOL.parametersSchema },
      handler: (params, context, platform) => readLeadCtos(params, context, platform) },
    { name: PUBLISH_DESIGN_BASELINE_TOOL.name, declaration: { displayName: PUBLISH_DESIGN_BASELINE_TOOL.displayName,
      description: PUBLISH_DESIGN_BASELINE_TOOL.description, parametersSchema: PUBLISH_DESIGN_BASELINE_TOOL.parametersSchema },
      handler: (params, context, platform) => publishLeadDesignBaseline(params, context, platform) },
    { name: READ_DESIGN_BASELINE_TOOL.name, declaration: { displayName: READ_DESIGN_BASELINE_TOOL.displayName,
      description: READ_DESIGN_BASELINE_TOOL.description, parametersSchema: READ_DESIGN_BASELINE_TOOL.parametersSchema },
      handler: (params, context, platform) => readLeadBaseline(params, context, platform) },
    { name: PUBLISH_TECHNOLOGY_DECISIONS_TOOL.name, declaration: { displayName: PUBLISH_TECHNOLOGY_DECISIONS_TOOL.displayName,
      description: PUBLISH_TECHNOLOGY_DECISIONS_TOOL.description, parametersSchema: PUBLISH_TECHNOLOGY_DECISIONS_TOOL.parametersSchema },
      handler: (params, context, platform) => publishLeadTechnologyDecisions(params, context, platform) },
    { name: READ_TECHNOLOGY_DECISIONS_TOOL.name, declaration: { displayName: READ_TECHNOLOGY_DECISIONS_TOOL.displayName,
      description: READ_TECHNOLOGY_DECISIONS_TOOL.description, parametersSchema: READ_TECHNOLOGY_DECISIONS_TOOL.parametersSchema },
      handler: (params, context, platform) => readLeadTechnologyRegister(params, context, platform) },
    { name: PUBLISH_WORKSTREAM_TOOL.name, declaration: { displayName: PUBLISH_WORKSTREAM_TOOL.displayName,
      description: PUBLISH_WORKSTREAM_TOOL.description, parametersSchema: PUBLISH_WORKSTREAM_TOOL.parametersSchema },
      handler: (params, context, platform) => publishLeadWorkstream(params, context, platform) },
    { name: READ_WORKSTREAMS_TOOL.name, declaration: { displayName: READ_WORKSTREAMS_TOOL.displayName,
      description: READ_WORKSTREAMS_TOOL.description, parametersSchema: READ_WORKSTREAMS_TOOL.parametersSchema },
      handler: (params, context, platform) => readWorkstreamBoardAsLead(params, context, platform) },
    { name: READ_CTO_WORKSTREAM_TOOL.name, declaration: { displayName: READ_CTO_WORKSTREAM_TOOL.displayName,
      description: READ_CTO_WORKSTREAM_TOOL.description, parametersSchema: READ_CTO_WORKSTREAM_TOOL.parametersSchema },
      handler: (params, context, platform) => readAssignedCtoWorkstream(params, context, platform) },
    { name: ACKNOWLEDGE_WORKSTREAM_TOOL.name, declaration: { displayName: ACKNOWLEDGE_WORKSTREAM_TOOL.displayName,
      description: ACKNOWLEDGE_WORKSTREAM_TOOL.description, parametersSchema: ACKNOWLEDGE_WORKSTREAM_TOOL.parametersSchema },
      handler: (params, context, platform) => acknowledgeAssignedWorkstream(params, context, platform) },
    { name: DISPATCH_CTO_WORKSTREAM_TOOL.name, declaration: { displayName: DISPATCH_CTO_WORKSTREAM_TOOL.displayName,
      description: DISPATCH_CTO_WORKSTREAM_TOOL.description, parametersSchema: DISPATCH_CTO_WORKSTREAM_TOOL.parametersSchema },
      handler: (params, context, platform) => dispatchLeadWorkstream(params, context, platform) },
    { name: READ_CTO_WORKSTREAM_DELIVERY_TOOL.name, declaration: { displayName: READ_CTO_WORKSTREAM_DELIVERY_TOOL.displayName,
      description: READ_CTO_WORKSTREAM_DELIVERY_TOOL.description, parametersSchema: READ_CTO_WORKSTREAM_DELIVERY_TOOL.parametersSchema },
      handler: (params, context, platform) => readLeadWorkstreamDelivery(params, context, platform) },
    { name: CANCEL_CTO_WORKSTREAM_DELIVERY_TOOL.name, declaration: { displayName: CANCEL_CTO_WORKSTREAM_DELIVERY_TOOL.displayName,
      description: CANCEL_CTO_WORKSTREAM_DELIVERY_TOOL.description, parametersSchema: CANCEL_CTO_WORKSTREAM_DELIVERY_TOOL.parametersSchema },
      handler: (params, context, platform) => cancelLeadWorkstreamDelivery(params, context, platform) },
    { name: READ_CTO_MEMORY_TOOL.name, declaration: { displayName: READ_CTO_MEMORY_TOOL.displayName,
      description: READ_CTO_MEMORY_TOOL.description, parametersSchema: READ_CTO_MEMORY_TOOL.parametersSchema },
      handler: (params, context, platform) => readAssignedCtoMemory(params, context, platform) },
    { name: UPDATE_CTO_MEMORY_TOOL.name, declaration: { displayName: UPDATE_CTO_MEMORY_TOOL.displayName,
      description: UPDATE_CTO_MEMORY_TOOL.description, parametersSchema: UPDATE_CTO_MEMORY_TOOL.parametersSchema },
      handler: (params, context, platform) => updateAssignedCtoMemory(params, context, platform) },
    { name: SUBMIT_CTO_QUESTION_TOOL.name, declaration: { displayName: SUBMIT_CTO_QUESTION_TOOL.displayName,
      description: SUBMIT_CTO_QUESTION_TOOL.description, parametersSchema: SUBMIT_CTO_QUESTION_TOOL.parametersSchema },
      handler: (params, context, platform) => submitAssignedCtoQuestion(params, context, platform) },
    { name: READ_CTO_QUESTIONS_TOOL.name, declaration: { displayName: READ_CTO_QUESTIONS_TOOL.displayName,
      description: READ_CTO_QUESTIONS_TOOL.description, parametersSchema: READ_CTO_QUESTIONS_TOOL.parametersSchema },
      handler: (params, context, platform) => readCtoQuestionIntake(params, context, platform) },
    { name: READ_CTO_INTAKE_TOOL.name, declaration: { displayName: READ_CTO_INTAKE_TOOL.displayName,
      description: READ_CTO_INTAKE_TOOL.description, parametersSchema: READ_CTO_INTAKE_TOOL.parametersSchema },
      handler: (params, context, platform) => readBoundCtoQuestionIntake(params, context, platform) },
    { name: READ_OWN_CTO_QUESTION_TOOL.name, declaration: { displayName: READ_OWN_CTO_QUESTION_TOOL.displayName,
      description: READ_OWN_CTO_QUESTION_TOOL.description, parametersSchema: READ_OWN_CTO_QUESTION_TOOL.parametersSchema },
      handler: (params, context, platform) => readOwnCtoQuestionReceipt(params, context, platform) },
    { name: ANSWER_CTO_QUESTION_TOOL.name, declaration: { displayName: ANSWER_CTO_QUESTION_TOOL.displayName,
      description: ANSWER_CTO_QUESTION_TOOL.description, parametersSchema: ANSWER_CTO_QUESTION_TOOL.parametersSchema },
      handler: (params, context, platform) => answerCtoQuestionIntake(params, context, platform) },
    { name: READ_CTO_QUESTION_ANSWER_TOOL.name, declaration: { displayName: READ_CTO_QUESTION_ANSWER_TOOL.displayName,
      description: READ_CTO_QUESTION_ANSWER_TOOL.description, parametersSchema: READ_CTO_QUESTION_ANSWER_TOOL.parametersSchema },
      handler: (params, context, platform) => readCtoQuestionAnswerForCto(params, context, platform) },
    { name: ACKNOWLEDGE_CTO_QUESTION_ANSWER_TOOL.name, declaration: { displayName: ACKNOWLEDGE_CTO_QUESTION_ANSWER_TOOL.displayName,
      description: ACKNOWLEDGE_CTO_QUESTION_ANSWER_TOOL.description, parametersSchema: ACKNOWLEDGE_CTO_QUESTION_ANSWER_TOOL.parametersSchema },
      handler: (params, context, platform) => acknowledgeCtoQuestionAnswerForCto(params, context, platform) },
    { name: REVIEW_CTO_QUESTION_TOOL.name, declaration: { displayName: REVIEW_CTO_QUESTION_TOOL.displayName,
      description: REVIEW_CTO_QUESTION_TOOL.description, parametersSchema: REVIEW_CTO_QUESTION_TOOL.parametersSchema },
      handler: (params, context, platform) => reviewCtoQuestionIntake(params, context, platform) },
    { name: READ_CTO_TASK_PACKETS_TOOL.name, declaration: { displayName: READ_CTO_TASK_PACKETS_TOOL.displayName,
      description: READ_CTO_TASK_PACKETS_TOOL.description, parametersSchema: READ_CTO_TASK_PACKETS_TOOL.parametersSchema },
      handler: (params, context, platform) => readAssignedCtoTaskPackets(params, context, platform) },
    { name: PUBLISH_CTO_TASK_PACKET_TOOL.name, declaration: { displayName: PUBLISH_CTO_TASK_PACKET_TOOL.displayName,
      description: PUBLISH_CTO_TASK_PACKET_TOOL.description, parametersSchema: PUBLISH_CTO_TASK_PACKET_TOOL.parametersSchema },
      handler: (params, context, platform) => publishAssignedCtoTaskPacket(params, context, platform) }],
    data: [{ key: "builder.workstreams", handler: async (params, platform) => {
      const companyId = workspaceId(params.companyId);
      if (typeof params.projectId !== "string") throw new TypeError("A Builder project ID is required.");
      const current = await readWorkstreams(companyId, params.projectId, platform);
      return current && { workspaceId: companyId, projectId: params.projectId, sequence: current.sequence,
        board: current.revision } as unknown as JsonValue;
    } }, { key: "builder.technology-decisions", handler: async (params, platform) => {
      const companyId = workspaceId(params.companyId);
      if (typeof params.projectId !== "string") throw new TypeError("A Builder project ID is required.");
      const current = await readTechnologyDecisions(companyId, params.projectId, platform);
      return current && { workspaceId: companyId, projectId: params.projectId, sequence: current.sequence,
        record: current.revision } as unknown as JsonValue;
    } }, { key: "builder.design-baseline", handler: async (params, platform) => {
      const companyId = workspaceId(params.companyId);
      if (typeof params.projectId !== "string") throw new TypeError("A Builder project ID is required.");
      const current = await readDesignBaseline(companyId, params.projectId, platform);
      return current && { workspaceId: companyId, projectId: params.projectId, sequence: current.sequence,
        baseline: current.revision } as unknown as JsonValue;
    } }, { key: "builder.project-ctos", handler: async (params, platform) => {
      const companyId = workspaceId(params.companyId);
      if (typeof params.projectId !== "string") throw new TypeError("A Builder project ID is required.");
      return await readProjectCtos(companyId, params.projectId, platform) as unknown as JsonValue;
    } }, { key: "builder.cto-user-decisions", handler: async (params, platform) => {
      const companyId = workspaceId(params.companyId);
      if (typeof params.projectId !== "string") throw new TypeError("A Builder project ID is required.");
      return await readUserCtoQuestions(companyId, params.projectId, platform) as unknown as JsonValue;
    } }, { key: "builder.snapshot", handler: async (params, platform) =>
      await readBuilderSnapshot(workspaceId(params.companyId), platform) as unknown as JsonValue },
    { key: "builder.lead-agents", handler: async (params, platform) =>
      await readLeadAgentOptions(workspaceId(params.companyId), platform) as unknown as JsonValue },
    { key: "builder.lead-sessions", handler: async (params, platform) =>
      await readLeadSessions(workspaceId(params.companyId), platform) as unknown as JsonValue },
    { key: "builder.lead-contexts", handler: async (params, platform) =>
      await readLeadContexts(workspaceId(params.companyId), platform) as unknown as JsonValue },
    { key: "builder.lead-memory", handler: async (params, platform) => {
      const companyId = workspaceId(params.companyId);
      if (typeof params.projectId !== "string") throw new TypeError("A Builder project ID is required.");
      const current = await createLeadMemoryStore(companyId, params.projectId, platform.state).current();
      return current && { workspaceId: companyId, projectId: params.projectId, sequence: current.sequence,
        createdAt: current.revision.createdAt, memory: current.revision.memory } as unknown as JsonValue;
    } },
    { key: "builder.design-draft", handler: async (params, platform) => {
      const companyId = workspaceId(params.companyId);
      if (typeof params.projectId !== "string") throw new TypeError("A Builder project ID is required.");
      const current = await readCurrentDesignDraft(companyId, params.projectId, platform);
      return current && { workspaceId: companyId, projectId: params.projectId, selectionRevision: current.revision.selectionRevision,
        agentId: current.revision.author.agentId, sequence: current.sequence, createdAt: current.revision.createdAt,
        draft: current.revision.draft,
        ...(current.revision.decisions ? { decisions: current.revision.decisions } : {}) } as unknown as JsonValue;
    } },
    { key: "builder.lead-conversation", handler: async (params, platform) => {
      // renderEnvironment is Host UI envelope metadata, not conversation input
      // or authority. It must not enter the strict domain payload or storage.
      const { companyId, renderEnvironment: _renderEnvironment, ...input } = params;
      return await readLeadConversation(workspaceId(companyId), input, platform) as unknown as JsonValue;
    } }],
    actions: [{ key: "builder.import-consultation", handler: async (params, context) => {
      // Core includes its authorized companyId in action parameters. It is
      // envelope metadata, never a user-selected destination or domain field.
      return importConsultation(context.companyId, userActionInput(params, context), context);
    } }, { key: "builder.select-lead-agent", handler: async (params, context) =>
      selectLeadAgent(context.companyId, userActionInput(params, context), context) },
    { key: "builder.prepare-lead-sessions", handler: async (params, context) =>
      prepareLeadSessions(context.companyId, userActionInput(params, context), context) },
    { key: "builder.prepare-lead-contexts", handler: async (params, context) =>
      prepareLeadContexts(context.companyId, userActionInput(params, context), context) },
    { key: "builder.send-lead-message", handler: async (params, context) =>
      sendLeadMessage(context.companyId, userActionInput(params, context), context) },
    { key: "builder.refresh-lead-conversation", handler: async (params, context) =>
      refreshLeadConversation(context.companyId, userActionInput(params, context), context) },
    { key: "builder.cancel-lead-message", handler: async (params, context) =>
      cancelLeadMessage(context.companyId, userActionInput(params, context), context) },
    { key: "builder.resume-prepared-lead-message", handler: async (params, context) =>
      resumePreparedLeadMessage(context.companyId, userActionInput(params, context), context) }],
  });
}
