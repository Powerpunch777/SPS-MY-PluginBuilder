import { createHash, randomUUID } from "node:crypto";
import { defineSpsPlatformContract, SPS_PLATFORM_CAPABILITIES } from "@sonparkserver/plugin-sdk/platform";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import type { BuilderSnapshot, BuilderLeadSessions } from "./domain/model.ts";
import { createEmptyBuilderSnapshot, parseBuilderSnapshot } from "./domain/snapshot.ts";
import { parseLeadAgentBinding, parseLeadAgentOptions } from "./domain/lead-agent.ts";
import { integrationManagerStateKey, parseIntegrationManagerBinding } from "./domain/integration-manager.ts";
import { prepareIntegrationManager, readIntegrationManagerOptions, selectIntegrationManager } from "./integration-manager-settings.ts";
import { LEAD_CHANNELS, parseLeadSessions } from "./domain/lead-sessions.ts";
import type { LeadChannel } from "./domain/model.ts";
import { createLeadConversationStore, readLeadUserSource } from "./lead-conversations.ts";
import { createRevisionJournal, createSolutionRevisionStore, type RevisionState } from "./solution-revision-store.ts";
import { READ_SOLUTION_TOOL, PROPOSE_DESIGN_TOOL, READ_DESIGN_DRAFT_TOOL, READ_DESIGN_SOURCES_TOOL, READ_LEAD_MEMORY_TOOL, UPDATE_LEAD_MEMORY_TOOL, RESOLVE_DESIGN_QUESTION_TOOL, CREATE_CTO_TOOL, LIST_CTOS_TOOL, PUBLISH_DESIGN_BASELINE_TOOL, READ_DESIGN_BASELINE_TOOL, INSPECT_SPEC_ASSURANCE_TOOL } from "./tool-declarations.mjs";
import { publishDesignBaseline, readLeadDesignBaseline, readDesignBaseline } from "./design-baseline-tools.ts";
import { createCurrentBaselineAssuranceProvider } from "./spec-assurance/current-baseline-provider.ts";
import { createSpecAssuranceConsumer } from "./spec-assurance/evaluator.ts";
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
import { READ_CTO_TASK_PACKETS_TOOL, PUBLISH_CTO_TASK_PACKET_TOOL, PREPARE_TASK_WORKER_TOOL, READ_TASK_WORKERS_TOOL,
  DISPATCH_TASK_WORKER_TOOL, READ_TASK_SOURCE_FILE_TOOL, WRITE_TASK_SOURCE_FILE_TOOL, DELETE_TASK_SOURCE_FILE_TOOL,
  SUBMIT_TASK_SOURCE_TOOL, READ_TASK_SOURCE_SUBMISSIONS_TOOL, ACCEPT_TASK_SOURCE_SUBMISSION_TOOL,
  REQUEST_PROTECTED_TASK_QA_TOOL, READ_PROTECTED_TASK_QA_TOOL, READ_PROTECTED_TASK_QA_HISTORY_TOOL } from "./task-packet-tool-declarations.mjs";
import { requestProtectedTaskQa, readProtectedTaskQa } from "./task-protected-qa.ts";
import { readProtectedTaskQaHistory } from "./task-protected-qa-history.ts";
import { PUBLISH_TASK_QA_REPORT_TOOL, VERIFY_WORKSTREAM_TOOL } from "./task-packet-tool-declarations.mjs";
import { publishTaskQaReport } from "./task-qa-reports.ts";
import { verifyCurrentWorkstream } from "./builder-gates/current-workstream-verification.ts";
import { WORKSTREAM_VERIFIED_JOB } from "./builder-gates/workstream-verification-publication.ts";
import { consumeManagerSessionTerminalJob, consumeVerifiedWorkstreamJob,
  MANAGER_SESSION_TERMINAL_JOB } from "./builder-gates/integration-manager-job.ts";
import { readVerifiedWorkstreamForManager } from "./builder-gates/integration-manager-job.ts";
import { publishIntegrationPlan } from "./builder-gates/integration-plan.ts";
import { integrateVerifiedTask, readIntegrationProgress } from "./builder-gates/integration-progress.ts";
import { requestIntegrationValidation } from "./builder-gates/integration-validation.ts";
import { PUBLISH_INTEGRATION_PLAN_TOOL, READ_VERIFIED_WORKSTREAM_TOOL, INTEGRATE_VERIFIED_TASK_TOOL,
  READ_INTEGRATION_PROGRESS_TOOL, REQUEST_INTEGRATION_VALIDATION_TOOL, PUBLISH_INTEGRATION_PACKET_TOOL } from "./builder-gates/tool-declarations.mjs";
import { acceptCtoTaskSourceSubmission, readCtoTaskSourceSubmission } from "./task-source-acceptance.ts";
import { readCtoTaskPackets, publishCtoTaskPacket } from "./task-packet-tools.ts";
import { prepareTaskWorker, readTaskWorkers, dispatchPreparedTaskWorker, readTaskWorkerFile,
  writeTaskWorkerFile, deleteTaskWorkerFile, submitTaskWorkerSource } from "./task-worker-tools.ts";
import { createProjectCto, listProjectCtos, readProjectCtos } from "./project-cto-tools.ts";
import { parseQuestionContext } from "./domain/question-context.ts";
import { resolveDesignQuestion } from "./design-decision-tools.ts";
import { readLeadMemory, updateLeadMemory } from "./lead-memory-tools.ts";
import { createLeadMemoryStore } from "./lead-memory-store.ts";
import { exactToolRecord, parseLeadToolContext, resolveLeadToolAuthority } from "./lead-tool-authority.ts";
import { parseDesignDraft } from "./domain/design-drafts.ts";
import { createDesignDraftStore, type AuthoredDesignDraft } from "./design-draft-store.ts";
import { createProductSelectionStore, saveProductSelectionAction } from "./product-selection/store.ts";
import { createConsultationAnalysisStore, consultationAnalysisPrompt } from "./consultation-analysis.ts";
import { READ_CONSULTATION_ANALYSIS_TOOL } from "./tool-declarations.mjs";
import { createBaselineBodySource } from "./project-documents/baseline-body-source.ts";
import { proposeDeliveryDocuments, readCurrentDeliveryDocuments } from "./project-documents/delivery-documents.ts";
import { PROPOSE_DELIVERY_DOCUMENTS_TOOL, READ_DELIVERY_DOCUMENTS_TOOL } from "./project-documents/tool-declarations.mjs";
import { proposeSpecAssurancePack } from "./spec-assurance/pack-producer.ts";
import { createSpecAssurancePackStore } from "./spec-assurance/pack-store.ts";
import { SPEC_ASSURANCE_PACK_PROPOSAL_TOOL, READ_SPEC_ASSURANCE_PACK_TOOL, READ_FIRST_DESIGN_REVIEW_TOOL, PROPOSE_FIRST_DESIGN_REVIEW_TOOL,
  RECORD_SPEC_GAPS_TOOL, READ_SPEC_GAPS_TOOL } from "./spec-assurance/tool-declarations.mjs";
import { readCurrentSpecGaps, recordCurrentSpecGaps } from "./spec-assurance/gap-observations.ts";
import { createUiContractStore } from "./ui-contracts/store.ts";
import { parseUiApproval, parseUiRevision, revisionDigest, type UiApproval, type UiRevision } from "./ui-contracts/domain.ts";
import { uiReviewApprovalPrompt, uiReviewRequestId } from "./ui-contracts/review-dispatch.ts";
import { PROPOSE_UI_CONTRACT_TOOL, PUBLISH_UI_CONTRACT_TOOL, READ_UI_CONTRACTS_TOOL } from "./ui-contracts/tool-declarations.mjs";
import { createFinalPacketStore } from "./delivery-evidence/final-packet.ts";
import { readFinalReview } from "./delivery-evidence/final-review.ts";
import { publishIntegrationPacket, readCurrentIntegrationPacket } from "./delivery-evidence/integration-packet.ts";
import { INTEGRATION_PACKET_EVENT, INTEGRATION_PACKET_MAIN_JOB } from "./delivery-evidence/integration-packet-evidence.ts";
import { dispatchIntegrationPacketToMain, integrationPacketMainRequestId } from "./delivery-evidence/integration-packet-dispatch.ts";
import { createCurrentFinalEvidenceReader } from "./delivery-evidence/current-final-evidence.ts";
import { dispatchFinalReview, FINAL_REVIEW_EVENT, FINAL_REVIEW_JOB } from "./delivery-evidence/final-review-dispatch.ts";
import type { RevisionPublicationGuard } from "./solution-revision-store.ts";
import { ATTEST_FINAL_PACKET_TOOL, READ_FINAL_REVIEW_TOOL, REQUEST_FINAL_REVIEW_TOOL } from "./delivery-evidence/tool-declarations.mjs";
import { approveFirstDesignReview, proposeFirstDesignReview, readFirstDesignReviewBundle } from "./spec-assurance/review-first-design.ts";
import { readG5ChangeImpactCandidates, readUserG5ChangeImpact } from "./g5-change-impact-tools.ts";
import { readUserG5ComparisonPairs } from "./g5-comparison-pairs.ts";
import { OWNED_AGENT_CAPABILITIES, READ_CHANGE_IMPACT_TOOL } from "./tool-declarations.mjs";
import { readG5Revalidation } from "./g5-revalidation.ts";
import { readReuseFirstRevision } from "./reuse-first/index.ts";
import { readLeadReuseFirstCandidates, recordLeadReuseFirstCandidate } from "./reuse-first/lead-research-tools.ts";
import { READ_REUSE_CANDIDATES_TOOL, RECORD_REUSE_CANDIDATE_TOOL } from "./reuse-first/tool-declarations.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_IMPORT_REQUEST_BYTES = 48 * 1024;
const MAX_INITIAL_SNAPSHOT_BYTES = 192 * 1024;
const queues = new Map<string, Promise<unknown>>();
const taskFolderCapabilities = ["sps.workspaceSources.read", "local.folders", "sps.workspaceSources.gitWrite"]
  .filter(capability => SPS_PLATFORM_CAPABILITIES.includes(capability as (typeof SPS_PLATFORM_CAPABILITIES)[number]));

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
      const managerRaw = await platform.state.get(integrationManagerStateKey(companyId));
      const manager = managerRaw === null
        ? parseIntegrationManagerBinding({ schemaVersion: 1, workspaceId: companyId, revision: 0, selectedAgentId: null }, companyId)
        : parseIntegrationManagerBinding(managerRaw, companyId);
      if (manager.selectedAgentId === params.agentId) throw new Error("The current Integration Manager Agent cannot also be selected as Lead.");
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
    agentId: binding.selectedAgentId, sessions: Object.fromEntries(LEAD_CHANNELS.map(channel => [channel, null])) }, companyId);
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

function conversationInput(params: Record<string, unknown>, extra: readonly string[] = [], optional: readonly string[] = []) {
  const keys = ["channel", ...extra];
  if (keys.some(key => !Object.hasOwn(params, key)) || Object.keys(params).some(key => ![...keys, ...optional].includes(key))
    || typeof params.channel !== "string" || !LEAD_CHANNELS.includes(params.channel as LeadChannel)) {
    throw new TypeError("Lead conversation requires a supported channel and exact fields.");
  }
  return params.channel as LeadChannel;
}

async function withConversation<T>(companyId: string, platform: SpsPlatformInvocationContext,
  action: (store: ReturnType<typeof createLeadConversationStore>) => Promise<T>) {
  workspaceId(companyId);
  return serialize(companyId, async () => {
    const binding = await readLeadAgentBinding(companyId, platform);
    const sessions = await leadSessionsFor(companyId, binding, platform);
    const check = async () => {
      await assertLeadSelection(companyId, binding, platform);
      const current = await leadSessionsFor(companyId, binding, platform);
      if (LEAD_CHANNELS.some(channel => current.sessions[channel] !== sessions.sessions[channel])) {
        throw new Error("Lead session binding changed. Refresh without automatically resending.");
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
    };
    return action(createLeadConversationStore(platform, sessions, check, beforeDispatch));
  });
}

export async function readLeadConversation(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  const channel = conversationInput(params, ["cursor"]);
  if (params.cursor !== null && (typeof params.cursor !== "string" || !UUID.test(params.cursor))) throw new TypeError("Invalid conversation cursor.");
  return withConversation(companyId, platform, store => store.page(channel, params.cursor as string | null));
}
export async function sendLeadMessage(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  const channel = conversationInput(params, ["requestId", "text"], ["questionContext"]);
  if (channel === "cto-inbox") throw new Error("The internal Lead intake channel does not accept user messages.");
  const questionContext = Object.hasOwn(params, "questionContext") ? parseQuestionContext(params.questionContext) : undefined;
  if (questionContext && channel !== "decisions") throw new Error("Question-associated answers use the decisions channel.");
  if (typeof params.requestId !== "string" || !UUID.test(params.requestId) || typeof params.text !== "string") throw new TypeError("Invalid Lead message.");
  return withConversation(companyId, platform, store => store.send(channel, params.requestId as string, params.text as string, questionContext));
}

export async function startConsultationAnalysis(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["requestId", "expectedCollectionRevision"]);
  if (typeof input.requestId !== "string" || !UUID.test(input.requestId)
    || !Number.isSafeInteger(input.expectedCollectionRevision) || (input.expectedCollectionRevision as number) < 0) {
    throw new TypeError("Analysis requires a request ID and the displayed collection revision.");
  }
  return withConversation(companyId, platform, async store => {
    const sessions = await readLeadSessions(companyId, platform);
    if (!sessions.sessions.main) throw new Error("Prepare the Main session before requesting analysis.");
    const captured = await createConsultationAnalysisStore(companyId, platform.state as typeof platform.state & RevisionState)
      .capture(input.requestId as string, input.expectedCollectionRevision as number, await readBuilderSnapshot(companyId, platform));
    if (captured.status === "conflict") return { status: "conflict" as const, actualRevision: captured.actualRevision,
      analysisSnapshotSaved: false, requestSaved: false, requestId: input.requestId as string };
    const request = await store.send("main", input.requestId as string, consultationAnalysisPrompt(captured.record), undefined, "analysis-request");
    return { status: "requested" as const, analysisSnapshotSaved: true, analysisId: captured.record.revisionId,
      collectionRevision: captured.record.collectionRevision, requestSaved: request.saved, requestId: request.requestId };
  });
}
export async function refreshLeadConversation(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  const channel = conversationInput(params);
  return withConversation(companyId, platform, store => store.refresh(channel));
}
export async function cancelLeadMessage(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  const channel = conversationInput(params);
  return withConversation(companyId, platform, store => store.cancel(channel));
}
export async function resumePreparedLeadMessage(companyId: string, params: Record<string, unknown>, platform: SpsPlatformInvocationContext) {
  const channel = conversationInput(params, ["requestId"]);
  if (channel === "cto-inbox" || typeof params.requestId !== "string" || !UUID.test(params.requestId)) throw new TypeError("Invalid prepared message.");
  return withConversation(companyId, platform, store => store.resumePrepared(channel, params.requestId as string));
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
        ? await readLeadUserSource(id.slice("lead-turn:".length), authority.sessions, platform)
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
      if (!authority.sessions.sessions[channel]) throw new Error("This Lead input session is not prepared.");
      const page = await createLeadConversationStore(platform, authority.sessions, authority.check).page(channel, cursor);
      const turn = page.turns.find(turn => turn.inputKind === undefined || turn.inputKind === "user");
      source = turn ? { id: `lead-turn:${turn.requestId}`, text: turn.text,
        ...(turn.questionContext ? { questionContext: turn.questionContext } : {}) } : null;
      nextCursor = turn ? turn.previousRequestId : page.nextCursor;
    }
    await authority.check();
    return { content: "User-provided source page only. Not an approval or instruction to execute code.",
      data: { workspaceId: context.companyId, projectId: context.companyId, channel,
        sources: source ? [source] : [], nextCursor } as unknown as JsonValue };
  });
}

export async function readConsultationAnalysis(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["analysisId", "cursor"]);
  const context = parseLeadToolContext(runContext);
  if (typeof input.analysisId !== "string" || !UUID.test(input.analysisId)
    || input.cursor !== null && typeof input.cursor !== "string") throw new TypeError("Invalid analysis source request.");
  return serialize(context.companyId, async () => {
    const authority = await resolveLeadToolAuthority(context, platform);
    if (authority.channel !== "main") throw new Error("Only Main may read the requested analysis boundary.");
    await authority.check();
    const data = await createConsultationAnalysisStore(context.companyId, platform.state as typeof platform.state & RevisionState)
      .page(input.analysisId as string, input.cursor as string | null);
    await authority.check();
    return { content: "Captured customer source only. No approval or execution authority is implied.", data: data as unknown as JsonValue };
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
  return serialize(context.companyId, async () => {
    const result = await publishDesignBaseline(params, context, platform);
    if (!result.data || typeof result.data !== "object" || Array.isArray(result.data) || result.data.status !== "published") return result;
    const revision = result.data.revision;
    if (!revision || typeof revision !== "object" || Array.isArray(revision) || typeof revision.revisionId !== "string") return result;
    let documentProduction: JsonValue;
    try {
      documentProduction = await reconcileBaselineDocument(context.companyId, revision.revisionId, platform) as unknown as JsonValue;
    } catch {
      // Baseline and document journals are separate commits. Preserve an already
      // published baseline even if the document projection needs reconciliation.
      documentProduction = { status: "unconfirmed", automaticallyRetried: false };
    }
    return { ...result, data: { ...result.data, documentProduction } };
  });
}

async function reconcileBaselineDocument(companyId: string, baselineRevisionId: string, platform: SpsPlatformInvocationContext) {
  workspaceId(companyId);
  if (typeof baselineRevisionId !== "string" || !baselineRevisionId.trim() || baselineRevisionId.length > 160) throw new TypeError("An exact Baseline revision is required.");
  const documents = createBaselineBodySource(companyId, companyId, platform.state);
  const current = await documents.current();
  return documents.publish({ documentRevisionId: `baseline-document-${createHash("sha256").update(baselineRevisionId).digest("hex")}`,
    expectedDocumentRevisionId: current?.revision.documentRevisionId ?? null, expectedBaselineRevisionId: baselineRevisionId });
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

export async function inspectSpecAssurance(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId"]);
  const context = parseLeadToolContext(runContext);
  if (typeof input.projectId !== "string" || input.projectId !== context.companyId) {
    throw new TypeError("Specification inspection requires the authenticated Workspace project.");
  }
  const authority = await resolveLeadToolAuthority(context, platform);
  if (authority.sessions.sessions.main !== context.sessionId) {
    throw new Error("Specification assurance inspection is restricted to the current Main Lead session.");
  }
  await authority.check();

  const current = await readDesignBaseline(context.companyId, context.companyId, platform);
  if (!current) {
    await authority.check();
    return { content: "UNKNOWN: no current Workspace-bound design baseline is available; no assurance was established.",
      data: { projectId: context.companyId, result: { status: "UNKNOWN", coverageAuthority: "unavailable",
        identity: null, scope: { requirementIds: [], uiIds: [], contractIds: [], workstreamIds: [], taskIds: [] },
        itemDecisions: [], packVersions: [], applicablePackIds: [], excludedPackIds: [], excludedRules: [],
        excludedCombinations: [], scenarios: [], checkerResults: [], gaps: [], sourceEvidence: [] } } as unknown as JsonValue };
  }

  const specification = current.revision.specification;
  const identity = Object.freeze({ workspaceId: context.companyId, projectId: context.companyId,
    specRevisionId: specification.revisionId,
    specDigest: createHash("sha256").update(JSON.stringify(specification), "utf8").digest("hex") });
  const provider = createCurrentBaselineAssuranceProvider({ workspaceId: context.companyId,
    projectId: context.companyId, sessions: authority.sessions, platform });
  const result = await createSpecAssuranceConsumer(provider)({ identity,
    scope: { requirementIds: specification.requirements.map(requirement => requirement.id) },
    facts: [], packs: [], scenarios: [] });

  await authority.check();
  const latest = await readDesignBaseline(context.companyId, context.companyId, platform);
  if (!latest || latest.sequence !== current.sequence || JSON.stringify(latest.revision) !== JSON.stringify(current.revision)) {
    const stale = { ...result, status: "UNKNOWN" as const, coverageAuthority: "identity-mismatch" as const,
      sourceEvidence: [] };
    return { content: "UNKNOWN: the current baseline changed during inspection; refresh before interpreting this result.",
      data: { projectId: context.companyId, result: stale } as unknown as JsonValue };
  }
  return { content: "Read-only specification assurance inspection. UNKNOWN means current coverage/domain authority is unavailable; this result is not approval or execution permission.",
    data: { projectId: context.companyId, result } as unknown as JsonValue };
}

export async function readUiContractView(companyId: string, platform: SpsPlatformInvocationContext,
  requested: Record<string, unknown> = {}) {
  workspaceId(companyId);
  const input = exactToolRecord(requested, [], ["proposalRevisionId", "approvalRevisionId"]);
  for (const value of Object.values(input)) if (value !== null && (typeof value !== "string" || !value.trim()
    || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value))) throw new TypeError("Invalid UI record revision ID.");
  const binding = await readLeadAgentBinding(companyId, platform);
  const proposals = createRevisionJournal(companyId, companyId, platform.state, { prefix: "ui-proposals",
    parse: value => parseUiRevision(value, companyId), revisionId: value => value.revisionId });
  const approvals = createRevisionJournal(companyId, companyId, platform.state, { prefix: "ui-approvals",
    parse: value => parseUiApproval(value, companyId), revisionId: value => value.revisionId });
  const formalStore = createRevisionJournal(companyId, companyId, platform.state, { prefix: "ui-contracts",
    parse: value => parseUiRevision(value, companyId), revisionId: value => value.revisionId });
  const proposalHead = await proposals.current(), approvalHead = await approvals.current(), formal = await formalStore.current();
  const proposal = typeof input.proposalRevisionId === "string" ? await proposals.publishedRevision(input.proposalRevisionId) : proposalHead;
  const approval = typeof input.approvalRevisionId === "string" ? await approvals.publishedRevision(input.approvalRevisionId) : approvalHead;
  const matchesSource = async (revision: UiRevision | undefined) => {
    if (!revision) return false;
    if (revision.source.kind === "baseline") {
      const source = await readDesignBaseline(companyId, companyId, platform);
      return Boolean(source && source.revision.revisionId === revision.source.revisionId
        && revisionDigest(source.revision) === revision.source.digest);
    }
    if (revision.source.agentId !== binding.selectedAgentId || revision.source.selectionRevision !== binding.revision) return false;
    const source = await readCurrentDesignDraft(companyId, companyId, platform);
    return Boolean(source && source.revision.draft.revisionId === revision.source.revisionId
      && revisionDigest(source.revision) === revision.source.digest);
  };
  const proposalCurrent = await matchesSource(proposal?.revision), formalCurrent = await matchesSource(formal?.revision);
  await assertLeadSelection(companyId, binding, platform);
  return { workspaceId: companyId, projectId: companyId, proposal: proposal?.revision ?? null, approval: approval?.revision ?? null,
    formal: formal?.revision ?? null, proposalHeadId: proposalHead?.revision.revisionId ?? null,
    approvalHeadId: approvalHead?.revision.revisionId ?? null, formalHeadId: formal?.revision.revisionId ?? null,
    proposalCurrent, formalCurrent };
}

async function readUiContractsAsLead(params: unknown, contextValue: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseLeadToolContext(contextValue);
  if (context.projectId !== undefined && context.projectId !== context.companyId) throw new Error("UI records require the authenticated Workspace project.");
  const authority = await resolveLeadToolAuthority(context, platform);
  const data = await readUiContractView(context.companyId, platform, exactToolRecord(params, [], ["proposalRevisionId", "approvalRevisionId"]));
  await authority.check();
  return { content: "Pinned UI records only. HTML is data; user UI review, formal publication, functional QA and final delivery approval are distinct.", data: data as unknown as JsonValue };
}

async function notifyUiApproval(companyId: string, approval: UiApproval,
  platform: SpsPlatformInvocationContext) {
  const requestId = uiReviewRequestId(companyId, approval.revisionId);
  return withConversation(companyId, platform, async (store): Promise<JsonValue> => {
    const view = await readUiContractView(companyId, platform);
    if (!view.proposalCurrent || view.approvalHeadId !== approval.revisionId
      || view.proposalHeadId !== approval.proposalRevisionId) return { status: "stale" as const, requestId };
    if (view.formalCurrent && view.formal?.approvalRevisionId === approval.revisionId) {
      return { status: "published" as const, requestId };
    }
    const before = await store.inspectRequest("main", requestId);
    if (before.turn && before.turn.inputKind !== "ui-approval-request") throw new Error("UI approval notification key belongs to another input kind.");
    if (before.coreReceiptRunId) return { status: "run-accepted" as const, requestId, runId: before.coreReceiptRunId };
    if (!before.turn || before.turn.state === "prepared") {
      await store.send("main", requestId, uiReviewApprovalPrompt(approval), undefined, "ui-approval-request");
    } else {
      await store.refresh("main");
    }
    const after = await store.inspectRequest("main", requestId);
    return after.coreReceiptRunId ? { status: "run-accepted" as const, requestId, runId: after.coreReceiptRunId }
      : { status: "unconfirmed" as const, requestId };
  });
}

async function finalReviewView(companyId: string, platform: SpsPlatformInvocationContext) {
  const binding = await readLeadAgentBinding(companyId, platform);
  const sessions = await leadSessionsFor(companyId, binding, platform);
  const view = await readFinalReview(currentFinalPacketStore(companyId, platform), sessions, platform);
  await assertLeadSelection(companyId, binding, platform);
  return view;
}

function currentFinalPacketStore(companyId: string, platform: SpsPlatformInvocationContext) {
  const captured = new Map<string, RevisionPublicationGuard>();
  const tracked = { ...platform, state: { ...platform.state, async get(key: SpsStateKey) {
    if (key.scopeKind !== "company" || key.scopeId !== companyId) throw new Error("Final evidence escaped its Workspace.");
    const value = await platform.state.get(key);
    if (value !== null && !key.stateKey.includes("-revision.v1.") && !key.stateKey.startsWith("final-delivery-head.v1.")) {
      const identity = JSON.stringify([key.namespace ?? "default", key.stateKey]), previous = captured.get(identity);
      if (previous && JSON.stringify(previous.expectedValue) !== JSON.stringify(value)) throw new Error("Final evidence changed during read.");
      captured.set(identity, { stateKey: key.stateKey, ...(key.namespace === undefined ? {} : { namespace: key.namespace }), expectedValue: value });
    }
    return value;
  } } };
  return createFinalPacketStore(companyId, companyId, platform.state, createCurrentFinalEvidenceReader(companyId, tracked), undefined,
    async event => {
      const selection = event.attestation?.mainLeadSelectionRevision;
      if (selection === undefined) throw new Error("Main attestation scope is missing.");
      const binding = await readLeadAgentBinding(companyId, tracked);
      const sessions = await leadSessionsFor(companyId, binding, tracked);
      if (binding.revision !== selection || binding.selectedAgentId !== event.attestation!.mainLeadAgentId
        || sessions.sessions.main !== event.attestation!.mainLeadSessionId) throw new Error("Main authority changed before final review publication.");
      const guards = [...captured.values()];
      if (!guards.length || guards.length > 64 || Buffer.byteLength(JSON.stringify(guards)) > 200_000) throw new Error("Final review publication guard bound exceeded.");
      return { guards, wake: { name: FINAL_REVIEW_EVENT, eventId: event.eventId, jobKey: FINAL_REVIEW_JOB,
        payload: { workspaceId: companyId, packetRevisionId: event.requestId, attestationEventId: event.eventId } } };
    });
}

function unrelatedJobEvent(job: unknown, expectedType: string) {
  if (!job || typeof job !== "object") throw new TypeError("Invalid event Job context.");
  const descriptor = Object.getOwnPropertyDescriptor(job, "event");
  if (!descriptor) return false;
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Invalid event Job envelope.");
  const event = exactToolRecord(descriptor.value, ["eventType", "payload"]);
  if (typeof event.eventType !== "string" || !event.eventType) throw new TypeError("Invalid persisted event type.");
  return event.eventType !== expectedType;
}

async function notifyIntegrationPacket(job: { companyId?: string; eventId?: string; trigger: string }, platform: SpsPlatformInvocationContext) {
  if (job.trigger !== "event" || !job.companyId || !job.eventId) throw new Error("Main packet notification requires a Workspace event.");
  const companyId = job.companyId, eventId = job.eventId;
  return withConversation(companyId, platform, async store => {
    const packet = await readCurrentIntegrationPacket(companyId, platform);
    if (packet.status === "stale" || packet.status === "available" && packet.eventId !== eventId) return { status: "stale" as const };
    if (packet.status !== "available") throw new Error("The persisted Main packet event is unavailable; do not consume it.");
    const binding = await readLeadAgentBinding(companyId, platform);
    const requestId = integrationPacketMainRequestId(companyId, binding.revision, eventId);
    await assertLeadSelection(companyId, binding, platform);
    const current = await readCurrentIntegrationPacket(companyId, platform);
    if (current.status === "stale" || current.status === "available" && current.eventId !== eventId) return { status: "stale" as const };
    if (current.status !== "available") throw new Error("Current packet authority is unconfirmed; preserve the job.");
    return dispatchIntegrationPacketToMain(store, requestId, current.packetRevisionId);
  });
}

async function notifyFinalReview(job: { companyId?: string; eventId?: string; trigger: string }, platform: SpsPlatformInvocationContext) {
  if (job.trigger !== "event" || !job.companyId || !job.eventId) throw new Error("Final review requires an exact Workspace event.");
  const companyId = job.companyId, eventId = job.eventId;
  return withConversation(companyId, platform, async store => {
    const current = (await createFinalPacketStore(companyId, companyId, platform.state).current()).revisions[0]?.revision;
    if (!current || current.kind !== "main-attestation" || current.eventId !== eventId) return { status: "stale" as const };
    const author = current.attestation!;
    const binding = await readLeadAgentBinding(companyId, platform);
    const sessions = await leadSessionsFor(companyId, binding, platform);
    if (author.mainLeadAgentId !== binding.selectedAgentId || author.mainLeadSelectionRevision !== binding.revision
      || author.mainLeadSessionId !== sessions.sessions.main) return { status: "stale" as const };
    const packet = await readCurrentIntegrationPacket(companyId, platform);
    if (packet.status === "stale") return { status: "stale" as const };
    if (packet.status !== "available") throw new Error("Final review evidence is unconfirmed; preserve the job.");
    const run = await platform.agents.sessions.getRun(author.mainLeadSessionId, companyId, author.mainLeadRunId);
    if (run.runId !== author.mainLeadRunId || run.status !== "succeeded" || run.cancellationRequested
      || run.termination !== "not_applicable") throw new Error("Main attestation run has not completed successfully; preserve the review job.");
    const view = await finalReviewView(companyId, platform);
    if (view.status !== "ready" || view.mainAttestation?.eventId !== eventId || view.snapshot.g7 !== "PASS") {
      throw new Error("Current Main attestation evidence is unavailable; do not consume its review job.");
    }
    await assertLeadSelection(companyId, binding, platform);
    if (await createFinalPacketStore(companyId, companyId, platform.state).headRevisionId() !== eventId) return { status: "stale" as const };
    return dispatchFinalReview(store, integrationPacketMainRequestId(companyId, binding.revision, `review:${eventId}`), current);
  });
}

async function firstDesignReviewView(companyId: string, platform: SpsPlatformInvocationContext) {
  const bundle = await readFirstDesignReviewBundle(companyId, companyId, platform.state);
  if (!bundle) return { status: "empty" as const };
  const binding = await readLeadAgentBinding(companyId, platform);
  const [draft, baseline] = await Promise.all([readCurrentDesignDraft(companyId, companyId, platform),
    readDesignBaseline(companyId, companyId, platform)]);
  const current = Boolean(draft && bundle.draftRevisionId === draft.revision.draft.revisionId
    && bundle.draftDigest === createHash("sha256").update(JSON.stringify(draft.revision.draft)).digest("hex")
    && bundle.author.selectionRevision === binding.revision && bundle.author.agentId === binding.selectedAgentId);
  const prior = bundle.priorBaseline as null | Readonly<{ revisionId: string; sequence: number; digest: string }>;
  const priorMatches = prior === null ? baseline === null : Boolean(baseline && prior.revisionId === baseline.revision.revisionId
    && prior.sequence === baseline.sequence && prior.digest === createHash("sha256").update(JSON.stringify(baseline.revision)).digest("hex"));
  const applied = Boolean(bundle.status === "APPROVED" && baseline
    && baseline.revision.userDecision.sourceId === `first-design-review:${bundle.revisionId}`);
  await assertLeadSelection(companyId, binding, platform);
  return { status: current && (priorMatches || applied) ? "ready" as const : "stale" as const,
    bundle, proposalRevisionId: bundle.revisionId, expectedHead: bundle.revisionId };
}

export function createBuilderPlatform() {
  return defineSpsPlatformContract({
    capabilities: ["plugin.state.read", "plugin.state.write", "events.emit", "jobs.schedule", "agent.tools.register", "agents.read", "agent.sessions.create",
      "agent.sessions.send", "agent.sessions.read", "agent.sessions.list", "agent.sessions.cancel", ...OWNED_AGENT_CAPABILITIES,
      ...taskFolderCapabilities as (typeof SPS_PLATFORM_CAPABILITIES)[number][],
      ...["sps.runs.dispatch", "sps.executions.read", "sps.artifacts.read"].filter(capability => (SPS_PLATFORM_CAPABILITIES as readonly string[]).includes(capability)) as (typeof SPS_PLATFORM_CAPABILITIES)[number][]],
    jobs: [{ jobKey: WORKSTREAM_VERIFIED_JOB, handler: async (job, platform) => {
      const result = await consumeVerifiedWorkstreamJob(job, platform);
      // A persisted pending reservation is not successful Git/CI execution.
      // Surface the missing producer to Core's bounded job-error handling.
      if ("waitingDependencies" in result && result.waitingDependencies === true
        || ["accepted", "stale", "ignored", "waiting"].includes(result.status)) return;
      if (result.status !== "accepted") throw new Error(`Workstream integration not admitted: ${result.reason}`);
    } }, { jobKey: MANAGER_SESSION_TERMINAL_JOB, handler: async (job, platform) => {
      const result = await consumeManagerSessionTerminalJob(job, platform);
      if (["accepted", "failed", "stale", "ignored", "waiting"].includes(result.status)) return;
      throw new Error(`Manager terminal continuation unresolved: ${result.reason}`);
    } }, { jobKey: INTEGRATION_PACKET_MAIN_JOB, handler: async (job, platform) => {
      if (unrelatedJobEvent(job, INTEGRATION_PACKET_EVENT)) return;
      const result = await notifyIntegrationPacket(job, platform);
      if (result.status !== "accepted" && result.status !== "stale") throw new Error("Main packet notification admission is unconfirmed; preserve its request.");
    } }, { jobKey: FINAL_REVIEW_JOB, handler: async (job, platform) => {
      if (unrelatedJobEvent(job, FINAL_REVIEW_EVENT)) return;
      const result = await notifyFinalReview(job, platform);
      if (result.status !== "accepted" && result.status !== "stale") throw new Error("Integration Review admission is unconfirmed; preserve its request.");
    } }],
    tools: [{ name: READ_SOLUTION_TOOL.name, declaration: { displayName: READ_SOLUTION_TOOL.displayName,
      description: READ_SOLUTION_TOOL.description, parametersSchema: READ_SOLUTION_TOOL.parametersSchema },
    handler: (params, context, platform) => readLeadSolution(params, context, platform) },
    { name: PROPOSE_DELIVERY_DOCUMENTS_TOOL.name, declaration: PROPOSE_DELIVERY_DOCUMENTS_TOOL,
      handler: (params, context, platform) => {
        const run = parseLeadToolContext(context);
        return serialize(run.companyId, async () => ({
          content: "Main delivery guide draft result only. Exact Source pins do not establish integration, QA, G7 or user approval.",
          data: await proposeDeliveryDocuments(params, run, platform) as unknown as JsonValue,
        }));
      } },
    { name: READ_DELIVERY_DOCUMENTS_TOOL.name, declaration: READ_DELIVERY_DOCUMENTS_TOOL,
      handler: (params, context, platform) => {
        const run = parseLeadToolContext(context);
        return serialize(run.companyId, async () => {
          const input = exactToolRecord(params, ["projectId"]);
          if (input.projectId !== run.companyId || run.projectId !== undefined && run.projectId !== run.companyId) {
            throw new Error("Delivery documents require the authenticated Workspace project.");
          }
          const authority = await resolveLeadToolAuthority(run, platform);
          const read = await readCurrentDeliveryDocuments(run.companyId, platform);
          await authority.check();
          return { content: "Pinned unapproved delivery guide drafts. This read does not attest G7, approve delivery or execute AI.",
            data: { workspaceId: run.companyId, projectId: run.companyId, read } as unknown as JsonValue };
        });
      } },
    { name: READ_CHANGE_IMPACT_TOOL.name, declaration: READ_CHANGE_IMPACT_TOOL,
      handler: async (params, context, platform) => {
        const input = exactToolRecord(params,
          ["projectId", "oldBaselineRevisionId", "newBaselineRevisionId", "oldUiRevisionId", "newUiRevisionId"],
          ["technology", "workstreams", "tasks", "projection"]);
        if (input.projection === undefined) return readG5ChangeImpactCandidates(params, context, platform);
        if (input.projection !== "revalidation") throw new TypeError("Unsupported G5 change-impact projection.");
        delete input.projection;
        return readG5Revalidation(input, context, platform);
      } },
    { name: READ_REUSE_CANDIDATES_TOOL.name, declaration: READ_REUSE_CANDIDATES_TOOL, handler: readLeadReuseFirstCandidates },
    { name: RECORD_REUSE_CANDIDATE_TOOL.name, declaration: RECORD_REUSE_CANDIDATE_TOOL, handler: recordLeadReuseFirstCandidate },
    { name: READ_FIRST_DESIGN_REVIEW_TOOL.name, declaration: READ_FIRST_DESIGN_REVIEW_TOOL,
      handler: (params, context, platform) => serialize(context.companyId, async () => {
        exactToolRecord(params, []);
        const run = parseLeadToolContext(context);
        if (run.projectId !== undefined && run.projectId !== run.companyId) throw new Error("Initial design review requires the authenticated Workspace project.");
        const authority = await resolveLeadToolAuthority(run, platform);
        if (authority.channel !== "main") throw new Error("Only Main may read initial design review records through this tool.");
        const data = await firstDesignReviewView(run.companyId, platform);
        await authority.check();
        return { content: "Exact stored proposal or user review record; not a Baseline publication, QA, or execution approval.", data: data as unknown as JsonValue };
      }) },
    { name: PROPOSE_FIRST_DESIGN_REVIEW_TOOL.name, declaration: PROPOSE_FIRST_DESIGN_REVIEW_TOOL,
      handler: (params, context, platform) => serialize(context.companyId, async () => {
        const result = await proposeFirstDesignReview(params, context, platform);
        return { content: result.content, data: result as unknown as JsonValue };
      }) },
    { name: READ_FINAL_REVIEW_TOOL.name, declaration: READ_FINAL_REVIEW_TOOL,
      handler: (params, context, platform) => serialize(context.companyId, async () => {
        const input = exactToolRecord(params, [], ["projection"]);
        if (input.projection !== undefined && input.projection !== "integration-packet") throw new TypeError("Invalid final review projection.");
        const run = parseLeadToolContext(context);
        if (run.projectId !== undefined && run.projectId !== run.companyId) throw new Error("Final review requires the authenticated Workspace project.");
        const authority = await resolveLeadToolAuthority(run, platform);
        if (authority.channel !== "main" && authority.channel !== "integration-review") throw new Error("Only Main and Integration Review may inspect Final Packet records.");
        const view = input.projection === "integration-packet" ? await readCurrentIntegrationPacket(run.companyId, platform)
          : await finalReviewView(run.companyId, platform);
        await authority.check();
        return { content: "Final Packet review records only. UNKNOWN is not QA, user approval, or permission to deliver.", data: view as unknown as JsonValue };
      }) },
    { name: ATTEST_FINAL_PACKET_TOOL.name, declaration: ATTEST_FINAL_PACKET_TOOL,
      handler: (params, context, platform) => serialize(context.companyId, async () => ({ content: "Main readiness check only; never a user approval.",
        data: await currentFinalPacketStore(context.companyId, platform).attestFinalPacket(params, context, platform) as unknown as JsonValue })) },
    { name: REQUEST_FINAL_REVIEW_TOOL.name, declaration: REQUEST_FINAL_REVIEW_TOOL,
      handler: (params, context, platform) => serialize(context.companyId, async () => ({ content: "Integration Review request only; never a user approval.",
        data: await currentFinalPacketStore(context.companyId, platform).publishApprovalRequest(params, context, platform) as unknown as JsonValue })) },
    { name: PROPOSE_DESIGN_TOOL.name, declaration: { displayName: PROPOSE_DESIGN_TOOL.displayName,
      description: PROPOSE_DESIGN_TOOL.description, parametersSchema: PROPOSE_DESIGN_TOOL.parametersSchema },
    handler: (params, context, platform) => proposeLeadDesign(params, context, platform) },
    { name: READ_DESIGN_DRAFT_TOOL.name, declaration: { displayName: READ_DESIGN_DRAFT_TOOL.displayName,
      description: READ_DESIGN_DRAFT_TOOL.description, parametersSchema: READ_DESIGN_DRAFT_TOOL.parametersSchema },
    handler: (params, context, platform) => readLeadDesignDraft(params, context, platform) },
    { name: READ_DESIGN_SOURCES_TOOL.name, declaration: { displayName: READ_DESIGN_SOURCES_TOOL.displayName,
      description: READ_DESIGN_SOURCES_TOOL.description, parametersSchema: READ_DESIGN_SOURCES_TOOL.parametersSchema },
    handler: (params, context, platform) => readLeadDesignSources(params, context, platform) },
    { name: READ_CONSULTATION_ANALYSIS_TOOL.name, declaration: { displayName: READ_CONSULTATION_ANALYSIS_TOOL.displayName,
      description: READ_CONSULTATION_ANALYSIS_TOOL.description, parametersSchema: READ_CONSULTATION_ANALYSIS_TOOL.parametersSchema },
    handler: (params, context, platform) => readConsultationAnalysis(params, context, platform) },
    { name: READ_UI_CONTRACTS_TOOL.name, declaration: { displayName: READ_UI_CONTRACTS_TOOL.displayName,
      description: READ_UI_CONTRACTS_TOOL.description, parametersSchema: READ_UI_CONTRACTS_TOOL.parametersSchema },
      handler: (params, context, platform) => serialize(context.companyId, () => readUiContractsAsLead(params, context, platform)) },
    { name: PROPOSE_UI_CONTRACT_TOOL.name, declaration: { displayName: PROPOSE_UI_CONTRACT_TOOL.displayName,
      description: PROPOSE_UI_CONTRACT_TOOL.description, parametersSchema: PROPOSE_UI_CONTRACT_TOOL.parametersSchema },
      handler: (params, context, platform) => serialize(context.companyId, async () => ({ content: "UI proposal stored or conflicted; not user approval or formal publication.",
        data: await createUiContractStore(context.companyId, context.companyId, platform.state).propose(params, context, platform) as unknown as JsonValue })) },
    { name: PUBLISH_UI_CONTRACT_TOOL.name, declaration: { displayName: PUBLISH_UI_CONTRACT_TOOL.displayName,
      description: PUBLISH_UI_CONTRACT_TOOL.description, parametersSchema: PUBLISH_UI_CONTRACT_TOOL.parametersSchema },
      handler: (params, context, platform) => serialize(context.companyId, async () => ({ content: "Formal UI revision result only. This is not functional QA, product design approval or delivery approval.",
        data: await createUiContractStore(context.companyId, context.companyId, platform.state).publishFormal(params, context, platform) as unknown as JsonValue })) },
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
    { name: SPEC_ASSURANCE_PACK_PROPOSAL_TOOL.name, declaration: { displayName: SPEC_ASSURANCE_PACK_PROPOSAL_TOOL.displayName,
      description: SPEC_ASSURANCE_PACK_PROPOSAL_TOOL.description, parametersSchema: SPEC_ASSURANCE_PACK_PROPOSAL_TOOL.parametersSchema },
      handler: (params, context, platform) => serialize(context.companyId, () => proposeSpecAssurancePack(params, context, platform)) },
    { name: READ_SPEC_ASSURANCE_PACK_TOOL.name, declaration: { displayName: READ_SPEC_ASSURANCE_PACK_TOOL.displayName,
      description: READ_SPEC_ASSURANCE_PACK_TOOL.description, parametersSchema: READ_SPEC_ASSURANCE_PACK_TOOL.parametersSchema },
      handler: (params, context, platform) => serialize(context.companyId, async () => {
        const input = exactToolRecord(params, ["projectId", "packId"]);
        const authority = await resolveLeadToolAuthority(parseLeadToolContext(context), platform);
        if (authority.channel !== "main" || input.projectId !== context.companyId || typeof input.packId !== "string") {
          throw new Error("A current Main session and authenticated Workspace project are required.");
        }
        const current = await createSpecAssurancePackStore(context.companyId, context.companyId, platform.state).current(input.packId);
        const baseline = await readDesignBaseline(context.companyId, context.companyId, platform);
        await authority.check();
        return { content: "Proposal only. No approved rule authority, coverage or QA is implied.",
          data: { current, matchesCurrentBaseline: Boolean(current && baseline && current.revision.baselineRevisionId === baseline.revision.revisionId
            && current.revision.identity.specDigest === createHash("sha256").update(JSON.stringify(baseline.revision.specification)).digest("hex")) } as unknown as JsonValue };
      }) },
    { name: INSPECT_SPEC_ASSURANCE_TOOL.name, declaration: { displayName: INSPECT_SPEC_ASSURANCE_TOOL.displayName,
      description: INSPECT_SPEC_ASSURANCE_TOOL.description, parametersSchema: INSPECT_SPEC_ASSURANCE_TOOL.parametersSchema },
      handler: (params, context, platform) => inspectSpecAssurance(params, context, platform) },
    { name: RECORD_SPEC_GAPS_TOOL.name, declaration: { displayName: RECORD_SPEC_GAPS_TOOL.displayName,
      description: RECORD_SPEC_GAPS_TOOL.description, parametersSchema: RECORD_SPEC_GAPS_TOOL.parametersSchema },
      handler: (params, context, platform) => serialize(context.companyId, async () => ({
        content: "Specification gap observation only. This does not resolve a gap or approve a decision.",
        data: await recordCurrentSpecGaps(params, context, platform) as unknown as JsonValue,
      })) },
    { name: READ_SPEC_GAPS_TOOL.name, declaration: { displayName: READ_SPEC_GAPS_TOOL.displayName,
      description: READ_SPEC_GAPS_TOOL.description, parametersSchema: READ_SPEC_GAPS_TOOL.parametersSchema },
      handler: async (params, context, platform) => ({
        content: "Recorded specification gap candidates for this Baseline and requirement.",
        data: await readCurrentSpecGaps(params, context, platform) as unknown as JsonValue,
      }) },
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
      handler: (params, context, platform) => publishAssignedCtoTaskPacket(params, context, platform) },
    { name: PREPARE_TASK_WORKER_TOOL.name, declaration: { displayName: PREPARE_TASK_WORKER_TOOL.displayName,
      description: PREPARE_TASK_WORKER_TOOL.description, parametersSchema: PREPARE_TASK_WORKER_TOOL.parametersSchema },
      handler: (params, runContext, platform) => {
        const context = parseLeadToolContext(runContext);
        return serialize(context.companyId, () => prepareTaskWorker(params, context, platform));
      } },
    { name: READ_TASK_WORKERS_TOOL.name, declaration: { displayName: READ_TASK_WORKERS_TOOL.displayName,
      description: READ_TASK_WORKERS_TOOL.description, parametersSchema: READ_TASK_WORKERS_TOOL.parametersSchema },
      handler: (params, runContext, platform) => {
        const context = parseLeadToolContext(runContext);
        return serialize(context.companyId, () => readTaskWorkers(params, context, platform));
      } },
    { name: DISPATCH_TASK_WORKER_TOOL.name, declaration: { displayName: DISPATCH_TASK_WORKER_TOOL.displayName,
      description: DISPATCH_TASK_WORKER_TOOL.description, parametersSchema: DISPATCH_TASK_WORKER_TOOL.parametersSchema },
      handler: (params, runContext, platform) => {
        const context = parseLeadToolContext(runContext);
        return serialize(context.companyId, () => dispatchPreparedTaskWorker(params, context, platform));
      } },
    { name: READ_TASK_SOURCE_SUBMISSIONS_TOOL.name, declaration: { displayName: READ_TASK_SOURCE_SUBMISSIONS_TOOL.displayName,
      description: READ_TASK_SOURCE_SUBMISSIONS_TOOL.description, parametersSchema: READ_TASK_SOURCE_SUBMISSIONS_TOOL.parametersSchema },
      handler: async (params, context, platform) => ({
        content: "Exact submission lookup, not current Git tip or independent QA evidence.",
        data: await readCtoTaskSourceSubmission(params, context, platform) as unknown as JsonValue,
      }) },
    { name: ACCEPT_TASK_SOURCE_SUBMISSION_TOOL.name, declaration: { displayName: ACCEPT_TASK_SOURCE_SUBMISSION_TOOL.displayName,
      description: ACCEPT_TASK_SOURCE_SUBMISSION_TOOL.description, parametersSchema: ACCEPT_TASK_SOURCE_SUBMISSION_TOOL.parametersSchema },
      handler: (params, context, platform) => serialize(context.companyId, async () => ({
        content: "Receipt is not current Git tip, Task completion, or QA.",
        data: await acceptCtoTaskSourceSubmission(params, context, platform) as unknown as JsonValue,
      })) },
    { name: REQUEST_PROTECTED_TASK_QA_TOOL.name, declaration: { displayName: REQUEST_PROTECTED_TASK_QA_TOOL.displayName,
      description: REQUEST_PROTECTED_TASK_QA_TOOL.description, parametersSchema: REQUEST_PROTECTED_TASK_QA_TOOL.parametersSchema },
      handler: (params, context, platform) => serialize(context.companyId, async () => ({
        content: "Protected execution was requested only for the exact accepted Task/source and approved plan. Technical status is not QA PASS.",
        data: await requestProtectedTaskQa(params, context, platform) as unknown as JsonValue,
      })) },
    { name: READ_PROTECTED_TASK_QA_TOOL.name, declaration: { displayName: READ_PROTECTED_TASK_QA_TOOL.displayName,
      description: READ_PROTECTED_TASK_QA_TOOL.description, parametersSchema: READ_PROTECTED_TASK_QA_TOOL.parametersSchema },
      handler: (params, context, platform) => serialize(context.companyId, async () => ({
        content: "Protected Node technical run status only; no QA verdict or task completion is inferred.",
        data: await readProtectedTaskQa(params, context, platform) as unknown as JsonValue,
      })) },
    { name: READ_PROTECTED_TASK_QA_HISTORY_TOOL.name, declaration: { displayName: READ_PROTECTED_TASK_QA_HISTORY_TOOL.displayName,
      description: READ_PROTECTED_TASK_QA_HISTORY_TOOL.description, parametersSchema: READ_PROTECTED_TASK_QA_HISTORY_TOOL.parametersSchema },
      handler: (params, context, platform) => serialize(context.companyId, async () => ({
        content: "Historical Task-to-Core-run references and technical status only; no QA verdict or completion is inferred.",
        data: await readProtectedTaskQaHistory(params, context, platform) as unknown as JsonValue,
      })) },
    { name: PUBLISH_INTEGRATION_PLAN_TOOL.name, declaration: PUBLISH_INTEGRATION_PLAN_TOOL,
      handler: (params, context, platform) => serialize(context.companyId, async () => ({
        content: "Main-pinned integration workflow only; Host Git/Runner grants and current verification remain required.",
        data: await publishIntegrationPlan(params, context, platform) as unknown as JsonValue,
      })) },
    { name: READ_VERIFIED_WORKSTREAM_TOOL.name, declaration: READ_VERIFIED_WORKSTREAM_TOOL,
      handler: (params, context, platform) => serialize(context.companyId, () => readVerifiedWorkstreamForManager(params, context, platform)) },
    { name: INTEGRATE_VERIFIED_TASK_TOOL.name, declaration: INTEGRATE_VERIFIED_TASK_TOOL,
      handler: (params, context, platform) => serialize(context.companyId, async () => ({
        content: "Candidate Git effect only. Required CI/E2E, Final Packet and user delivery approval remain separate.",
        data: await integrateVerifiedTask(params, context, platform) as unknown as JsonValue,
      })) },
    { name: READ_INTEGRATION_PROGRESS_TOOL.name, declaration: READ_INTEGRATION_PROGRESS_TOOL,
      handler: (params, context, platform) => serialize(context.companyId, async () => ({
        content: "Stored candidate integration attempts only; reading never executes Git or AI.",
        data: await readIntegrationProgress(params, context, platform) as unknown as JsonValue,
      })) },
    { name: REQUEST_INTEGRATION_VALIDATION_TOOL.name, declaration: REQUEST_INTEGRATION_VALIDATION_TOOL,
      handler: (params, context, platform) => serialize(context.companyId, async () => ({
        content: "Exact protected candidate test request only. Technical execution, authored QA, complete G6/G7 and user delivery approval remain distinct.",
        data: await requestIntegrationValidation(params, context, platform) as unknown as JsonValue,
      })) },
    { name: PUBLISH_INTEGRATION_PACKET_TOOL.name, declaration: PUBLISH_INTEGRATION_PACKET_TOOL,
      handler: (params, context, platform) => serialize(context.companyId, async () => ({
        content: "Manager evidence handoff only. Main G7 and authenticated user approval are separate.",
        data: await publishIntegrationPacket(params, context, platform) as unknown as JsonValue,
      })) },
    { name: VERIFY_WORKSTREAM_TOOL.name, declaration: { displayName: VERIFY_WORKSTREAM_TOOL.displayName,
      description: VERIFY_WORKSTREAM_TOOL.description, parametersSchema: VERIFY_WORKSTREAM_TOOL.parametersSchema },
      handler: (params, context, platform) => serialize(context.companyId, () => verifyCurrentWorkstream(params, context, platform)) },
    { name: PUBLISH_TASK_QA_REPORT_TOOL.name, declaration: { displayName: PUBLISH_TASK_QA_REPORT_TOOL.displayName,
      description: PUBLISH_TASK_QA_REPORT_TOOL.description, parametersSchema: PUBLISH_TASK_QA_REPORT_TOOL.parametersSchema },
      handler: (params, context, platform) => serialize(context.companyId, async () => ({
        content: "Exact independent Task QA report only. Workstream verification, integration and delivery approval remain separate.",
        data: await publishTaskQaReport(params, context, platform) as unknown as JsonValue,
      })) },
    { name: READ_TASK_SOURCE_FILE_TOOL.name, declaration: { displayName: READ_TASK_SOURCE_FILE_TOOL.displayName,
      description: READ_TASK_SOURCE_FILE_TOOL.description, parametersSchema: READ_TASK_SOURCE_FILE_TOOL.parametersSchema },
      handler: (params, runContext, platform) => {
        const context = exactToolRecord(runContext, ["companyId", "agentId", "runId", "sessionId"], ["projectId"]);
        const companyId = workspaceId(context.companyId);
        return serialize(companyId, () => readTaskWorkerFile(params, runContext, platform));
      } },
    { name: WRITE_TASK_SOURCE_FILE_TOOL.name, declaration: { displayName: WRITE_TASK_SOURCE_FILE_TOOL.displayName,
      description: WRITE_TASK_SOURCE_FILE_TOOL.description, parametersSchema: WRITE_TASK_SOURCE_FILE_TOOL.parametersSchema },
      handler: (params, runContext, platform) => {
        const context = exactToolRecord(runContext, ["companyId", "agentId", "runId", "sessionId"], ["projectId"]);
        const companyId = workspaceId(context.companyId);
        return serialize(companyId, () => writeTaskWorkerFile(params, runContext, platform));
      } },
    { name: DELETE_TASK_SOURCE_FILE_TOOL.name, declaration: { displayName: DELETE_TASK_SOURCE_FILE_TOOL.displayName,
      description: DELETE_TASK_SOURCE_FILE_TOOL.description, parametersSchema: DELETE_TASK_SOURCE_FILE_TOOL.parametersSchema },
      handler: (params, runContext, platform) => {
        const context = exactToolRecord(runContext, ["companyId", "agentId", "runId", "sessionId"], ["projectId"]);
        const companyId = workspaceId(context.companyId);
        return serialize(companyId, () => deleteTaskWorkerFile(params, runContext, platform));
      } },
    { name: SUBMIT_TASK_SOURCE_TOOL.name, declaration: { displayName: SUBMIT_TASK_SOURCE_TOOL.displayName,
      description: SUBMIT_TASK_SOURCE_TOOL.description, parametersSchema: SUBMIT_TASK_SOURCE_TOOL.parametersSchema },
      handler: (params, runContext, platform) => {
        const context = exactToolRecord(runContext, ["companyId", "agentId", "runId", "sessionId"], ["projectId"]);
        const companyId = workspaceId(context.companyId);
        return serialize(companyId, () => submitTaskWorkerSource(params, runContext, platform));
      } }],
    data: [{ key: "builder.delivery-documents", handler: async (params, platform) => {
      exactToolRecord(params, ["companyId"], ["renderEnvironment"]);
      const companyId = workspaceId(params.companyId);
      return serialize(companyId, async () => ({ workspaceId: companyId, projectId: companyId,
        read: await readCurrentDeliveryDocuments(companyId, platform) }) as unknown as JsonValue);
    } }, { key: "builder.reuse-candidates", handler: async (params, platform) => {
      exactToolRecord(params, ["companyId"], ["renderEnvironment"]);
      const companyId = workspaceId(params.companyId);
      const current = await readReuseFirstRevision({ workspaceId: companyId, projectId: companyId }, platform.state);
      return current && { workspaceId: companyId, projectId: companyId, sequence: current.sequence, revision: current.revision } as unknown as JsonValue;
    } }, { key: "builder.first-design-review", handler: async (params, platform) => {
      const companyId = workspaceId(params.companyId);
      return serialize(companyId, async () => await firstDesignReviewView(companyId, platform) as unknown as JsonValue);
    } }, { key: "builder.final-review", handler: async (params, platform) => {
      const companyId = workspaceId(params.companyId);
      return serialize(companyId, async () => await finalReviewView(companyId, platform) as unknown as JsonValue);
    } }, { key: "builder.ui-contracts", handler: async (params, platform) =>
      await readUiContractView(workspaceId(params.companyId), platform) as unknown as JsonValue },
    { key: "builder.workstreams", handler: async (params, platform) => {
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
    } }, { key: "builder.baseline-document", handler: async (params, platform) => {
      const companyId = workspaceId(params.companyId);
      const source = createBaselineBodySource(companyId, companyId, platform.state);
      const current = await source.current();
      return current && { workspaceId: companyId, projectId: companyId,
        read: await source.read(current.revision.documentRevisionId) } as unknown as JsonValue;
    } }, { key: "builder.consultation-analysis", handler: async (params, platform) => {
      const companyId = workspaceId(params.companyId);
      const current = await createConsultationAnalysisStore(companyId, platform.state as typeof platform.state & RevisionState).current();
      if (!current) return null;
      const { sources, ...record } = current.revision;
      return { ...record, sourceCount: sources.length } as unknown as JsonValue;
    } }, { key: "builder.product-selection", handler: async (params, platform) => {
      const companyId = workspaceId(params.companyId);
      const current = await createProductSelectionStore(companyId, companyId,
        platform.state as typeof platform.state & RevisionState).current();
      return current && { workspaceId: companyId, projectId: companyId, ...current } as unknown as JsonValue;
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
    { key: "builder.integration-manager", handler: async (params, platform) => {
      exactToolRecord(params, ["companyId"], ["projectId", "renderEnvironment"]);
      const companyId = workspaceId(params.companyId);
      const projectId = params.projectId === undefined ? companyId : params.projectId;
      if (typeof projectId !== "string") throw new TypeError("A Builder project ID is required.");
      return await readIntegrationManagerOptions(companyId, platform, projectId) as unknown as JsonValue;
    } },
    { key: "builder.lead-sessions", handler: async (params, platform) =>
      await readLeadSessions(workspaceId(params.companyId), platform) as unknown as JsonValue },
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
    actions: [{ key: "builder.read-g5-comparison-pairs", handler: async (params, context) => {
      return await readUserG5ComparisonPairs(userActionInput(params, context), context) as unknown as JsonValue;
    } }, { key: "builder.read-change-impact", handler: async (params, context) => {
      return readUserG5ChangeImpact(userActionInput(params, context), context);
    } }, { key: "builder.approve-first-design-review", handler: async (params, context) => {
      const input = exactToolRecord(userActionInput(params, context), ["proposalRevisionId", "expectedHead"]);
      const companyId = workspaceId(context.companyId);
      if (typeof input.proposalRevisionId !== "string" || input.proposalRevisionId !== input.expectedHead) {
        throw new TypeError("The displayed first-design proposal and expected head must match.");
      }
      return serialize(companyId, async () => {
        const view = await firstDesignReviewView(companyId, context);
        if (view.status !== "ready" || view.expectedHead !== input.expectedHead || view.bundle.status !== "PROPOSED") {
          return { status: "conflict" };
        }
        return await approveFirstDesignReview({ projectId: companyId,
          expectedBundleRevisionId: input.proposalRevisionId }, context) as unknown as JsonValue;
      });
    } }, { key: "builder.final-review-decision", handler: async (params, context) => {
      const input = exactToolRecord(userActionInput(params, context), ["eventId", "requestId", "expectedBaseRevisionId", "action"], ["reason"]);
      const companyId = workspaceId(context.companyId);
      return serialize(companyId, async () => {
        const store = currentFinalPacketStore(companyId, context);
        return await store.respond(input, context, async () => {
          const view = await finalReviewView(companyId, context);
          if (view.status !== "ready" || !view.mainReceipt || !view.integrationReviewReceipt || view.decision
            || !view.approvalRequest || view.approvalRequest.requestId !== input.requestId
            || view.approvalRequest.eventId !== input.expectedBaseRevisionId) throw new Error("The current final review request and its authenticated run receipts could not be verified.");
          if (input.action === "approve" && view.approvalEligibility.status !== "eligible") throw new Error("The current Final Packet is not eligible for user approval.");
        }) as unknown as JsonValue;
      });
    } }, { key: "builder.import-consultation", handler: async (params, context) => {
      // Core includes its authorized companyId in action parameters. It is
      // envelope metadata, never a user-selected destination or domain field.
      return importConsultation(context.companyId, userActionInput(params, context), context);
    } }, { key: "builder.start-consultation-analysis", handler: async (params, context) => {
      return await startConsultationAnalysis(context.companyId, userActionInput(params, context), context) as unknown as JsonValue;
    } }, { key: "builder.reconcile-baseline-document", handler: async (params, context) => {
      const input = exactToolRecord(userActionInput(params, context), ["baselineRevisionId"]);
      if (typeof input.baselineRevisionId !== "string") throw new TypeError("An exact Baseline revision is required.");
      return await serialize(context.companyId, () => reconcileBaselineDocument(context.companyId, input.baselineRevisionId as string, context)) as unknown as JsonValue;
    } }, { key: "builder.approve-ui-proposal", handler: async (params, context) => {
      const input = userActionInput(params, context);
      if (typeof input.revisionId !== "string" || !UUID.test(input.revisionId) || input.revisionId !== input.revisionId.toLowerCase()) {
        throw new TypeError("A UI approval request ID is required.");
      }
      const result = await serialize(context.companyId, () => createUiContractStore(context.companyId, context.companyId, context.state)
        .approveProposalAction(input, context, async proposal => {
          const view = await readUiContractView(context.companyId, context);
          if (!view.proposalCurrent || view.proposalHeadId !== proposal.revisionId) throw new Error("The UI proposal is no longer current.");
        }));
      if (result.status === "conflict") return result as unknown as JsonValue;
      let mainNotification: JsonValue;
      try { mainNotification = await notifyUiApproval(context.companyId, result.approval, context) as unknown as JsonValue; }
      catch { mainNotification = { status: "unconfirmed", automaticallyRetried: false }; }
      return { ...result, mainNotification } as unknown as JsonValue;
    } }, { key: "builder.retry-ui-approval-notification", handler: async (params, context) => {
      const { approvalRevisionId } = exactToolRecord(userActionInput(params, context), ["approvalRevisionId"]);
      if (typeof approvalRevisionId !== "string" || !UUID.test(approvalRevisionId)) throw new TypeError("An exact UI approval revision ID is required.");
      const view = await readUiContractView(context.companyId, context);
      if (view.approval?.revisionId !== approvalRevisionId) return { status: "stale" };
      return notifyUiApproval(context.companyId, view.approval, context);
    } }, { key: "builder.select-lead-agent", handler: async (params, context) =>
      selectLeadAgent(context.companyId, userActionInput(params, context), context) },
    { key: "builder.select-integration-manager", handler: async (params, context) =>
      await serialize(context.companyId, () => selectIntegrationManager(context.companyId,
        userActionInput(params, context), context)) as unknown as JsonValue },
    { key: "builder.prepare-integration-manager", handler: async (params, context) =>
      await serialize(context.companyId, () => prepareIntegrationManager(context.companyId,
        userActionInput(params, context), context)) as unknown as JsonValue },
    { key: "builder.prepare-lead-sessions", handler: async (params, context) =>
      prepareLeadSessions(context.companyId, userActionInput(params, context), context) },
    { key: "builder.send-lead-message", handler: async (params, context) =>
      sendLeadMessage(context.companyId, userActionInput(params, context), context) },
    { key: "builder.refresh-lead-conversation", handler: async (params, context) =>
      refreshLeadConversation(context.companyId, userActionInput(params, context), context) },
    { key: "builder.cancel-lead-message", handler: async (params, context) =>
      cancelLeadMessage(context.companyId, userActionInput(params, context), context) },
    { key: "builder.resume-prepared-lead-message", handler: async (params, context) =>
      resumePreparedLeadMessage(context.companyId, userActionInput(params, context), context) },
    { key: "builder.save-product-selection", handler: async (params, context) =>
      await saveProductSelectionAction(params, context) as unknown as JsonValue }],
  });
}
