import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { UiInteraction } from "../ui-contracts/domain.ts";

export type UiHtmlReviewTarget = Readonly<{
  artifactId: string;
  revisionId: string;
  htmlSha256: string;
}>;

export type ApproveUiProposalInput = Readonly<{
  revisionId: string;
  expectedBaseRevisionId: string | null;
  proposalRevisionId: string;
  htmlSha256: string;
  approvedInteractionIds: readonly string[];
}>;

export type UiHtmlReviewState = "pending" | "approved" | "changes-requested" | "on-hold";

export type UiHtmlReviewProps = Readonly<{
  artifactId: string | null;
  revisionId: string | null;
  htmlSha256: string | null;
  html: string | null;
  source?: Readonly<{ kind: "draft" | "baseline"; revisionId: string }> | null;
  contractRevisionId?: string | null;
  interactions?: readonly UiInteraction[];
  approvalAction?: Readonly<{ revisionId: string; expectedBaseRevisionId: string | null }> | null;
  loading?: boolean;
  error?: string | null;
  reviewState?: UiHtmlReviewState;
  onUserApprove?: (input: ApproveUiProposalInput) => void | Promise<void>;
  onRequestChanges?: (target: UiHtmlReviewTarget) => void | Promise<void>;
  onHold?: (target: UiHtmlReviewTarget) => void | Promise<void>;
}>;

type HashCheck = Readonly<{
  artifactId: string;
  revisionId: string;
  htmlSha256: string;
  html: string;
  valid: boolean;
  error: string | null;
}>;

type ReviewAction = "approve" | "changes" | "hold";
const EMPTY_INTERACTIONS: readonly UiInteraction[] = Object.freeze([]);

const URL_ATTRIBUTES = new Set([
  "action", "archive", "background", "cite", "codebase", "data", "formaction", "href", "longdesc",
  "manifest", "ping", "poster", "profile", "src", "srcdoc", "srcset", "usemap", "xlink:href",
]);

const PREVIEW_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src data:",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src data:",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "worker-src 'none'",
].join("; ");

const sectionStyle: CSSProperties = {
  display: "grid",
  gap: 12,
  minWidth: 0,
  maxWidth: "100%",
  color: "var(--builder-text, #ededed)",
  fontSize: 13,
};

const mutedStyle: CSSProperties = {
  color: "var(--builder-muted, #a0a0a0)",
  fontSize: 12,
  overflowWrap: "anywhere",
};

const buttonStyle: CSSProperties = {
  minHeight: 36,
  padding: "7px 12px",
  border: "1px solid var(--builder-border, #414141)",
  borderRadius: 4,
  background: "var(--builder-panel, #222222)",
  color: "var(--builder-text, #ededed)",
  font: "inherit",
};

function isSafeInlineImage(value: string): boolean {
  return /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/]+=*$/iu.test(value);
}

function isBoundedId(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function buildSandboxDocument(source: string): string {
  const template = document.createElement("template");
  template.innerHTML = source;
  const content = template.content;
  content.querySelectorAll("script, iframe, frame, frameset, object, embed, portal, base, link").forEach(element => element.remove());

  for (const element of content.querySelectorAll("*")) {
    if (element.localName === "meta" && element.getAttribute("http-equiv")?.trim().toLowerCase() === "refresh") {
      element.remove();
      continue;
    }

    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (!URL_ATTRIBUTES.has(name)) continue;

      if ((name === "href" || name === "xlink:href") && attribute.value.trim().startsWith("#")) continue;
      if (name === "src" && element.localName === "img" && isSafeInlineImage(attribute.value.trim())) continue;
      element.removeAttribute(attribute.name);
    }
  }

  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${template.innerHTML}</body></html>`;
}

function reviewLabel(state: UiHtmlReviewState): string {
  switch (state) {
    case "approved": return "승인됨";
    case "changes-requested": return "수정 요청됨";
    case "on-hold": return "보류됨";
    default: return "사용자 검토 필요";
  }
}

export function UiHtmlReview({
  artifactId, revisionId, htmlSha256, html, source = null, contractRevisionId = null, loading = false, error = null, reviewState = "pending",
  interactions = EMPTY_INTERACTIONS, approvalAction = null, onUserApprove, onRequestChanges, onHold,
}: UiHtmlReviewProps) {
  const [hashCheck, setHashCheck] = useState<HashCheck | null>(null);
  const [busyAction, setBusyAction] = useState<ReviewAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedInteractionIds, setSelectedInteractionIds] = useState<ReadonlySet<string>>(() => new Set());

  const hasArtifact = isBoundedId(artifactId) && isBoundedId(revisionId)
    && typeof htmlSha256 === "string" && /^[a-f0-9]{64}$/iu.test(htmlSha256)
    && typeof html === "string";

  useEffect(() => {
    setHashCheck(null);
    setActionError(null);
    setBusyAction(null);
    setSelectedInteractionIds(new Set());
  }, [revisionId]);

  useEffect(() => {
    setHashCheck(null);
    setActionError(null);
    setBusyAction(null);
    if (loading || error !== null || !hasArtifact || artifactId === null || revisionId === null
      || htmlSha256 === null || html === null) return;

    let cancelled = false;
    const check = async () => {
      try {
        const subtle = globalThis.crypto?.subtle;
        if (!subtle) throw new Error("이 환경에서는 HTML 해시를 검증할 수 없습니다.");
        const bytes = await subtle.digest("SHA-256", new TextEncoder().encode(html));
        const actual = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
        if (!cancelled) setHashCheck({ artifactId, revisionId, htmlSha256, html,
          valid: actual === htmlSha256.toLowerCase(), error: actual === htmlSha256.toLowerCase() ? null : "HTML 내용의 SHA-256이 저장된 해시와 다릅니다." });
      } catch {
        if (!cancelled) setHashCheck({ artifactId, revisionId, htmlSha256, html, valid: false,
          error: "HTML 해시 검증에 실패했습니다. 검증 전에는 미리보기와 검토 action을 사용할 수 없습니다." });
      }
    };
    void check();
    return () => { cancelled = true; };
  }, [artifactId, revisionId, htmlSha256, html, loading, error, hasArtifact]);

  const verified = !loading && error === null && hasArtifact && hashCheck?.valid === true
    && hashCheck.artifactId === artifactId && hashCheck.revisionId === revisionId
    && hashCheck.htmlSha256 === htmlSha256 && hashCheck.html === html;
  const previewDocument = useMemo(() => verified && html !== null ? buildSandboxDocument(html) : null, [verified, html]);
  const target = verified && artifactId !== null && revisionId !== null && htmlSha256 !== null
    ? Object.freeze({ artifactId, revisionId, htmlSha256: htmlSha256.toLowerCase() }) : null;

  async function runAction(action: ReviewAction, callback: ((target: UiHtmlReviewTarget) => void | Promise<void>) | undefined) {
    if (!target || !callback || busyAction !== null) return;
    setActionError(null);
    setBusyAction(action);
    try {
      await callback(target);
    } catch {
      setActionError("검토 action을 완료하지 못했습니다. 저장된 상태를 새로 확인해 주세요.");
    } finally {
      setBusyAction(null);
    }
  }

  async function approve() {
    if (!target || !approvalAction || !onUserApprove || busyAction !== null) return;
    setActionError(null);
    setBusyAction("approve");
    try {
      await onUserApprove(Object.freeze({
        revisionId: approvalAction.revisionId,
        expectedBaseRevisionId: approvalAction.expectedBaseRevisionId,
        proposalRevisionId: target.revisionId,
        htmlSha256: target.htmlSha256,
        approvedInteractionIds: Object.freeze(interactions.filter(item => selectedInteractionIds.has(item.id)).map(item => item.id)),
      }));
    } catch {
      setActionError("검토 action을 완료하지 못했습니다. 저장된 상태를 새로 확인해 주세요.");
    } finally {
      setBusyAction(null);
    }
  }

  const stateText = loading ? "HTML 시안을 불러오는 중입니다."
    : error !== null ? "HTML 시안을 불러오지 못했습니다."
      : !hasArtifact ? artifactId === null && revisionId === null && htmlSha256 === null && html === null
        ? "검토할 HTML artifact가 없습니다." : "HTML artifact 식별정보가 올바르지 않습니다."
        : !hashCheck || hashCheck.artifactId !== artifactId || hashCheck.revisionId !== revisionId
          || hashCheck.htmlSha256 !== htmlSha256 || hashCheck.html !== html
          ? "HTML 내용을 확인하는 중입니다."
          : hashCheck.error ?? reviewLabel(reviewState);
  const blockedReason = loading ? "HTML을 불러오는 중입니다."
    : error !== null ? "HTML을 불러오지 못했습니다."
      : !verified ? "정확한 artifact와 revision의 HTML 해시 검증이 필요합니다."
        : busyAction !== null ? "검토 action을 처리 중입니다."
          : "실제 검토 action이 연결되지 않았습니다.";
  const validApprovalAction = approvalAction !== null && isBoundedId(approvalAction.revisionId)
    && (approvalAction.expectedBaseRevisionId === null || isBoundedId(approvalAction.expectedBaseRevisionId));
  const approveReady = Boolean(verified && validApprovalAction && onUserApprove);
  const button = (label: string, action: ReviewAction, callback: UiHtmlReviewProps["onRequestChanges"] | UiHtmlReviewProps["onHold"], onClick: () => void) => (
    <button key={action} disabled={!verified || !callback || busyAction !== null} onClick={onClick}
      style={{ ...buttonStyle, opacity: !verified || !callback || busyAction !== null ? 0.55 : 1, cursor: !verified || !callback || busyAction !== null ? "not-allowed" : "pointer" }}
      title={!verified || !callback || busyAction !== null ? blockedReason : undefined} type="button">
      {busyAction === action ? "처리 중…" : label}
    </button>
  );

  return (
    <section aria-label="제품 HTML 승인 뷰어" style={sectionStyle}>
      <header style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0, display: "grid", gap: 4 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>제품 HTML 검토</h2>
          <div style={mutedStyle}>
            Artifact <code>{artifactId ?? "없음"}</code> · Revision <code>{revisionId ?? "없음"}</code>
          </div>
          {source && <div style={mutedStyle}>출처 {source.kind === "draft" ? "설계 초안" : "기준선"} · <code>{source.revisionId}</code></div>}
          {contractRevisionId && <div style={mutedStyle}>UI Contract · <code>{contractRevisionId}</code></div>}
          <code style={mutedStyle}>{htmlSha256 ?? "해시 없음"}</code>
        </div>
        <span aria-label="사용자 검토 상태" role="status" style={{ ...mutedStyle, border: "1px solid var(--builder-border, #414141)", borderRadius: 4, padding: "5px 8px" }}>
          {stateText}
        </span>
      </header>

      {error !== null && !loading && <p role="alert" style={{ ...mutedStyle, margin: 0 }}>{error}</p>}
      {hashCheck?.error && verified === false && hashCheck.artifactId === artifactId && hashCheck.revisionId === revisionId
        && hashCheck.htmlSha256 === htmlSha256 && hashCheck.html === html
        && <p role="alert" style={{ ...mutedStyle, margin: 0 }}>{hashCheck.error}</p>}
      {actionError !== null && <p role="alert" style={{ ...mutedStyle, margin: 0 }}>{actionError}</p>}

      <p style={{ ...mutedStyle, margin: 0 }}>
        격리된 정적 검토입니다. 임의 JavaScript 실행, 외부 URL·통신, 부모 문서 접근, 폼 제출, 다운로드, 팝업 및 최상위 이동은 허용하지 않습니다. CSS 상호작용만 확인할 수 있습니다.
      </p>
      <p style={{ ...mutedStyle, margin: 0 }}>시안 미리보기는 실제 제품 동작이나 기능 QA 통과를 뜻하지 않습니다.</p>

      {previewDocument !== null && (
        <iframe aria-label="격리된 HTML 시안" loading="eager" referrerPolicy="no-referrer" sandbox="" srcDoc={previewDocument}
          style={{ display: "block", boxSizing: "border-box", width: "100%", minWidth: 0, height: "min(72vh, 760px)", minHeight: 360,
            border: "1px solid var(--builder-border, #414141)", borderRadius: 4, background: "#fff" }}
          title={`HTML 시안 ${artifactId} · ${revisionId}`} />
      )}

      {interactions.length > 0 && <section aria-label="UI Contract 동작 검토" style={{ display: "grid", gap: 8, minWidth: 0 }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>UI Contract 동작</h3>
        {interactions.map(interaction => <article key={interaction.id} style={{ display: "grid", gap: 6, minWidth: 0,
          padding: 10, border: "1px solid var(--builder-border, #363636)", borderRadius: 4 }}>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, overflowWrap: "anywhere" }}>
            <input aria-label={`${interaction.id} 동작 검토 승인`} checked={selectedInteractionIds.has(interaction.id)}
              onChange={event => {
                const checked = event.currentTarget.checked;
                setSelectedInteractionIds(previous => {
                  const next = new Set(previous);
                  if (checked) next.add(interaction.id);
                  else next.delete(interaction.id);
                  return next;
                });
              }} type="checkbox" />
            <span><strong>{interaction.id}</strong> · 화면 {interaction.screenId} · {interaction.status === "specified" ? "명세됨" : interaction.status === "unknown" ? "미확인" : "미연결"}</span>
          </label>
          <div style={mutedStyle}>요구: {interaction.requirementRefs.join(", ") || "없음"} · 동작: {interaction.behaviorRefs.join(", ") || "없음"}</div>
          <div style={mutedStyle}>상태: {interaction.stateRefs.join(", ") || "없음"} · API: {interaction.apiRefs.join(", ") || "없음"}</div>
          <div style={mutedStyle}>선행 조건: {interaction.preconditions.join(" · ") || "없음"} · 결과: {interaction.outcomes.join(" · ") || "없음"}</div>
          <div style={mutedStyle}>금지 동작: {interaction.prohibited.join(" · ") || "없음"} · 검증 기준: {interaction.validationCriteria.join(" · ") || "없음"}</div>
        </article>)}
      </section>}

      <footer aria-label="사용자 HTML 검토 action" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button disabled={!approveReady || busyAction !== null} onClick={() => void approve()}
          style={{ ...buttonStyle, opacity: !approveReady || busyAction !== null ? 0.55 : 1, cursor: !approveReady || busyAction !== null ? "not-allowed" : "pointer" }}
          title={!approveReady || busyAction !== null ? approvalAction ? blockedReason : "UI proposal 승인 action 정보가 연결되지 않았습니다." : undefined} type="button">
          {busyAction === "approve" ? "처리 중…" : "사용자 승인"}
        </button>
        {button("수정 요청", "changes", onRequestChanges, () => void runAction("changes", onRequestChanges))}
        {button("보류", "hold", onHold, () => void runAction("hold", onHold))}
      </footer>
    </section>
  );
}
