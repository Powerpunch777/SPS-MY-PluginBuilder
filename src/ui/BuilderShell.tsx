import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity, AlertCircle, Bot, Check, ChevronLeft, ChevronRight, CircleHelp, FileText,
  GitBranch, GitFork, LoaderCircle, MessageSquare, Network, PanelRight, RefreshCw, Send,
  Server, Settings, Upload, X,
} from "lucide-react";
import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from "@xyflow/react";
import flowCss from "@xyflow/react/dist/style.css";
import builderCss from "./builder.css";
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
  system: { title: "시스템", description: "Workspace와 분리된 Host 연동 상태입니다." },
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
  props, view, selectedQuestion, onSelectQuestion, onClose,
}: {
  props: BuilderShellProps;
  view: BuilderView;
  selectedQuestion: BuilderQuestion | null;
  onSelectQuestion(id: string): void;
  onClose(): void;
}) {
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
  return <aside className="builder-activity-rail" aria-label="최근 작업 기록">
    <div className="builder-rail-header"><h2>최근 작업 기록</h2><p>Workspace에 저장된 활동</p></div>
    <div className="builder-rail-content">
      {props.snapshot.activity.length ? [...props.snapshot.activity].reverse().map(item => <div className="builder-activity-item" key={item.id}>
        <strong>{item.label}</strong>
        <small>{item.actorId ? props.snapshot.actors.find(actor => actor.id === item.actorId)?.label ?? "기록된 작업자" : "Workspace 활동"} · {displayTime(item.createdAt)}</small>
      </div>) : <EmptyState icon={Activity} title="활동 기록이 없습니다" detail="저장된 작업이 생기면 여기에 표시됩니다." />}
    </div>
    <button aria-label="작업 기록 닫기" className="builder-icon-button builder-drawer-close" onClick={onClose} type="button"><X /></button>
  </aside>;
}

function MessageList({ messages, actor, actors = [] }: { messages: BuilderMessage[]; actor?: BuilderActor | null; actors?: BuilderActor[] }) {
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
    catch { setFeedback("메시지를 저장하지 못했습니다. 다시 시도해 주세요."); }
    finally { setSending(false); }
  }
  return <div className="builder-composer">
    <form className="builder-compose-form" onSubmit={submit}>
      <textarea aria-label="Lead에게 메시지" disabled={!enabled || sending} onChange={event => setText(event.target.value)}
        placeholder={enabled ? "Lead에게 메시지 보내기" : "메시지 전송을 사용할 수 없습니다"} value={text} />
      <button aria-label="메시지 보내기" className="builder-primary-button" disabled={!enabled || sending || !text.trim()} type="submit">
        <Send aria-hidden="true" /><span>{sending ? "전송 중" : "보내기"}</span>
      </button>
    </form>
    <div className="builder-composer-note">{enabled ? "Lead 대화는 현재 Workspace에 저장됩니다." : "AI 메시지 연결을 사용할 수 없어 입력이 비활성화되었습니다."}</div>
    {feedback && <p className="builder-feedback" role="status">{feedback}</p>}
  </div>;
}

function LeadView({ props, messages, actor, drawerOpen, onDrawerClose, onDrawerToggle }: {
  props: BuilderShellProps;
  messages: BuilderMessage[];
  actor?: BuilderActor | null;
  drawerOpen: boolean;
  onDrawerClose(): void;
  onDrawerToggle(): void;
}) {
  const [importOpen, setImportOpen] = useState(false);
  const readOnly = Boolean(actor);
  const channel: LeadChannel = actor ? "cto-inbox" : "main";
  const enabled = !readOnly && props.snapshot.integrations.ai === "ready" && Boolean(props.onSendMessage);
  return <div className={`builder-message-layout${drawerOpen ? " is-drawer-open" : ""}`}>
    <button aria-label="작업 기록 닫기" className="builder-drawer-backdrop" onClick={onDrawerClose} type="button" />
    <section aria-label={actor ? `${actor.label} 세션` : "Lead 대화"} className="builder-message-main">
      <div className="builder-chat-context">
        <span>{actor ? `${actor.label} · ${ACTOR_STATUS[actor.status]} · 읽기 전용` : "Lead · 메인 사용자 대화"}</span>
        <div className="builder-header-actions">
          {!readOnly && props.onImportConsultation && <button aria-expanded={importOpen} aria-label="상담 텍스트 가져오기" className="builder-icon-button" onClick={() => setImportOpen(open => !open)} type="button"><Upload /><span className="builder-refresh-label">상담 가져오기</span></button>}
          <button aria-label="작업 기록 열기" className="builder-icon-button" onClick={onDrawerToggle} type="button"><PanelRight /><span className="builder-refresh-label">작업 기록</span></button>
        </div>
      </div>
      {props.loading && <div className="builder-status-strip"><LoaderCircle /> Workspace 상태를 불러오는 중입니다.</div>}
      {props.error && <div className="builder-status-strip is-error" role="alert"><AlertCircle /> Workspace 상태를 불러오지 못했습니다.</div>}
      <MessageList actor={actor} messages={messages} />
      {readOnly ? <div className="builder-composer-note" style={{ padding: 13 }}>이 세션은 조회 전용입니다. 사용자 메시지는 보낼 수 없습니다.</div> : <>
        {importOpen && props.onImportConsultation && <ConsultationImport onImport={props.onImportConsultation} />}
        <MessageComposer channel={channel} enabled={enabled} onSend={props.onSendMessage} />
      </>}
    </section>
    <ActivityRail onClose={onDrawerClose} onSelectQuestion={() => {}} props={props} selectedQuestion={null} view="lead" />
  </div>;
}

function ActorTranscriptView({ props, actor, drawerOpen, onDrawerClose, onDrawerToggle }: {
  props: BuilderShellProps; actor: BuilderActor; drawerOpen: boolean; onDrawerClose(): void; onDrawerToggle(): void;
}) {
  const messages = props.snapshot.messages.filter(message => message.actorId === actor.id);
  return <LeadView actor={actor} drawerOpen={drawerOpen} messages={messages} onDrawerClose={onDrawerClose}
    onDrawerToggle={onDrawerToggle} props={props} />;
}

function ArchitectureView({ props, onActor }: { props: BuilderShellProps; onActor(id: string): void }) {
  const { nodes, edges } = useMemo(() => {
    const entities = props.snapshot.graph.entities;
    const positions = new Map(entities.map((entity, index) => [entity.id, { x: (index % 3) * 245 + 35, y: Math.floor(index / 3) * 140 + 35 }]));
    const graphNodes: Node[] = entities.map(entity => ({
      id: entity.id,
      position: positions.get(entity.id) ?? { x: 0, y: 0 },
      data: { label: entity.label },
      draggable: false,
      selectable: false,
      connectable: false,
      style: { width: 195, minHeight: 64 },
    }));
    const ids = new Set(entities.map(entity => entity.id));
    const graphEdges: Edge[] = props.snapshot.graph.relations.filter(relation => ids.has(relation.sourceId) && ids.has(relation.targetId))
      .map(relation => ({ id: relation.id, source: relation.sourceId, target: relation.targetId, label: relation.kind.replaceAll("_", " "),
        markerEnd: { type: MarkerType.ArrowClosed, color: "#8da39a" }, style: { stroke: "#8da39a" } }));
    return { nodes: graphNodes, edges: graphEdges };
  }, [props.snapshot.graph.entities, props.snapshot.graph.relations]);
  if (!nodes.length) return <div className="builder-page"><div className="builder-page-intro"><h2>Workspace 설계 Graph</h2><p>기록된 요구사항, 기능, 구성 요소와 관계를 조회합니다.</p></div>
    <div className="builder-card builder-empty-card"><GitBranch /><strong>설계 Graph가 없습니다</strong><p>이 Workspace에 저장된 Graph 노드가 없습니다.</p></div></div>;
  return <div className="builder-page"><div className="builder-page-intro"><h2>Workspace 설계 Graph</h2><p>노드는 조회 전용입니다. 담당 Actor를 선택하면 기록된 세션을 열 수 있습니다.</p></div>
    <div className="builder-graph-card"><ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{ padding: 0.18 }} nodesDraggable={false}
      nodesConnectable={false} elementsSelectable={false} deleteKeyCode={null} onNodeClick={(_, node) => {
        const ownerId = props.snapshot.graph.entities.find(entity => entity.id === node.id)?.ownerActorId;
        if (ownerId && props.snapshot.actors.some(actor => actor.id === ownerId)) onActor(ownerId);
      }}>
      <Background gap={20} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow><div className="builder-graph-note">조회 전용 · Graph revision {props.snapshot.graph.revisionId ?? "미기록"}</div></div></div>;
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
    {(childrenByParent.get(actor.id)?.length ?? 0) > 0 && <div className="builder-org-children">{childrenByParent.get(actor.id)?.map(child => renderActor(child, depth + 1))}</div>}
  </div>;
  return <div className="builder-page"><div className="builder-page-intro"><h2>현재 Workspace Actor</h2><p>저장된 부모 관계와 세션 상태를 표시합니다. Lead는 활성 작업 목록에는 포함하지 않습니다.</p></div>
    {roots.length ? <div className="builder-org-tree">{roots.map(actor => renderActor(actor))}</div>
      : <div className="builder-card builder-empty-card"><Network /><strong>조직 정보가 없습니다</strong><p>이 Workspace의 Actor와 관계가 아직 저장되지 않았습니다.</p></div>}</div>;
}

function DocumentsView({ props }: { props: BuilderShellProps }) {
  const [selectedId, setSelectedId] = useState<string | null>(props.snapshot.documents[0]?.id ?? null);
  const selected = props.snapshot.documents.find(document => document.id === selectedId) ?? props.snapshot.documents[0];
  return <div className="builder-page"><div className="builder-page-intro"><h2>설계 문서</h2><p>Lead가 저장한 문서의 현재 Revision을 확인합니다.</p></div>
    {props.snapshot.documents.length ? <div className="builder-doc-layout">
      <section className="builder-card"><h2>Workspace 문서</h2><div className="builder-record-list">{props.snapshot.documents.map(document => <button
        className={`builder-record-button${selected?.id === document.id ? " is-selected" : ""}`} key={document.id} onClick={() => setSelectedId(document.id)} type="button">
        <strong>{document.title}</strong><small>{document.revisionId} · {displayTime(document.createdAt)}</small>
      </button>)}</div></section>
      {selected && <section className="builder-card"><h2>{selected.title}</h2><p className="builder-card-sub">Revision {selected.revisionId} · {displayTime(selected.createdAt)}</p><pre className="builder-document-preview">{selected.text}</pre></section>}
    </div> : <div className="builder-card builder-empty-card"><FileText /><strong>설계 문서가 없습니다</strong><p>Lead가 이 Workspace에 문서를 저장하면 여기에 표시됩니다.</p></div>}</div>;
}

function DecisionsView({ props, drawerOpen, onDrawerToggle, onDrawerClose }: {
  props: BuilderShellProps; drawerOpen: boolean; onDrawerToggle(): void; onDrawerClose(): void;
}) {
  const openQuestions = props.snapshot.questions.filter(question => question.status === "open");
  const [selectedId, setSelectedId] = useState<string | null>(openQuestions[0]?.id ?? props.snapshot.questions[0]?.id ?? null);
  const selected = props.snapshot.questions.find(question => question.id === selectedId) ?? openQuestions[0] ?? props.snapshot.questions[0] ?? null;
  const messages = selected ? props.snapshot.messages.filter(message => message.channel === "decisions" && (!message.runId || message.runId === selected.id)) : [];
  return <div className={`builder-message-layout${drawerOpen ? " is-drawer-open" : ""}`}>
    <button aria-label="질문 목록 닫기" className="builder-drawer-backdrop" onClick={onDrawerClose} type="button" />
    <section className="builder-message-main">
      <div className="builder-chat-context"><span>질문 전용 Lead 대화 · 결정은 명세 Revision과 연결됩니다.</span>
        <button aria-label="미결정사항 목록 열기" className="builder-icon-button" onClick={onDrawerToggle} type="button"><PanelRight /><span className="builder-refresh-label">질문 목록</span></button>
      </div>
      {selected ? <><div className="builder-question-detail" style={{ padding: "12px 18px 0" }}>
        <StatusLabel status={selected.status} /><h2 style={{ margin: "7px 0", fontSize: 14 }}>{selected.title}</h2><p>{selected.text}</p>
        {selected.options.map(option => <div className="builder-option" key={option.id}><strong>{option.label}</strong><small>{option.tradeoff}</small></div>)}
        {selected.recommendation && <div className="builder-recommendation">Lead 추천: {selected.recommendation}</div>}
        {selected.answer && <div className="builder-recommendation"><Check aria-hidden="true" size={14} /> 결정된 답변: {selected.answer}{selected.revisionId ? ` · ${selected.revisionId}` : ""}</div>}
      </div><MessageList actors={props.snapshot.actors} messages={messages} /><MessageComposer channel="decisions" enabled={Boolean(props.onSendMessage) && props.snapshot.integrations.ai === "ready" && selected.status === "open"} onSend={props.onSendMessage} /></>
        : <EmptyState icon={CircleHelp} title="미결정사항이 없습니다" detail="Lead가 사용자 결정을 요청하면 질문과 관련 대화가 여기에 표시됩니다." />}
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
  return <div className="builder-page"><div className="builder-page-intro"><h2>Host 연동 상태</h2><p>현재 Workspace와 분리된 Host 수준 정보입니다. 제공되지 않은 Runner 상태는 추정하지 않습니다.</p></div>
    <div className="builder-system-grid"><section className="builder-card"><h2>연결 상태</h2>
      <IntegrationCard detail="메인 Lead 및 질문 대화 연결 상태" icon={Bot} state={aiLabel} title="AI 대화" />
      <IntegrationCard detail="저장소 및 Actions 연동 상태" icon={GitFork} state={githubLabel} title="GitHub" />
    </section><section className="builder-card"><h2>Runner 정보</h2>
      <div className="builder-empty-card" style={{ minHeight: 130 }}><Server /><strong>Runner 데이터가 없습니다</strong><p>현재 Builder snapshot에는 Host Runner 인벤토리, 온라인 상태, OS, 라벨 또는 최근 작업이 포함되지 않습니다.</p></div>
    </section></div>
  </div>;
}

function WithActivityRail({ children, props, view, drawerOpen, onDrawerClose, onSelectQuestion }: {
  children: ReactNode;
  props: BuilderShellProps;
  view: BuilderView;
  drawerOpen: boolean;
  onDrawerClose(): void;
  onSelectQuestion(id: string): void;
}) {
  return <div className={`builder-message-layout${drawerOpen ? " is-drawer-open" : ""}`}>
    <button aria-label="작업 기록 닫기" className="builder-drawer-backdrop" onClick={onDrawerClose} type="button" />
    <section className="builder-message-main">{children}</section>
    <ActivityRail onClose={onDrawerClose} onSelectQuestion={onSelectQuestion} props={props} selectedQuestion={null} view={view} />
  </div>;
}

function ConsultationImport({ onImport }: { onImport: NonNullable<BuilderShellProps["onImportConsultation"]> }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = text.trim();
    if (!value || saving) return;
    setSaving(true); setStatus("");
    try { await onImport(value); setText(""); setStatus("상담 입력이 Builder에 저장되었습니다."); }
    catch { setStatus("상담 입력을 저장하지 못했습니다. 다시 시도해 주세요."); }
    finally { setSaving(false); }
  }
  return <section aria-label="상담 텍스트 가져오기" className="builder-card builder-import">
    <p className="builder-card-sub">입력은 제공된 Builder 저장 기능에 전달됩니다. Lead 분석은 실제 대화 연동 후 진행됩니다.</p>
    <form className="builder-import-form" onSubmit={submit}><textarea aria-label="상담 텍스트" onChange={event => setText(event.target.value)} placeholder="고객 상담 원문 붙여넣기" value={text} />
      <button className="builder-primary-button" disabled={!text.trim() || saving} type="submit"><Upload size={14} /> 저장된 입력으로 전달</button>
    </form>{status && <p className="builder-composer-note" role="status">{status}</p>}</section>;
}

export function BuilderShell(props: BuilderShellProps) {
  const [view, setView] = useState<BuilderView>("lead");
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [actorId, setActorId] = useState<string | null>(null);
  const activeActors = props.snapshot.actors.filter(actor => actor.role !== "lead" && (actor.status === "running" || actor.status === "waiting"));
  const activeActor = actorId ? props.snapshot.actors.find(actor => actor.id === actorId) ?? null : null;
  const current = VIEW_TITLES[view];
  const leadIds = new Set(props.snapshot.actors.filter(actor => actor.role === "lead").map(actor => actor.id));
  const mainMessages = props.snapshot.messages.filter(message => message.channel === "main"
    && (message.actorId === null || leadIds.has(message.actorId)));
  const openQuestionCount = props.snapshot.questions.filter(question => question.status === "open").length;

  function selectView(next: BuilderView) { setView(next); setActorId(null); setDrawerOpen(false); }
  function openActor(id: string) {
    if (props.snapshot.actors.find(actor => actor.id === id)?.role === "lead") selectView("lead");
    else { setActorId(id); setDrawerOpen(false); }
  }
  const headerActions = <div className="builder-header-actions">
    {props.loading && <span aria-label="불러오는 중" className="builder-loading"><LoaderCircle /></span>}
    <button aria-label="Workspace 새로고침" className="builder-icon-button" onClick={props.onRefresh} type="button"><RefreshCw /><span className="builder-refresh-label">새로고침</span></button>
    {props.onOpenCoreSettings && <button aria-label="SPS Core 설정 열기" className="builder-icon-button" onClick={props.onOpenCoreSettings} type="button"><Settings /></button>}
    {view === "lead" && !activeActor && props.onOpenHtmlPreview && <button aria-label="Lead HTML 뷰어 열기" className="builder-icon-button" onClick={props.onOpenHtmlPreview} type="button"><FileText /><span className="builder-refresh-label">HTML 뷰어</span></button>}
    {view !== "lead" && view !== "decisions" && <button aria-label="작업 기록 열기" className="builder-icon-button" onClick={() => setDrawerOpen(value => !value)} type="button"><PanelRight /></button>}
  </div>;

  let content: ReactNode;
  if (activeActor) content = <ActorTranscriptView actor={activeActor} drawerOpen={drawerOpen} onDrawerClose={() => setDrawerOpen(false)} onDrawerToggle={() => setDrawerOpen(value => !value)} props={props} />;
  else if (view === "lead") content = <LeadView drawerOpen={drawerOpen} messages={mainMessages} onDrawerClose={() => setDrawerOpen(false)} onDrawerToggle={() => setDrawerOpen(value => !value)} props={props} />;
  else if (view === "architecture") content = <WithActivityRail drawerOpen={drawerOpen} onDrawerClose={() => setDrawerOpen(false)} onSelectQuestion={() => {}} props={props} view={view}><ArchitectureView onActor={openActor} props={props} /></WithActivityRail>;
  else if (view === "organization") content = <WithActivityRail drawerOpen={drawerOpen} onDrawerClose={() => setDrawerOpen(false)} onSelectQuestion={() => {}} props={props} view={view}><OrganizationView onActor={openActor} props={props} /></WithActivityRail>;
  else if (view === "documents") content = <WithActivityRail drawerOpen={drawerOpen} onDrawerClose={() => setDrawerOpen(false)} onSelectQuestion={() => {}} props={props} view={view}><DocumentsView props={props} /></WithActivityRail>;
  else if (view === "decisions") content = <DecisionsView drawerOpen={drawerOpen} onDrawerClose={() => setDrawerOpen(false)} onDrawerToggle={() => setDrawerOpen(value => !value)} props={props} />;
  else content = <WithActivityRail drawerOpen={drawerOpen} onDrawerClose={() => setDrawerOpen(false)} onSelectQuestion={() => {}} props={props} view={view}><SystemView props={props} /></WithActivityRail>;

  return <div className="builder-shell">
    <style>{flowCss}{builderCss}</style>
    <div className={`builder-layout${collapsed ? " is-collapsed" : ""}`}>
      <aside aria-label="SPS Builder 탐색" className="builder-sidebar">
        <div className="builder-brand"><span className="builder-brand-mark">SPS</span><div className="builder-brand-copy"><strong>SPS Builder</strong><small>Workspace</small></div></div>
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
          {props.onOpenCoreSettings && <button className="builder-quiet-button builder-settings" onClick={props.onOpenCoreSettings} title="SPS Core 설정" type="button"><Settings /><span>SPS Core 설정</span></button>}
          <button aria-label={collapsed ? "사이드바 펼치기" : "사이드바 접기"} className="builder-quiet-button builder-collapse" onClick={() => setCollapsed(value => !value)} type="button">
            {collapsed ? <ChevronRight /> : <ChevronLeft />}<span>{collapsed ? "메뉴 펼치기" : "메뉴 접기"}</span>
          </button>
        </div>
      </aside>
      <main className="builder-main">
        <header className="builder-view-header"><div className="builder-view-title"><h1>{activeActor ? activeActor.label : current.title}</h1>
          <p>{activeActor ? `${ACTOR_STATUS[activeActor.status]} · 조회 전용 세션` : current.description}</p></div>{headerActions}</header>
        <div className="builder-view-body">{content}</div>
      </main>
    </div>
  </div>;
}
