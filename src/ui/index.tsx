import { useEffect, useMemo, useRef, useState } from "react";
import { useHostContext, usePluginAction, usePluginData } from "@sonparkserver/plugin-sdk/ui/bridge";
import { BuilderShell } from "./BuilderShell.tsx";
import { createEmptyBuilderSnapshot, parseBuilderSnapshot } from "../domain/snapshot.ts";
import { parseLeadAgentOptions } from "../domain/lead-agent.ts";
import { parseLeadContexts } from "../domain/lead-contexts.ts";
import type { LeadConversationId } from "../domain/model.ts";
import { parseQuestionContext, type QuestionContext } from "../domain/question-context.ts";
import { parseLeadConversationPage } from "../lead-conversations.ts";
import { parseDesignDraftView, projectDesignDraft } from "../domain/design-draft-view.ts";
import { projectDesignBaseline } from "../domain/design-baseline-view.ts";
import { projectTechnologyDecisions } from "../domain/technology-decisions-view.ts";
import { projectWorkstreams } from "../domain/workstreams-view.ts";
import { projectLeadMemory } from "../domain/lead-memory-view.ts";
import { projectProjectCtos } from "../domain/project-ctos-view.ts";
import { parseCtoUserQuestionsView, projectCtoUserQuestions } from "../domain/cto-question-view.ts";
import { invalidateLiveScopeOnCleanup, resumePreparedMessageInScope } from "./prepared-message-resume.ts";

export function BuilderPage() {
  const context = useHostContext();
  const state = usePluginData<unknown>("builder.snapshot");
  const lead = usePluginData<unknown>("builder.lead-agents");
  const logicalContexts = usePluginData<unknown>("builder.lead-contexts");
  const design = usePluginData<unknown>("builder.design-draft", { projectId: context.companyId ?? "" });
  const designBaseline = usePluginData<unknown>("builder.design-baseline", { projectId: context.companyId ?? "" });
  const technology = usePluginData<unknown>("builder.technology-decisions", { projectId: context.companyId ?? "" });
  const workstreams = usePluginData<unknown>("builder.workstreams", { projectId: context.companyId ?? "" });
  const memory = usePluginData<unknown>("builder.lead-memory", { projectId: context.companyId ?? "" });
  const projectCtos = usePluginData<unknown>("builder.project-ctos", { projectId: context.companyId ?? "" });
  const ctoUserDecisions = usePluginData<unknown>("builder.cto-user-decisions", { projectId: context.companyId ?? "" });
  const [channel, setChannel] = useState<LeadConversationId>("user_conversation");
  const [cursor, setCursor] = useState<string | null>(null);
  const conversation = usePluginData<unknown>("builder.lead-conversation", { contextId: channel, cursor });
  const send = usePluginAction<{ contextId: LeadConversationId; requestId: string; text: string; questionContext?: QuestionContext }, { saved: boolean; requestId: string }>("builder.send-lead-message");
  const refreshConversation = usePluginAction<{ contextId: LeadConversationId }, { refreshed: boolean }>("builder.refresh-lead-conversation");
  const cancelMessage = usePluginAction<{ contextId: LeadConversationId }, { cancellationRequested: boolean }>("builder.cancel-lead-message");
  const resumeMessage = usePluginAction<{ contextId: LeadConversationId; requestId: string }, { saved: boolean; requestId: string }>("builder.resume-prepared-lead-message");
  const selectLead = usePluginAction<{ agentId: string | null; expectedRevision: number }, { saved: boolean; executionStarted: boolean }>("builder.select-lead-agent");
  const prepareLeadContexts = usePluginAction<{ agentId: string; expectedRevision: number; requestId: string },
    { saved: boolean; requestId: string; status: "ready"; contextsReady: true }>("builder.prepare-lead-contexts");
  const importText = usePluginAction<{ requestId: string; text: string }, { saved: boolean; analysisStarted: boolean }>("builder.import-consultation");
  const pending = useRef<{ workspaceId: string; text: string; requestId: string } | null>(null);
  const pendingMessage = useRef<{ workspaceId: string; channel: LeadConversationId; text: string; questionContext: QuestionContext | null; requestId: string } | null>(null);
  const liveScope = useRef<{ key: string; token: object } | null>(null);
  const current = useMemo(() => {
    if (!context.companyId) return null;
    try {
      return { snapshot: state.data === null ? createEmptyBuilderSnapshot(context.companyId)
        : parseBuilderSnapshot(state.data, context.companyId), error: null };
    } catch {
      return { snapshot: createEmptyBuilderSnapshot(context.companyId), error: "Workspace data could not be validated. Refresh to try again." };
    }
  }, [context.companyId, state.data]);
  const leadOptions = useMemo(() => {
    if (!context.companyId || lead.loading || lead.error) return null;
    try { return parseLeadAgentOptions(lead.data, context.companyId); } catch { return null; }
  }, [context.companyId, lead.data, lead.loading, lead.error]);
  const currentLeadContexts = useMemo(() => {
    if (!context.companyId || !leadOptions || logicalContexts.loading || logicalContexts.error || logicalContexts.data === null) return null;
    try {
      const parsed = parseLeadContexts(logicalContexts.data, context.companyId);
      return parsed.selectionRevision === leadOptions.revision && parsed.agentId === leadOptions.selectedAgentId ? parsed : null;
    } catch { return null; }
  }, [context.companyId, leadOptions, logicalContexts.data, logicalContexts.loading, logicalContexts.error]);
  const conversationPage = useMemo(() => {
    if (!currentLeadContexts || currentLeadContexts.status !== "ready" || conversation.loading || conversation.error) return null;
    try { return parseLeadConversationPage(conversation.data, currentLeadContexts, channel); } catch { return null; }
  }, [currentLeadContexts, conversation.data, conversation.loading, conversation.error, channel]);
  const draftView = useMemo(() => {
    if (!context.companyId || !leadOptions?.selectedAgentId || design.loading || design.error) return { view: null, error: null };
    if (design.data === null) return { view: null, error: null };
    try { return { view: parseDesignDraftView(design.data, context.companyId, leadOptions.revision, leadOptions.selectedAgentId), error: null }; }
    catch { return { view: null, error: "설계 초안을 확인하지 못했습니다. 새로고침해 주세요." }; }
  }, [context.companyId, leadOptions, design.data, design.loading, design.error]);
  const memoryView = useMemo(() => {
    if (!current) return { snapshot: null, error: null };
    let projected = current.snapshot;
    if (!projectCtos.error && (projectCtos.data !== null && projectCtos.data !== undefined || !projectCtos.loading)) {
      try { projected = projectProjectCtos(projected, projectCtos.data); }
      catch { return { snapshot: current.snapshot, error: projectCtos.loading ? null : "프로젝트 CTO 목록을 확인하지 못했습니다. 새로고침해 주세요." }; }
    }
    if (memory.loading || memory.error) return { snapshot: projected, error: null };
    try { return { snapshot: projectLeadMemory(projected, memory.data), error: null }; }
    catch { return { snapshot: projected, error: "Lead 공유 기억을 확인하지 못했습니다. 새로고침해 주세요." }; }
  }, [current, projectCtos.data, projectCtos.loading, projectCtos.error, memory.data, memory.loading, memory.error]);
  const baselineView = useMemo(() => {
    if (!memoryView.snapshot) return { snapshot: null, error: null };
    if (designBaseline.error) return { snapshot: memoryView.snapshot, error: "설계 기준을 불러오지 못했습니다. 새로고침해 주세요." };
    if (designBaseline.loading || designBaseline.data === null) {
      return { snapshot: memoryView.snapshot, error: null };
    }
    try { return { snapshot: projectDesignBaseline(memoryView.snapshot, designBaseline.data), error: null }; }
    catch { return { snapshot: memoryView.snapshot, error: "설계 기준을 확인하지 못했습니다. 새로고침해 주세요." }; }
  }, [memoryView, designBaseline.data, designBaseline.loading, designBaseline.error]);
  const technologyView = useMemo(() => {
    if (!baselineView.snapshot) return { snapshot: null, error: null };
    if (technology.error) return { snapshot: baselineView.snapshot, error: "기술 선정 명세를 불러오지 못했습니다. 새로고침해 주세요." };
    if (technology.loading || technology.data === null) return { snapshot: baselineView.snapshot, error: null };
    try { return { snapshot: projectTechnologyDecisions(baselineView.snapshot, technology.data), error: null }; }
    catch { return { snapshot: baselineView.snapshot, error: "기술 선정 명세를 확인하지 못했습니다. 새로고침해 주세요." }; }
  }, [baselineView, technology.data, technology.loading, technology.error]);
  const workstreamsView = useMemo(() => {
    if (!technologyView.snapshot) return { snapshot: null, error: null };
    if (workstreams.error) return { snapshot: technologyView.snapshot, error: "CTO 작업 명세를 불러오지 못했습니다. 새로고침해 주세요." };
    if (workstreams.loading || workstreams.data === null) return { snapshot: technologyView.snapshot, error: null };
    try { return { snapshot: projectWorkstreams(technologyView.snapshot, workstreams.data), error: null }; }
    catch { return { snapshot: technologyView.snapshot, error: "CTO 작업 명세를 확인하지 못했습니다. 새로고침해 주세요." }; }
  }, [technologyView, workstreams.data, workstreams.loading, workstreams.error]);
  const ctoQuestionsView = useMemo(() => {
    if (!context.companyId || !workstreamsView.snapshot) return { snapshot: workstreamsView.snapshot, error: null };
    const decisionBase = { ...workstreamsView.snapshot, questions: [] };
    if (ctoUserDecisions.error) return { snapshot: decisionBase, error: "CTO 사용자 결정 질문을 불러오지 못했습니다. 새로고침해 주세요." };
    if (ctoUserDecisions.loading || ctoUserDecisions.data === null) return { snapshot: decisionBase, error: null };
    try {
      const view = parseCtoUserQuestionsView(ctoUserDecisions.data, context.companyId, context.companyId);
      return { snapshot: projectCtoUserQuestions(decisionBase, view), error: null };
    } catch { return { snapshot: decisionBase, error: "CTO 사용자 결정 질문을 확인하지 못했습니다. 새로고침해 주세요." }; }
  }, [context.companyId, workstreamsView, ctoUserDecisions.data, ctoUserDecisions.loading, ctoUserDecisions.error]);
  const scopeKey = JSON.stringify([context.companyId, leadOptions?.revision ?? null, channel]);
  if (liveScope.current?.key !== scopeKey) liveScope.current = { key: scopeKey, token: {} };
  const scopeToken = liveScope.current.token;
  const conversationActionIdentity = JSON.stringify([scopeKey, conversationPage?.active?.requestId ?? null]);
  const conversationAction = useRef<{ identity: string; token: object } | null>(null);
  if (conversationAction.current?.identity !== conversationActionIdentity) {
    conversationAction.current = { identity: conversationActionIdentity, token: {} };
  }
  const conversationActionToken = conversationAction.current.token;
  const createConversationActionGuard = () => {
    const actionToken = conversationAction.current?.token;
    const actionScope = liveScope.current;
    return () => conversationAction.current?.token === actionToken
      && liveScope.current?.token === actionScope?.token && liveScope.current?.key === actionScope?.key;
  };
  useEffect(() => invalidateLiveScopeOnCleanup(liveScope, scopeKey), [scopeKey]);
  useEffect(() => { setCursor(null); pendingMessage.current = null; }, [context.companyId, leadOptions?.revision]);
  useEffect(() => {
    const request = conversationPage?.active;
    if (!request?.runId || request.state === "uncertain" || conversation.error) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const observedScopeToken = scopeToken;
    async function poll() {
      if (disposed || liveScope.current?.token !== observedScopeToken) return;
      if (document.visibilityState === "hidden") { timer = setTimeout(() => void poll(), 2_000); return; }
      try {
        await refreshConversation({ contextId: channel });
        if (!disposed && liveScope.current?.token === observedScopeToken) { conversation.refresh(); design.refresh(); designBaseline.refresh(); technology.refresh(); workstreams.refresh(); memory.refresh(); projectCtos.refresh(); ctoUserDecisions.refresh(); }
      } catch {
        // Polling only observes the exact saved request. Stop on error; the
        // explicit button remains available and no send is retried here.
        return;
      }
      if (!disposed) timer = setTimeout(() => void poll(), 2_000);
    }
    timer = setTimeout(() => void poll(), 2_000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [conversationPage?.active?.requestId, conversationPage?.active?.runId, conversationPage?.active?.state,
    conversation.error, scopeKey, scopeToken, channel, refreshConversation, conversation.refresh, design.refresh, designBaseline.refresh, technology.refresh, workstreams.refresh, memory.refresh, projectCtos.refresh, ctoUserDecisions.refresh]);
  if (!current || !context.companyId) return <section role="status">Select an SPS Workspace to open Builder.</section>;
  const workspaceId = context.companyId;
  const presented = ctoQuestionsView.snapshot ?? workstreamsView.snapshot ?? technologyView.snapshot ?? baselineView.snapshot ?? memoryView.snapshot ?? current.snapshot;
  return <BuilderShell key={workspaceId} snapshot={draftView.view ? projectDesignDraft(presented, draftView.view) : presented}
    designDraft={draftView.view?.draft ?? null} designDraftLoading={design.loading}
    designDraftResolvedQuestionIds={draftView.view?.decisions?.map(decision => decision.questionId) ?? []}
    designDraftError={draftView.error ?? (design.error ? "설계 초안을 불러오지 못했습니다." : null)}
    workspaceLabel={context.companyPrefix ?? "Workspace"}
    conversation={conversationPage} conversationChannel={channel} conversationActionToken={conversationActionToken}
    isConversationActionCurrent={createConversationActionGuard}
    conversationLoading={conversation.loading}
    conversationError={currentLeadContexts?.status === "ready" && currentLeadContexts.contexts[channel as keyof typeof currentLeadContexts.contexts]
      && !conversation.loading && !conversationPage ? "대화 기록을 확인하지 못했습니다. 새로고침해 주세요." : null}
    conversationHasNewer={cursor !== null}
    onLeadChannelChange={next => {
      if (next !== channel) liveScope.current = { key: JSON.stringify([context.companyId, leadOptions?.revision ?? null, next]), token: {} };
      setChannel(next); setCursor(null); pendingMessage.current = null;
      conversation.refresh(); design.refresh(); designBaseline.refresh(); technology.refresh(); workstreams.refresh();
      memory.refresh(); projectCtos.refresh(); ctoUserDecisions.refresh(); logicalContexts.refresh();
    }}
    onOlderConversation={conversationPage?.nextCursor ? () => setCursor(conversationPage.nextCursor) : undefined}
    onLatestConversation={cursor !== null ? () => setCursor(null) : undefined}
    onRefreshConversation={currentLeadContexts?.status === "ready" && currentLeadContexts.contexts[channel as keyof typeof currentLeadContexts.contexts] ? async () => {
      const isCurrent = createConversationActionGuard();
      try {
        const result = await refreshConversation({ contextId: channel });
        if (result.refreshed !== true) throw new Error("Unexpected refresh result.");
      } finally {
        if (isCurrent()) {
          conversation.refresh(); lead.refresh(); design.refresh(); designBaseline.refresh(); technology.refresh(); workstreams.refresh(); memory.refresh(); projectCtos.refresh();
        }
      }
    } : undefined}
    onCancelLeadMessage={conversationPage?.active?.runId ? async () => {
      const isCurrent = createConversationActionGuard();
      try { await cancelMessage({ contextId: channel }); }
      finally { if (isCurrent()) conversation.refresh(); }
    } : undefined}
    onResumePreparedLeadMessage={conversationPage?.active?.state === "prepared" ? async () => {
      const requestId = conversationPage.active!.requestId;
      const isCurrent = createConversationActionGuard();
      const actionScopeToken = liveScope.current?.token;
      if (!actionScopeToken) return;
      await resumePreparedMessageInScope({ requestId, scopeToken: actionScopeToken, currentScopeToken: () => isCurrent() ? actionScopeToken : null,
        resume: () => resumeMessage({ contextId: channel, requestId }),
        refreshCurrentScope: [conversation.refresh, lead.refresh, design.refresh, designBaseline.refresh, technology.refresh,
          workstreams.refresh, memory.refresh, projectCtos.refresh, ctoUserDecisions.refresh, logicalContexts.refresh] });
    } : undefined}
    onSendMessage={conversationPage && !conversationPage.active && !conversation.loading && !conversation.error
      && !current.error && !state.loading && !state.error && !lead.error && leadOptions
      && leadOptions.agents.some(agent => agent.id === leadOptions.selectedAgentId && ["idle", "running"].includes(agent.status)) ? async (text, selectedChannel, questionContext) => {
      const actionScopeToken = liveScope.current?.token;
      const actionScopeKey = liveScope.current?.key;
      const isCurrent = () => liveScope.current?.token === actionScopeToken && liveScope.current?.key === actionScopeKey;
      if (selectedChannel !== channel || ["cto-inbox", "background_planning", "question_intake"].includes(selectedChannel)) throw new Error("Conversation changed.");
      if ((questionContext && selectedChannel !== "question_discussion") || selectedChannel === "question_discussion" && !questionContext) throw new Error("Question Discussion requires a specific current question.");
      const contextSnapshot = questionContext ? parseQuestionContext(questionContext) : null;
      if (!pendingMessage.current || pendingMessage.current.workspaceId !== workspaceId
        || pendingMessage.current.channel !== channel || pendingMessage.current.text !== text
        || JSON.stringify(pendingMessage.current.questionContext) !== JSON.stringify(contextSnapshot)) {
        pendingMessage.current = { workspaceId, channel, text, questionContext: contextSnapshot, requestId: crypto.randomUUID() };
      }
      const request = pendingMessage.current;
      try {
        const result = await send({ contextId: channel, text, requestId: request.requestId,
          ...(request.questionContext ? { questionContext: request.questionContext } : {}) });
        if (!isCurrent()) throw new Error("Conversation changed while sending.");
        if (result.saved !== true || result.requestId !== request.requestId) throw new Error("Unexpected send result.");
        pendingMessage.current = null;
        setCursor(null);
      } finally { if (isCurrent()) { conversation.refresh(); lead.refresh(); designBaseline.refresh(); } }
    } : undefined}
    leadAgents={leadOptions} leadAgentsLoading={lead.loading}
    leadAgentsError={!lead.loading && !leadOptions ? "Agent 목록을 불러오지 못했습니다. 새로고침해 주세요." : null}
    onSelectLeadAgent={async (agentId, expectedRevision) => {
      if (!leadOptions || lead.loading || lead.error) throw new Error("Agent settings are not ready.");
      const result = await selectLead({ agentId, expectedRevision });
      if (result.saved !== true || result.executionStarted !== false) throw new Error("Unexpected Lead Agent selection result.");
      lead.refresh();
      design.refresh();
      designBaseline.refresh();
      technology.refresh();
      workstreams.refresh();
      memory.refresh();
      projectCtos.refresh();
      ctoUserDecisions.refresh();
      conversation.refresh();
    }}
    leadContexts={currentLeadContexts} leadContextsLoading={lead.loading || logicalContexts.loading}
    leadContextsError={!lead.loading && leadOptions && !logicalContexts.loading && logicalContexts.data !== null && !currentLeadContexts
      ? "새 Lead 구성 상태를 확인하지 못했습니다. 새로고침해 주세요." : logicalContexts.error ? "새 Lead 구성 상태를 불러오지 못했습니다." : null}
    onPrepareLeadContexts={async (agentId, expectedRevision) => {
      if (!leadOptions || lead.loading || logicalContexts.loading || logicalContexts.error || currentLeadContexts
        || leadOptions.selectedAgentId !== agentId || leadOptions.revision !== expectedRevision) {
        throw new Error("Lead context settings are not ready for a new explicit start.");
      }
      const requestId = crypto.randomUUID();
      try {
        const result = await prepareLeadContexts({ agentId, expectedRevision, requestId });
        if (result.saved !== true || result.requestId !== requestId || result.status !== "ready" || result.contextsReady !== true) {
          throw new Error("Unexpected Lead context preparation result.");
        }
      } finally { logicalContexts.refresh(); }
    }}
    loading={state.loading || projectCtos.loading || ctoUserDecisions.loading} error={current.error ?? memoryView.error ?? baselineView.error ?? technologyView.error ?? workstreamsView.error ?? ctoQuestionsView.error ?? (projectCtos.error ? "프로젝트 CTO 목록을 불러오지 못했습니다." : null) ?? (memory.error ? "Lead 공유 기억을 불러오지 못했습니다." : null) ?? (state.error ? "Builder data is unavailable. Refresh to try again." : null)}
    onRefresh={() => { state.refresh(); lead.refresh(); logicalContexts.refresh(); conversation.refresh(); design.refresh(); designBaseline.refresh(); technology.refresh(); workstreams.refresh(); memory.refresh(); projectCtos.refresh(); ctoUserDecisions.refresh(); }} onImportConsultation={async text => {
      if (state.loading || state.error || current.error) throw new Error("Workspace data is not ready.");
      if (pending.current?.workspaceId !== workspaceId || pending.current.text !== text) {
        pending.current = { workspaceId, text, requestId: crypto.randomUUID() };
      }
      const result = await importText({ requestId: pending.current.requestId, text });
      if (result.saved !== true || result.analysisStarted !== false) throw new Error("Unexpected consultation import result.");
      pending.current = null;
      state.refresh();
    }} />;
}
