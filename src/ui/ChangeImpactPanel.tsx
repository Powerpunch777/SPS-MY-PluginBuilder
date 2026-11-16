import { useEffect, useRef, useState } from "react";
import { G5_DIMENSIONS, type G5Dimension, type G5DimensionResult } from "../domain/g5-change-impact.ts";
import type { G5ComparisonPairsReadDTO } from "../g5-comparison-pairs.ts";

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
    baselines: readonly [
      Readonly<{ revisionId: string; sequence: number; specRevisionId: string; graphRevisionId: string }>,
      Readonly<{ revisionId: string; sequence: number; specRevisionId: string; graphRevisionId: string }>,
    ];
    formalUi: readonly [
      Readonly<{ revisionId: string; proposalRevisionId: string; approvalRevisionId: string; contractRevisionId: string; htmlSha256: string }>,
      Readonly<{ revisionId: string; proposalRevisionId: string; approvalRevisionId: string; contractRevisionId: string; htmlSha256: string }>,
    ];
    technology: Readonly<{ oldRevisionId: string; newRevisionId: string }> | null;
    workstreams: Readonly<{ oldRevisionId: string; newRevisionId: string }> | null;
    tasks: Readonly<{ ctoId: string; workstreamId: string; oldRevisionId: string; newRevisionId: string }> | null;
  }>;
  inventoryLimits: Readonly<Record<"technology" | "ctoWorkstreams" | "tasks" | "scheduleProductScope", string>>;
}>;

export type ChangeImpactPanelProps = Readonly<{
  projectId: string | null;
  onReadComparisonPairs?: (request: { projectId: string }) => Promise<G5ComparisonPairsReadDTO>;
  onQueryImpact?: (request: G5ChangeImpactRequest) => Promise<G5ChangeImpactReadDTO>;
}>;

const DIMENSION_LABELS: Record<G5Dimension, string> = {
  requirements: "요구사항", ui: "UI", technology: "기술", graph: "Graph",
  ctoWorkstreams: "CTO Workstream", tasks: "Task", scheduleProductScope: "일정·상품 범위",
};

const STYLE = `
.sps-g5-impact{--g5-panel:#272727;--g5-border:#444;--g5-text:#ededed;--g5-muted:#b9b9b9;color:var(--g5-text);font:13px/1.55 -apple-system,BlinkMacSystemFont,Pretendard,"Noto Sans KR","Malgun Gothic",sans-serif;letter-spacing:0;min-width:0;margin-top:20px;container-type:inline-size;container-name:sps-g5-impact}
.sps-g5-impact *{box-sizing:border-box;letter-spacing:0}
.sps-g5-impact button,.sps-g5-impact select{font:inherit;color:inherit}
.sps-g5-impact button:focus-visible,.sps-g5-impact select:focus-visible{outline:2px solid #ededed;outline-offset:2px}
.sps-g5-note,.sps-g5-muted{color:var(--g5-muted);font-size:11px}
.sps-g5-note{margin:0 0 12px}
.sps-g5-query{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;max-width:760px}
.sps-g5-field{display:grid;gap:4px;min-width:0;color:var(--g5-muted);font-size:11px}
.sps-g5-field select{width:100%;min-width:0;min-height:36px;border:1px solid var(--g5-border);border-radius:5px;background:#181818;padding:6px 8px;color:var(--g5-text)}
.sps-g5-query button{grid-column:1/-1;justify-self:start;min-height:36px;border:1px solid #656565;border-radius:5px;background:#333;padding:6px 12px;cursor:pointer}
.sps-g5-query button:disabled,.sps-g5-field select:disabled{opacity:.55;cursor:not-allowed}
.sps-g5-pair-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;max-width:760px;margin:10px 0}
.sps-g5-pair-toolbar button{min-height:34px;border:1px solid #656565;border-radius:5px;background:#333;padding:5px 10px;cursor:pointer}
.sps-g5-pair-toolbar button:disabled{opacity:.55;cursor:not-allowed}
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
@container sps-g5-impact (max-width:520px){.sps-g5-query{grid-template-columns:minmax(0,1fr)}.sps-g5-query button{grid-column:auto}.sps-g5-dimension{padding:8px}.sps-g5-pair-toolbar{align-items:stretch;flex-direction:column}}
`;

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isImpactReadDTO(value: unknown, request: G5ChangeImpactRequest): value is G5ChangeImpactReadDTO {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.projectId !== request.projectId || row.approvalCreated !== false || row.executionAuthorized !== false
    || row.productExecutionAuthorized !== false || row.dimensions === null || typeof row.dimensions !== "object"
    || row.sourcePins === null || typeof row.sourcePins !== "object" || row.inventoryLimits === null || typeof row.inventoryLimits !== "object") return false;
  const pins = row.sourcePins as Record<string, unknown>;
  if (pins.oldBaselineRevisionId !== request.oldBaselineRevisionId || pins.newBaselineRevisionId !== request.newBaselineRevisionId
    || pins.oldUiRevisionId !== request.oldUiRevisionId || pins.newUiRevisionId !== request.newUiRevisionId
    || !Array.isArray(pins.baselines) || pins.baselines.length !== 2
    || !Array.isArray(pins.formalUi) || pins.formalUi.length !== 2) return false;
  const [oldBaseline, newBaseline] = pins.baselines as unknown[];
  const [oldFormalUi, newFormalUi] = pins.formalUi as unknown[];
  const baselinePins = [oldBaseline, newBaseline] as Record<string, unknown>[];
  const formalUiPins = [oldFormalUi, newFormalUi] as Record<string, unknown>[];
  const baselines = [request.oldBaselineRevisionId, request.newBaselineRevisionId];
  const uiRevisions = [request.oldUiRevisionId, request.newUiRevisionId];
  if (baselinePins.some((pin, index) => pin === null || typeof pin !== "object"
    || pin.revisionId !== baselines[index] || !Number.isSafeInteger(pin.sequence) || (pin.sequence as number) < 1
    || !isText(pin.specRevisionId) || !isText(pin.graphRevisionId))
    || formalUiPins.some((pin, index) => pin === null || typeof pin !== "object"
      || pin.revisionId !== uiRevisions[index] || !isText(pin.proposalRevisionId) || !isText(pin.approvalRevisionId)
      || !isText(pin.contractRevisionId) || typeof pin.htmlSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(pin.htmlSha256))) return false;

  const optionalPair = (value: unknown): value is Readonly<{ oldRevisionId: string; newRevisionId: string }> | null =>
    value === null || (value !== null && typeof value === "object" && !Array.isArray(value)
      && isText((value as Record<string, unknown>).oldRevisionId) && isText((value as Record<string, unknown>).newRevisionId));
  if (!optionalPair(pins.technology) || !optionalPair(pins.workstreams)) return false;
  const taskPins = pins.tasks;
  if (!(taskPins === null || (taskPins !== null && typeof taskPins === "object" && !Array.isArray(taskPins)
    && isText((taskPins as Record<string, unknown>).ctoId) && isText((taskPins as Record<string, unknown>).workstreamId)
    && isText((taskPins as Record<string, unknown>).oldRevisionId) && isText((taskPins as Record<string, unknown>).newRevisionId)))) return false;

  const dimensions = row.dimensions as Record<string, unknown>;
  if (!G5_DIMENSIONS.every(dimension => {
    const result = dimensions[dimension];
    if (result === null || typeof result !== "object") return false;
    const item = result as Record<string, unknown>;
    if (!(item.oldRevisionId === null || isText(item.oldRevisionId))
      || !(item.newRevisionId === null || isText(item.newRevisionId)) || !Array.isArray(item.candidates)) return false;
    if (item.status === "CANDIDATES" && item.candidates.length === 0) return false;
    if (item.status === "NO_CANDIDATE_OBSERVED" && (item.candidates.length !== 0 || !item.oldRevisionId || !item.newRevisionId)) return false;
    if (!["CANDIDATES", "NO_CANDIDATE_OBSERVED", "UNKNOWN"].includes(String(item.status))) return false;
    if (!item.candidates.every(candidate => {
        if (candidate === null || typeof candidate !== "object") return false;
        const entry = candidate as Record<string, unknown>;
        return entry.dimension === dimension && isText(entry.recordId)
          && ["direct-revision-diff", "derived-reference"].includes(String(entry.basis))
          && Array.isArray(entry.via) && entry.via.every(isText);
      })) return false;
    let expected: readonly [string, string] | null = null;
    if (dimension === "requirements") expected = [baselinePins[0]!.specRevisionId as string, baselinePins[1]!.specRevisionId as string];
    else if (dimension === "graph") expected = [baselinePins[0]!.graphRevisionId as string, baselinePins[1]!.graphRevisionId as string];
    else if (dimension === "ui") expected = [formalUiPins[0]!.revisionId as string, formalUiPins[1]!.revisionId as string];
    else if (dimension === "technology" && pins.technology !== null) {
      const pair = pins.technology as Record<string, string>;
      expected = [pair.oldRevisionId, pair.newRevisionId];
    } else if (dimension === "ctoWorkstreams" && pins.workstreams !== null) {
      const pair = pins.workstreams as Record<string, string>;
      expected = [pair.oldRevisionId, pair.newRevisionId];
    } else if (dimension === "tasks" && taskPins !== null) {
      const pair = taskPins as Record<string, string>;
      expected = [pair.oldRevisionId, pair.newRevisionId];
    }
    return expected ? item.oldRevisionId === expected[0] && item.newRevisionId === expected[1]
      : item.oldRevisionId === null && item.newRevisionId === null && item.status === "UNKNOWN" && item.candidates.length === 0;
  })) return false;
  const limits = row.inventoryLimits as Record<string, unknown>;
  return ["technology", "ctoWorkstreams", "tasks", "scheduleProductScope"].every(key => isText(limits[key]));
}

function isComparisonPairsDTO(value: unknown, projectId: string): value is G5ComparisonPairsReadDTO {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.projectId !== projectId || !Array.isArray(row.selectableBaselines)
    || !Array.isArray(row.comparisonPairs) || row.coverage === null || typeof row.coverage !== "object") return false;
  const coverage = row.coverage as Record<string, unknown>;
  if (typeof coverage.limit !== "number" || !Number.isSafeInteger(coverage.limit) || coverage.limit < 1 || coverage.limit > 50
    || typeof coverage.baselineHasMore !== "boolean" || typeof coverage.formalUiHasMore !== "boolean"
    || typeof coverage.complete !== "boolean" || coverage.currentPairInferred !== false || coverage.writesPerformed !== false
    || coverage.complete !== (!coverage.baselineHasMore && !coverage.formalUiHasMore)
    || !isText(coverage.scope) || coverage.excluded === null || typeof coverage.excluded !== "object"
    || Array.isArray(coverage.excluded) || row.selectableBaselines.length > coverage.limit
    || !Object.values(coverage.excluded).every(count => Number.isSafeInteger(count) && (count as number) >= 0)) return false;
  const limit = coverage.limit;
  const seenBaselines = new Set<string>(), seenSequences = new Set<number>(), seenUi = new Set<string>();
  const seenUiSequences = new Set<number>();
  const baselines = new Map<string, { sequence: number; uiIds: string[] }>();
  if (!row.selectableBaselines.every(baseline => {
    if (baseline === null || typeof baseline !== "object" || Array.isArray(baseline)) return false;
    const item = baseline as Record<string, unknown>;
    if (!(isText(item.baselineRevisionId) && Number.isSafeInteger(item.sequence) && (item.sequence as number) > 0
      && isText(item.sourceSpecRevisionId) && typeof item.digest === "string" && /^[a-f0-9]{64}$/u.test(item.digest)
      && Array.isArray(item.approvedFormalUi) && item.approvedFormalUi.length <= limit)) return false;
    if (seenBaselines.has(item.baselineRevisionId) || seenSequences.has(item.sequence as number)) return false;
    seenBaselines.add(item.baselineRevisionId); seenSequences.add(item.sequence as number);
    const uiIds: string[] = [];
    const valid = item.approvedFormalUi.every(formal => {
        if (formal === null || typeof formal !== "object" || Array.isArray(formal)) return false;
        const ui = formal as Record<string, unknown>;
        if (!(ui.baselineRevisionId === item.baselineRevisionId && isText(ui.formalUiRevisionId)
          && Number.isSafeInteger(ui.formalUiSequence) && (ui.formalUiSequence as number) > 0
          && isText(ui.proposalRevisionId) && isText(ui.approvalRevisionId) && isText(ui.contractRevisionId)
          && typeof ui.formalUiDigest === "string" && /^[a-f0-9]{64}$/u.test(ui.formalUiDigest)
          && typeof ui.approvalDigest === "string" && /^[a-f0-9]{64}$/u.test(ui.approvalDigest)
          && typeof ui.htmlSha256 === "string" && /^[a-f0-9]{64}$/u.test(ui.htmlSha256)
          && Array.isArray(ui.approvedInteractionIds) && ui.approvedInteractionIds.every(isText))) return false;
        if (seenUi.has(ui.formalUiRevisionId) || seenUiSequences.has(ui.formalUiSequence as number)) return false;
        seenUi.add(ui.formalUiRevisionId); uiIds.push(ui.formalUiRevisionId);
        seenUiSequences.add(ui.formalUiSequence as number);
        return true;
      });
    if (valid) baselines.set(item.baselineRevisionId, { sequence: item.sequence as number, uiIds });
    return valid;
  })) return false;
  const seenPairs = new Set<string>();
  const sameIds = (value: unknown, expected: string[]) => Array.isArray(value) && value.length > 0
    && value.length === expected.length && new Set(value).size === value.length
    && value.every(id => typeof id === "string" && expected.includes(id));
  return row.comparisonPairs.length <= 1225 && row.comparisonPairs.every(pair => {
    if (pair === null || typeof pair !== "object" || Array.isArray(pair)) return false;
    const item = pair as Record<string, unknown>;
    if (!isText(item.oldBaselineRevisionId) || !isText(item.newBaselineRevisionId)) return false;
    const before = baselines.get(item.oldBaselineRevisionId), after = baselines.get(item.newBaselineRevisionId);
    const pairKey = JSON.stringify([item.oldBaselineRevisionId, item.newBaselineRevisionId]);
    if (!before || !after || before.sequence >= after.sequence || item.oldSequence !== before.sequence
      || item.newSequence !== after.sequence || item.selected !== false || !isText(item.selectionRule)
      || !sameIds(item.oldFormalUiRevisionIds, before.uiIds) || !sameIds(item.newFormalUiRevisionIds, after.uiIds)
      || seenPairs.has(pairKey)) return false;
    seenPairs.add(pairKey);
    return true;
  });
}

function statusLabel(status: G5DimensionResult["status"]): string {
  if (status === "CANDIDATES") return "후보 발견";
  if (status === "NO_CANDIDATE_OBSERVED") return "관찰 후보 없음";
  return "UNKNOWN · 자료 불완전";
}

export function ChangeImpactPanel({ projectId, onReadComparisonPairs, onQueryImpact }: ChangeImpactPanelProps) {
  const [pairs, setPairs] = useState<G5ComparisonPairsReadDTO | null>(null);
  const [oldBaselineRevisionId, setOldBaselineRevisionId] = useState("");
  const [newBaselineRevisionId, setNewBaselineRevisionId] = useState("");
  const [oldUiRevisionId, setOldUiRevisionId] = useState("");
  const [newUiRevisionId, setNewUiRevisionId] = useState("");
  const [pairsLoading, setPairsLoading] = useState(false);
  const [pairsError, setPairsError] = useState(false);
  const [result, setResult] = useState<G5ChangeImpactReadDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [queried, setQueried] = useState(false);
  const pairsGeneration = useRef(0);
  const impactGeneration = useRef(0);
  const readPairs = useRef(onReadComparisonPairs);
  readPairs.current = onReadComparisonPairs;
  const hasPairReader = Boolean(onReadComparisonPairs);

  async function loadPairs() {
    const reader = readPairs.current;
    if (!projectId || !reader) return;
    const generation = ++pairsGeneration.current;
    setPairsLoading(true); setPairsError(false); setPairs(null);
    setOldBaselineRevisionId(""); setNewBaselineRevisionId(""); setOldUiRevisionId(""); setNewUiRevisionId("");
    setResult(null); setError(false); setQueried(false); setLoading(false); ++impactGeneration.current;
    try {
      const response: unknown = await reader({ projectId });
      if (generation !== pairsGeneration.current) return;
      if (!isComparisonPairsDTO(response, projectId)) throw new TypeError("Unverified G5 comparison pair response.");
      setPairs(response);
    } catch {
      if (generation === pairsGeneration.current) setPairsError(true);
    } finally {
      if (generation === pairsGeneration.current) setPairsLoading(false);
    }
  }

  useEffect(() => {
    ++pairsGeneration.current;
    ++impactGeneration.current;
    setPairs(null); setPairsError(false); setPairsLoading(false);
    setOldBaselineRevisionId(""); setNewBaselineRevisionId(""); setOldUiRevisionId(""); setNewUiRevisionId("");
    setResult(null); setError(false); setQueried(false); setLoading(false);
    if (projectId && hasPairReader) void loadPairs();
    return () => { ++pairsGeneration.current; ++impactGeneration.current; };
  // Host hooks may return a new callback on every parent render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, hasPairReader]);

  const baselineOptions = pairs?.selectableBaselines ?? [];
  const oldBaseline = baselineOptions.find(item => item.baselineRevisionId === oldBaselineRevisionId);
  const newBaseline = baselineOptions.find(item => item.baselineRevisionId === newBaselineRevisionId);
  const orderedPair = Boolean(oldBaseline && newBaseline && oldBaseline.sequence < newBaseline.sequence);

  const ready = Boolean(projectId?.trim() && orderedPair && oldUiRevisionId && newUiRevisionId && onQueryImpact && !loading);
  function clearResult() {
    ++impactGeneration.current;
    setResult(null); setError(false); setQueried(false); setLoading(false);
  }
  function selectOldBaseline(value: string) {
    setOldBaselineRevisionId(value); setOldUiRevisionId(""); clearResult();
  }
  function selectNewBaseline(value: string) {
    setNewBaselineRevisionId(value); setNewUiRevisionId(""); clearResult();
  }
  function selectOldUi(value: string) { setOldUiRevisionId(value); clearResult(); }
  function selectNewUi(value: string) { setNewUiRevisionId(value); clearResult(); }

  function selectOptions(items: readonly Readonly<{ revisionId: string; sequence: number }>[], emptyLabel: string, selected: string) {
    return <>
      <option value="">{emptyLabel}</option>
      {items.map(item => <option key={item.revisionId} value={item.revisionId}>
        {item.revisionId} · #{item.sequence}{selected === item.revisionId ? " · 선택됨" : ""}
      </option>)}
    </>;
  }
  async function query() {
    if (!ready || !projectId || !onQueryImpact) return;
    const generation = ++impactGeneration.current;
    const request = { projectId, oldBaselineRevisionId, newBaselineRevisionId, oldUiRevisionId, newUiRevisionId };
    setLoading(true); setError(false); setResult(null); setQueried(true);
    try {
      const response: unknown = await onQueryImpact(request);
      if (generation !== impactGeneration.current) return;
      if (!isImpactReadDTO(response, request)) {
        throw new TypeError("Unverified G5 comparison response.");
      }
      setResult(response);
    } catch { if (generation === impactGeneration.current) setError(true); }
    finally { if (generation === impactGeneration.current) setLoading(false); }
  }

  return <section className="sps-g5-impact" aria-labelledby="sps-g5-title">
    <style>{STYLE}</style>
    <h2 id="sps-g5-title">변경 영향 비교</h2>
    <p className="sps-g5-note">정확한 이전·신규 Baseline 및 승인 UI Revision을 조회합니다. 후보는 검토 단서이며 승인, 실행, 전체 영향 목록 또는 무영향 증명이 아닙니다.</p>
    {!projectId?.trim() && <p className="sps-g5-status" role="status">현재 project 범위를 확인할 수 없어 비교가 UNKNOWN입니다.</p>}
    {!onReadComparisonPairs && <p className="sps-g5-status" role="status">게시 Baseline 및 승인 UI 목록을 읽는 서버 callback이 연결되지 않았습니다.</p>}
    {onReadComparisonPairs && <div className="sps-g5-pair-toolbar">
      <button type="button" onClick={() => void loadPairs()} disabled={pairsLoading || !projectId}>{pairsLoading ? "선택지 조회 중…" : "게시 선택지 새로고침"}</button>
      {pairs && <span className="sps-g5-muted">최근 게시 조회 범위의 선택지이며 전체 이력 목록은 아닙니다.
        {pairs.coverage.baselineHasMore || pairs.coverage.formalUiHasMore ? " 더 오래된 게시 페이지가 있습니다." : ""}</span>}
    </div>}
    {pairsLoading && <p className="sps-g5-status" role="status">게시 Baseline과 승인 UI 선택지를 확인하고 있습니다.</p>}
    {pairsError && <p className="sps-g5-status sps-g5-alert" role="alert">게시 선택지를 확인하지 못했습니다. 임의 Revision을 입력하지 않습니다.</p>}
    {pairs && baselineOptions.length === 0 && !pairsLoading && <p className="sps-g5-status" role="status">확인된 게시 Baseline 및 승인 UI 선택지가 없습니다.</p>}
    <form className="sps-g5-query" onSubmit={event => { event.preventDefault(); void query(); }}>
      <label className="sps-g5-field">이전 Baseline<select value={oldBaselineRevisionId} disabled={!pairs || loading || pairsLoading}
        onChange={event => selectOldBaseline(event.currentTarget.value)}>
        {selectOptions(baselineOptions.map(item => ({ revisionId: item.baselineRevisionId, sequence: item.sequence })), "이전 Baseline 선택", oldBaselineRevisionId)}
      </select></label>
      <label className="sps-g5-field">신규 Baseline<select value={newBaselineRevisionId} disabled={!pairs || loading || pairsLoading}
        onChange={event => selectNewBaseline(event.currentTarget.value)}>
        {selectOptions(baselineOptions.map(item => ({ revisionId: item.baselineRevisionId, sequence: item.sequence })), "신규 Baseline 선택", newBaselineRevisionId)}
      </select></label>
      <label className="sps-g5-field">이전 승인 UI · 선택한 Baseline에 연결된 버전<select value={oldUiRevisionId} disabled={!oldBaseline || loading || pairsLoading}
        onChange={event => selectOldUi(event.currentTarget.value)}>
        {selectOptions((oldBaseline?.approvedFormalUi ?? []).map(item => ({ revisionId: item.formalUiRevisionId, sequence: item.formalUiSequence })), "이전 승인 UI 선택", oldUiRevisionId)}
      </select></label>
      <label className="sps-g5-field">신규 승인 UI · 선택한 Baseline에 연결된 버전<select value={newUiRevisionId} disabled={!newBaseline || loading || pairsLoading}
        onChange={event => selectNewUi(event.currentTarget.value)}>
        {selectOptions((newBaseline?.approvedFormalUi ?? []).map(item => ({ revisionId: item.formalUiRevisionId, sequence: item.formalUiSequence })), "신규 승인 UI 선택", newUiRevisionId)}
      </select></label>
      {oldBaseline && newBaseline && !orderedPair && <p className="sps-g5-status" role="status">이전 Baseline은 신규 Baseline보다 먼저 게시된 버전이어야 합니다.</p>}
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
