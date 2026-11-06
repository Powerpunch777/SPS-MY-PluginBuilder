import { useState } from "react";
import { LoaderCircle, Play } from "lucide-react";

export function ConsultationAnalysisControl({ enabled, start }: { enabled: boolean; start(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);
  return <div className="builder-analysis-control">
    <button className="builder-quiet-button" disabled={!enabled || busy} type="button" onClick={() => {
      if (!enabled || busy) return;
      setBusy(true); setError(null); setRequested(false);
      void start().then(() => setRequested(true), () => setError("분석 요청을 확인하지 못했습니다. 새로고침 후 기존 요청을 확인해 주세요."))
        .finally(() => setBusy(false));
    }}>{busy ? <LoaderCircle size={14} /> : <Play size={14} />}상담 분석 시작</button>
    {requested && <span role="status">분석 요청이 저장되었습니다.</span>}
    {error && <span className="builder-feedback" role="alert">{error}</span>}
  </div>;
}
