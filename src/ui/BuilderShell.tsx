import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity, AlertCircle, ArrowUp, Bot, Check, ChevronLeft, ChevronRight, CircleHelp, FileText,
  GitBranch, GitFork, LoaderCircle, MessageSquare, Network, PanelRight, RefreshCw, Send,
  Server, Settings, Upload, X,
} from "lucide-react";
import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from "@xyflow/react";
import flowCss from "@xyflow/react/dist/style.css";
import builderCss from "./builder.css";
import { LeadAgentSettings } from "./LeadAgentSettings.tsx";
import { DesignDraftSummary } from "./DesignDraftSummary.tsx";
import { selectLeadDecisionTranscript } from "../domain/selectors.ts";
import { assertConsultationRequestSize, decodeConsultationFile, MAX_CONSULTATION_REQUEST_BYTES } from "../domain/consultation-file.js";
import type {
  BuilderActor, BuilderMessage, BuilderQuestion, BuilderShellProps, BuilderView, LeadChannel,
} from "../domain/model.js";

const NAV_ITEMS: Array<{ id: BuilderView; label: string; icon: typeof MessageSquare }> = [
  { id: "lead", label: "Lead 대화", icon: MessageSquare },
  { id: "architecture", label: "설계 시각화", icon: GitBranch },
  { id: "organization", label: "조직도", icon: Network },
  { id: "documents", label: "설계 문서", icon: FileText },
  { id: "decisions", label: "미결정사항", icon: CircleHelp },
  { id: "system", label: "시스템", icon: Server },
];

const VIEW_TITLES: Record<BuilderView, { title: string; description: string }> = {
  lead: { title: "Lead 대화", description: "요구사항과 설계를 Lead와 함께 정리합니다." },
  architecture: { title: "설계 시각화", description: "현재 Workspace의 설계 Graph를 조회합니다." },
  organization: { title: "조직도", description: "Workspace에 기록된 Lead와 실행 중인 작업 관계입니다." },
  documents: { title: "설계 문서", description: "Lead가 기록한 Workspace 문서와 Revision입니다." },
  decisions: { title: "미결정사항", description: "Lead에게 전달된 질문과 사용자 결정 기록입니다." },
  system: { title: "시스템", description: "현재 Workspace의 연결 상태와 제공 가능한 시스템 정보입니다." },
};

const ACTOR_STATUS: Record<BuilderActor["status"], string> = {
  idle: "대기", running: "실행 중", waiting: "응답 대기", failed: "실패", archived: "보관됨",
};

function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium", timeStyle: "short",
  }).format(date);
}

function actorInitial(actor: BuilderActor): string {
  return actor.role === "cto" ? "CTO" : actor.role === "qa" ? "QA" : actor.role === "development" ? "DEV" : "LD";
}

function actorStatusTone(status: BuilderActor["status"]): string {
  return status === "running" ? "실행 중" : status === "waiting" ? "응답 대기" : ACTOR_STATUS[status];
}

function EmptyState({ icon: Icon, title, detail }: { icon: typeof Activity; title: string; detail: string }) {
  return <div className="builder-empty"><Icon aria-hidden="true" /><strong>{title}</strong><p>{detail}</p></div>;
}

function StatusLabel({ status }: { status: BuilderQuestion["status"] }) {
  return <span className={`builder-tag${status === "open" ? " is-open" : ""}`}>{status === "open" ? "답변 필요" : "답변 완료"}</span>;
}

function ActivityRail({
  props, view, selectedQuestion, onSelectQuestion, onClose, actor = null, onOpenArchitecture,
}: {
  props: BuilderShellProps;
  view: BuilderView;
  selectedQuestion: BuilderQuestion | null;
  onSelectQuestion(id: string): void;
  onClose(): void;
  actor?: BuilderActor | null;
  onOpenArchitecture?(): void;
}) {
  const [tab, setTab] = useState("history");
  const panelId = useId();
  if (view === "decisions") {
    return <aside className="builder-activity-rail" aria-label="미결정사항 목록">
      <div className="builder-rail-header"><h2>미결정사항</h2><p>실제 저장된 Lead 질문</p></div>
      <div className="builder-rail-content">
        {props.snapshot.questions.length ? props.snapshot.questions.map(question => <button
          className={`builder-question-button${selectedQuestion?.id === question.id ? " is-selected" : ""}`}
          key={question.id} onClick={() => onSelectQuestion(question.id)} type="button">
          <strong>{question.title}</strong><small><StatusLabel status={question.status} /> · {question.id}</small>
        </button>) : <EmptyState icon={CircleHelp} title="등록된 질문이 없습니다" detail="Lead가 결정을 요청하면 여기에 표시됩니다." />}
      </div>
      <button aria-label="작업 기록 닫기" className="builder-icon-button builder-drawer-close" onClick={onClose} type="button"><X /></button>
    </aside>;
  }
  const leadIds = new Set(props.snapshot.actors.filter(value => value.role === "lead").map(value => value.id));
  const history = props.snapshot.activity.filter(item => actor ? item.actorId === actor.id : item.actorId === null || leadIds.has(item.actorId));
  const entities = props.snapshot.graph.entities.filter(item => !actor || item.ownerActorId === actor.id);
  const tabs = [
    { id: "changes", label: "수정사항", unavailable: "수정안 조회가 아직 연결되지 않았습니다." },
    { id: "orders", label: "작업 지시", unavailable: "작업 지시 조회가 아직 연결되지 않았습니다." },
    { id: "history", label: "기록", unavailable: null },
    { id: "files", label: "작업 파일", unavailable: "작업 파일 조회가 아직 연결되지 않았습니다." },
    { id: "design", label: "설계", unavailable: null },
  ];
  return <aside className="builder-activity-rail" aria-label="AI 작업 기록">
    <div className="builder-rail-header"><div className="builder-rail-head-top"><h2>AI 작업 기록</h2>
      {tab === "history" && <span className="builder-tag">{history.length}건</span>}</div>
      <p><strong>{actor?.label ?? "Lead"}</strong>의 수정사항·지시·작업 기록</p>
      <div aria-label="AI 작업 기록 종류" className="builder-rail-tabs" role="tablist" onKeyDown={event => {
        const enabled = tabs.filter(value => !value.unavailable);
        const index = enabled.findIndex(value => value.id === tab);
        const next = event.key === "ArrowRight" ? enabled[(index + 1) % enabled.length]
          : event.key === "ArrowLeft" ? enabled[(index + enabled.length - 1) % enabled.length]
            : event.key === "Home" ? enabled[0] : event.key === "End" ? enabled.at(-1) : null;
        if (!next) return;
        event.preventDefault(); setTab(next.id);
        event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus();
      }}>{tabs.map(value => <button aria-controls={panelId} aria-selected={tab === value.id} className="builder-rail-tab"
        data-tab={value.id} disabled={Boolean(value.unavailable)} id={`${panelId}-${value.id}`} key={value.id}
        onClick={() => setTab(value.id)} role="tab" tabIndex={tab === value.id ? 0 : -1}
        title={value.unavailable ?? value.label} type="button">{value.label}</button>)}</div>
    </div>
    <div aria-labelledby={`${panelId}-${tab}`} className="builder-rail-content builder-rail-panel is-active" id={panelId} role="tabpanel" tabIndex={0}>
      {tab === "history" ? history.length ? [...history].reverse().map(item => <div className="builder-activity-item" key={item.id}>
        <strong>{item.label}</strong>
        <small>{item.actorId ? props.snapshot.actors.find(actor => actor.id === item.actorId)?.label ?? "기록된 작업자" : "Workspace 활동"} · {displayTime(item.createdAt)}</small>
      </div>) : <EmptyState icon={Activity} title="활동 기록이 없습니다" detail="저장된 작업이 생기면 여기에 표시됩니다." />
        : <><div className="builder-rail-section-label">설계 흐름 요약</div><div className="builder-card">
          <h3>{props.snapshot.graph.revisionId ?? "등록된 설계가 없습니다"}</h3><p className="builder-card-sub">현재 범위의 설계 요소 {entities.length}개</p>
          {onOpenArchitecture && <button className="builder-quiet-button" onClick={onOpenArchitecture} type="button">설계 시각화 열기</button>}
        </div></>}
    </div>
    <div className="builder-rail-bottom">{actor?.label ?? "Lead"} 기준 · Builder에 저장된 기록</div>
    <button aria-label="작업 기록 닫기" className="builder-icon-button builder-drawer-close" onClick={onClose} type="button"><X /></button>
  </aside>;
}

function MessageList({ messages, actor, actors = [] }: { messages: readonly BuilderMessage[]; actor?: BuilderActor | null; actors?: BuilderActor[] }) {
  if (!messages.length) return <EmptyState icon={actor ? Bot : MessageSquare}
    title={actor ? "이 세션에 연결된 대화가 없습니다" : "Lead 대화가 아직 없습니다"}
    detail={actor ? "이 Builder 상태에는 해당 세션의 메시지가 기록되지 않았습니다." : "Lead에게 메시지를 보내면 실제 대화 기록이 여기에 표시됩니다."} />;
  return <div className="builder-transcript" aria-live="polite">
    {messages.map(message => {
      const isUser = message.role === "user";
      const messageActor = message.actorId ? actors.find(candidate => candidate.id === message.actorId) : null;
      const who = isUser ? "운영자" : message.role === "system" ? "시스템 기록" : actor?.label ?? messageActor?.label ?? "Lead";
      return <article className={`builder-message is-${message.role}`} key={message.id}>
        <span aria-hidden="true" className="builder-message-avatar">{isUser ? "ME" : message.role === "system" ? "i" : actor ? actorInitial(actor) : "LD"}</span>
        <div className="builder-message-content"><div className="builder-message-meta">{who} · {displayTime(message.createdAt)}</div>
          <div className="builder-message-bubble">{message.text}</div></div>
      </article>;
    })}
  </div>;
}

function conversationMessages(props: BuilderShellProps, channel: LeadChannel): BuilderMessage[] {
  const page = props.conversation;
  if (!page || page.channel !== channel) return [];
  return [...page.turns].reverse().flatMap(turn => [
    { id: `${turn.requestId}:user`, channel, actorId: null, role: "user" as const, text: turn.text, createdAt: turn.createdAt, runId: turn.runId },
    ...(turn.answer === null ? [] : [{ id: `${turn.requestId}:assistant`, channel, actorId: null, role: "assistant" as const,
      text: turn.answer, createdAt: turn.createdAt, runId: turn.runId }]),
    ...(turn.state === "succeeded" && turn.answer === null ? [{ id: `${turn.requestId}:unavailable`, channel, actorId: null,
      role: "system" as const, text: "실행은 끝났지만 확인 가능한 답변을 제공하지 않았습니다.", createdAt: turn.createdAt, runId: turn.runId }] : []),
    ...(["failed", "cancelled", "interrupted", "timed_out"].includes(turn.state) ? [{ id: `${turn.requestId}:terminal`, channel, actorId: null,
      role: "system" as const, text: ({ failed: "실행 실패", cancelled: "실행 중단", interrupted: "실행 끊김", timed_out: "실행 시간 초과" } as Record<string, string>)[turn.state]!,
      createdAt: turn.createdAt, runId: turn.runId }] : []),
  ]);
}

function ConversationControls({ props, channel }: { props: BuilderShellProps; channel: LeadChannel }) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  if (props.conversation === undefined || props.conversationChannel !== channel) return null;
  const current = props.conversation?.active;
  const labels = { prepared: "저장됨 · 전송 준비 중", dispatching: "접수 확인 중", uncertain: "접수 불명확 · 자동 재전송하지 않음",
    submitted: "실행 중 · 응답 확인 가능", succeeded: "실행 완료", failed: "실행 실패", cancelled: "중단됨", interrupted: "실행 끊김", timed_out: "시간 초과" };
  async function perform(action: (() => Promise<void>) | undefined) {
    if (!action || busy) return;
    setBusy(true); setFeedback("");
    try { await action(); }
    catch { setFeedback("결과를 확인하지 못했습니다. 같은 실행의 상태를 다시 확인해 주세요."); }
    finally { setBusy(false); }
  }
  return <div className="builder-conversation-controls">
    <div className="builder-header-actions">
      <button className="builder-quiet-button" disabled={busy || props.conversationLoading || !props.onRefreshConversation}
        onClick={() => void perform(props.onRefreshConversation)} type="button"><RefreshCw size={14} />응답 확인</button>
      {current?.state === "prepared" && <button className="builder-quiet-button" disabled={busy || props.conversationLoading || !props.onResumePreparedLeadMessage}
        onClick={() => void perform(props.onResumePreparedLeadMessage)} type="button">저장된 메시지 전송</button>}
      {current && <button className="builder-quiet-button" disabled={busy || props.conversationLoading || !props.onCancelLeadMessage || current.cancellationRequested}
        onClick={() => void perform(props.onCancelLeadMessage)} type="button">실행 중단</button>}
      {props.onOlderConversation && <button className="builder-quiet-button" disabled={busy || props.conversationLoading}
        onClick={props.onOlderConversation} type="button">이전 대화</button>}
      {props.conversationHasNewer && <button className="builder-quiet-button" disabled={busy || props.conversationLoading}
        onClick={props.onLatestConversation} type="button">최신 대화</button>}
    </div>
    {(current || props.conversationLoading || props.conversationError || feedback) && <p className="builder-composer-note" role="status">
      {props.conversationLoading ? "대화 상태 확인 중" : props.conversationError ?? (feedback
        || (current ? `${labels[current.state]}${current.cancellationRequested && current.termination !== "confirmed" ? " · 종료 확인 대기" : ""}` : ""))}
    </p>}
  </div>;
}

function MessageComposer({
  enabled, channel, onSend,
}: { enabled: boolean; channel: LeadChannel; onSend?: BuilderShellProps["onSendMessage"] }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = text.trim();
    if (!value || !enabled || !onSend || sending) return;
    setSending(true);
    setFeedback("");
    try { await onSend(value, channel); setText(""); }
    catch { setFeedback("전송 결과를 확인하지 못했습니다. 응답 확인으로 기존 실행을 확인해 주세요."); }
    finally { setSending(false); }
  }
  return <div className="builder-composer">
    <form className="builder-compose-form" onSubmit={submit}>
      <textarea aria-label="Lead에게 메시지" maxLength={16_384} disabled={!enabled || sending} onChange={event => setText(event.target.value)}
        placeholder={enabled ? "Lead에게 메시지 보내기" : "메시지 전송을 사용할 수 없습니다"} value={text} />
      <button aria-label={sending ? "메시지 전송 중" : "메시지 보내기"} className="builder-primary-button builder-send" disabled={!enabled || sending || !text.trim()} title="메시지 보내기" type="submit">
        {sending ? <LoaderCircle aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
      </button>
    </form>
    <div className="builder-composer-note">{enabled ? "Lead 대화는 현재 Workspace에 저장됩니다." : "AI 메시지 연결을 사용할 수 없어 입력이 비활성화되었습니다."}</div>
    {feedback && <p className="builder-feedback" role="status">{feedback}</p>}
  </div>;
}

function LeadView({ props, messages, actor, drawerOpen, onDrawerClose, onDrawerToggle, actions, onOpenArchitecture }: {
  props: BuilderShellProps;
  messages: BuilderMessage[];
  actor?: BuilderActor | null;
  drawerOpen: boolean;
  onDrawerClose(): void;
  onDrawerToggle(): void;
  actions: ReactNode;
  onOpenArchitecture(): void;
}) {
  const [importOpen, setImportOpen] = useState(false);
  const readOnly = Boolean(actor);
  const channel: LeadChannel = actor ? "cto-inbox" : "main";
  const enabled = !readOnly && Boolean(props.onSendMessage)
    && (props.conversation === undefined ? props.snapshot.integrations.ai === "ready" : props.conversation?.channel === channel && !props.conversation.active);
  return <div className={`builder-message-layout${drawerOpen ? " is-drawer-open" : ""}`}>
    <button aria-label="작업 기록 닫기" className="builder-drawer-backdrop" onClick={onDrawerClose} type="button" />
    <section aria-label={actor ? `${actor.label} 세션` : "Lead 대화"} className="builder-message-main">
      <div className="builder-chat-context">
        <div className="builder-chat-heading"><h1>{actor?.label ?? "Lead와 대화"}</h1>
          <p>{actor ? `${ACTOR_STATUS[actor.status]} · 읽기 전용 세션` : "전체 설계와 기능 통합을 담당하는 AI"}</p></div>
        <div className="builder-header-actions">
          {actions}<span className="builder-agent-dot">{actor ? actorInitial(actor) : "LEAD"}</span>
          <span className={`builder-lead-status${enabled ? " is-ready" : ""}`}>{actor ? "읽기 전용" : enabled ? "전송 준비됨" : props.conversation?.active ? "실행 확인 중" : "미연결"}</span>
          {!readOnly && props.onImportConsultation && <button aria-expanded={importOpen} aria-label="상담 텍스트 가져오기" className="builder-icon-button" onClick={() => setImportOpen(open => !open)} type="button"><Upload /><span className="builder-refresh-label">상담 가져오기</span></button>}
          <button aria-label="작업 기록 열기" className="builder-icon-button" onClick={onDrawerToggle} type="button"><PanelRight /><span className="builder-refresh-label">작업 기록</span></button>
        </div>
      </div>
      {props.loading && <div className="builder-status-strip"><LoaderCircle /> Workspace 상태를 불러오는 중입니다.</div>}
      {props.error && <div className="builder-status-strip is-error" role="alert"><AlertCircle /> Workspace 상태를 불러오지 못했습니다.</div>}
      {!readOnly && <ConversationControls channel={channel} props={props} />}
      <MessageList actor={actor} messages={messages} />
      {readOnly ? <div className="builder-composer-note" style={{ padding: 13 }}>이 세션은 조회 전용입니다. 사용자 메시지는 보낼 수 없습니다.</div> : <>
        {importOpen && props.onImportConsultation && <ConsultationImport onImport={props.onImportConsultation} />}
        <MessageComposer channel={channel} enabled={enabled} onSend={props.onSendMessage} />
      </>}
    </section>
    <ActivityRail actor={actor} onClose={onDrawerClose} onOpenArchitecture={onOpenArchitecture} onSelectQuestion={() => {}} props={props} selectedQuestion={null} view="lead" />
  </div>;
}

function ActorTranscriptView({ props, actor, drawerOpen, onDrawerClose, onDrawerToggle, actions, onOpenArchitecture }: {
  props: BuilderShellProps; actor: BuilderActor; drawerOpen: boolean; onDrawerClose(): void; onDrawerToggle(): void;
  actions: ReactNode; onOpenArchitecture(): void;
}) {
  const messages = props.snapshot.messages.filter(message => message.actorId === actor.id);
  return <LeadView actions={actions} actor={actor} drawerOpen={drawerOpen} messages={messages} onDrawerClose={onDrawerClose}
    onDrawerToggle={onDrawerToggle} onOpenArchitecture={onOpenArchitecture} props={props} />;
}

export function resolveSelectedGraphEntity(
  entities: BuilderShellProps["snapshot"]["graph"]["entities"], selectedId: string | null,
) {
  return entities.find(entity => entity.id === selectedId) ?? entities[0] ?? null;
}

const GRAPH_KIND_LABEL: Record<BuilderShellProps["snapshot"]["graph"]["entities"][number]["kind"], string> = {
  requirement: "요구사항", feature: "기능", component: "구성 요소", agent: "AI",
  "external-system": "외부 시스템", data: "데이터", workflow: "작업 흐름", test: "테스트",
  environment: "환경", approval: "승인",
};

const GRAPH_STATUS_LABEL: Record<BuilderShellProps["snapshot"]["graph"]["entities"][number]["status"], string> = {
  planned: "계획", running: "실행 중", verified: "검증됨", blocked: "차단",
};

const GRAPH_ARIA_LABELS = {
  "node.a11yDescription.default": "Enter 또는 Space 키를 눌러 노드를 선택하세요. 그래프는 조회 전용입니다.",
  "node.a11yDescription.keyboardDisabled": "Enter 또는 Space 키를 눌러 노드를 선택하세요. 그래프는 조회 전용입니다.",
};

function ArchitectureView({ props, onActor }: { props: BuilderShellProps; onActor(id: string): void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const entities = props.snapshot.graph.entities;
  const selectedEntity = resolveSelectedGraphEntity(entities, selectedId);
  const selectedOwner = selectedEntity?.ownerActorId
    ? props.snapshot.actors.find(actor => actor.id === selectedEntity.ownerActorId) ?? null
    : null;
  const relatedEntities = selectedEntity ? props.snapshot.graph.relations.flatMap(relation => {
    const relatedId = relation.sourceId === selectedEntity.id ? relation.targetId
      : relation.targetId === selectedEntity.id ? relation.sourceId : null;
    const relatedEntity = relatedId ? entities.find(entity => entity.id === relatedId) : null;
    return relatedEntity ? [{ id: relation.id, kind: relation.kind.replaceAll("_", " "), label: relatedEntity.label }] : [];
  }) : [];
  const { nodes, edges } = useMemo(() => {
    const positions = new Map(entities.map((entity, index) => [entity.id, { x: (index % 3) * 245 + 35, y: Math.floor(index / 3) * 140 + 35 }]));
    const graphNodes: Node[] = entities.map(entity => ({
      id: entity.id,
      position: positions.get(entity.id) ?? { x: 0, y: 0 },
      data: { label: entity.label },
      ariaLabel: `${entity.label} 노드 선택`,
      selected: entity.id === selectedEntity?.id,
      draggable: false,
      selectable: true,
      connectable: false,
      style: { width: 195, minHeight: 64 },
    }));
    const ids = new Set(entities.map(entity => entity.id));
    const graphEdges: Edge[] = props.snapshot.graph.relations.filter(relation => ids.has(relation.sourceId) && ids.has(relation.targetId))
      .map(relation => ({ id: relation.id, source: relation.sourceId, target: relation.targetId, label: relation.kind.replaceAll("_", " "),
        selectable: false, focusable: false,
        markerEnd: { type: MarkerType.ArrowClosed, color: "#858585" }, style: { stroke: "#858585" } }));
    return { nodes: graphNodes, edges: graphEdges };
  }, [entities, props.snapshot.graph.relations, selectedEntity?.id]);
  if (!nodes.length) return <div className="builder-page builder-architecture-page"><div className="builder-page-intro"><h2>Workspace 설계 Graph</h2><p>기록된 요구사항, 기능, 구성 요소와 관계를 조회합니다.</p></div>
    <div className="builder-card builder-empty-card"><GitBranch /><strong>설계 Graph가 없습니다</strong><p>이 Workspace에 저장된 Graph 노드가 없습니다.</p></div></div>;
  return <div className="builder-page builder-architecture-page"><div className="builder-page-intro"><h2>Workspace 설계 Graph</h2><p>노드는 조회 전용입니다. 담당 Actor를 선택하면 기록된 세션을 열 수 있습니다.</p></div>
    <div className="builder-architecture-layout"><div className="builder-graph-card"><ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{ padding: 0.18 }} minZoom={0.1} nodesDraggable={false} nodesFocusable
      edgesFocusable={false} nodesConnectable={false} elementsSelectable deleteKeyCode={null} ariaLabelConfig={GRAPH_ARIA_LABELS}
      onNodesChange={changes => {
        const selection = changes.find(change => change.type === "select" && change.selected);
        if (selection?.type === "select") setSelectedId(selection.id);
      }} onNodeClick={(_, node) => {
        setSelectedId(node.id);
      }}>
      <Background gap={20} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow><div className="builder-graph-note">조회 전용 · Graph revision {props.snapshot.graph.revisionId ?? "미기록"}</div></div>
    <aside aria-label="선택한 설계 노드 정보" aria-live="polite" className="builder-graph-detail">
      <section className="builder-card" aria-labelledby="builder-selected-node-title">
        <div className="builder-card-sub">SELECTED NODE</div>
        <h2 id="builder-selected-node-title">{selectedEntity?.label ?? "노드를 선택하세요"}</h2>
        {selectedEntity ? <>
          <span className="builder-tag">{GRAPH_KIND_LABEL[selectedEntity.kind]}</span>
          <dl className="builder-graph-meta">
            <dt>상태</dt><dd>{GRAPH_STATUS_LABEL[selectedEntity.status]}</dd>
            <dt>담당</dt><dd>{selectedOwner?.label ?? (selectedEntity.ownerActorId ? "담당 Actor를 찾을 수 없습니다" : "담당자 없음")}</dd>
            <dt>연결</dt><dd>{relatedEntities.length ? `${relatedEntities.length}개` : "연결된 관계 없음"}</dd>
          </dl>
          {relatedEntities.length > 0 && <ul aria-label="연결된 설계 노드" className="builder-graph-relations">
            {relatedEntities.map(relation => <li key={relation.id}><span>{relation.kind}</span><strong>{relation.label}</strong></li>)}
          </ul>}
          {selectedOwner?.role !== "lead" && selectedOwner
            ? <button className="builder-quiet-button builder-graph-owner-action" onClick={() => onActor(selectedOwner.id)} type="button">담당 Actor 세션 열기 · 읽기 전용</button>
            : <button className="builder-quiet-button builder-graph-owner-action" disabled title={selectedOwner?.role === "lead" ? "Lead 세션은 이 읽기 전용 작업 화면에서 열 수 없습니다." : "연결된 담당 Actor가 없습니다."} type="button">담당 Actor 세션 열기 · 읽기 전용</button>}
        </> : <p>선택한 노드가 현재 Workspace Graph에 없습니다.</p>}
      </section>
      <div className="builder-graph-callout"><strong>설계 변경은 Lead가 담당합니다</strong><p>이 화면에서는 저장된 설계를 조회합니다. 노드와 관계는 직접 편집할 수 없습니다.</p></div>
    </aside></div></div>;
}

function OrganizationView({ props, onActor }: { props: BuilderShellProps; onActor(id: string): void }) {
  const actors = props.snapshot.actors;
  const roots = actors.filter(actor => !actor.parentActorId || !actors.some(parent => parent.id === actor.parentActorId));
  const childrenByParent = new Map<string, BuilderActor[]>();
  for (const actor of actors) if (actor.parentActorId) childrenByParent.set(actor.parentActorId, [...childrenByParent.get(actor.parentActorId) ?? [], actor]);
  const renderActor = (actor: BuilderActor, depth = 0): ReactNode => <div key={actor.id}>
    <button className={`builder-org-card${actor.role === "lead" ? " is-lead" : ""}`} onClick={() => onActor(actor.id)} type="button">
      <span className="builder-org-avatar">{actorInitial(actor)}</span><span><strong>{actor.label}</strong><small>{ACTOR_STATUS[actor.status]}{actor.agentId ? ` · ${actor.agentId}` : ""}</small></span>
    </button>
    {(childrenByParent.get(actor.id)?.length ?? 0) > 0 && <div className={`builder-org-children${depth === 0 ? " is-top-level" : ""}`}>{childrenByParent.get(actor.id)?.map(child => renderActor(child, depth + 1))}</div>}
  </div>;
  return <div className="builder-page builder-org-page"><div className="builder-page-intro"><h2>현재 Workspace Actor</h2><p>저장된 부모 관계와 세션 상태를 표시합니다. Lead는 활성 작업 목록에는 포함하지 않습니다.</p></div>
    {roots.length ? <div className="builder-org-tree">{roots.map(actor => renderActor(actor))}</div>
      : <div className="builder-card builder-empty-card"><Network /><strong>조직 정보가 없습니다</strong><p>이 Workspace의 Actor와 관계가 아직 저장되지 않았습니다.</p></div>}</div>;
}

export function resolveSelectedDocument(documents: BuilderShellProps["snapshot"]["documents"], selectedId: string | null) {
  return documents.find(document => document.id === selectedId) ?? documents[0] ?? null;
}

function DocumentsView({ props }: { props: BuilderShellProps }) {
  const [selectedId, setSelectedId] = useState<string | null>(props.snapshot.documents[0]?.id ?? null);
  const selected = resolveSelectedDocument(props.snapshot.documents, selectedId);
  useEffect(() => {
    if (selectedId !== (selected?.id ?? null)) setSelectedId(selected?.id ?? null);
  }, [selectedId, selected?.id]);
  return <div className="builder-page builder-doc-page"><div className="builder-page-intro"><p>Lead가 관리하는 계약·기술 선정·변경 명세를 조회합니다. 상담 원문은 별도 보관합니다.</p></div>
    <div className="builder-doc-layout">
      <section className="builder-card"><h2>프로젝트 파일</h2><p className="builder-card-sub">현재 Workspace에 저장된 문서입니다. 프로젝트별 분류는 아직 연결되지 않았습니다.</p><div className="builder-record-list">{props.snapshot.documents.length ? props.snapshot.documents.map(document => <button
        aria-pressed={selected?.id === document.id} className={`builder-record-button${selected?.id === document.id ? " is-selected" : ""}`} key={document.id} onClick={() => setSelectedId(document.id)} type="button">
        <strong>{document.title}</strong><small>{document.revisionId} · {displayTime(document.createdAt)}</small>
      </button>) : <p className="builder-card-sub">저장된 프로젝트 문서가 없습니다.</p>}</div></section>
      <section className="builder-card"><h2>미리보기</h2><p className="builder-card-sub">{selected ? `${selected.title} · Revision ${selected.revisionId} · ${displayTime(selected.createdAt)}` : "파일을 선택하세요"}</p>
        {selected ? <pre className="builder-document-preview">{selected.text}</pre> : <p className="builder-card-sub">문서를 선택하면 저장된 내용이 표시됩니다.</p>}</section>
    </div></div>;
}

function DecisionsView({ props, drawerOpen, onDrawerToggle, onDrawerClose }: {
  props: BuilderShellProps; drawerOpen: boolean; onDrawerToggle(): void; onDrawerClose(): void;
}) {
  const openQuestions = props.snapshot.questions.filter(question => question.status === "open");
  const [selectedId, setSelectedId] = useState<string | null>(openQuestions[0]?.id ?? props.snapshot.questions[0]?.id ?? null);
  const selected = props.snapshot.questions.find(question => question.id === selectedId) ?? openQuestions[0] ?? props.snapshot.questions[0] ?? null;
  const messages = [...selectLeadDecisionTranscript(props.snapshot), ...conversationMessages(props, "decisions")];
  return <div className={`builder-message-layout${drawerOpen ? " is-drawer-open" : ""}`}>
    <button aria-label="질문 목록 닫기" className="builder-drawer-backdrop" onClick={onDrawerClose} type="button" />
    <section className="builder-message-main">
      <div className="builder-chat-context"><div className="builder-chat-heading"><h1>미결정사항</h1><p>질문 전용 Lead 대화 · Builder에 저장된 기록</p></div>
        <button aria-label="미결정사항 목록 열기" className="builder-icon-button" onClick={onDrawerToggle} type="button"><PanelRight /><span className="builder-refresh-label">질문 목록</span></button>
      </div>
      <ConversationControls channel="decisions" props={props} />
      {selected ? <><div className="builder-question-detail" style={{ padding: "12px 18px 0" }}>
        <StatusLabel status={selected.status} /><h2 style={{ margin: "7px 0", fontSize: 14 }}>{selected.title}</h2><p>{selected.text}</p>
        {selected.options.map(option => <div className="builder-option" key={option.id}><strong>{option.label}</strong><small>{option.tradeoff}</small></div>)}
        {selected.recommendation && <div className="builder-recommendation">Lead 추천: {selected.recommendation}</div>}
        {selected.answer && <div className="builder-recommendation"><Check aria-hidden="true" size={14} /> 결정된 답변: {selected.answer}{selected.revisionId ? ` · ${selected.revisionId}` : ""}</div>}
      </div></>
        : <EmptyState icon={CircleHelp} title="미결정사항이 없습니다" detail="Lead가 사용자 결정을 요청하면 여기에 표시됩니다." />}
      {(selected || messages.length > 0) && <MessageList actors={props.snapshot.actors} messages={messages} />}
      {selected && <MessageComposer channel="decisions" enabled={Boolean(props.onSendMessage) && selected.status === "open"
        && (props.conversation === undefined ? props.snapshot.integrations.ai === "ready" : props.conversation?.channel === "decisions" && !props.conversation.active)} onSend={props.onSendMessage} />}
    </section>
    <ActivityRail onClose={onDrawerClose} onSelectQuestion={setSelectedId} props={props} selectedQuestion={selected} view="decisions" />
  </div>;
}

function IntegrationCard({ title, state, detail, icon }: { title: string; state: string; detail: string; icon: React.ComponentType<{ size?: number }> }) {
  const Icon = icon;
  return <div className="builder-integration"><span className="builder-integration-icon"><Icon size={15} /></span><div><strong>{title}</strong><small>{detail}</small><span className="builder-system-state">{state}</span></div></div>;
}

function SystemView({ props }: { props: BuilderShellProps }) {
  const aiLabel = props.snapshot.integrations.ai === "ready" ? "사용 가능" : props.snapshot.integrations.ai === "unavailable" ? "사용 불가" : "설정되지 않음";
  const githubLabel = props.snapshot.integrations.github === "ready" ? "사용 가능" : props.snapshot.integrations.github === "unavailable" ? "사용 불가" : "설정되지 않음";
  return <div className="builder-page builder-system-page"><div className="builder-page-intro"><h2>Workspace 상태</h2><p>이 Workspace의 AI와 GitHub 연결 상태입니다.</p></div>
    <div className="builder-system-grid"><section className="builder-card"><h2>연결 상태</h2>
      <LeadAgentSettings options={props.leadAgents ?? null} loading={props.leadAgentsLoading ?? false}
        error={props.leadAgentsError ?? null} onSave={props.onSelectLeadAgent}
        sessions={props.leadSessions} sessionsLoading={props.leadSessionsLoading} sessionsError={props.leadSessionsError}
        onPrepare={props.onPrepareLeadSessions} />
      <IntegrationCard detail="메인 Lead 및 질문 대화 연결 상태" icon={Bot} state={aiLabel} title="AI 대화" />
      <IntegrationCard detail="저장소 및 Actions 연동 상태" icon={GitFork} state={githubLabel} title="GitHub" />
    </section><section className="builder-card"><h2>Runner 정보</h2>
      <div className="builder-empty-card builder-runner-unavailable"><Server /><strong>Runner 정보가 아직 연결되지 않았습니다</strong><p>접속 상태, 운영체제, 라벨, 최근 작업은 현재 화면에서 확인할 수 없습니다.</p></div>
    </section></div>
  </div>;
}

function ConsultationImport({ onImport }: { onImport: NonNullable<BuilderShellProps["onImportConsultation"]> }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [fileName, setFileName] = useState("");
  const operationVersion = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operationVersion.current += 1; };
  }, []);
  function isCurrent(version: number) {
    return mounted.current && operationVersion.current === version;
  }
  async function chooseFile(file: File | undefined) {
    if (!file) return;
    const version = ++operationVersion.current;
    setStatus("");
    setReading(false);
    if (!file.name.toLowerCase().endsWith(".txt")) {
      setStatus(".txt 파일만 선택할 수 있습니다.");
      return;
    }
    if (file.size > MAX_CONSULTATION_REQUEST_BYTES) {
      setStatus("파일이 48 KiB를 넘습니다. 더 작은 UTF-8 .txt 파일을 선택해 주세요.");
      return;
    }
    setReading(true);
    setStatus("파일을 읽는 중입니다.");
    try {
      const preview = decodeConsultationFile(new Uint8Array(await file.arrayBuffer()));
      if (!isCurrent(version)) return;
      setText(preview);
      setFileName(file.name);
      setStatus("파일 내용을 미리보기로 불러왔습니다. 저장하려면 아래 버튼을 누르세요.");
    } catch (error) {
      if (!isCurrent(version)) return;
      setStatus(error instanceof Error ? error.message : "파일을 읽지 못했습니다. UTF-8 .txt 파일을 선택해 주세요.");
    } finally {
      if (isCurrent(version)) setReading(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = text.trim();
    if (!value || saving || reading) return;
    try { assertConsultationRequestSize(value); }
    catch (error) {
      setStatus(error instanceof Error ? error.message : "상담 입력이 48 KiB 요청 한도를 넘습니다.");
      return;
    }
    const version = ++operationVersion.current;
    setReading(false);
    setSaving(true); setStatus("");
    try {
      await onImport(value);
      if (!isCurrent(version)) return;
      setText(""); setFileName(""); setStatus("상담 입력이 Builder에 저장되었습니다.");
    } catch {
      if (isCurrent(version)) setStatus("상담 입력을 저장하지 못했습니다. 다시 시도해 주세요.");
    } finally {
      if (isCurrent(version)) setSaving(false);
    }
  }
  return <section aria-label="상담 텍스트 가져오기" className="builder-card builder-import">
    <p className="builder-card-sub">입력은 제공된 Builder 저장 기능에 전달됩니다. Lead 분석은 실제 대화 연동 후 진행됩니다.</p>
    <form className="builder-import-form" onSubmit={submit}>
      <div className="builder-import-file-row"><label className={`builder-file-button${saving ? " is-disabled" : ""}`}>UTF-8 .txt 파일 선택<input accept=".txt,text/plain" aria-label="상담 .txt 파일" disabled={saving} onChange={event => {
        void chooseFile(event.currentTarget.files?.[0]);
        event.currentTarget.value = "";
      }} type="file" /></label>{fileName && <span className="builder-file-name">미리보기: {fileName}</span>}</div>
      <textarea aria-label="상담 텍스트" disabled={saving} onChange={event => { operationVersion.current += 1; setReading(false); setText(event.target.value); setFileName(""); setStatus(""); }} placeholder="고객 상담 원문 붙여넣기 또는 .txt 파일 선택" value={text} />
      <button className="builder-primary-button" disabled={!text.trim() || saving || reading} type="submit"><Upload size={14} /> {reading ? "파일 읽는 중" : saving ? "저장 중" : "저장된 입력으로 전달"}</button>
    </form>{status && <p className="builder-composer-note" role="status">{status}</p>}</section>;
}

export function BuilderShell(props: BuilderShellProps) {
  const [view, setView] = useState<BuilderView>("lead");
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [actorId, setActorId] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const activeActors = props.snapshot.actors.filter(actor => actor.role !== "lead" && (actor.status === "running" || actor.status === "waiting"));
  const activeActor = actorId ? props.snapshot.actors.find(actor => actor.id === actorId) ?? null : null;
  const current = VIEW_TITLES[view];
  const leadIds = new Set(props.snapshot.actors.filter(actor => actor.role === "lead").map(actor => actor.id));
  const mainMessages = [...props.snapshot.messages.filter(message => message.channel === "main"
    && (message.actorId === null || leadIds.has(message.actorId))), ...conversationMessages(props, "main")];
  const openQuestionCount = props.snapshot.questions.filter(question => question.status === "open").length;

  function selectView(next: BuilderView) {
    setView(next); setActorId(null); setDrawerOpen(false);
    if (next === "lead" || next === "decisions") props.onLeadChannelChange?.(next === "lead" ? "main" : "decisions");
  }
  function openActor(id: string) {
    if (props.snapshot.actors.find(actor => actor.id === id)?.role === "lead") selectView("lead");
    else { setActorId(id); setDrawerOpen(false); }
  }
  const headerActions = <div className="builder-header-actions">
    {props.loading && <span aria-label="불러오는 중" className="builder-loading"><LoaderCircle /></span>}
    <button aria-label="Workspace 새로고침" className="builder-icon-button" onClick={props.onRefresh} type="button"><RefreshCw /><span className="builder-refresh-label">새로고침</span></button>
    {view === "lead" && !activeActor && <button aria-label="Lead HTML 뷰어 열기" className="builder-icon-button" disabled={!props.onOpenHtmlPreview}
      onClick={props.onOpenHtmlPreview} title={props.onOpenHtmlPreview ? "Lead HTML 뷰어 열기" : "HTML 뷰어가 아직 연결되지 않았습니다."} type="button"><FileText /><span className="builder-refresh-label">HTML 뷰어</span></button>}
    {view === "architecture" && !activeActor && <button className="builder-quiet-button" onClick={() => selectView("lead")} type="button"><MessageSquare />Lead와 설계 논의</button>}
  </div>;

  let content: ReactNode;
  if (activeActor) content = <ActorTranscriptView actions={headerActions} actor={activeActor} drawerOpen={drawerOpen} onDrawerClose={() => setDrawerOpen(false)} onDrawerToggle={() => setDrawerOpen(value => !value)} onOpenArchitecture={() => selectView("architecture")} props={props} />;
  else if (view === "lead") content = <LeadView actions={headerActions} drawerOpen={drawerOpen} messages={mainMessages} onDrawerClose={() => setDrawerOpen(false)} onDrawerToggle={() => setDrawerOpen(value => !value)} onOpenArchitecture={() => selectView("architecture")} props={props} />;
  else if (view === "architecture") content = <ArchitectureView onActor={openActor} props={props} />;
  else if (view === "organization") content = <OrganizationView onActor={openActor} props={props} />;
  else if (view === "documents") content = <DocumentsView props={props} />;
  else if (view === "decisions") content = <DecisionsView drawerOpen={drawerOpen} onDrawerClose={() => setDrawerOpen(false)} onDrawerToggle={() => setDrawerOpen(value => !value)} props={props} />;
  else content = <SystemView props={props} />;

  return <div className="builder-shell">
    <style>{flowCss}{builderCss}</style>
    <div className={`builder-layout${collapsed ? " is-collapsed" : ""}`}>
      <aside aria-label="SPS Builder 탐색" className="builder-sidebar">
        <div className="builder-brand"><span className="builder-brand-mark">SPS</span><div className="builder-brand-copy"><strong>SPS Builder</strong><small>PRIVATE SOLUTION STUDIO</small></div></div>
        <div className="builder-workspace"><small>SPS CORE WORKSPACE</small><strong title={props.workspaceLabel}>{props.workspaceLabel || props.snapshot.workspaceId}</strong></div>
        <div className="builder-nav-label">작업 공간</div>
        <nav aria-label="주 메뉴" className="builder-nav">
          {NAV_ITEMS.map(item => { const Icon = item.icon; return <button aria-label={item.label} title={item.label} aria-current={view === item.id && !activeActor ? "page" : undefined}
            className={`builder-nav-item${view === item.id && !activeActor ? " is-active" : ""}`} key={item.id} onClick={() => selectView(item.id)} type="button">
            <Icon aria-hidden="true" /><span>{item.label}</span>{item.id === "decisions" && openQuestionCount > 0 && <small className="builder-nav-count">{openQuestionCount}</small>}
          </button>; })}
        </nav>
        <div className="builder-sidebar-rule" />
        <div className="builder-nav-label">활성 AI · Lead 제외</div>
        <div className="builder-actor-list">
          {activeActors.map(actor => <button aria-label={`${actor.label}, ${actorStatusTone(actor.status)}`} className="builder-actor-item" key={actor.id} onClick={() => openActor(actor.id)} title={`${actor.label} · ${ACTOR_STATUS[actor.status]}`} type="button">
            <span className="builder-actor-avatar">{actorInitial(actor)}</span><span className="builder-actor-copy"><strong>{actor.label}</strong><small>{ACTOR_STATUS[actor.status]}</small></span><i aria-hidden="true" className="builder-live-dot" />
          </button>)}
          {!activeActors.length && <div className="builder-actor-copy" style={{ padding: "4px 9px", color: "var(--builder-muted)", fontSize: 10 }}>실행 중 또는 응답 대기 중인 AI가 없습니다.</div>}
        </div>
        <div className="builder-sidebar-footer">
          <button aria-label={collapsed ? "사이드바 펼치기" : "사이드바 접기"} className="builder-quiet-button builder-collapse" onClick={() => setCollapsed(value => !value)} type="button">
            {collapsed ? <ChevronRight /> : <ChevronLeft />}<span>{collapsed ? "메뉴 펼치기" : "메뉴 접기"}</span>
          </button>
          <div className="builder-profile">
            {profileOpen && <div className="builder-profile-menu"><button aria-label="SPS Core 설정 열기" className="builder-quiet-button" disabled={!props.onOpenCoreSettings}
              onClick={() => { setProfileOpen(false); props.onOpenCoreSettings?.(); }} type="button"><Settings /><span>SPS Core 설정 열기</span></button></div>}
            <button aria-expanded={profileOpen} aria-label="프로필 메뉴" className="builder-profile-button" onClick={() => setProfileOpen(value => !value)}
              onKeyDown={event => { if (event.key === "Escape") setProfileOpen(false); }} title="프로필 메뉴" type="button">
              <span className="builder-profile-avatar"><Settings aria-hidden="true" size={16} /></span><span className="builder-actor-copy"><strong>현재 Workspace</strong><small>Core 설정</small></span>
            </button>
          </div>
        </div>
      </aside>
      <main className="builder-main">
        <DesignDraftSummary draft={props.designDraft ?? null} loading={props.designDraftLoading ?? false} error={props.designDraftError ?? null} />
        {view !== "lead" && view !== "decisions" && !activeActor
          ? <div className="builder-view-body"><div className="builder-page-actions"><h1>{current.title}</h1>{headerActions}</div>{content}</div>
          : <div className="builder-view-body">{content}</div>}
      </main>
    </div>
  </div>;
}
