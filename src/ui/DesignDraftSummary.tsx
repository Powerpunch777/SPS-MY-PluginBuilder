import type { CSSProperties } from "react";
import type { DesignDraft } from "../domain/design-drafts.ts";

export type DesignDraftSummaryProps = Readonly<{
  draft: DesignDraft | null;
  loading: boolean;
  error: string | null;
  resolvedQuestionIds?: readonly string[];
}>;

const contentStyle: CSSProperties = {
  minWidth: 0,
  maxWidth: "100%",
  color: "var(--builder-text, #ededed)",
  fontSize: 13,
  overflowWrap: "anywhere",
};

const mutedStyle: CSSProperties = {
  color: "var(--builder-muted, #a0a0a0)",
  fontSize: 12,
  overflowWrap: "anywhere",
};

const listStyle: CSSProperties = {
  display: "grid",
  gap: 8,
  margin: "8px 0 0",
  paddingLeft: 20,
};

export function DesignDraftSummary({ draft, loading, error, resolvedQuestionIds = [] }: DesignDraftSummaryProps) {
  if (loading) {
    return <p role="status" style={mutedStyle}>설계 초안을 불러오는 중입니다.</p>;
  }

  if (error !== null) {
    return <p role="alert" style={{ ...mutedStyle, color: "var(--builder-danger, #e28b8b)" }}>설계 초안을 불러오지 못했습니다.</p>;
  }

  if (draft === null) return null;
  const resolved = new Set(resolvedQuestionIds);
  const unresolvedCount = draft.questions.filter(question => !resolved.has(question.id)).length;

  return (
    <section aria-label="Lead 설계 초안" style={{ ...contentStyle, flexShrink: 0, maxHeight: "32vh", overflow: "auto",
      padding: "10px 16px", borderBottom: "1px solid var(--builder-border, #363636)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <strong>설계 초안 · 승인·실행 전</strong>
        <span style={mutedStyle}>{draft.revisionId}</span>
        <span aria-label={`요구사항 ${draft.specification.requirements.length}개`} style={mutedStyle}>
          요구사항 {draft.specification.requirements.length}개
        </span>
        <span aria-label={`설계 질문 ${unresolvedCount}개`} style={mutedStyle}>
          설계 질문 {unresolvedCount}개
        </span>
      </div>

      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: "pointer", fontSize: 12 }}>세부 내용</summary>
        <div style={{ display: "grid", gap: 12, marginTop: 8 }}>
          <section aria-label="요구사항">
            <h3 style={{ margin: 0, fontSize: 13 }}>요구사항</h3>
            {draft.specification.requirements.length > 0 ? (
              <ul style={listStyle}>
                {draft.specification.requirements.map(requirement => (
                  <li key={requirement.id} style={contentStyle}>
                    <strong>{requirement.id}</strong>
                    <div>{requirement.description}</div>
                    <div style={mutedStyle}>인수 기준 ID: {requirement.acceptanceCriteriaIds.join(", ") || "없음"}</div>
                  </li>
                ))}
              </ul>
            ) : <p style={mutedStyle}>요구사항이 없습니다.</p>}
          </section>

          <section aria-label="설계 질문">
            <h3 style={{ margin: 0, fontSize: 13 }}>설계 질문</h3>
            {draft.questions.length > 0 ? (
              <ul style={listStyle}>
                {draft.questions.map(question => (
                  <li key={question.id} style={contentStyle}>
                    <strong>{question.title}</strong>
                    <span style={mutedStyle}> · {resolved.has(question.id) ? "답변 완료" : "답변 필요"}</span>
                    <div>{question.text}</div>
                    {question.options.length > 0 && (
                      <ul style={listStyle}>
                        {question.options.map(option => (
                          <li key={option.id} style={contentStyle}>
                            <strong>{option.label}</strong>
                            {question.recommendation === option.id && <span style={mutedStyle}> · 초안 권장안</span>}
                            <div style={mutedStyle}>{option.tradeoff}</div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            ) : <p style={mutedStyle}>설계 질문이 없습니다.</p>}
          </section>

          <section aria-label="상담근거">
            <h3 style={{ margin: 0, fontSize: 13 }}>상담근거</h3>
            <ul style={listStyle}>
              {draft.sourceIds.map(sourceId => <li key={sourceId} style={contentStyle}>{sourceId}</li>)}
            </ul>
          </section>
        </div>
      </details>
    </section>
  );
}
