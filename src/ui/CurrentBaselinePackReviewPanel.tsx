import { useEffect, useState } from "react";

export type CurrentBaselinePackConfirmationInput = Readonly<{
  projectId: string;
  packId: string;
  expectedProposalRevisionId: string;
  expectedBaselineRevisionId: string;
  expectedApprovalRevisionId: string | null;
}>;

export type CurrentBaselinePackReviewView =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "empty" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "ready"; data: unknown }>
  | Readonly<{ status: "stale"; data: unknown }>;

export type CurrentBaselinePackReviewPanelProps = Readonly<{
  view: CurrentBaselinePackReviewView;
  onConfirm?: (input: CurrentBaselinePackConfirmationInput) => unknown | Promise<unknown>;
  onRefresh?: () => unknown | Promise<unknown>;
}>;

type ReadResult = Readonly<{
  sequence: number;
  revision: Record<string, unknown>;
  currentBaselineRevisionId: string;
  currentBaselineSequence: number;
  matchesCurrentBaseline: boolean;
  approvalRevisionId: string | null;
  approval: Record<string, unknown> | null;
  pinKey: string;
}>;

const CSS = ".sps-cbpr{color:var(--builder-text,#ededed);background:var(--builder-panel,#202020);border:1px solid var(--builder-border,#353535);border-radius:6px;padding:14px;min-width:0}" +
  ".sps-cbpr *{box-sizing:border-box}.sps-cbpr h2,.sps-cbpr h3,.sps-cbpr p{margin-top:0}.sps-cbpr h2{margin-bottom:4px;font-size:16px}.sps-cbpr h3{margin-bottom:8px;font-size:13px}" +
  ".sps-cbpr-muted{color:var(--builder-muted,#a0a0a0)}.sps-cbpr-state{margin:8px 0}.sps-cbpr-section{border-top:1px solid var(--builder-border,#353535);margin-top:14px;padding-top:12px;min-width:0}" +
  ".sps-cbpr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:8px}.sps-cbpr-item{min-width:0;padding:9px;border:1px solid var(--builder-border,#353535);border-radius:5px;overflow-wrap:anywhere}" +
  ".sps-cbpr-item strong,.sps-cbpr-item small{display:block}.sps-cbpr-item small{margin-top:4px;color:var(--builder-muted,#a0a0a0)}.sps-cbpr-mono{font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}" +
  ".sps-cbpr-list{display:grid;gap:8px;margin:0;padding:0;list-style:none}.sps-cbpr-rule{border-left:2px solid var(--builder-border,#555);padding:2px 0 2px 10px;min-width:0}" +
  ".sps-cbpr-quote{margin:6px 0 0;padding:8px 10px;border-left:2px solid var(--builder-border,#555);background:var(--builder-panel-muted,#252525);white-space:pre-wrap;overflow-wrap:anywhere}" +
  ".sps-cbpr-warning{color:var(--builder-warning,#d1b977)}.sps-cbpr-danger{color:var(--builder-danger,#e38e8e)}.sps-cbpr-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}" +
  ".sps-cbpr button{min-height:36px;border:1px solid var(--builder-border,#555);border-radius:5px;padding:7px 12px;background:var(--builder-accent-soft,#2b2b2b);color:var(--builder-text,#ededed);font:inherit;cursor:pointer}" +
  ".sps-cbpr button:disabled{opacity:.55;cursor:not-allowed}";

const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 160
  && !/[\u0000-\u001f\u007f]/u.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const shown = (value: unknown) => {
  try { return JSON.stringify(value, null, 2) ?? "값 없음"; }
  catch { return "내용을 표시할 수 없음"; }
};

function readData(value: unknown): ReadResult | null {
  if (!plain(value)) return null;
  const row = plain(value.data) ? value.data : value;
  const current = row.current;
  const baselineRevisionId = row.currentBaselineRevisionId;
  const baselineSequence = row.currentBaselineSequence;
  const approvalEntry = row.currentApproval;
  if (!plain(current) || !Number.isSafeInteger(current.sequence) || (current.sequence as number) < 1
    || !plain(current.revision) || !id(baselineRevisionId) || !Number.isSafeInteger(baselineSequence)
    || (baselineSequence as number) < 1 || typeof row.matchesCurrentBaseline !== "boolean"
    || !Object.hasOwn(row, "currentApproval")) return null;
  const proposal = current.revision;
  const identity = proposal.identity;
  const pack = proposal.pack;
  if (proposal.status !== "PROPOSED" || !id(proposal.revisionId) || !id(proposal.workspaceId) || !id(proposal.projectId)
    || !id(proposal.baselineRevisionId) || !Number.isSafeInteger(proposal.baselineSequence)
    || !plain(identity) || identity.workspaceId !== proposal.workspaceId || identity.projectId !== proposal.projectId
    || !id(identity.specRevisionId) || !digest(identity.specDigest) || !Array.isArray(proposal.scopeBindings)
    || !plain(pack) || !id(pack.packId) || !id(pack.version) || !plain(pack.applicability)
    || !Array.isArray(pack.rules) || !Array.isArray(pack.transitions) || !Array.isArray(pack.exceptions)
    || !Array.isArray(pack.excludedCombinations) || !Array.isArray(proposal.sourceRefs)
    || !plain(proposal.rulesManifest) || !digest(proposal.rulesManifest.digest) || !id(proposal.rulesManifest.rulesVersion)) return null;
  const seenPins = new Set<string>();
  for (const pin of proposal.sourceRefs) {
    if (!plain(pin) || !id(pin.requirementId) || pin.acId !== null && !id(pin.acId) || !id(pin.sourceId)
      || !digest(pin.sourceDigest) || pin.revisionId !== identity.specRevisionId) return null;
    const key = `${pin.requirementId}\0${pin.acId ?? ""}\0${pin.sourceId}`;
    if (seenPins.has(key)) return null;
    seenPins.add(key);
  }
  if (proposal.designModel !== undefined) {
    const model = proposal.designModel;
    if (!plain(model) || model.kind !== "design-model-v1" || !Array.isArray(model.facts) || !model.facts.every(id)
      || !plain(model.rulesManifest) || !digest(model.rulesManifest.digest) || !id(model.rulesManifest.rulesVersion)
      || !plain(model.rulesManifest.identity) || model.rulesManifest.identity.workspaceId !== identity.workspaceId
      || model.rulesManifest.identity.projectId !== identity.projectId
      || model.rulesManifest.identity.specRevisionId !== identity.specRevisionId
      || model.rulesManifest.identity.specDigest !== identity.specDigest || !Array.isArray(model.scenarios)
      || !Array.isArray(model.itemDecisions) || !Array.isArray(model.acceptanceCriteria)) return null;
    for (const item of model.scenarios) if (!plain(item) || !id(item.id) || !id(item.state) || !id(item.event)
      || !id(item.nextState) || item.exceptionId !== null && !id(item.exceptionId)) return null;
    for (const item of model.itemDecisions) if (!plain(item) || !id(item.requirementId) || !id(item.status)
      || !id(item.reason) || !Array.isArray(item.sourceIds) || !item.sourceIds.every(id)) return null;
    for (const item of model.acceptanceCriteria) if (!plain(item) || !id(item.requirementId) || !id(item.acId)
      || !id(item.sourceId) || !digest(item.sourceDigest) || !digest(item.textSha256)
      || typeof item.text !== "string" || !item.text.trim() || item.text.length > 8192) return null;
  }
  let approvalRevisionId: string | null = null, approval: Record<string, unknown> | null = null;
  if (approvalEntry !== null) {
    if (!plain(approvalEntry) || !Number.isSafeInteger(approvalEntry.sequence) || (approvalEntry.sequence as number) < 1
      || !plain(approvalEntry.revision)) return null;
    approval = approvalEntry.revision;
    if (approval.status !== "APPROVED" || !id(approval.revisionId) || !id(approval.proposalRevisionId)
      || !digest(approval.proposalDigest) || !id(approval.baselineRevisionId)
      || !Number.isSafeInteger(approval.baselineSequence) || !plain(approval.identity)
      || approval.identity.workspaceId !== identity.workspaceId || approval.identity.projectId !== identity.projectId
      || approval.identity.specRevisionId !== identity.specRevisionId || approval.identity.specDigest !== identity.specDigest
      || approval.designModelDigest !== null && !digest(approval.designModelDigest) || !plain(approval.user)
      || !id(approval.user.userId) || !id(approval.user.agentId) || !id(approval.user.sessionId)
      || !Number.isSafeInteger(approval.user.selectionRevision) || typeof approval.user.approvedAt !== "string") return null;
    approvalRevisionId = approval.revisionId;
  }
  return Object.freeze({ sequence: current.sequence as number, revision: proposal,
    currentBaselineRevisionId: baselineRevisionId, currentBaselineSequence: baselineSequence as number,
    matchesCurrentBaseline: row.matchesCurrentBaseline,
    approvalRevisionId, approval,
    pinKey: JSON.stringify([proposal.revisionId, baselineRevisionId, baselineSequence, approvalRevisionId]) });
}

function Item({ label, value, mono = false }: { label: string; value: unknown; mono?: boolean }) {
  return <div className="sps-cbpr-item"><strong>{label}</strong><small className={mono ? "sps-cbpr-mono" : undefined}>{String(value)}</small></div>;
}

export function CurrentBaselinePackReviewPanel({ view, onConfirm, onRefresh }: CurrentBaselinePackReviewPanelProps) {
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<"idle" | "submitted" | "changed" | "unknown">("idle");
  const data = view.status === "ready" || view.status === "stale" ? readData(view.data) : null;
  const current = view.status === "ready" && data !== null && data.matchesCurrentBaseline
    && data.revision.baselineRevisionId === data.currentBaselineRevisionId
    && data.revision.baselineSequence === data.currentBaselineSequence;
  const pack = data && plain(data.revision.pack) ? data.revision.pack : null;
  const key = data?.pinKey ?? "";

  useEffect(() => { setAttempt("idle"); }, [key]);

  const canConfirm = Boolean(current && data && pack && onConfirm && !busy && attempt === "idle");
  async function confirm() {
    if (!canConfirm || !data || !pack || !onConfirm) return;
    setBusy(true);
    try {
      const result = await onConfirm(Object.freeze({ projectId: data.revision.projectId as string,
        packId: pack.packId as string, expectedProposalRevisionId: data.revision.revisionId as string,
        expectedBaselineRevisionId: data.currentBaselineRevisionId, expectedApprovalRevisionId: data.approvalRevisionId }));
      if (plain(result) && ["published", "replayed", "existing"].includes(String(result.status))) setAttempt("submitted");
      else if (plain(result) && ["stale", "conflict"].includes(String(result.status))) setAttempt("changed");
      else setAttempt("unknown");
    } catch { setAttempt("unknown"); }
    finally { setBusy(false); }
  }

  const existingApproval = data?.approval;
  return <section className="sps-cbpr" aria-labelledby="sps-cbpr-title">
    <style>{CSS}</style>
    <header><h2 id="sps-cbpr-title">후속 명세 규칙 확인</h2>
      <p className="sps-cbpr-muted">현재 Main 제안의 규칙 팩과 선택적 설계 모델을 검토합니다. 이 확인은 Baseline 발행이나 실행·QA 권한을 부여하지 않습니다.</p>
    </header>
    {view.status === "loading" ? <p className="sps-cbpr-state" role="status">규칙 제안을 불러오는 중입니다.</p>
      : view.status === "empty" ? <p className="sps-cbpr-state" role="status">검토할 후속 규칙 제안이 없습니다.</p>
      : view.status === "error" ? <p className="sps-cbpr-state" role="alert">규칙 제안을 확인하지 못했습니다. 기존 사용자 확인 기록은 변경되지 않았습니다.</p>
      : !data ? <p className="sps-cbpr-state" role="alert">제안 또는 현재 확인 기록의 구조가 올바르지 않아 새 확인을 차단했습니다.</p>
      : <>
        {(view.status === "stale" || !current) && <p className="sps-cbpr-state sps-cbpr-warning" role="status">
          제안 또는 Baseline 핀이 바뀌었습니다. 이 내용은 읽기만 가능하며 다시 불러오기 전까지 확인할 수 없습니다.
        </p>}
        <section className="sps-cbpr-section" aria-label="현재 기준선과 제안">
          <h3>현재 핀</h3>
          <div className="sps-cbpr-grid">
            <Item label="Baseline revision" value={data.currentBaselineRevisionId} mono />
            <Item label="제안 revision" value={data.revision.revisionId} mono />
            <Item label="제안된 Main" value={plain(data.revision.author)
              ? `${String(data.revision.author.agentId)} / ${String(data.revision.author.sessionId)} / ${String(data.revision.author.runId)}` : "확인 불가"} mono />
            <Item label="현재 사용자 확인" value={data.approvalRevisionId ?? "없음"} mono />
          </div>
        </section>
        <section className="sps-cbpr-section" aria-label="규칙 팩">
          <h3>규칙 팩</h3>
          <div className="sps-cbpr-grid">
            <Item label="Pack / version" value={`${String(pack!.packId)} @ ${String(pack!.version)}`} />
            <Item label="명세 identity" value={`${String(plain(data.revision.identity) ? data.revision.identity.specRevisionId : "")} · ${String(plain(data.revision.identity) ? data.revision.identity.specDigest : "")}`} mono />
          <Item label="coverage rules" value={(data.revision.rulesManifest as Record<string, unknown>).rulesVersion} />
            <Item label="규칙 수 / 전이 / 예외 / 제외" value={`${(pack!.rules as unknown[]).length} / ${(pack!.transitions as unknown[]).length} / ${(pack!.exceptions as unknown[]).length} / ${(pack!.excludedCombinations as unknown[]).length}`} />
          </div>
          <ul className="sps-cbpr-list">{(pack!.rules as Record<string, unknown>[]).map((rule, index) => <li className="sps-cbpr-rule" key={`${String(rule.id)}-${index}`}>
            <strong>{String(rule.id ?? "규칙")}</strong>
            <small>요구사항: {Array.isArray(rule.requirementIds) ? rule.requirementIds.map(String).join(", ") : "연결 없음"}</small>
            <small>필수 검사: {rule.requiresCheck ? "필요" : "불필요"} · 모델 사례: {Array.isArray(rule.modelCases) ? rule.modelCases.length : 0}</small>
            <pre className="sps-cbpr-quote">{shown({ appliesWhen: rule.appliesWhen, modelCases: rule.modelCases ?? [] })}</pre>
          </li>)}</ul>
        </section>
        <section className="sps-cbpr-section" aria-label="원문 핀">
          <h3>원문 연결 {(data.revision.sourceRefs as unknown[]).length}개</h3>
          <ul className="sps-cbpr-list">{(data.revision.sourceRefs as Record<string, unknown>[]).map((pin, index) => <li className="sps-cbpr-item" key={`${String(pin.requirementId)}-${String(pin.acId)}-${index}`}>
            <strong>{String(pin.requirementId)} · {pin.acId === null ? "요구사항" : String(pin.acId)}</strong>
            <small className="sps-cbpr-mono">{String(pin.sourceId)} · SHA-256 {String(pin.sourceDigest)}</small>
          </li>)}</ul>
        </section>
        {plain(data.revision.designModel) && <section className="sps-cbpr-section" aria-label="정적 설계 모델">
          <h3>정적 설계 모델</h3>
          <p className="sps-cbpr-muted">유한 시나리오의 결과는 설계 모델 평가이며 실제 코드 실행이나 QA 합격이 아닙니다.</p>
          <div className="sps-cbpr-grid">
            <Item label="사실값" value={(data.revision.designModel.facts as unknown[]).map(String).join(", ") || "없음"} />
            <Item label="유한 시나리오" value={(data.revision.designModel.scenarios as unknown[]).length} />
            <Item label="Coverage digest" value={String((data.revision.designModel.rulesManifest as Record<string, unknown>).digest)} mono />
          </div>
          <ul className="sps-cbpr-list">{(data.revision.designModel.scenarios as Record<string, unknown>[]).map((scenario, index) => <li className="sps-cbpr-item" key={`${String(scenario.id)}-${index}`}>
            <strong>{String(scenario.id)} · {String(scenario.state)} → {String(scenario.nextState)}</strong>
            <small>이벤트: {String(scenario.event)}{scenario.exceptionId === null ? "" : ` · 예외: ${String(scenario.exceptionId)}`}</small>
          </li>)}</ul>
          <ul className="sps-cbpr-list">{(data.revision.designModel.itemDecisions as Record<string, unknown>[]).map((item, index) => <li className="sps-cbpr-item" key={`${String(item.requirementId)}-${index}`}>
            <strong>{String(item.requirementId)} · {String(item.status)}</strong>
            <small>{String(item.reason)}</small><small className="sps-cbpr-mono">{(item.sourceIds as unknown[]).map(String).join(", ")}</small>
          </li>)}</ul>
          {(data.revision.designModel.acceptanceCriteria as Record<string, unknown>[]).map((item, index) => <blockquote className="sps-cbpr-quote" key={`${String(item.acId)}-${index}`}>
            <strong>{String(item.acId)} · {String(item.sourceId)}</strong>
            <div>{String(item.text)}</div>
            <small className="sps-cbpr-mono">원문 SHA-256 {String(item.sourceDigest)} · 인용 SHA-256 {String(item.textSha256)}</small>
          </blockquote>)}
        </section>}
        {existingApproval && <section className="sps-cbpr-section" aria-label="기존 사용자 확인">
          <h3>저장된 사용자 확인</h3>
          <div className="sps-cbpr-grid">
            <Item label="확인 revision" value={String(existingApproval.revisionId)} mono />
            <Item label="확인 시각" value={String(plain(existingApproval.user) ? existingApproval.user.approvedAt : "확인 불가")} />
          </div>
        </section>}
        {attempt === "submitted" && <p className="sps-cbpr-state" role="status">확인 action이 접수됐습니다. 최신 기록을 다시 읽어 결과를 확인하세요.</p>}
        {attempt === "changed" && <p className="sps-cbpr-state sps-cbpr-warning" role="status">제안 또는 확인 head가 바뀌었습니다. 자동 재시도하지 않았습니다.</p>}
        {attempt === "unknown" && <p className="sps-cbpr-state sps-cbpr-danger" role="alert">저장 결과를 확인할 수 없습니다. 기존 확인을 보존해 표시하며 재전송하지 않았습니다.</p>}
        <div className="sps-cbpr-actions">
          <button type="button" disabled={!canConfirm} onClick={() => void confirm()}>
            {busy ? "확인 중…" : "이 규칙 팩·모델 확인"}
          </button>
          {attempt !== "idle" && onRefresh && <button type="button" disabled={busy} onClick={() => void onRefresh()}>최신 기록 다시 읽기</button>}
          {!onConfirm && <span className="sps-cbpr-muted" role="status">사용자 확인 action이 연결되지 않았습니다.</span>}
        </div>
      </>}
  </section>;
}
