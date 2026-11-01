import { useEffect, useState, type FormEvent } from "react";
import type { BuilderLeadAgentOptions, BuilderLeadSessions } from "../domain/model.js";

export interface LeadAgentSettingsProps {
  options: BuilderLeadAgentOptions | null;
  loading: boolean;
  error: string | null;
  onSave?: (agentId: string | null, expectedRevision: number) => Promise<void>;
  sessions?: BuilderLeadSessions | null;
  sessionsLoading?: boolean;
  sessionsError?: string | null;
  onPrepare?: (agentId: string, expectedRevision: number) => Promise<void>;
}

export function LeadAgentSettings({ options, loading, error, onSave, sessions, sessionsLoading, sessionsError, onPrepare }: LeadAgentSettingsProps) {
  const selectedAgentId = options?.selectedAgentId ?? null;
  const revision = options?.revision ?? null;
  const workspaceId = options?.workspaceId ?? null;
  const [draft, setDraft] = useState<string | null>(selectedAgentId);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(selectedAgentId);
    setSaveError(null);
    setPrepareError(null);
  }, [selectedAgentId, revision, workspaceId]);

  const selectedAgent = draft === null ? null : options?.agents.find(agent => agent.id === draft) ?? null;
  const unavailable = draft !== null && selectedAgent === null;
  const eligible = draft === null || selectedAgent?.status === "idle" || selectedAgent?.status === "running";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onSave || !options || !eligible || loading || saving || preparing) return;
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

  const sessionsMatch = sessions?.selectionRevision === options?.revision && sessions?.agentId === selectedAgentId;
  const savedCount = sessionsMatch && sessions ? Object.values(sessions.sessions).filter(Boolean).length : 0;
  async function prepare() {
    if (!options?.selectedAgentId || !onPrepare || loading || saving || preparing || sessionsLoading
      || draft !== selectedAgentId || !eligible) return;
    setPreparing(true);
    setPrepareError(null);
    try { await onPrepare(options.selectedAgentId, options.revision); }
    catch { setPrepareError("Lead 세션을 준비하지 못했습니다. 새로고침 후 다시 확인해 주세요."); }
    finally { setPreparing(false); }
  }

  return <section aria-labelledby="lead-agent-settings-title">
    <h2 id="lead-agent-settings-title">Lead Agent</h2>
    <form onSubmit={submit}>
      <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
        <select aria-label="Lead Agent" style={{ width: "100%", minWidth: 0 }} disabled={loading || saving || preparing || !options} onChange={event => {
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
        <button className="builder-primary-button" disabled={!onSave || !options || loading || saving || preparing || !eligible}
          type="submit">{saving ? "저장 중..." : "Lead Agent 저장"}</button>
      </div>
    </form>
    <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
      <p className="builder-card-sub" role="status" style={{ margin: 0 }}>저장된 Lead 세션 {savedCount}/3 · AI 전송 준비 중</p>
      {sessionsError && <p className="builder-feedback" role="alert">{sessionsError}</p>}
      {prepareError && <p className="builder-feedback" role="alert">{prepareError}</p>}
      <button className="builder-primary-button" type="button" aria-label="Lead 세션 준비 및 확인" onClick={() => { void prepare(); }}
        disabled={!onPrepare || !options?.selectedAgentId || loading || saving || preparing || sessionsLoading
          || draft !== selectedAgentId || !eligible || Boolean(sessionsError)}>
        {preparing ? "세션 확인 중..." : savedCount === 3 ? "Lead 세션 확인" : "Lead 세션 준비"}
      </button>
    </div>
  </section>;
}
