import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BuilderShell } from "./ui/BuilderShell.tsx";
import { createEmptyBuilderSnapshot } from "./domain/snapshot.ts";

function DevelopmentPreview() {
  const [snapshot, setSnapshot] = useState(() => {
    const initial = createEmptyBuilderSnapshot("11111111-1111-4111-8111-111111111111");
    const fixture = new URLSearchParams(window.location.search).get("fixture");
    if (fixture === "graph") {
      initial.actors.push({ id: "graph-owner", role: "cto", label: "Fixture CTO", parentActorId: null,
        agentId: null, sessionId: "fixture-graph-session", status: "running" });
      initial.graph = { revisionId: "fixture-graph-revision", entities: [
        { id: "fixture-feature", kind: "feature", label: "Fixture Feature", ownerActorId: "graph-owner", status: "running", evidenceRefs: [] },
        { id: "fixture-component", kind: "component", label: "Fixture Component", ownerActorId: null, status: "blocked", evidenceRefs: [] },
        { id: "fixture-isolated", kind: "environment", label: "Fixture Isolated", ownerActorId: null, status: "planned", evidenceRefs: [] },
      ], relations: [{ id: "fixture-dependency", sourceId: "fixture-feature", targetId: "fixture-component", kind: "depends_on" }] };
      initial.messages.push({ id: "graph-owner-record", channel: "main", actorId: "graph-owner", role: "assistant",
        text: "Fixture CTO read-only record", createdAt: "2026-11-01T00:00:00.000Z", runId: "fixture-run" });
      return initial;
    }
    if (fixture === "documents") {
      initial.documents = [
        { id: "fixture-spec", title: "Lead 설계·계약 명세", revisionId: "spec-r01",
          text: "# Lead 설계·계약 명세\n\n저장된 Workspace 문서 fixture입니다.\n\n- Lead 관리\n- 현재 Revision: spec-r01", createdAt: "2026-11-01T00:00:00.000Z" },
        { id: "fixture-technology", title: "기술 선정 명세", revisionId: "tech-r02",
          text: "# 기술 선정 명세\n\n두 번째 저장 문서 fixture입니다.\n\n- React / required\n- 자체 CI / prohibited", createdAt: "2026-11-01T01:00:00.000Z" },
      ];
      return initial;
    }
    if (fixture === "organization") {
      initial.actors.push(
        { id: "org-lead", role: "lead", label: "Fixture Lead", parentActorId: null,
          agentId: null, sessionId: null, status: "running" },
        { id: "org-cto-a", role: "cto", label: "Fixture CTO A", parentActorId: "org-lead",
          agentId: "fixture-agent-cto-a", sessionId: "fixture-session-cto-a", status: "running" },
        { id: "org-cto-b", role: "cto", label: "Fixture CTO B", parentActorId: "org-lead",
          agentId: "fixture-agent-cto-b", sessionId: "fixture-session-cto-b", status: "waiting" },
        { id: "org-dev", role: "development", label: "Fixture Development Worker", parentActorId: "org-cto-a",
          agentId: "fixture-agent-dev", sessionId: "fixture-session-dev", status: "running" },
        { id: "org-qa", role: "qa", label: "Fixture QA Worker", parentActorId: "org-cto-a",
          agentId: "fixture-agent-qa", sessionId: "fixture-session-qa", status: "idle" },
      );
      initial.messages.push({ id: "org-dev-record", channel: "main", actorId: "org-dev", role: "assistant",
        text: "Fixture Development Worker read-only record", createdAt: "2026-11-01T00:00:00.000Z", runId: null });
      return initial;
    }
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
    <div role="status" style={{ padding: "6px 14px", background: "#202020", color: "#a0a0a0", font: "12px Segoe UI, Malgun Gothic, sans-serif", flexShrink: 0 }}>
      UI Preview · Core/AI 미연결 · 입력은 이 창의 메모리에만 보관됩니다.
    </div>
    <div style={{ minHeight: 0, flex: 1 }}><BuilderShell snapshot={snapshot} workspaceLabel="Builder Development"
      onRefresh={() => {
        if (new URLSearchParams(window.location.search).get("fixture") === "documents") {
          setSnapshot(previous => ({ ...previous, revision: previous.revision + 1,
            documents: previous.documents.length > 1 ? previous.documents.slice(0, 1) : [] }));
        }
      }} onImportConsultation={async text => {
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
