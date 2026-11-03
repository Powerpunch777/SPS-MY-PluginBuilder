import { useEffect, useState, type FormEvent } from "react";
import { LEAD_CONTEXTS, type BuilderLeadContexts } from "../domain/lead-contexts.ts";
import type { BuilderLeadAgentOptions } from "../domain/model.js";

export interface LeadAgentSettingsProps {
  options: BuilderLeadAgentOptions | null;
  loading: boolean;
  error: string | null;
  onSave?: (agentId: string | null, expectedRevision: number) => Promise<void>;
  contexts?: BuilderLeadContexts | null;
  contextsLoading?: boolean;
  contextsError?: string | null;
  onPrepareContexts?: (agentId: string, expectedRevision: number) => Promise<void>;
}

export function LeadAgentSettings({ options, loading, error, onSave,
  contexts, contextsLoading, contextsError, onPrepareContexts }: LeadAgentSettingsProps) {
  const selectedAgentId = options?.selectedAgentId ?? null;
  const revision = options?.revision ?? null;
  const workspaceId = options?.workspaceId ?? null;
  const [draft, setDraft] = useState<string | null>(selectedAgentId);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [startingContexts, setStartingContexts] = useState(false);
  const [contextsStartError, setContextsStartError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(selectedAgentId);
    setSaveError(null);
    setContextsStartError(null);
  }, [selectedAgentId, revision, workspaceId]);

  const selectedAgent = draft === null ? null : options?.agents.find(agent => agent.id === draft) ?? null;
  const unavailable = draft !== null && selectedAgent === null;
  const eligible = draft === null || selectedAgent?.status === "idle" || selectedAgent?.status === "running";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onSave || !options || !eligible || loading || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(draft, options.revision);
    } catch {
      setSaveError("Lead Agent 설정을 저장하지 못했습니다. 다시 시도해 주세요.");
    } finally {
      setSaving(false);
    }
  }

  async function prepareContexts() {
    if (!options?.selectedAgentId || !onPrepareContexts || loading || saving || startingContexts
      || contextsLoading || draft !== selectedAgentId || !eligible || contexts) return;
    setStartingContexts(true);
    setContextsStartError(null);
    try { await onPrepareContexts(options.selectedAgentId, options.revision); }
    catch { setContextsStartError("새 Lead 구성을 시작하지 못했습니다. 상태를 새로고침해 확인해 주세요."); }
    finally { setStartingContexts(false); }
  }

  return <section aria-labelledby="lead-agent-settings-title">
    <h2 id="lead-agent-settings-title">Lead Agent</h2>
    <form onSubmit={submit}>
      <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
        <select aria-label="Lead Agent" style={{ width: "100%", minWidth: 0 }} disabled={loading || saving || !options} onChange={event => {
          setDraft(event.target.value || null);
          setSaveError(null);
        }} value={draft ?? ""}>
          <option value="">설정 안 함</option>
          {unavailable && <option disabled value={draft!}>현재 선택된 Lead Agent를 사용할 수 없음 ({draft})</option>}
          {options?.agents.map(agent => <option disabled={agent.status !== "idle" && agent.status !== "running"}
            key={agent.id} value={agent.id}>{agent.name} · {agent.status}</option>)}
        </select>
        {unavailable && <p className="builder-card-sub" role="status" style={{ margin: 0 }}>
          현재 선택된 Agent를 찾을 수 없습니다. 다른 Agent로 자동 변경되지 않았습니다.
        </p>}
        {error && <p className="builder-feedback" role="alert">{error}</p>}
        {saveError && <p className="builder-feedback" role="alert">{saveError}</p>}
        <button className="builder-primary-button" disabled={!onSave || !options || loading || saving || !eligible}
          type="submit">{saving ? "저장 중..." : "Lead Agent 저장"}</button>
      </div>
    </form>
    <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
      <p className="builder-card-sub" role="status" style={{ margin: 0 }}>
        {contexts?.status === "ready" ? "새 Lead 구성 준비 완료 · 5개 논리 컨텍스트"
          : contexts?.status === "uncertain" ? `새 Lead 구성 확인 필요 · ${contexts.pendingContext} Host 세션 결과가 불확실합니다. 자동 재시도하지 않았습니다.`
            : contexts?.status === "preparing" ? `새 Lead 구성 진행 상태 · ${contexts.pendingContext} 확인이 필요합니다.`
              : "새 5개 논리 Lead 구성을 시작하면 Host 세션 5개를 별도로 준비합니다."}
      </p>
      <ul aria-label="5개 논리 Lead 컨텍스트" className="builder-context-list" style={{ margin: 0, paddingLeft: 18 }}>
        {LEAD_CONTEXTS.map((context, index) => {
          const label = ["Main", "UI Design", "Background", "Question Intake", "Question Discussion"][index]!;
          const sessionId = contexts?.contexts[context] ?? null;
          return <li key={context}><span>{label}</span><small className="builder-card-sub">
            {sessionId ? "Host 세션 연결됨" : contexts?.pendingContext === context
              ? contexts.status === "uncertain" ? "Host 결과 확인 필요" : "Host 준비 진행 중"
              : "세션 없음"}
          </small></li>;
        })}
      </ul>
      {contextsError && <p className="builder-feedback" role="alert">{contextsError}</p>}
      {contextsStartError && <p className="builder-feedback" role="alert">{contextsStartError}</p>}
      {contexts?.status === "uncertain" && <p className="builder-feedback" role="alert">
        Host SDK는 taskKey만으로 동일 세션이 복구된다고 보장하지 않습니다. 정확한 상태를 확인할 때까지 시작을 다시 누를 수 없습니다.
      </p>}
      <button className="builder-primary-button" type="button" aria-label="새 5개 Lead 컨텍스트 명시 시작"
        onClick={() => { void prepareContexts(); }} disabled={!onPrepareContexts || !options?.selectedAgentId || loading || saving
          || startingContexts || contextsLoading || draft !== selectedAgentId || !eligible || Boolean(contextsError) || Boolean(contexts)}>
        {startingContexts ? "새 Lead 구성 시작 중..." : contexts?.status === "ready" ? "새 Lead 구성 준비 완료"
          : contexts ? "새 Lead 구성 상태 확인 필요" : "새 5개 Lead 구성 명시 시작"}
      </button>
      <small className="builder-card-sub">기본 상태에는 대화와 세션이 없습니다. 명시적으로 시작해도 AI 대화를 자동 실행하지 않습니다. 왼쪽 화면 이동은 세션을 만들지 않습니다.</small>
    </div>
  </section>;
}
