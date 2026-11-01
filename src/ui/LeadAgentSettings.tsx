import { useEffect, useState, type FormEvent } from "react";
import type { BuilderLeadAgentOptions } from "../domain/model.js";

export interface LeadAgentSettingsProps {
  options: BuilderLeadAgentOptions | null;
  loading: boolean;
  error: string | null;
  onSave?: (agentId: string | null, expectedRevision: number) => Promise<void>;
}

export function LeadAgentSettings({ options, loading, error, onSave }: LeadAgentSettingsProps) {
  const selectedAgentId = options?.selectedAgentId ?? null;
  const revision = options?.revision ?? null;
  const workspaceId = options?.workspaceId ?? null;
  const [draft, setDraft] = useState<string | null>(selectedAgentId);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(selectedAgentId);
    setSaveError(null);
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
  </section>;
}
