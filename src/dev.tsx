import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BuilderShell } from "./ui/BuilderShell.tsx";
import { createEmptyBuilderSnapshot } from "./domain/snapshot.ts";

function DevelopmentPreview() {
  const [snapshot, setSnapshot] = useState(() => {
    const initial = createEmptyBuilderSnapshot("11111111-1111-4111-8111-111111111111");
    const fixture = new URLSearchParams(window.location.search).get("fixture");
    if (fixture !== "decisions" && fixture !== "decisions-no-question") return initial;
    if (fixture === "decisions") initial.questions.push({ id: "question-fixture", title: "Regression question", text: "Selected question details remain visible.",
      status: "open", options: [], recommendation: null, answer: null, revisionId: null });
    initial.actors.push({ id: "actor-fixture", role: "cto", label: "Fixture CTO", parentActorId: null,
      agentId: null, sessionId: "fixture-session", status: "running" });
    initial.messages.push(
      { id: "lead-decision-fixture", channel: "decisions", actorId: null, role: "assistant",
        text: "Lead decision with unrelated run ID", createdAt: "2026-11-01T00:00:00.000Z", runId: "arbitrary-execution-42" },
      { id: "subordinate-decision-fixture", channel: "decisions", actorId: "actor-fixture", role: "assistant",
        text: "SUBORDINATE RECORD MUST NOT APPEAR", createdAt: "2026-11-01T00:00:00.000Z", runId: "arbitrary-execution-42" },
    );
    return initial;
  });
  return <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
    <div role="status" style={{ padding: "6px 14px", background: "#edf3f0", color: "#34564a", font: "12px Segoe UI, Malgun Gothic, sans-serif", flexShrink: 0 }}>
      UI Preview · Core/AI 미연결 · 입력은 이 창의 메모리에만 보관됩니다.
    </div>
    <div style={{ minHeight: 0, flex: 1 }}><BuilderShell snapshot={snapshot} workspaceLabel="Builder Development"
      onRefresh={() => {}} onImportConsultation={async text => {
        const now = new Date().toISOString();
        setSnapshot(previous => ({ ...previous, revision: previous.revision + 1,
          messages: [...previous.messages, { id: crypto.randomUUID(), channel: "main", actorId: null,
            role: "user", text, createdAt: now, runId: null }],
          activity: [...previous.activity, { id: crypto.randomUUID(), actorId: null,
            label: "상담 입력을 미리보기 메모리에 보관함", createdAt: now, evidenceRef: null }],
        }));
      }} /></div>
  </div>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Preview root is missing.");
createRoot(root).render(<DevelopmentPreview />);
