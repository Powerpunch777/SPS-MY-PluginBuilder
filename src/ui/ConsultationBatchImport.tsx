import { useMemo, useState, type FormEvent } from "react";
import { Upload } from "lucide-react";
import type { BuilderShellProps } from "../domain/model.ts";
import { decodeConsultationFile, MAX_CONSULTATION_REQUEST_BYTES } from "../domain/consultation-file.ts";
import { previewConsultationBatch } from "../consultation-import/batch.ts";

export function ConsultationBatchImport({ batches = [], onConfirm }: {
  batches?: NonNullable<BuilderShellProps["consultationBatches"]>;
  onConfirm: NonNullable<BuilderShellProps["onImportConsultationBatch"]>;
}) {
  const [text, setText] = useState(""); const [sourceName, setSourceName] = useState("복사한 상담 텍스트");
  const [fromLine, setFromLine] = useState(1); const [throughLine, setThroughLine] = useState(1);
  const [previewed, setPreviewed] = useState(false); const [ackDuplicate, setAckDuplicate] = useState(false);
  const [busy, setBusy] = useState(false); const [status, setStatus] = useState("");
  const id = useMemo(() => crypto.randomUUID(), [previewed, text, sourceName, fromLine, throughLine]);
  const preview = useMemo(() => {
    if (!previewed || !text.trim()) return null;
    try { return previewConsultationBatch({ id, text, sourceName, fromLine, throughLine }); } catch { return null; }
  }, [previewed, id, text, sourceName, fromLine, throughLine]);
  const duplicate = Boolean(preview && batches.some(batch => batch.sha256 === preview.sha256));
  function changeText(value: string) { setText(value); setFromLine(1); setThroughLine(Math.max(1, value.split(/\r?\n/).length)); setPreviewed(false); setAckDuplicate(false); setStatus(""); }
  async function choose(file?: File) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".txt") || file.size > MAX_CONSULTATION_REQUEST_BYTES) {
      setStatus("UTF-8 .txt 파일만 가능하며 파일 크기는 48 KiB 이하여야 합니다."); return;
    }
    try { changeText(decodeConsultationFile(new Uint8Array(await file.arrayBuffer()))); setSourceName(file.name); }
    catch (error) { setStatus(error instanceof Error ? error.message : "파일을 읽지 못했습니다."); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    try { previewConsultationBatch({ id, text, sourceName, fromLine, throughLine }); setPreviewed(true); setStatus(""); }
    catch (error) { setStatus(error instanceof Error ? error.message : "범위를 확인해 주세요."); }
  }
  async function confirm() {
    if (!preview || busy || duplicate && !ackDuplicate) return;
    setBusy(true);
    try {
      await onConfirm({ id, sourceName, text, fromLine, throughLine, allowDuplicate: duplicate && ackDuplicate });
      setText(""); setPreviewed(false); setStatus("선택 범위를 Main 원문과 현재 Workspace에 저장했습니다. 분석·AI 실행은 시작하지 않았습니다.");
    } catch { setStatus("저장 결과가 불확실할 수 있습니다. Main 원문과 Workspace Batch 기록을 새로 조회하세요. 일부 저장이 있었다면 같은 Batch ID와 동일 입력으로만 재시도하며 기존 원문은 자동 삭제·덮어쓰지 않습니다."); }
    finally { setBusy(false); }
  }
  return <section aria-label="수동 상담 Batch 가져오기" className="builder-card builder-import">
    <p className="builder-card-sub">사용자가 제공한 UTF-8 텍스트만 처리합니다. 입력 줄은 메시지 경계로 해석하지 않으며 출처·발신자·시각·전체 대화 범위가 없으면 UNKNOWN으로 기록합니다.</p>
    <form className="builder-import-form" onSubmit={submit}>
      <label className="builder-file-button">UTF-8 .txt 파일 선택<input accept=".txt,text/plain" aria-label="상담 .txt 파일" onChange={event => { void choose(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} type="file" /></label>
      <textarea aria-label="상담 원문" disabled={busy} onChange={event => changeText(event.target.value)} placeholder="상담 원문을 붙여넣으세요" value={text} />
      <label>출처 이름<input aria-label="출처 이름" onChange={event => { setSourceName(event.target.value); setPreviewed(false); }} value={sourceName} /></label>
      <div className="builder-import-range"><label>시작 원문 줄<input aria-label="시작 원문 줄" min={1} onChange={event => { setFromLine(Number(event.target.value)); setPreviewed(false); }} type="number" value={fromLine} /></label><label>끝 원문 줄<input aria-label="끝 원문 줄" min={1} onChange={event => { setThroughLine(Number(event.target.value)); setPreviewed(false); }} type="number" value={throughLine} /></label></div>
      <p className="builder-card-sub">줄 범위는 제공 원문에 대한 문자 범위입니다. 대화방·메시지 구간임을 의미하지 않습니다.</p>
      <button className="builder-primary-button" disabled={!text.trim() || busy} type="submit">범위 미리보기</button>
    </form>
    {preview && <div className="builder-batch-preview" aria-label="Batch 범위 미리보기"><strong>저장 전 확인</strong><p>{preview.sourceName} · 원문 {preview.lineCount}줄 · 선택 {preview.selectedFromLine}–{preview.selectedThroughLine}줄</p><p>SHA-256 {preview.sha256} · 첨부파일 UNKNOWN · 대화 완전성 UNKNOWN</p><pre>{preview.selectedText}</pre>
      {duplicate && <label><input checked={ackDuplicate} onChange={event => setAckDuplicate(event.target.checked)} type="checkbox" /> 같은 원문 해시의 Batch가 있습니다. 별도 가져오기로 기록함을 확인합니다.</label>}
      <button className="builder-primary-button" disabled={busy || duplicate && !ackDuplicate} onClick={() => void confirm()} type="button"><Upload size={14} /> {busy ? "저장 중" : "확인하고 Main 및 Workspace에 저장"}</button>
      <button className="builder-secondary-button" disabled={busy} onClick={() => { setPreviewed(false); setText(""); setStatus("가져오기를 취소했습니다. 저장하지 않았습니다."); }} type="button">취소</button>
    </div>}
    {status && <p className="builder-composer-note" role="status">{status}</p>}
    <section aria-label="현재 Workspace 상담 Batch 기록"><h3>현재 Workspace에 저장된 Batch</h3>{batches.length ? batches.map(batch => <article key={batch.id} className="builder-batch-record"><strong>{batch.sourceName}</strong><p>상태: 일부 범위 저장 · 제공 시각: UNKNOWN · 발신자: UNKNOWN · 메시지 시각: UNKNOWN · 첨부: UNKNOWN · 전체 범위: UNKNOWN</p><p>원문 줄 {batch.selectedFromLine}–{batch.selectedThroughLine}/{batch.lineCount} · SHA-256 {batch.sha256}</p><pre>{batch.sourceId}</pre></article>) : <p>저장된 상담 Batch가 없습니다.</p>}</section>
  </section>;
}
