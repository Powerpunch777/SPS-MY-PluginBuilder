import { useMemo, useState, type FormEvent } from "react";
import { usePluginAction, usePluginData } from "@sonparkserver/plugin-sdk/ui/bridge";
import { CurrentBaselinePackReviewPanel, type CurrentBaselinePackConfirmationInput,
  type CurrentBaselinePackReviewView } from "./CurrentBaselinePackReviewPanel.tsx";

type ConfirmResult = Readonly<{ status: string }>;
type ReadResult = Readonly<{ status: "empty" | "ready" | "stale"; data?: unknown }>;

function projectView(value: unknown, loading: boolean, failed: boolean, workspaceId: string, packId: string): CurrentBaselinePackReviewView {
  if (!packId) return { status: "empty" };
  if (loading) return { status: "loading" };
  if (failed || value === null || typeof value !== "object" || Array.isArray(value)) return { status: "error" };
  const row = value as Partial<ReadResult>;
  if (row.status === "empty") return { status: "empty" };
  if ((row.status !== "ready" && row.status !== "stale") || !row.data || typeof row.data !== "object" || Array.isArray(row.data)) {
    return { status: "error" };
  }
  const data = row.data as Record<string, unknown>;
  if (data.workspaceId !== workspaceId || data.projectId !== workspaceId || data.packId !== packId) return { status: "error" };
  return { status: row.status, data };
}

export function CurrentBaselinePackReviewSection({ workspaceId }: Readonly<{ workspaceId: string }>) {
  const [draftPackId, setDraftPackId] = useState("");
  const [requestedPackId, setRequestedPackId] = useState("");
  const packRead = usePluginData<unknown>("builder.current-baseline-spec-assurance-pack", {
    projectId: workspaceId, ...(requestedPackId ? { packId: requestedPackId } : {}),
  });
  const confirm = usePluginAction<CurrentBaselinePackConfirmationInput, ConfirmResult>(
    "builder.confirm-current-baseline-spec-assurance-pack");
  const view = useMemo(() => projectView(packRead.data, packRead.loading, Boolean(packRead.error), workspaceId, requestedPackId),
    [packRead.data, packRead.loading, packRead.error, workspaceId, requestedPackId]);
  function load(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const packId = draftPackId.trim();
    if (!packId || packId.length > 160 || /[\u0000-\u001f\u007f]/u.test(packId)) return;
    setRequestedPackId(packId);
  }
  return <section aria-label="후속 명세 팩 검토" style={{ display: "grid", gap: 10 }}>
    <p>현재 Main의 팩 제안 결과에 표시된 pack ID를 입력해 전체 규칙·모델·원문 핀을 검토합니다.</p>
    <form onSubmit={load} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end" }}>
      <label style={{ display: "grid", gap: 4, minWidth: 0, flex: "1 1 220px" }}>
        <span>후속 팩 ID</span>
        <input aria-label="검토할 후속 팩 ID" value={draftPackId} maxLength={160}
          onChange={event => setDraftPackId(event.currentTarget.value)} />
      </label>
      <button type="submit" disabled={!draftPackId.trim() || draftPackId.length > 160}>제안 불러오기</button>
    </form>
    <CurrentBaselinePackReviewPanel view={view} onConfirm={async input => {
      try { return await confirm(input); }
      finally { packRead.refresh(); }
    }} onRefresh={packRead.refresh} />
  </section>;
}
