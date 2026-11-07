import { useEffect, useMemo, useRef, useState } from "react";
import { useHostContext, usePluginAction, usePluginData } from "@sonparkserver/plugin-sdk/ui/bridge";
import { BuilderShell } from "./BuilderShell.tsx";
import { parseIntegrationManagerDTO } from "./IntegrationManagerSettings.tsx";
import { ProductSelectionPanel, type ProductSelectionSave } from "./ProductSelectionPanel.tsx";
import { ConsultationAnalysisControl } from "./ConsultationAnalysisControl.tsx";
import { UiContractPanel } from "./UiContractPanel.tsx";
import { IntegrationReviewPanel, parseIntegrationReviewDTO, type IntegrationReviewDTO } from "./IntegrationReviewPanel.tsx";
import { FirstDesignReviewPanel, type FirstDesignReviewApprovalInput, type FirstDesignReviewPanelView } from "./FirstDesignReviewPanel.tsx";
import { ChangeImpactPanel, type G5ChangeImpactRequest, type G5ChangeImpactReadDTO } from "./ChangeImpactPanel.tsx";
import type { G5ComparisonPairsReadDTO } from "../g5-comparison-pairs.ts";
import type { ApproveUiProposalInput } from "./UiHtmlReview.tsx";
import { createEmptyBuilderSnapshot, parseBuilderSnapshot } from "../domain/snapshot.ts";
import { parseLeadAgentOptions } from "../domain/lead-agent.ts";
import { parseLeadSessions } from "../domain/lead-sessions.ts";
import type { LeadChannel } from "../domain/model.ts";
import { parseQuestionContext, type QuestionContext } from "../domain/question-context.ts";
import { parseLeadConversationPage } from "../lead-conversations.ts";
import { parseDesignDraftView, projectDesignDraft } from "../domain/design-draft-view.ts";
import { projectDesignBaseline } from "../domain/design-baseline-view.ts";
import { projectBaselineDocument } from "../domain/project-documents-view.ts";
import { projectDeliveryDocuments } from "../domain/delivery-documents-view.ts";
import { projectTechnologyDecisions } from "../domain/technology-decisions-view.ts";
import { projectReuseFirstCandidates } from "../domain/reuse-first-view.ts";
import { projectWorkstreams } from "../domain/workstreams-view.ts";
import { projectLeadMemory } from "../domain/lead-memory-view.ts";
import { projectProjectCtos } from "../domain/project-ctos-view.ts";
import { parseCtoUserQuestionsView, projectCtoUserQuestions } from "../domain/cto-question-view.ts";

export function BuilderPage() {
  const context = useHostContext();
  const state = usePluginData<unknown>("builder.snapshot");
  const productSelection = usePluginData<unknown>("builder.product-selection");
  const saveProductSelection = usePluginAction<ProductSelectionSave, unknown>("builder.save-product-selection");
  const lead = usePluginData<unknown>("builder.lead-agents");
  const sessions = usePluginData<unknown>("builder.lead-sessions");
  const integrationManager = usePluginData<unknown>("builder.integration-manager");
  const selectIntegrationManager = usePluginAction<{ agentId: string | null; expectedRevision: number }, unknown>("builder.select-integration-manager");
  const prepareIntegrationManager = usePluginAction<{ projectId: string; expectedManagerRevision: number }, unknown>("builder.prepare-integration-manager");
  const design = usePluginData<unknown>("builder.design-draft", { projectId: context.companyId ?? "" });
  const designBaseline = usePluginData<unknown>("builder.design-baseline", { projectId: context.companyId ?? "" });
  const baselineDocument = usePluginData<unknown>("builder.baseline-document");
  const deliveryDocuments = usePluginData<unknown>("builder.delivery-documents");
  const uiContracts = usePluginData<unknown>("builder.ui-contracts");
  const approveUiProposal = usePluginAction<ApproveUiProposalInput, unknown>("builder.approve-ui-proposal");
  const retryUiNotification = usePluginAction<{ approvalRevisionId: string }, unknown>("builder.retry-ui-approval-notification");
  const finalReview = usePluginData<unknown>("builder.final-review");
  const firstReview = usePluginData<unknown>("builder.first-design-review");
  const compareChangeImpact = usePluginAction<G5ChangeImpactRequest, G5ChangeImpactReadDTO>("builder.read-change-impact");
  const readG5ComparisonPairs = usePluginAction<{ projectId: string }, G5ComparisonPairsReadDTO>("builder.read-g5-comparison-pairs");
  const approveFirstReview = usePluginAction<FirstDesignReviewApprovalInput, { status: string }>("builder.approve-first-design-review");
  const decideFinalReview = usePluginAction<{ eventId: string; requestId: string; expectedBaseRevisionId: string;
    action: "approve" | "request-changes" | "hold"; reason?: string }, { status: string }>("builder.final-review-decision");
  const finalDecisionAttempt = useRef<{ key: string; eventId: string } | null>(null);
  const technology = usePluginData<unknown>("builder.technology-decisions", { projectId: context.companyId ?? "" });
  const reuseCandidates = usePluginData<unknown>("builder.reuse-candidates");
  const workstreams = usePluginData<unknown>("builder.workstreams", { projectId: context.companyId ?? "" });
  const memory = usePluginData<unknown>("builder.lead-memory", { projectId: context.companyId ?? "" });
  const projectCtos = usePluginData<unknown>("builder.project-ctos", { projectId: context.companyId ?? "" });
  const ctoUserDecisions = usePluginData<unknown>("builder.cto-user-decisions", { projectId: context.companyId ?? "" });
  const [channel, setChannel] = useState<LeadChannel>("main");
  const [cursor, setCursor] = useState<string | null>(null);
  const conversation = usePluginData<unknown>("builder.lead-conversation", { channel, cursor });
  const send = usePluginAction<{ channel: LeadChannel; requestId: string; text: string; questionContext?: QuestionContext }, { saved: boolean; requestId: string }>("builder.send-lead-message");
  const refreshConversation = usePluginAction<{ channel: LeadChannel }, { refreshed: boolean }>("builder.refresh-lead-conversation");
  const cancelMessage = usePluginAction<{ channel: LeadChannel }, { cancellationRequested: boolean }>("builder.cancel-lead-message");
  const resumeMessage = usePluginAction<{ channel: LeadChannel; requestId: string }, { saved: boolean; requestId: string }>("builder.resume-prepared-lead-message");
  const selectLead = usePluginAction<{ agentId: string | null; expectedRevision: number }, { saved: boolean; executionStarted: boolean }>("builder.select-lead-agent");
  const prepareLead = usePluginAction<{ agentId: string; expectedRevision: number }, { saved: boolean; executionStarted: boolean; sessionsReady: boolean }>("builder.prepare-lead-sessions");
  const importText = usePluginAction<{ requestId: string; text: string }, { saved: boolean; analysisStarted: boolean }>("builder.import-consultation");
  const startAnalysis = usePluginAction<{ requestId: string; expectedCollectionRevision: number },
    { status: "requested" | "conflict"; analysisSnapshotSaved: boolean; requestSaved: boolean; requestId: string }>("builder.start-consultation-analysis");
  const pendingAnalysis = useRef<{ workspaceId: string; revision: number; requestId: string } | null>(null);
  const pending = useRef<{ workspaceId: string; text: string; requestId: string } | null>(null);
  const pendingMessage = useRef<{ workspaceId: string; channel: LeadChannel; text: string; questionContext: QuestionContext | null; requestId: string } | null>(null);
  const liveScope = useRef("");
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
  const integrationManagerOptions = useMemo(() => {
    if (!context.companyId || integrationManager.loading || integrationManager.error || integrationManager.data == null) return null;
    try { return parseIntegrationManagerDTO(integrationManager.data, context.companyId); } catch { return null; }
  }, [context.companyId, integrationManager.data, integrationManager.loading, integrationManager.error]);
  const leadSessions = useMemo(() => {
    if (!context.companyId || !leadOptions || sessions.loading || sessions.error) return null;
    try {
      const parsed = parseLeadSessions(sessions.data, context.companyId);
      return parsed.selectionRevision === leadOptions.revision && parsed.agentId === leadOptions.selectedAgentId ? parsed : null;
    } catch { return null; }
  }, [context.companyId, leadOptions, sessions.data, sessions.loading, sessions.error]);
  const conversationPage = useMemo(() => {
    if (!leadSessions || conversation.loading || conversation.error) return null;
    try { return parseLeadConversationPage(conversation.data, leadSessions, channel); } catch { return null; }
  }, [leadSessions, conversation.data, conversation.loading, conversation.error, channel]);
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
  const reuseView = useMemo(() => {
    if (!workstreamsView.snapshot || reuseCandidates.loading) return { snapshot: workstreamsView.snapshot, error: null };
    if (reuseCandidates.error) return { snapshot: workstreamsView.snapshot, error: "재사용 후보를 불러오지 못했습니다." };
    try { return { snapshot: projectReuseFirstCandidates(workstreamsView.snapshot, reuseCandidates.data), error: null }; }
    catch { return { snapshot: workstreamsView.snapshot, error: "재사용 후보의 출처를 확인하지 못했습니다." }; }
  }, [workstreamsView, reuseCandidates.data, reuseCandidates.loading, reuseCandidates.error]);
  const baselineDocumentView = useMemo(() => {
    if (!reuseView.snapshot || baselineDocument.loading || baselineDocument.error) return { snapshot: reuseView.snapshot, error: null };
    try { return { snapshot: projectBaselineDocument(reuseView.snapshot, baselineDocument.data), error: null }; }
    catch { return { snapshot: reuseView.snapshot, error: "기준선 문서 본문을 확인하지 못했습니다. 새로고침해 주세요." }; }
  }, [reuseView, baselineDocument.data, baselineDocument.loading, baselineDocument.error]);
  const documentsView = useMemo(() => {
    const { snapshot, error } = baselineDocumentView;
    if (!snapshot || deliveryDocuments.loading || deliveryDocuments.data == null && !deliveryDocuments.error) return baselineDocumentView;
    const readError = "납품 문서 초안을 확인하지 못했습니다.";
    if (deliveryDocuments.error) return { snapshot, error: error ?? readError };
    try {
      const documents = projectDeliveryDocuments(snapshot.workspaceId, deliveryDocuments.data);
      const ids = new Set(documents.map(document => document.id));
      return { snapshot: { ...snapshot, documents: [...snapshot.documents.filter(document => !ids.has(document.id)), ...documents] }, error };
    } catch {
      return { snapshot, error: error ?? readError };
    }
  }, [baselineDocumentView, deliveryDocuments.data, deliveryDocuments.loading, deliveryDocuments.error]);
  const ctoQuestionsView = useMemo(() => {
    if (!context.companyId || !documentsView.snapshot) return { snapshot: documentsView.snapshot, error: null };
    const decisionBase = { ...documentsView.snapshot, questions: [] };
    if (ctoUserDecisions.error) return { snapshot: decisionBase, error: "CTO 사용자 결정 질문을 불러오지 못했습니다. 새로고침해 주세요." };
    if (ctoUserDecisions.loading || ctoUserDecisions.data === null) return { snapshot: decisionBase, error: null };
    try {
      const view = parseCtoUserQuestionsView(ctoUserDecisions.data, context.companyId, context.companyId);
      return { snapshot: projectCtoUserQuestions(decisionBase, view), error: null };
    } catch { return { snapshot: decisionBase, error: "CTO 사용자 결정 질문을 확인하지 못했습니다. 새로고침해 주세요." }; }
  }, [context.companyId, documentsView, ctoUserDecisions.data, ctoUserDecisions.loading, ctoUserDecisions.error]);
  const scope = JSON.stringify([context.companyId, leadOptions?.revision ?? null, channel]);
  liveScope.current = scope;
  useEffect(() => { setCursor(null); pendingMessage.current = null; }, [context.companyId, leadOptions?.revision]);
  useEffect(() => {
    const request = conversationPage?.active;
    if (!request?.runId || request.state === "uncertain" || conversation.error) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const observedScope = scope;
    async function poll() {
      if (disposed || liveScope.current !== observedScope) return;
      if (document.visibilityState === "hidden") { timer = setTimeout(() => void poll(), 2_000); return; }
      try {
        await refreshConversation({ channel });
        if (!disposed && liveScope.current === observedScope) { conversation.refresh(); design.refresh(); designBaseline.refresh(); baselineDocument.refresh(); deliveryDocuments.refresh(); uiContracts.refresh(); firstReview.refresh(); technology.refresh(); reuseCandidates.refresh(); workstreams.refresh(); memory.refresh(); projectCtos.refresh(); ctoUserDecisions.refresh(); }
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
    conversation.error, scope, channel, refreshConversation, conversation.refresh, design.refresh, designBaseline.refresh, baselineDocument.refresh, deliveryDocuments.refresh, uiContracts.refresh, firstReview.refresh, technology.refresh, reuseCandidates.refresh, workstreams.refresh, memory.refresh, projectCtos.refresh, ctoUserDecisions.refresh]);
  if (!current || !context.companyId) return <section role="status">Select an SPS Workspace to open Builder.</section>;
  const workspaceId = context.companyId;
  let firstDesign: FirstDesignReviewPanelView = { status: firstReview.loading ? "loading" : "error" };
  if (!firstReview.loading && !firstReview.error && firstReview.data && typeof firstReview.data === "object") {
    const row = firstReview.data as Record<string, unknown>;
    if (row.status === "empty") firstDesign = { status: "empty" };
    else if ((row.status === "ready" || row.status === "stale") && typeof row.proposalRevisionId === "string"
      && row.proposalRevisionId === row.expectedHead && row.bundle && typeof row.bundle === "object"
      && "workspaceId" in row.bundle && row.bundle.workspaceId === workspaceId
      && "projectId" in row.bundle && row.bundle.projectId === workspaceId) {
      firstDesign = { status: row.status, bundle: row.bundle, proposalRevisionId: row.proposalRevisionId, expectedHead: row.proposalRevisionId };
    }
  }
  let review: IntegrationReviewDTO = { status: "unknown" };
  let reviewError = Boolean(finalReview.error);
  if (finalReview.loading) review = { status: "loading" };
  else if (!reviewError) {
    try {
      review = parseIntegrationReviewDTO(finalReview.data);
      if (review.status === "ready" && (review.snapshot.workspaceId !== workspaceId || review.snapshot.projectId !== workspaceId)) {
        review = { status: "unknown" }; reviewError = true;
      }
    } catch { reviewError = true; }
  }
  const reviewRequest = review.status === "ready" && !review.decision ? review.approvalRequest : null;
  async function respondToFinalReview(action: "approve" | "request-changes" | "hold", reason?: string) {
    if (!reviewRequest || reviewError) throw new Error("The current approval request is not available.");
    const key = JSON.stringify([workspaceId, reviewRequest.requestId, reviewRequest.eventId, action, reason ?? null]);
    const attempt = finalDecisionAttempt.current?.key === key ? finalDecisionAttempt.current : { key, eventId: crypto.randomUUID() };
    finalDecisionAttempt.current = attempt;
    try {
      const result = await decideFinalReview({ eventId: attempt.eventId, requestId: reviewRequest.requestId,
        expectedBaseRevisionId: reviewRequest.eventId, action, ...(reason === undefined ? {} : { reason }) });
      if (result?.status !== "recorded") throw new Error("Final review decision was not confirmed.");
    } finally { finalReview.refresh(); }
  }
  const presented = ctoQuestionsView.snapshot ?? workstreamsView.snapshot ?? technologyView.snapshot ?? baselineView.snapshot ?? memoryView.snapshot ?? current.snapshot;
  return <BuilderShell key={workspaceId} snapshot={draftView.view ? projectDesignDraft(presented, draftView.view) : presented}
    changeImpact={<ChangeImpactPanel projectId={workspaceId} onReadComparisonPairs={readG5ComparisonPairs} onQueryImpact={compareChangeImpact} />}
    firstDesignReview={draftView.view || firstDesign.status === "ready" || firstDesign.status === "stale"
      ? <FirstDesignReviewPanel key={"expectedHead" in firstDesign ? firstDesign.expectedHead : workspaceId} view={firstDesign}
        onApprove={async input => {
          try {
            const result = await approveFirstReview(input);
            if (result?.status !== "published" && result?.status !== "conflict") throw new Error("First-design approval was not confirmed.");
            return result;
          } finally { firstReview.refresh(); designBaseline.refresh(); deliveryDocuments.refresh(); }
        }} /> : undefined}
    documentsLoading={state.loading || design.loading || baselineDocument.loading || deliveryDocuments.loading || designBaseline.loading || technology.loading || reuseCandidates.loading || workstreams.loading || memory.loading}
    documentsError={documentsView.error ?? reuseView.error ?? baselineView.error ?? technologyView.error ?? workstreamsView.error ?? draftView.error
      ?? (state.error || baselineDocument.error || design.error || memory.error ? "문서를 불러오지 못했습니다." : null)}
    finalReview={<IntegrationReviewPanel key={reviewRequest?.eventId ?? workspaceId} view={review}
      error={reviewError ? "최종 검토 자료를 불러오지 못했습니다." : null}
      onApprove={reviewRequest && review.status === "ready" && review.approvalEligibility.status === "eligible" ? () => respondToFinalReview("approve") : undefined}
      onRequestChanges={reviewRequest ? reason => respondToFinalReview("request-changes", reason) : undefined}
      onHold={reviewRequest ? reason => respondToFinalReview("hold", reason) : undefined} />}
    uiReview={<UiContractPanel workspaceId={workspaceId} value={uiContracts.data} loading={uiContracts.loading}
      unavailable={Boolean(uiContracts.error)} approve={approveUiProposal} retryNotification={retryUiNotification}
      refresh={() => { uiContracts.refresh(); conversation.refresh(); }} />}
    consultationAnalysis={<ConsultationAnalysisControl enabled={channel === "main" && Boolean(leadSessions?.sessions.main)
      && Boolean(conversationPage && !conversationPage.active) && !state.loading && !state.error && !current.error
      && current.snapshot.messages.some(message => message.id.startsWith("consultation-") && message.role === "user")}
    start={async () => {
      if (!pendingAnalysis.current || pendingAnalysis.current.workspaceId !== workspaceId) {
        pendingAnalysis.current = { workspaceId, revision: current.snapshot.revision, requestId: crypto.randomUUID() };
      }
      const request = pendingAnalysis.current;
      try {
        const result = await startAnalysis({ requestId: request.requestId, expectedCollectionRevision: request.revision });
        if (result.status === "conflict") {
          pendingAnalysis.current = null;
          throw new Error("The displayed consultation collection changed.");
        }
        if (result.analysisSnapshotSaved !== true || result.requestSaved !== true || result.requestId !== request.requestId) {
          throw new Error("Unexpected analysis request receipt.");
        }
        pendingAnalysis.current = null;
        setCursor(null);
      } finally { state.refresh(); conversation.refresh(); }
    }} />}
    productSelection={<ProductSelectionPanel workspaceId={workspaceId} value={productSelection.data} loading={productSelection.loading}
      unavailable={Boolean(productSelection.error)} save={async input => {
        const receipt = await saveProductSelection(input);
        if (receipt && typeof receipt === "object" && "status" in receipt && receipt.status === "saved") productSelection.refresh();
        return receipt;
      }} />}
    designDraft={draftView.view?.draft ?? null} designDraftLoading={design.loading}
    designDraftResolvedQuestionIds={draftView.view?.decisions?.map(decision => decision.questionId) ?? []}
    designDraftError={draftView.error ?? (design.error ? "설계 초안을 불러오지 못했습니다." : null)}
    workspaceLabel={context.companyPrefix ?? "Workspace"}
    conversation={conversationPage} conversationChannel={channel} conversationLoading={conversation.loading}
    conversationError={leadSessions?.sessions[channel] && !conversation.loading && !conversationPage ? "대화 기록을 확인하지 못했습니다. 새로고침해 주세요." : null}
    conversationHasNewer={cursor !== null}
    onLeadChannelChange={next => { setChannel(next); setCursor(null); if (next === "ui-design") uiContracts.refresh(); if (next === "integration-review") finalReview.refresh(); }}
    onOlderConversation={conversationPage?.nextCursor ? () => setCursor(conversationPage.nextCursor) : undefined}
    onLatestConversation={cursor !== null ? () => setCursor(null) : undefined}
    onRefreshConversation={leadSessions?.sessions[channel] ? async () => {
      try {
        const result = await refreshConversation({ channel });
        if (result.refreshed !== true) throw new Error("Unexpected refresh result.");
      } finally { conversation.refresh(); lead.refresh(); design.refresh(); designBaseline.refresh(); baselineDocument.refresh(); deliveryDocuments.refresh(); uiContracts.refresh(); technology.refresh(); workstreams.refresh(); memory.refresh(); projectCtos.refresh(); }
    } : undefined}
    onCancelLeadMessage={conversationPage?.active?.runId ? async () => {
      try { await cancelMessage({ channel }); } finally { conversation.refresh(); }
    } : undefined}
    onResumePreparedLeadMessage={conversationPage?.active?.state === "prepared" ? async () => {
      const requestId = conversationPage.active!.requestId;
      try {
        const result = await resumeMessage({ channel, requestId });
        if (result.saved !== true || result.requestId !== requestId) throw new Error("Unexpected prepared message result.");
      } finally { conversation.refresh(); }
    } : undefined}
    onSendMessage={conversationPage && !conversationPage.active && !conversation.loading && !conversation.error
      && !current.error && !state.loading && !state.error && !lead.error && leadOptions
      && leadOptions.agents.some(agent => agent.id === leadOptions.selectedAgentId && ["idle", "running"].includes(agent.status)) ? async (text, selectedChannel, questionContext) => {
      if (selectedChannel !== channel || selectedChannel === "cto-inbox") throw new Error("Conversation changed.");
      if (questionContext && selectedChannel !== "decisions") throw new Error("Question context is only valid for decisions.");
      const contextSnapshot = questionContext ? parseQuestionContext(questionContext) : null;
      if (!pendingMessage.current || pendingMessage.current.workspaceId !== workspaceId
        || pendingMessage.current.channel !== channel || pendingMessage.current.text !== text
        || JSON.stringify(pendingMessage.current.questionContext) !== JSON.stringify(contextSnapshot)) {
        pendingMessage.current = { workspaceId, channel, text, questionContext: contextSnapshot, requestId: crypto.randomUUID() };
      }
      const request = pendingMessage.current;
      try {
        const result = await send({ channel, text, requestId: request.requestId,
          ...(request.questionContext ? { questionContext: request.questionContext } : {}) });
        if (liveScope.current !== scope) throw new Error("Conversation changed while sending.");
        if (result.saved !== true || result.requestId !== request.requestId) throw new Error("Unexpected send result.");
        pendingMessage.current = null;
        setCursor(null);
      } finally { conversation.refresh(); lead.refresh(); designBaseline.refresh(); }
    } : undefined}
    leadAgents={leadOptions} leadAgentsLoading={lead.loading}
    leadAgentsError={!lead.loading && !leadOptions ? "Agent 목록을 불러오지 못했습니다. 새로고침해 주세요." : null}
    integrationManager={integrationManagerOptions} integrationManagerLoading={integrationManager.loading}
    integrationManagerError={!integrationManager.loading && (integrationManager.error || integrationManager.data != null && !integrationManagerOptions)
      ? "Manager 설정을 불러오지 못했습니다. 새로고침해 주세요." : null}
    onSelectIntegrationManager={async (agentId, expectedRevision) => {
      if (!integrationManagerOptions || integrationManager.loading || integrationManager.error
        || integrationManagerOptions.workspaceId !== workspaceId || integrationManagerOptions.revision !== expectedRevision) {
        throw new Error("Manager settings changed.");
      }
      await selectIntegrationManager({ agentId, expectedRevision });
    }}
    onPrepareIntegrationManager={async (projectId, expectedManagerRevision) => {
      if (!integrationManagerOptions || integrationManager.loading || integrationManager.error
        || projectId !== workspaceId || integrationManagerOptions.workspaceId !== workspaceId
        || integrationManagerOptions.revision !== expectedManagerRevision) throw new Error("Manager settings changed.");
      return prepareIntegrationManager({ projectId, expectedManagerRevision });
    }}
    onRefreshIntegrationManager={integrationManager.refresh}
    leadSessions={leadSessions} leadSessionsLoading={lead.loading || sessions.loading}
    leadSessionsError={!lead.loading && leadOptions && !sessions.loading && !leadSessions ? "Lead 세션 상태를 불러오지 못했습니다. 새로고침해 주세요." : null}
    onSelectLeadAgent={async (agentId, expectedRevision) => {
      if (!leadOptions || lead.loading || lead.error) throw new Error("Agent settings are not ready.");
      const result = await selectLead({ agentId, expectedRevision });
      if (result.saved !== true || result.executionStarted !== false) throw new Error("Unexpected Lead Agent selection result.");
      lead.refresh();
      design.refresh();
      designBaseline.refresh();
      uiContracts.refresh();
      technology.refresh();
      workstreams.refresh();
      memory.refresh();
      projectCtos.refresh();
      ctoUserDecisions.refresh();
      sessions.refresh();
      conversation.refresh();
    }}
    onPrepareLeadSessions={async (agentId, expectedRevision) => {
      if (!leadOptions || !leadSessions || lead.loading || sessions.loading || sessions.error) throw new Error("Lead session settings are not ready.");
      try {
        const result = await prepareLead({ agentId, expectedRevision });
        if (result.saved !== true || result.executionStarted !== false || result.sessionsReady !== true) throw new Error("Unexpected Lead session preparation result.");
      } finally { sessions.refresh(); conversation.refresh(); }
    }}
    loading={state.loading || projectCtos.loading || ctoUserDecisions.loading} error={current.error ?? memoryView.error ?? baselineView.error ?? technologyView.error ?? workstreamsView.error ?? baselineDocumentView.error ?? ctoQuestionsView.error ?? (baselineDocument.error ? "기준선 문서를 불러오지 못했습니다." : null) ?? (projectCtos.error ? "프로젝트 CTO 목록을 불러오지 못했습니다." : null) ?? (memory.error ? "Lead 공유 기억을 불러오지 못했습니다." : null) ?? (state.error ? "Builder data is unavailable. Refresh to try again." : null)}
    onRefresh={() => { state.refresh(); productSelection.refresh(); lead.refresh(); sessions.refresh(); integrationManager.refresh(); conversation.refresh(); design.refresh(); designBaseline.refresh(); baselineDocument.refresh(); deliveryDocuments.refresh(); uiContracts.refresh(); finalReview.refresh(); firstReview.refresh(); technology.refresh(); reuseCandidates.refresh(); workstreams.refresh(); memory.refresh(); projectCtos.refresh(); ctoUserDecisions.refresh(); }} onImportConsultation={async text => {
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
