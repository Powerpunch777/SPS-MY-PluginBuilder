import { useEffect, useRef, useState } from "react";

export type IntegrationManagerDTO = Readonly<{
  workspaceId: string;
  revision: number;
  selectedAgentId: string | null;
  agents: readonly Readonly<{ id: string; name: string; status: string }>[];
  sessionId: string | null;
  executionReadiness: "unknown";
  aiRunStarted: false;
}>;

type ManagerPreparationDTO = Readonly<{
  status: "preserved" | "provisioned" | "conflict" | "unknown";
  projectId: string;
  workspaceId: string;
  managerAgentId: string | null;
  managerSessionId: string | null;
  managerRevision: number;
  profileProvisioning: "created-or-resolved" | "already-present" | "not-required" | "not-attempted";
  sessionProvisioning: "created-or-resolved" | "already-present" | "not-required" | "not-attempted";
  profileStatus: string | null;
  executionReadiness: "unknown";
  aiRunStarted: false;
  authorityConsistency: "cross-key-reads-are-not-atomic";
}>;

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Invalid Integration Manager data.");
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError("Invalid Integration Manager data fields.");
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Invalid Integration Manager data field.");
    result[key] = descriptor.value;
  }
  return result;
}

function optionalId(value: unknown): value is string | null {
  return value === null || typeof value === "string" && value.length > 0 && value.length <= 160;
}

export function parseIntegrationManagerDTO(value: unknown, workspaceId: string): IntegrationManagerDTO {
  const row = exactRecord(value, ["workspaceId", "revision", "selectedAgentId", "agents", "sessionId", "executionReadiness", "aiRunStarted"]);
  if (row.workspaceId !== workspaceId || !Number.isSafeInteger(row.revision) || (row.revision as number) < 0
    || !optionalId(row.selectedAgentId) || !optionalId(row.sessionId) || row.executionReadiness !== "unknown"
    || row.aiRunStarted !== false || !Array.isArray(row.agents) || row.agents.length > 100) {
    throw new TypeError("Invalid Integration Manager DTO.");
  }
  const agents = row.agents.map(value => {
    const agent = exactRecord(value, ["id", "name", "status"]);
    if (typeof agent.id !== "string" || !agent.id || agent.id.length > 160
      || typeof agent.name !== "string" || !agent.name.trim() || agent.name.length > 500
      || typeof agent.status !== "string" || !/^[a-z_]{1,80}$/u.test(agent.status)) {
      throw new TypeError("Invalid Integration Manager Agent.");
    }
    return Object.freeze({ id: agent.id, name: agent.name, status: agent.status });
  });
  if (new Set(agents.map(agent => agent.id)).size !== agents.length) throw new TypeError("Duplicate Integration Manager Agent.");
  return Object.freeze({ workspaceId, revision: row.revision as number, selectedAgentId: row.selectedAgentId,
    agents: Object.freeze(agents), sessionId: row.sessionId, executionReadiness: "unknown", aiRunStarted: false });
}

function parsePreparation(value: unknown, workspaceId: string, projectId: string): ManagerPreparationDTO {
  const row = exactRecord(value, ["status", "reason", "projectId", "workspaceId", "managerAgentId", "managerSessionId",
    "managerRevision", "profileProvisioning", "sessionProvisioning", "profileStatus", "executionReadiness", "aiRunStarted", "authorityConsistency"]);
  const statuses = ["preserved", "provisioned", "conflict", "unknown"];
  const provisioning = ["created-or-resolved", "already-present", "not-required", "not-attempted"];
  if (!statuses.includes(row.status as string) || row.projectId !== projectId || row.workspaceId !== workspaceId
    || !optionalId(row.managerAgentId) || !optionalId(row.managerSessionId)
    || !Number.isSafeInteger(row.managerRevision) || (row.managerRevision as number) < 0
    || !provisioning.includes(row.profileProvisioning as string) || !provisioning.includes(row.sessionProvisioning as string)
    || row.profileStatus !== null && typeof row.profileStatus !== "string"
    || typeof row.reason !== "string" || row.executionReadiness !== "unknown" || row.aiRunStarted !== false
    || row.authorityConsistency !== "cross-key-reads-are-not-atomic") throw new TypeError("Invalid Integration Manager preparation result.");
  return row as unknown as ManagerPreparationDTO;
}

export interface IntegrationManagerSettingsProps {
  workspaceId: string;
  projectId: string;
  options: IntegrationManagerDTO | null;
  loading: boolean;
  error: string | null;
  onSelect?(agentId: string | null, expectedRevision: number): Promise<void>;
  onPrepare?(projectId: string, expectedManagerRevision: number): Promise<unknown>;
  onRefresh?(): void;
}

function statusLabel(status: string): string {
  return ({ idle: "대기", paused: "일시 정지", running: "실행 중", "not-ready": "실행 준비 안 됨" } as Record<string, string>)[status]
    ?? "상태 미확인";
}

export function IntegrationManagerSettings({ workspaceId, projectId, options, loading, error, onSelect, onPrepare, onRefresh }: IntegrationManagerSettingsProps) {
  const [draft, setDraft] = useState<string | null>(options?.selectedAgentId ?? null);
  const [saving, setSaving] = useState<"selection" | "profile" | null>(null);
  const [awaitingRevision, setAwaitingRevision] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
  const [preparation, setPreparation] = useState<ManagerPreparationDTO | null>(null);
  const operation = useRef(0);
  const live = useRef({ workspaceId, projectId, revision: options?.revision ?? null });
  live.current = { workspaceId, projectId, revision: options?.revision ?? null };

  useEffect(() => {
    operation.current += 1;
    setDraft(options?.selectedAgentId ?? null);
    setSaving(null);
    setAwaitingRevision(null);
    setFeedback(null);
    setPreparation(null);
  }, [workspaceId, projectId, options?.revision, options?.selectedAgentId]);
  useEffect(() => () => { operation.current += 1; }, []);

  const unavailableSelected = draft !== null && !options?.agents.some(agent => agent.id === draft);
  const staleSelection = awaitingRevision !== null && options?.revision === awaitingRevision;
  const disabled = loading || !options || saving !== null || staleSelection;
  const start = () => {
    const token = ++operation.current;
    return { token, workspaceId, projectId, revision: options!.revision };
  };
  const isCurrent = (request: ReturnType<typeof start>) => operation.current === request.token
    && live.current.workspaceId === request.workspaceId && live.current.projectId === request.projectId
    && live.current.revision === request.revision;

  async function saveSelection() {
    if (!options || !onSelect || disabled || draft === options.selectedAgentId) return;
    const request = start();
    setSaving("selection"); setFeedback(null); setPreparation(null);
    try {
      await onSelect(draft, request.revision);
      if (!isCurrent(request)) return;
      setAwaitingRevision(request.revision);
      setFeedback({ tone: "status", text: "선택 저장을 요청했습니다. 저장 상태는 새로고침 후 확인하세요." });
      onRefresh?.();
    } catch {
      if (isCurrent(request)) setFeedback({ tone: "alert", text: "Manager 선택을 저장하지 못했습니다. 현재 설정을 새로고침해 확인해 주세요." });
    } finally { if (isCurrent(request)) setSaving(null); }
  }

  async function prepareProfile() {
    if (!options || !onPrepare || disabled) return;
    const request = start();
    setSaving("profile"); setFeedback(null); setPreparation(null);
    try {
      const result = parsePreparation(await onPrepare(projectId, request.revision), workspaceId, projectId);
      if (!isCurrent(request)) return;
      setPreparation(result);
      onRefresh?.();
    } catch {
      if (isCurrent(request)) setFeedback({ tone: "alert", text: "기본 프로필 준비 결과를 확인하지 못했습니다. 새로고침해 다시 확인해 주세요." });
    } finally { if (isCurrent(request)) setSaving(null); }
  }

  const preparationText = preparation?.status === "preserved" ? "기존 기본 프로필과 세션 설정을 유지했습니다."
    : preparation?.status === "provisioned" ? "기본 프로필 준비 요청이 확인되었습니다. 실행이나 통합 완료를 뜻하지 않습니다."
      : preparation?.status === "conflict" ? "Manager 설정이 변경되었습니다. 새로고침 후 다시 확인해 주세요."
        : preparation ? "준비 결과를 확정할 수 없습니다. 실행 가능 상태로 간주하지 않았습니다." : null;

  return <section aria-labelledby="integration-manager-settings-title" className="builder-manager-settings">
    <h2 id="integration-manager-settings-title">Integration Manager</h2>
    <p className="builder-card-sub">Lead Agent와 별도로 Manager 프로필과 세션을 설정합니다. 설정은 AI 실행이나 통합 완료가 아닙니다.</p>
    {loading ? <p role="status">Manager 설정을 불러오는 중...</p>
      : error || !options ? <p className="builder-feedback" role="status">{error ?? "이 Host에서 Manager 설정을 사용할 수 없습니다."}</p>
        : <>
          <label className="builder-manager-field">Manager Agent
            <select aria-label="Integration Manager Agent" disabled={disabled || !onSelect} value={draft ?? ""}
              onChange={event => { setDraft(event.target.value || null); setFeedback(null); setPreparation(null); }}>
              <option value="">선택 안 함</option>
              {unavailableSelected && <option disabled value={draft!}>현재 선택 유지 · 목록에서 확인할 수 없음</option>}
              {options.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {statusLabel(agent.status)}</option>)}
            </select>
          </label>
          <div className="builder-manager-meta">
            <span>설정 Revision {options.revision}</span>
            <span>Manager 세션 {options.sessionId ? "연결됨" : "없음"}</span>
            <span>실행 준비 상태 미확인</span>
          </div>
          <div className="builder-manager-actions">
            <button className="builder-quiet-button" type="button" disabled={disabled || !onSelect || draft === options.selectedAgentId}
              onClick={() => { void saveSelection(); }}>{saving === "selection" ? "저장 중..." : "Manager 선택 저장"}</button>
            <button className="builder-primary-button" type="button" disabled={disabled || !onPrepare}
              onClick={() => { void prepareProfile(); }}>{saving === "profile" ? "프로필 준비 중..." : "기본 프로필 준비"}</button>
          </div>
          {staleSelection && <button className="builder-quiet-button" type="button" disabled={loading}
            onClick={onRefresh}>새 설정 확인</button>}
        </>}
    {feedback && <p role={feedback.tone === "alert" ? "alert" : "status"}>{feedback.text}</p>}
    {preparationText && <p role="status">{preparationText}</p>}
  </section>;
}
