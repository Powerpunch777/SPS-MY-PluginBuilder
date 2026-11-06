import { useState } from "react";
import type { FirstDesignReviewBundle } from "../spec-assurance/review-first-design.ts";

export type FirstDesignReviewApprovalInput = Readonly<{ proposalRevisionId: string; expectedHead: string }>;
export type FirstDesignReviewPanelView =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "empty" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "stale"; bundle: unknown; proposalRevisionId: string; expectedHead: string }>
  | Readonly<{ status: "ready"; bundle: unknown; proposalRevisionId: string; expectedHead: string }>;
export type FirstDesignReviewPanelProps = Readonly<{
  view: FirstDesignReviewPanelView;
  onApprove?: (input: FirstDesignReviewApprovalInput) => void | Promise<unknown>;
}>;

type ReadableBundle = Readonly<{
  bundle: FirstDesignReviewBundle;
  requirements: readonly Readonly<{ id: string; description: string; acceptanceCriteriaIds: readonly string[] }>[];
  pinsByRequirement: ReadonlyMap<string, readonly FirstDesignReviewBundle["sourcePins"][number][]>;
  issues: readonly string[];
}>;

const CSS = ".sps-fdr{color:var(--builder-text,#ededed);background:var(--builder-panel,#202020);border:1px solid var(--builder-border,#353535);border-radius:6px;padding:14px;min-width:0}" +
  ".sps-fdr *{box-sizing:border-box}.sps-fdr h2,.sps-fdr h3,.sps-fdr p{margin-top:0}.sps-fdr h2{margin-bottom:3px;font-size:16px}.sps-fdr h3{margin-bottom:8px;font-size:13px}" +
  ".sps-fdr-muted{color:var(--builder-muted,#a0a0a0)}.sps-fdr-state{margin:8px 0}.sps-fdr-section{border-top:1px solid var(--builder-border,#353535);margin-top:14px;padding-top:12px;min-width:0}" +
  ".sps-fdr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:8px}.sps-fdr-item{min-width:0;padding:9px;border:1px solid var(--builder-border,#353535);border-radius:5px}" +
  ".sps-fdr-item strong,.sps-fdr-item small{display:block}.sps-fdr-item small{margin-top:3px;color:var(--builder-muted,#a0a0a0);overflow-wrap:anywhere}" +
  ".sps-fdr-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;overflow-wrap:anywhere}.sps-fdr-list{display:grid;gap:8px;padding:0;list-style:none}" +
  ".sps-fdr-rule{border-left:2px solid var(--builder-border,#555);padding:2px 0 2px 10px;min-width:0}.sps-fdr-pre{margin:5px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--builder-muted,#a0a0a0)}" +
  ".sps-fdr-warning{color:var(--builder-warning,#d1b977)}.sps-fdr-danger{color:var(--builder-danger,#e38e8e)}.sps-fdr-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}" +
  ".sps-fdr button{min-height:36px;border:1px solid var(--builder-border,#555);border-radius:5px;padding:7px 12px;background:var(--builder-accent-soft,#2b2b2b);color:var(--builder-text,#ededed);font:inherit;cursor:pointer}" +
  ".sps-fdr button:disabled{opacity:.55;cursor:not-allowed}";

const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 4096;
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function predicate(value: unknown): boolean {
  return plain(value) && ["all", "any", "none"].every(key => value[key] === undefined
    || Array.isArray(value[key]) && (value[key] as unknown[]).every(text));
}
const shown = (value: unknown) => {
  try { return JSON.stringify(value, null, 2) ?? "값 없음"; }
  catch { return "구조를 표시할 수 없음"; }
};

function readBundle(value: unknown): ReadableBundle | null {
  if (!plain(value) || !["PROPOSED", "APPROVED"].includes(String(value.status)) || !text(value.revisionId)
    || !text(value.workspaceId) || !text(value.projectId) || value.priorBaseline !== null
    || !text(value.draftRevisionId) || !digest(value.draftDigest) || !plain(value.draft)
    || !Array.isArray(value.draft.sourceIds)
    || !plain(value.draft.specification) || !plain(value.pack) || !text(value.pack.packId) || !text(value.pack.version)
    || !plain(value.pack.identity) || !Array.isArray(value.pack.rules) || !Array.isArray(value.pack.transitions)
    || !Array.isArray(value.pack.exceptions) || !Array.isArray(value.pack.excludedCombinations)
    || !predicate(value.pack.applicability)
    || !Array.isArray(value.sourcePins) || !plain(value.author) || !text(value.author.agentId)
    || !text(value.author.sessionId) || !text(value.author.runId)
    || value.status === "APPROVED" && (!plain(value.approval) || !text(value.approval.userId)
      || !text(value.approval.approvedAt) || !text(value.approval.attestedBundleRevisionId)
      || value.approval.attestedBundleRevisionId === value.revisionId)
    || value.status === "PROPOSED" && value.approval !== undefined) return null;
  if (value.draft.projectId !== value.projectId || value.draft.revisionId !== value.draftRevisionId
    || value.pack.identity.workspaceId !== value.workspaceId || value.pack.identity.projectId !== value.projectId
    || value.pack.identity.specRevisionId !== value.draft.specification.revisionId
    || !digest(value.pack.identity.specDigest)) return null;

  if (!Array.isArray(value.draft.specification.requirements)) return null;
  const requirements: { id: string; description: string; acceptanceCriteriaIds: readonly string[] }[] = [];
  const requirementIds = new Set<string>();
  for (const item of value.draft.specification.requirements as unknown[]) {
    if (!plain(item) || !text(item.id) || !text(item.description) || !Array.isArray(item.acceptanceCriteriaIds)
      || !item.acceptanceCriteriaIds.every(text) || requirementIds.has(item.id)) return null;
    requirementIds.add(item.id);
    requirements.push(Object.freeze({ id: item.id, description: item.description,
      acceptanceCriteriaIds: Object.freeze([...item.acceptanceCriteriaIds]) }));
  }
  if (!value.draft.sourceIds.every(text)) return null;

  const issues: string[] = [];
  const pinsByRequirement = new Map<string, FirstDesignReviewBundle["sourcePins"][number][]>();
  const pinnedSourceIds = new Set<string>();
  for (const item of value.sourcePins) {
    if (!plain(item) || !text(item.requirementId) || !requirementIds.has(item.requirementId)
      || item.acId !== null && !text(item.acId) || !text(item.sourceId) || !digest(item.sourceDigest)) {
      issues.push("핀 형식 또는 대상 범위를 확인할 수 없습니다.");
      continue;
    }
    const requirement = requirements.find(candidate => candidate.id === item.requirementId)!;
    if (item.acId !== null && !requirement.acceptanceCriteriaIds.includes(item.acId as string)) {
      issues.push(String(item.requirementId) + ": 해당 요구사항에 없는 AC 핀입니다.");
      continue;
    }
    if (!value.draft.sourceIds.includes(item.sourceId)) {
      issues.push(String(item.requirementId) + ": Draft 원문 목록에 없는 source ID입니다.");
      continue;
    }
    const pin = Object.freeze({ requirementId: item.requirementId as string, acId: item.acId as string | null,
      sourceId: item.sourceId as string, sourceDigest: item.sourceDigest as string });
    const existing = pinsByRequirement.get(pin.requirementId) ?? [];
    existing.push(pin);
    pinsByRequirement.set(pin.requirementId, existing);
    pinnedSourceIds.add(pin.sourceId);
  }
  for (const requirement of requirements) {
    if (!pinsByRequirement.has(requirement.id)) issues.push(requirement.id + ": 연결된 원문 핀이 없습니다.");
  }
  for (const sourceId of value.draft.sourceIds) {
    if (!pinnedSourceIds.has(sourceId)) issues.push(sourceId + ": 요구사항 핀에 연결되지 않은 원문입니다.");
  }
  const scope = new Set(requirements.map(item => item.id));
  const linkedRequirements = new Set<string>();
  for (const rule of value.pack.rules) {
    if (!plain(rule) || !text(rule.id) || !Array.isArray(rule.requirementIds) || !rule.requirementIds.every(text)) return null;
    if (!predicate(rule.appliesWhen) || typeof rule.requiresCheck !== "boolean"
      || rule.modelCases !== undefined && (!Array.isArray(rule.modelCases) || !rule.modelCases.every(item => plain(item)
        && predicate(item.when) && text(item.state) && text(item.event) && Array.isArray(item.allowedNextStates)
        && item.allowedNextStates.every(text)))) return null;
    if (rule.requirementIds.length === 0) issues.push(String(rule.id) + ": 연결된 요구사항이 없습니다.");
    for (const id of rule.requirementIds) {
      if (!scope.has(id)) issues.push(String(rule.id) + ": Draft 범위 밖 requirement ID " + id + "가 있습니다.");
      else linkedRequirements.add(id);
    }
  }
  for (const requirement of requirements) if (!linkedRequirements.has(requirement.id)) {
    issues.push(requirement.id + ": 연결된 pack 규칙이 없습니다.");
  }
  if (value.pack.rules.length === 0) issues.push("제안된 rule pack에 규칙이 없습니다.");
  if (!value.pack.transitions.every(item => plain(item) && text(item.from) && text(item.event) && text(item.to))
    || !value.pack.exceptions.every(item => plain(item) && text(item.id) && text(item.from) && text(item.event) && text(item.to))
    || !value.pack.excludedCombinations.every(item => plain(item) && text(item.from) && text(item.event)
      && text(item.to) && text(item.reason))) return null;
  if (value.designModel !== undefined) {
    const model = value.designModel;
    const decisionStatuses = new Set(["RESOLVED", "DELEGATED", "UNDECIDED", "NOT_APPLICABLE", "NOT_CHECKED", "INCONCLUSIVE"]);
    if (!plain(model) || model.kind !== "design-model-v1" || !Array.isArray(model.facts) || !model.facts.every(text)
      || !plain(model.rulesManifest) || !text(model.rulesManifest.rulesVersion) || !digest(model.rulesManifest.digest)
      || !Array.isArray(model.rulesManifest.rules) || !Array.isArray(model.rulesManifest.targets)
      || !plain(model.rulesManifest.identity) || model.rulesManifest.identity.workspaceId !== value.workspaceId
      || model.rulesManifest.identity.projectId !== value.projectId
      || model.rulesManifest.identity.specRevisionId !== value.pack.identity.specRevisionId
      || model.rulesManifest.identity.specDigest !== value.pack.identity.specDigest
      || !Array.isArray(model.scenarios) || !Array.isArray(model.itemDecisions) || !Array.isArray(model.acceptanceCriteria)
      || !model.scenarios.every(item => plain(item) && text(item.id) && text(item.state) && text(item.event)
        && text(item.nextState) && (item.exceptionId === null || text(item.exceptionId)))
      || !model.itemDecisions.every(item => plain(item) && scope.has(String(item.requirementId)) && decisionStatuses.has(String(item.status))
        && text(item.reason) && Array.isArray(item.sourceIds) && item.sourceIds.every(sourceId => text(sourceId)
          && pinsByRequirement.get(String(item.requirementId))?.some(pin => pin.sourceId === sourceId)))
      || new Set(model.itemDecisions.map(item => plain(item) ? item.requirementId : null)).size !== requirements.length
      || !model.acceptanceCriteria.every(item => plain(item) && text(item.acId) && text(item.text)
        && text(item.sourceId) && digest(item.textSha256) && digest(item.sourceDigest)
        && pinsByRequirement.get(String(item.requirementId))?.some(pin => pin.acId === item.acId && pin.sourceId === item.sourceId
          && pin.sourceDigest === item.sourceDigest))) return null;
  }
  return { bundle: value as unknown as FirstDesignReviewBundle,
    requirements: Object.freeze(requirements),
    pinsByRequirement, issues: Object.freeze(issues) };
}

function DataItem({ label, value, mono = false }: { label: string; value: unknown; mono?: boolean }) {
  return <div className="sps-fdr-item"><strong>{label}</strong><small className={mono ? "sps-fdr-mono" : undefined}>{String(value)}</small></div>;
}

export function FirstDesignReviewPanel({ view, onApprove }: FirstDesignReviewPanelProps) {
  const [busy, setBusy] = useState(false);
  const [actionState, setActionState] = useState<"idle" | "error" | "stale" | "submitted">("idle");
  const snapshot = view.status === "ready" || view.status === "stale" ? readBundle(view.bundle) : null;
  const current = view.status === "ready" && snapshot !== null
    && view.proposalRevisionId === snapshot.bundle.revisionId && text(view.expectedHead);
  const canApprove = Boolean(current && snapshot?.issues.length === 0 && snapshot.bundle.status === "PROPOSED"
    && onApprove && !busy && actionState !== "stale");

  async function approve() {
    if (!canApprove || view.status !== "ready" || !snapshot || !onApprove) return;
    setBusy(true);
    setActionState("idle");
    try {
      const result = await onApprove(Object.freeze({ proposalRevisionId: view.proposalRevisionId, expectedHead: view.expectedHead }));
      setActionState(plain(result) && result.status === "conflict" ? "stale" : "submitted");
    } catch { setActionState("error"); }
    finally { setBusy(false); }
  }

  const bundle = snapshot?.bundle;
  return <section className="sps-fdr" aria-labelledby="sps-fdr-title">
    <style>{CSS}</style>
    <header><h2 id="sps-fdr-title">최초 설계 검토</h2>
      <p className="sps-fdr-muted">설계 초안, 요구사항별 원문 핀, 제안 규칙 버전을 확인합니다. 이 화면에서 규칙을 작성하거나 수정하지 않습니다.</p>
    </header>
    {view.status === "loading" ? <p className="sps-fdr-state" role="status">최초 설계 검토 자료를 불러오는 중입니다.</p>
      : view.status === "empty" ? <p className="sps-fdr-state" role="status">검토할 최초 설계 제안이 없습니다.</p>
      : view.status === "error" ? <p className="sps-fdr-state" role="alert">최초 설계 검토 자료를 확인하지 못했습니다. 새로고침해 주세요.</p>
      : !snapshot ? <p className="sps-fdr-state" role="alert">제안 구조가 올바르지 않아 검토와 승인을 차단했습니다.</p>
      : <>
        {view.status === "stale" && <p className="sps-fdr-state sps-fdr-warning" role="status">이 제안은 현재 head와 일치하지 않습니다. 내용은 조회할 수 있지만 승인은 비활성화됩니다.</p>}
        {view.status === "ready" && !current && <p className="sps-fdr-state sps-fdr-warning" role="status">제안 revision 또는 예상 head가 현재 자료와 맞지 않아 승인을 차단했습니다.</p>}
        <section className="sps-fdr-section" aria-label="정확한 설계 초안">
          <h3>설계 초안 원본</h3>
          <div className="sps-fdr-grid">
            <DataItem label="DesignDraft revision" value={bundle!.draftRevisionId} mono />
            <DataItem label="Draft digest (SHA-256)" value={bundle!.draftDigest} mono />
            <DataItem label="Workspace / Project" value={bundle!.workspaceId + " / " + bundle!.projectId} mono />
            <DataItem label="제안 Main run" value={bundle!.author.agentId + " / " + bundle!.author.sessionId + " / " + bundle!.author.runId} mono />
          </div>
          <p><strong>요구사항</strong></p>
          <ul className="sps-fdr-list">{snapshot.requirements.map(requirement => <li className="sps-fdr-item" key={requirement.id}>
            <strong>{requirement.id}: {requirement.description}</strong>
            <small>AC: {requirement.acceptanceCriteriaIds.length ? requirement.acceptanceCriteriaIds.join(", ") : "등록된 AC 없음"}</small>
            {snapshot.pinsByRequirement.get(requirement.id)?.map((pin, index) => <small className="sps-fdr-mono" key={pin.sourceId + "-" + String(pin.acId) + "-" + index}>
              원문 핀 · {pin.acId ? "AC " + pin.acId : "요구사항"} · {pin.sourceId} · SHA-256 {pin.sourceDigest}
            </small>) ?? <small className="sps-fdr-warning">원문 연결 미확인</small>}
          </li>)}</ul>
          <details className="sps-fdr-section"><summary>DesignDraft 전체 내용</summary>
            <pre className="sps-fdr-pre">{shown(bundle!.draft)}</pre>
          </details>
        </section>
        <section className="sps-fdr-section" aria-label="제안 규칙 묶음">
          <h3>제안된 rule pack (읽기 전용)</h3>
          <div className="sps-fdr-grid">
            <DataItem label="Pack / version" value={bundle!.pack.packId + " @ " + bundle!.pack.version} />
            <DataItem label="Specification scope" value={bundle!.pack.identity.specRevisionId + " · " + bundle!.pack.identity.specDigest} mono />
          </div>
          <p><strong>적용 조건</strong><pre className="sps-fdr-pre">{shown(bundle!.pack.applicability)}</pre></p>
          <h3>규칙 {bundle!.pack.rules.length}개</h3>
          {bundle!.pack.rules.length === 0 ? <p className="sps-fdr-warning">규칙 없음 · 빈 범위를 완전한 것으로 표시하지 않습니다.</p>
            : <ul className="sps-fdr-list">{bundle!.pack.rules.map(rule => <li className="sps-fdr-rule" key={rule.id}>
              <strong>{rule.id}</strong><small>요구사항 연결: {rule.requirementIds.length ? rule.requirementIds.join(", ") : "연결 없음"}</small>
              <small>적용 조건</small><pre className="sps-fdr-pre">{shown(rule.appliesWhen)}</pre>
              <small>필수 검사: {rule.requiresCheck ? "필요" : "불필요"}</small>
              <small>모델 사례: {rule.modelCases?.length ?? 0}개</small>
              {rule.modelCases?.map((item, index) => <pre className="sps-fdr-pre" key={rule.id + "-" + index}>{shown(item)}</pre>)}
            </li>)}</ul>}
          <div className="sps-fdr-grid">
            <DataItem label="상태 전이" value={bundle!.pack.transitions.length} />
            <DataItem label="예외" value={bundle!.pack.exceptions.length} />
            <DataItem label="제외 조합" value={bundle!.pack.excludedCombinations.length} />
          </div>
          <details className="sps-fdr-section"><summary>전이·예외·제외 조합 내용 보기</summary>
            <pre className="sps-fdr-pre">{shown({ transitions: bundle!.pack.transitions, exceptions: bundle!.pack.exceptions,
              excludedCombinations: bundle!.pack.excludedCombinations })}</pre>
          </details>
          {bundle!.designModel && <section className="sps-fdr-section" aria-label="명세 모델 검사 입력">
            <h3>명세 모델 검사 입력</h3>
            <p className="sps-fdr-muted">이 자료의 검사는 설계 모델의 정합성을 확인하며 실제 코드 실행이나 QA 합격을 뜻하지 않습니다.</p>
            <div className="sps-fdr-grid">
              <DataItem label="Coverage 규칙 버전" value={bundle!.designModel.rulesManifest.rulesVersion} />
              <DataItem label="명세 조건값" value={bundle!.designModel.facts.join(", ") || "없음"} />
              <DataItem label="유한 시나리오" value={bundle!.designModel.scenarios.length} />
            </div>
            <ul className="sps-fdr-list">{bundle!.designModel.itemDecisions.map(item => <li className="sps-fdr-item" key={item.requirementId}>
              <strong>{item.requirementId} · {item.status}</strong><small>{item.reason}</small>
              <small className="sps-fdr-mono">{item.sourceIds.join(", ")}</small>
            </li>)}</ul>
            {bundle!.designModel.acceptanceCriteria.map(item => <blockquote className="sps-fdr-rule" key={item.requirementId + "/" + item.acId + "/" + item.sourceId}>
              <strong>{item.acId}</strong><p>{item.text}</p><small className="sps-fdr-mono">{item.sourceId} · {item.sourceDigest}</small>
            </blockquote>)}
            <details><summary>Coverage·시나리오 전체 내용</summary><pre className="sps-fdr-pre">{shown(bundle!.designModel)}</pre></details>
          </section>}
          {snapshot.issues.length > 0 && <div className="sps-fdr-section" role="status">
            <h3 className="sps-fdr-warning">미확인 또는 연결 누락</h3>
            <ul>{snapshot.issues.map((issue, index) => <li key={index + "-" + issue}>{issue}</li>)}</ul>
          </div>}
        </section>
        <section className="sps-fdr-section" aria-label="사용자 확인 및 승인">
          <h3>사용자 확인</h3>
          <p className="sps-fdr-muted">승인은 표시된 Draft, 원문 핀, pack/version 그대로에만 적용됩니다. 규칙 작성·QA 합격·Baseline 발행을 뜻하지 않습니다.</p>
          {bundle!.status === "APPROVED" && <p role="status">이 제안에는 사용자 승인 기록이 있습니다.</p>}
          {actionState === "stale" && <p className="sps-fdr-warning" role="status">head가 바뀌었습니다. 최신 제안을 다시 불러오세요.</p>}
          {actionState === "error" && <p className="sps-fdr-danger" role="alert">승인 요청 결과를 확인하지 못했습니다. 새로고침 후 상태를 확인하세요.</p>}
          {actionState === "submitted" && <p role="status">승인 callback이 반환됐습니다. 최신 기록을 다시 불러와 확인하세요.</p>}
          {snapshot.issues.length > 0 && <p className="sps-fdr-warning" role="status">미확인 범위가 있어 승인을 차단했습니다.</p>}
          <div className="sps-fdr-actions"><button type="button" disabled={!canApprove} onClick={() => void approve()}>
            {busy ? "처리 중…" : "정확한 제안 승인"}
          </button></div>
          {!onApprove && bundle!.status === "PROPOSED" && <small className="sps-fdr-muted">승인 action이 연결되지 않아 비활성 상태입니다.</small>}
        </section>
      </>}
  </section>;
}
