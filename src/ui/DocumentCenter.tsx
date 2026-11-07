import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { selectProjectDocuments, parseDocumentCenterQuery, type DocumentCenterQuery } from "../domain/document-center.ts";
import { exportDocumentMarkdown, safeDocumentMarkdownFilename } from "../domain/document-markdown-export.ts";
import type { BuilderDocument, DocumentCategory, DocumentFreshnessStatus, DocumentSourceKind } from "../domain/model.ts";

export type DocumentCenterProps = Readonly<{
  documents: readonly BuilderDocument[];
  loading?: boolean;
  error?: string | null;
}>;

const STYLE = `
.sps-document-center{--dc-bg:#202020;--dc-panel:#262626;--dc-border:#414141;--dc-text:#ededed;--dc-muted:#b6b6b6;--dc-faint:#929292;color:var(--dc-text);font:13px/1.55 -apple-system,BlinkMacSystemFont,Pretendard,"Noto Sans KR","Malgun Gothic",sans-serif;letter-spacing:0;min-width:0;container-type:inline-size;container-name:sps-doc-center}
.sps-document-center *{box-sizing:border-box;letter-spacing:0}
.sps-document-center button,.sps-document-center input,.sps-document-center select{font:inherit;color:inherit}
.sps-document-center button:focus-visible,.sps-document-center input:focus-visible,.sps-document-center select:focus-visible{outline:2px solid #ededed;outline-offset:2px}
.sps-dc-note{margin:0 0 12px;color:var(--dc-muted);font-size:11px}
.sps-dc-controls{display:grid;grid-template-columns:minmax(180px,2fr) repeat(4,minmax(130px,1fr));gap:8px;margin-bottom:12px}
.sps-dc-field{display:grid;gap:4px;min-width:0;color:var(--dc-muted);font-size:11px}
.sps-dc-field input,.sps-dc-field select{width:100%;min-width:0;min-height:36px;border:1px solid var(--dc-border);border-radius:5px;background:#181818;padding:6px 8px;color:var(--dc-text)}
.sps-dc-sort{display:flex;align-items:end;gap:7px;min-width:0}
.sps-dc-sort .sps-dc-field{flex:1}
.sps-dc-direction{min-height:36px;border:1px solid var(--dc-border);border-radius:5px;background:#292929;padding:5px 8px;cursor:pointer}
.sps-dc-summary{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin:8px 0;color:var(--dc-muted);font-size:11px}
.sps-dc-reset{border:1px solid var(--dc-border);border-radius:5px;background:#292929;padding:5px 8px;cursor:pointer}
.sps-dc-layout{display:grid;grid-template-columns:minmax(240px,.85fr) minmax(0,1.5fr);gap:12px;align-items:start}
.sps-dc-list,.sps-dc-detail{min-width:0;border:1px solid var(--dc-border);border-radius:6px;background:var(--dc-panel);padding:10px}
.sps-dc-list h3,.sps-dc-detail h3{margin:0 0 8px;font-size:13px}
.sps-dc-items{display:grid;gap:5px;max-height:62vh;overflow:auto}
.sps-dc-item{display:grid;width:100%;min-width:0;gap:2px;border:1px solid transparent;border-radius:5px;background:transparent;padding:8px;text-align:left;cursor:pointer}
.sps-dc-item:hover{background:#303030}
.sps-dc-item[aria-pressed=true]{border-color:#666;background:#303030}
.sps-dc-item strong,.sps-dc-item small{overflow-wrap:anywhere}
.sps-dc-item strong{font-size:12px}
.sps-dc-item small{color:var(--dc-muted);font-size:10px}
.sps-dc-statuses{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0}
.sps-dc-chip{border:1px solid var(--dc-border);border-radius:4px;padding:2px 6px;color:var(--dc-muted);font-size:10px}
.sps-dc-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:7px;margin:8px 0}
.sps-dc-meta div{min-width:0;border:1px solid var(--dc-border);border-radius:5px;padding:7px;overflow-wrap:anywhere}
.sps-dc-meta dt{color:var(--dc-muted);font-size:10px}
.sps-dc-meta dd{margin:2px 0 0;overflow-wrap:anywhere}
.sps-dc-body{max-height:48vh;min-height:100px;overflow:auto;border:1px solid var(--dc-border);border-radius:5px;background:#181818;padding:10px;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}
.sps-dc-empty,.sps-dc-unavailable{border:1px solid var(--dc-border);border-radius:5px;background:#242424;padding:12px;color:var(--dc-muted)}
.sps-dc-empty code,.sps-dc-meta dd{overflow-wrap:anywhere}
.sps-dc-alert{border-color:#805858;color:#efbcbc}
@container sps-doc-center (max-width:900px){.sps-dc-controls{grid-template-columns:repeat(2,minmax(0,1fr))}.sps-dc-search{grid-column:1/-1}.sps-dc-layout{grid-template-columns:minmax(0,1fr)}}
@container sps-doc-center (max-width:520px){.sps-dc-controls{grid-template-columns:minmax(0,1fr)}.sps-dc-search{grid-column:auto}.sps-dc-sort{align-items:stretch}.sps-dc-layout{gap:8px}.sps-dc-list,.sps-dc-detail{padding:8px}.sps-dc-items{max-height:38vh}}
`;

const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  consultation: "상담", design: "설계", "ui-design": "UI 설계", validation: "검증", "technical-research": "기술 조사",
  development: "개발", "change-history": "변경 이력", "test-qa": "테스트·QA", delivery: "납품", unclassified: "미분류",
};
const SOURCE_LABELS: Record<DocumentSourceKind, string> = {
  "builder-document": "Builder 문서", "baseline-body": "기준선 본문", "design-baseline": "설계 기준선",
  "design-draft": "설계 초안", "technology-decision": "기술 결정", workstream: "Workstream", "lead-memory": "Lead 기억",
  "consultation-source": "상담 원문",
  "reuse-candidate": "재사용 후보",
  "delivery-document": "납품 문서 초안",
};
const APPROVAL_LABELS = { approved: "승인됨", unapproved: "미승인", unknown: "미확인" } as const;
const FRESHNESS_LABELS: Record<DocumentFreshnessStatus, string> = {
  current: "최신", stale: "이전 버전", "review-required": "재검토 필요", unknown: "미확인",
};

function initialQuery(): DocumentCenterQuery { return parseDocumentCenterQuery(); }

export function DocumentCenter({ documents, loading = false, error = null }: DocumentCenterProps) {
  const [query, setQuery] = useState<DocumentCenterQuery>(initialQuery);
  const [searchText, setSearchText] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const view = useMemo(() => selectProjectDocuments({ documents: [...documents] }, query), [documents, query]);
  const selected = (selectedId ? documents.find(document => document.id === selectedId) : null)
    ?? view.items[0] ?? null;
  const isFilteredOut = Boolean(selected && !view.items.some(document => document.id === selected.id));
  const hasFilters = Boolean(searchText.trim() || query.category || query.sourceKind || query.approvalStatus || query.freshnessStatus || query.relatedId);
  const canExport = Boolean(selected && selected.bodyAvailable !== false && !loading && !error);

  function updateQuery(field: keyof DocumentCenterQuery, value: string) {
    setQuery(previous => parseDocumentCenterQuery({ ...previous, [field]: value }));
  }
  function reset() {
    setQuery(initialQuery());
    setSearchText("");
  }

  function downloadSelected() {
    if (!canExport || !selected) return;
    try {
      const markdown = exportDocumentMarkdown(selected, new Date().toISOString());
      const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = safeDocumentMarkdownFilename(selected.title);
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch {
      // Invalid or unavailable snapshot data must not produce a partial export.
    }
  }

  return <section className="sps-document-center" aria-labelledby="sps-dc-title">
    <style>{STYLE}</style>
    <header><h2 id="sps-dc-title">문서센터</h2>
      <p className="sps-dc-note">현재 Builder snapshot과 연결된 문서만 표시합니다. 분류·검색 결과는 전체 Artifact inventory나 전체 검색의 완전성을 의미하지 않습니다.</p>
    </header>
    <div className="sps-dc-controls" aria-label="문서 검색 및 필터">
      <label className="sps-dc-field sps-dc-search">제목·본문 검색
        <input type="search" value={searchText} maxLength={500} disabled={loading || Boolean(error)}
          placeholder="현재 문서 제목과 사용 가능한 본문 검색" onChange={event => {
            const value = event.currentTarget.value; setSearchText(value); updateQuery("search", value);
          }} />
      </label>
      <label className="sps-dc-field">분류
        <select aria-label="분류" value={query.category ?? ""} disabled={loading || Boolean(error)} onChange={event => updateQuery("category", event.currentTarget.value)}>
          <option value="">모든 분류</option>{Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="sps-dc-field">유형
        <select aria-label="유형" value={query.sourceKind ?? ""} disabled={loading || Boolean(error)} onChange={event => updateQuery("sourceKind", event.currentTarget.value)}>
          <option value="">모든 유형</option>{Object.entries(SOURCE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="sps-dc-field">승인 상태
        <select aria-label="승인 상태" value={query.approvalStatus ?? ""} disabled={loading || Boolean(error)} onChange={event => updateQuery("approvalStatus", event.currentTarget.value)}>
          <option value="">모든 상태</option><option value="approved">승인됨</option><option value="unapproved">미승인</option><option value="unknown">미확인</option>
        </select>
      </label>
      <div className="sps-dc-sort">
        <label className="sps-dc-field">정렬
          <select aria-label="정렬" value={query.sortBy} disabled={loading || Boolean(error)} onChange={event => updateQuery("sortBy", event.currentTarget.value)}>
            <option value="createdAt">기록 시각</option><option value="title">제목</option><option value="sourceKind">유형</option><option value="revisionId">Revision</option>
          </select>
        </label>
        <button className="sps-dc-direction" type="button" aria-label={query.direction === "desc" ? "오름차순으로 정렬" : "내림차순으로 정렬"}
          disabled={loading || Boolean(error)} onClick={() => updateQuery("direction", query.direction === "desc" ? "asc" : "desc")}>
          {query.direction === "desc" ? "최신순" : "오래된순"}
        </button>
      </div>
      <label className="sps-dc-field">최신성
        <select aria-label="최신성" value={query.freshnessStatus ?? ""} disabled={loading || Boolean(error)} onChange={event => updateQuery("freshnessStatus", event.currentTarget.value)}>
          <option value="">모든 최신성</option><option value="current">최신</option><option value="stale">이전 버전</option>
          <option value="review-required">재검토 필요</option><option value="unknown">미확인</option>
        </select>
      </label>
      <label className="sps-dc-field">관련 ID (정확히 일치)
        <input type="search" aria-label="관련 ID" value={query.relatedId ?? ""} maxLength={160} disabled={loading || Boolean(error)}
          placeholder="Requirement · CR · Workstream ID" onChange={event => updateQuery("relatedId", event.currentTarget.value)} />
      </label>
    </div>
    <div className="sps-dc-summary" aria-live="polite">
      <span>현재 snapshot {documents.length}개 · 필터 결과 {view.total}개 · snapshot 분류 집계</span>
      <button className="sps-dc-reset" type="button" disabled={!hasFilters || loading || Boolean(error)} onClick={reset}>필터 초기화</button>
    </div>
    {loading ? <p className="sps-dc-empty" role="status">문서센터 자료를 불러오는 중입니다.</p>
      : error ? <p className="sps-dc-empty sps-dc-alert" role="alert">문서센터 자료를 확인하지 못했습니다. 새로고침 후 다시 확인해 주세요.</p>
      : documents.length === 0 ? <p className="sps-dc-empty" role="status">현재 snapshot에 표시할 문서가 없습니다.</p>
      : <div className="sps-dc-layout">
        <section className="sps-dc-list" aria-label="현재 snapshot 문서 목록">
          <h3>문서 목록</h3>
          {view.items.length ? <div className="sps-dc-items">{view.items.map(document => <button key={document.id} type="button"
            className="sps-dc-item" aria-pressed={selected?.id === document.id} onClick={() => setSelectedId(document.id)}>
            <strong>{document.title}</strong><small>{document.revisionId} · <time dateTime={document.createdAt}>{document.createdAt}</time></small>
            <small>{CATEGORY_LABELS[document.category]} · {SOURCE_LABELS[document.sourceKind]}</small>
          </button>)}</div>
            : <p className="sps-dc-empty" role="status">{searchText.trim() ? "검색어와 일치하는 문서가 없습니다." : "현재 필터에 해당하는 문서가 없습니다."}</p>}
        </section>
        <section className="sps-dc-detail" aria-label="선택한 문서">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <h3>문서 상세</h3>
            <button className="sps-dc-reset" type="button" aria-label="선택 문서 Markdown 내보내기"
              title="Markdown 내보내기" disabled={!canExport} onClick={downloadSelected}>
              <Download size={14} aria-hidden="true" />
            </button>
          </div>
          {selected ? <>
            {isFilteredOut && <p className="sps-dc-empty">선택 문서는 현재 필터 결과 밖에 있습니다. 선택은 유지됩니다.</p>}
            <h4>{selected.title}</h4>
            <dl className="sps-dc-meta">
              <div><dt>문서 ID</dt><dd>{selected.id}</dd></div>
              <div><dt>Revision</dt><dd>{selected.revisionId}</dd></div>
              <div><dt>기록 시각</dt><dd><time dateTime={selected.createdAt}>{selected.createdAt}</time></dd></div>
              <div><dt>분류</dt><dd>{CATEGORY_LABELS[view.items.find(item => item.id === selected.id)?.category ?? selected.category ?? "unclassified"]}</dd></div>
              <div><dt>유형</dt><dd>{SOURCE_LABELS[view.items.find(item => item.id === selected.id)?.sourceKind ?? selected.sourceKind ?? "builder-document"]}</dd></div>
              <div><dt>승인</dt><dd>{APPROVAL_LABELS[view.items.find(item => item.id === selected.id)?.approvalStatus ?? selected.approvalStatus ?? "unknown"]}</dd></div>
              <div><dt>최신성</dt><dd>{FRESHNESS_LABELS[view.items.find(item => item.id === selected.id)?.freshnessStatus ?? selected.freshnessStatus ?? "unknown"]}</dd></div>
            </dl>
            <div className="sps-dc-statuses" aria-label="문서 상태">
              <span className="sps-dc-chip">본문 {selected.bodyAvailable === false ? "사용 불가" : "사용 가능"}</span>
            </div>
            {selected.bodyAvailable === false ? <p className="sps-dc-unavailable" role="status">이 문서의 본문은 현재 연결된 source에서 사용할 수 없습니다.</p>
              : selected.text ? <pre className="sps-dc-body">{selected.text}</pre>
                : <p className="sps-dc-empty" role="status">저장된 본문이 비어 있습니다.</p>}
            <section aria-label="문서 출처 고정"><h4>출처 Revision · SHA-256</h4>
              {selected.sourcePins?.length ? <ul className="sps-dc-items">{selected.sourcePins.map((pin, index) => <li key={`${pin.sourceId}:${pin.revisionId}:${index}`} className="sps-dc-empty">
                {pin.sourceId} · {pin.revisionId}<br /><code>{pin.sha256}</code>
              </li>)}</ul> : <p className="sps-dc-empty">고정된 출처가 없습니다.</p>}
            </section>
            <section aria-label="관련 식별자"><h4>관련 ID</h4>
              {selected.relatedIds?.length ? <ul className="sps-dc-items">{selected.relatedIds.map(id => <li key={id} className="sps-dc-empty">{id}</li>)}</ul>
                : <p className="sps-dc-empty">관련 ID가 기록되어 있지 않습니다.</p>}
            </section>
          </> : <p className="sps-dc-empty" role="status">표시할 문서가 없습니다.</p>}
        </section>
      </div>}
  </section>;
}
