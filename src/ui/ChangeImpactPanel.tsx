import { useState, type ChangeEvent } from "react";
import { G5_DIMENSIONS, type G5Dimension, type G5DimensionResult } from "../domain/g5-change-impact.ts";

export type G5ChangeImpactRequest = Readonly<{
  projectId: string;
  oldBaselineRevisionId: string;
  newBaselineRevisionId: string;
  oldUiRevisionId: string;
  newUiRevisionId: string;
}>;

export type G5ChangeImpactReadDTO = Readonly<{
  projectId: string;
  dimensions: Readonly<Record<G5Dimension, G5DimensionResult>>;
  approvalCreated: false;
  executionAuthorized: false;
  productExecutionAuthorized: false;
  sourcePins: Readonly<{
    oldBaselineRevisionId: string;
    newBaselineRevisionId: string;
    oldUiRevisionId: string;
    newUiRevisionId: string;
    technology: Readonly<{ oldRevisionId: string; newRevisionId: string }> | null;
    workstreams: Readonly<{ oldRevisionId: string; newRevisionId: string }> | null;
    tasks: Readonly<{ ctoId: string; workstreamId: string; oldRevisionId: string; newRevisionId: string }> | null;
  }>;
  inventoryLimits: Readonly<Record<"technology" | "ctoWorkstreams" | "tasks" | "scheduleProductScope", string>>;
}>;

export type ChangeImpactPanelProps = Readonly<{
  projectId: string | null;
  onQueryImpact?: (request: G5ChangeImpactRequest) => Promise<G5ChangeImpactReadDTO>;
}>;

const DIMENSION_LABELS: Record<G5Dimension, string> = {
  requirements: "요구사항", ui: "UI", technology: "기술", graph: "Graph",
  ctoWorkstreams: "CTO Workstream", tasks: "Task", scheduleProductScope: "일정·상품 범위",
};

const STYLE = `
.sps-g5-impact{--g5-panel:#272727;--g5-border:#444;--g5-text:#ededed;--g5-muted:#b9b9b9;color:var(--g5-text);font:13px/1.55 -apple-system,BlinkMacSystemFont,Pretendard,"Noto Sans KR","Malgun Gothic",sans-serif;letter-spacing:0;min-width:0;margin-top:20px;container-type:inline-size;container-name:sps-g5-impact}
.sps-g5-impact *{box-sizing:border-box;letter-spacing:0}
.sps-g5-impact button,.sps-g5-impact input{font:inherit;color:inherit}
.sps-g5-impact button:focus-visible,.sps-g5-impact input:focus-visible{outline:2px solid #ededed;outline-offset:2px}
.sps-g5-note,.sps-g5-muted{color:var(--g5-muted);font-size:11px}
.sps-g5-note{margin:0 0 12px}
.sps-g5-query{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;max-width:760px}
.sps-g5-field{display:grid;gap:4px;min-width:0;color:var(--g5-muted);font-size:11px}
.sps-g5-field input{width:100%;min-width:0;min-height:36px;border:1px solid var(--g5-border);border-radius:5px;background:#181818;padding:6px 8px;color:var(--g5-text)}
.sps-g5-query button{grid-column:1/-1;justify-self:start;min-height:36px;border:1px solid #656565;border-radius:5px;background:#333;padding:6px 12px;cursor:pointer}
.sps-g5-query button:disabled{opacity:.55;cursor:not-allowed}
.sps-g5-status{margin:12px 0;border:1px solid var(--g5-border);border-radius:5px;background:#252525;padding:10px;color:var(--g5-muted)}
.sps-g5-alert{border-color:#805858;color:#efbcbc}
.sps-g5-summary{display:flex;flex-wrap:wrap;gap:6px 14px;margin:12px 0;color:var(--g5-muted);font-size:11px;overflow-wrap:anywhere}
.sps-g5-results{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,310px),1fr));gap:8px}
.sps-g5-dimension{min-width:0;border:1px solid var(--g5-border);border-radius:6px;background:var(--g5-panel);padding:10px}
.sps-g5-dimension h3{margin:0 0 6px;font-size:13px}
.sps-g5-revisions,.sps-g5-candidate{overflow-wrap:anywhere;word-break:break-word}
.sps-g5-revisions{color:var(--g5-muted);font-size:10px}
.sps-g5-state{margin:8px 0;color:var(--g5-muted)}
.sps-g5-candidate{margin:6px 0 0;border-top:1px solid var(--g5-border);padding-top:6px}
.sps-g5-provenance{color:var(--g5-muted);font-size:10px}
.sps-g5-sources{margin-top:12px;border-top:1px solid var(--g5-border);padding-top:8px}
.sps-g5-sources h3{font-size:12px}
.sps-g5-sources ul{margin:6px 0;padding-left:18px}
.sps-g5-sources li{margin:3px 0;overflow-wrap:anywhere;word-break:break-word;color:var(--g5-muted);font-size:10px}
@container sps-g5-impact (max-width:520px){.sps-g5-query{grid-template-columns:minmax(0,1fr)}.sps-g5-query button{grid-column:auto}.sps-g5-dimension{padding:8px}}
`;

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isImpactReadDTO(value: unknown): value is G5ChangeImpactReadDTO {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!isText(row.projectId) || row.approvalCreated !== false || row.executionAuthorized !== false
    || row.productExecutionAuthorized !== false || row.dimensions === null || typeof row.dimensions !== "object"
    || row.sourcePins === null || typeof row.sourcePins !== "object" || row.inventoryLimits === null || typeof row.inventoryLimits !== "object") return false;
  const dimensions = row.dimensions as Record<string, unknown>;
  if (!G5_DIMENSIONS.every(dimension => {
    const result = dimensions[dimension];
    if (result === null || typeof result !== "object") return false;
    const item = result as Record<string, unknown>;
    return ["CANDIDATES", "NO_CANDIDATE_OBSERVED", "UNKNOWN"].includes(String(item.status))
      && (item.oldRevisionId === null || isText(item.oldRevisionId))
      && (item.newRevisionId === null || isText(item.newRevisionId))
      && Array.isArray(item.candidates) && item.candidates.every(candidate => {
        if (candidate === null || typeof candidate !== "object") return false;
        const entry = candidate as Record<string, unknown>;
        return entry.dimension === dimension && isText(entry.recordId)
          && ["direct-revision-diff", "derived-reference"].includes(String(entry.basis))
          && Array.isArray(entry.via) && entry.via.every(isText);
      });
  })) return false;
  const pins = row.sourcePins as Record<string, unknown>;
  if (!["oldBaselineRevisionId", "newBaselineRevisionId", "oldUiRevisionId", "newUiRevisionId"].every(key => isText(pins[key]))) return false;
  const limits = row.inventoryLimits as Record<string, unknown>;
  return ["technology", "ctoWorkstreams", "tasks", "scheduleProductScope"].every(key => isText(limits[key]));
}

function statusLabel(status: G5DimensionResult["status"]): string {
  if (status === "CANDIDATES") return "후보 발견";
  if (status === "NO_CANDIDATE_OBSERVED") return "관찰 후보 없음";
  return "UNKNOWN · 자료 불완전";
}

export function ChangeImpactPanel({ projectId, onQueryImpact }: ChangeImpactPanelProps) {
  const [oldBaselineRevisionId, setOldBaselineRevisionId] = useState("");
  const [newBaselineRevisionId, setNewBaselineRevisionId] = useState("");
  const [oldUiRevisionId, setOldUiRevisionId] = useState("");
  const [newUiRevisionId, setNewUiRevisionId] = useState("");
  const [result, setResult] = useState<G5ChangeImpactReadDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [queried, setQueried] = useState(false);

  const ready = Boolean(projectId?.trim() && oldBaselineRevisionId.trim() && newBaselineRevisionId.trim()
    && oldUiRevisionId.trim() && newUiRevisionId.trim() && onQueryImpact && !loading);
  function edit(setter: (value: string) => void) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      setter(event.currentTarget.value);
      setResult(null);
      setError(false);
      setQueried(false);
    };
  }
  async function query() {
    if (!ready || !projectId || !onQueryImpact) return;
    setLoading(true); setError(false); setResult(null); setQueried(true);
    try {
      const response: unknown = await onQueryImpact({ projectId, oldBaselineRevisionId, newBaselineRevisionId, oldUiRevisionId, newUiRevisionId });
      if (!isImpactReadDTO(response) || response.projectId !== projectId
        || response.sourcePins.oldBaselineRevisionId !== oldBaselineRevisionId
        || response.sourcePins.newBaselineRevisionId !== newBaselineRevisionId
        || response.sourcePins.oldUiRevisionId !== oldUiRevisionId
        || response.sourcePins.newUiRevisionId !== newUiRevisionId) throw new TypeError("Unverified G5 comparison response.");
      setResult(response);
    } catch { setError(true); }
    finally { setLoading(false); }
  }

  return <section className="sps-g5-impact" aria-labelledby="sps-g5-title">
    <style>{STYLE}</style>
    <h2 id="sps-g5-title">변경 영향 비교</h2>
    <p className="sps-g5-note">정확한 이전·신규 Baseline 및 승인 UI Revision을 조회합니다. 후보는 검토 단서이며 승인, 실행, 전체 영향 목록 또는 무영향 증명이 아닙니다.</p>
    {!projectId?.trim() && <p className="sps-g5-status" role="status">현재 project 범위를 확인할 수 없어 비교가 UNKNOWN입니다.</p>}
    {!onQueryImpact && <p className="sps-g5-status" role="status">신뢰된 서버 조회 callback이 연결되지 않아 source 자료를 확인할 수 없습니다.</p>}
    <form className="sps-g5-query" onSubmit={event => { event.preventDefault(); void query(); }}>
      <label className="sps-g5-field">이전 Baseline Revision ID<input value={oldBaselineRevisionId} maxLength={160} disabled={loading}
        onChange={edit(setOldBaselineRevisionId)} autoComplete="off" /></label>
      <label className="sps-g5-field">신규 Baseline Revision ID<input value={newBaselineRevisionId} maxLength={160} disabled={loading}
        onChange={edit(setNewBaselineRevisionId)} autoComplete="off" /></label>
      <label className="sps-g5-field">이전 승인 UI Revision ID<input value={oldUiRevisionId} maxLength={160} disabled={loading}
        onChange={edit(setOldUiRevisionId)} autoComplete="off" /></label>
      <label className="sps-g5-field">신규 승인 UI Revision ID<input value={newUiRevisionId} maxLength={160} disabled={loading}
        onChange={edit(setNewUiRevisionId)} autoComplete="off" /></label>
      <button type="submit" disabled={!ready}>{loading ? "비교 조회 중…" : "영향 후보 조회"}</button>
    </form>
    {loading && <p className="sps-g5-status" role="status">정확한 게시 Revision source를 조회하고 있습니다.</p>}
    {error && <p className="sps-g5-status sps-g5-alert" role="alert">비교 자료를 확인하지 못했습니다. 결과를 추정하지 않았습니다. source를 확인한 뒤 다시 조회해 주세요.</p>}
    {queried && !loading && !error && !result && <p className="sps-g5-status" role="status">비교 결과가 UNKNOWN입니다.</p>}
    {result && <>
      <div className="sps-g5-summary" aria-label="비교 Revision">
        <span>Project {result.projectId}</span>
        <span>Baseline {result.sourcePins.oldBaselineRevisionId} → {result.sourcePins.newBaselineRevisionId}</span>
        <span>승인 UI {result.sourcePins.oldUiRevisionId} → {result.sourcePins.newUiRevisionId}</span>
      </div>
      <div className="sps-g5-results" aria-label="G5 일곱 영향 차원">
        {G5_DIMENSIONS.map(dimension => {
          const item = result.dimensions[dimension];
          return <section className="sps-g5-dimension" key={dimension} aria-label={DIMENSION_LABELS[dimension]}>
            <h3>{DIMENSION_LABELS[dimension]}</h3>
            <div className="sps-g5-revisions">{item.oldRevisionId ?? "이전 Revision 미확인"} → {item.newRevisionId ?? "신규 Revision 미확인"}</div>
            <p className="sps-g5-state" role="status">{statusLabel(item.status)}{item.status === "NO_CANDIDATE_OBSERVED" ? " · 관찰 범위에서 후보를 찾지 못했으나 무영향을 증명하지 않습니다." : ""}</p>
            {item.candidates.map(candidate => <div className="sps-g5-candidate" key={`${candidate.dimension}:${candidate.recordId}`}>
              <strong>{candidate.recordId}</strong>
              <div className="sps-g5-provenance">{candidate.basis === "direct-revision-diff" ? "직접 Revision 차이" : "참조 연결 후보"} · 근거 경로: {candidate.via.join(" → ")}</div>
            </div>)}
          </section>;
        })}
      </div>
      <section className="sps-g5-sources" aria-label="조회 source 및 범위 한계">
        <h3>조회 출처와 범위</h3>
        <ul>
          <li>Baseline: {result.sourcePins.oldBaselineRevisionId} → {result.sourcePins.newBaselineRevisionId}</li>
          <li>승인 UI: {result.sourcePins.oldUiRevisionId} → {result.sourcePins.newUiRevisionId}</li>
          {result.sourcePins.technology && <li>기술: {result.sourcePins.technology.oldRevisionId} → {result.sourcePins.technology.newRevisionId}</li>}
          {result.sourcePins.workstreams && <li>Workstream: {result.sourcePins.workstreams.oldRevisionId} → {result.sourcePins.workstreams.newRevisionId}</li>}
          {result.sourcePins.tasks && <li>Task: CTO {result.sourcePins.tasks.ctoId} · Workstream {result.sourcePins.tasks.workstreamId} · {result.sourcePins.tasks.oldRevisionId} → {result.sourcePins.tasks.newRevisionId}</li>}
          <li>기술 범위: {result.inventoryLimits.technology}</li>
          <li>CTO Workstream 범위: {result.inventoryLimits.ctoWorkstreams}</li>
          <li>Task 범위: {result.inventoryLimits.tasks}</li>
          <li>일정·상품 범위: {result.inventoryLimits.scheduleProductScope}</li>
        </ul>
        <p className="sps-g5-muted">비교 결과는 읽기 전용입니다. 승인이나 실행 권한을 만들지 않습니다.</p>
      </section>
    </>}
  </section>;
}
