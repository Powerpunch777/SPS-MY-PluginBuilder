import { useMemo, useRef, useState } from "react";
import { UiHtmlReview, type ApproveUiProposalInput } from "./UiHtmlReview.tsx";
import type { UiApproval, UiInteraction, UiRevision } from "../ui-contracts/domain.ts";

type View = { proposal: UiRevision | null; approval: UiApproval | null; formal: UiRevision | null;
  approvalHeadId: string | null; proposalCurrent: boolean };
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const bounded = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 160;

function revision(value: unknown, workspaceId: string): UiRevision | null {
  if (value === null) return null;
  if (!plain(value) || !bounded(value.revisionId) || value.projectId !== workspaceId
    || !plain(value.artifact) || !bounded(value.artifact.artifactId) || typeof value.artifact.html !== "string"
    || typeof value.artifact.htmlSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.artifact.htmlSha256)
    || !plain(value.source) || !["draft", "baseline"].includes(value.source.kind as string) || !bounded(value.source.revisionId)
    || !plain(value.contract) || value.contract.projectId !== workspaceId || !bounded(value.contract.revisionId)
    || !Array.isArray(value.contract.interactions) || value.contract.interactions.length > 2000) throw new TypeError("Invalid UI proposal view.");
  for (const interaction of value.contract.interactions) {
    if (!plain(interaction) || !bounded(interaction.id) || !bounded(interaction.screenId)
      || !["specified", "unknown", "unconnected"].includes(interaction.status as string)) throw new TypeError("Invalid UI interaction view.");
    for (const field of ["requirementRefs", "behaviorRefs", "stateRefs", "apiRefs", "preconditions", "outcomes", "prohibited", "validationCriteria"]) {
      const values = interaction[field];
      if (!Array.isArray(values) || values.length > 256 || !values.every(bounded)) throw new TypeError("Invalid UI interaction references.");
    }
  }
  return value as unknown as UiRevision;
}

export function parseUiContractPanelView(value: unknown, workspaceId: string): View {
  if (value === null) return { proposal: null, approval: null, formal: null, approvalHeadId: null, proposalCurrent: false };
  if (!plain(value) || value.workspaceId !== workspaceId || value.projectId !== workspaceId
    || typeof value.proposalCurrent !== "boolean" || value.approvalHeadId !== null && !bounded(value.approvalHeadId)) {
    throw new TypeError("Invalid or foreign UI contract view.");
  }
  const proposal = revision(value.proposal, workspaceId), formal = revision(value.formal, workspaceId);
  const approval = value.approval;
  if (approval !== null && (!plain(approval) || approval.projectId !== workspaceId || !bounded(approval.revisionId)
    || !bounded(approval.proposalRevisionId) || typeof approval.htmlSha256 !== "string"
    || !Array.isArray(approval.approvedInteractionIds) || !approval.approvedInteractionIds.every(bounded))) {
    throw new TypeError("Invalid UI approval view.");
  }
  return { proposal, formal, approval: approval as UiApproval | null, approvalHeadId: value.approvalHeadId as string | null,
    proposalCurrent: value.proposalCurrent };
}

export function UiContractPanel({ workspaceId, value, loading, unavailable, approve, retryNotification, refresh }: {
  workspaceId: string; value: unknown; loading: boolean; unavailable: boolean;
  approve(input: ApproveUiProposalInput): Promise<unknown>; refresh(): void;
  retryNotification?(input: { approvalRevisionId: string }): Promise<unknown>;
}) {
  const parsed = useMemo(() => {
    if (loading || unavailable) return { view: null, error: null };
    try { return { view: parseUiContractPanelView(value, workspaceId), error: null }; }
    catch { return { view: null, error: "UI 시안과 승인 기록을 확인하지 못했습니다." }; }
  }, [workspaceId, value, loading, unavailable]);
  const pending = useRef<{ key: string; input: ApproveUiProposalInput } | null>(null);
  const displayRequest = useRef(crypto.randomUUID());
  const [delivery, setDelivery] = useState<{ revisionId: string; state: string } | null>(null);
  const view = parsed.view;
  const proposal = view?.proposal ?? null;
  const review = view?.approval;
  const reviewed = Boolean(proposal && review && review.proposalRevisionId === proposal.revisionId
    && review.htmlSha256 === proposal.artifact.htmlSha256);
  const approved = new Set(reviewed ? review?.approvedInteractionIds : []);
  const fullyReviewed = Boolean(proposal && proposal.contract.interactions.length > 0
    && proposal.contract.interactions.every(item => item.status === "specified" && approved.has(item.id)));
  const canApprove = Boolean(proposal && view?.proposalCurrent && !loading && !unavailable && !parsed.error);
  const formalPublished = Boolean(reviewed && view?.formal?.approvalRevisionId === review?.revisionId);
  const deliveryState = delivery?.revisionId === review?.revisionId ? delivery?.state : undefined;
  return <section className="builder-ui-contract-panel">
    {proposal && !view?.proposalCurrent && <p role="status">현재 설계와 다른 시안입니다. 이전 내용은 조회할 수 있지만 새 승인은 할 수 없습니다.</p>}
    {reviewed && <p role="status">동작 {approved.size}/{proposal?.contract.interactions.length ?? 0}개 승인 기록
      {formalPublished ? " · Main 공식 발행됨" : " · Main 공식 발행 대기"}</p>}
    {reviewed && review && view?.proposalCurrent && !formalPublished && retryNotification && <div>
      <button type="button" disabled={deliveryState === "sending" || deliveryState === "run-accepted"} onClick={async () => {
        const revisionId = review.revisionId;
        setDelivery({ revisionId, state: "sending" });
        try {
          const result = await retryNotification({ approvalRevisionId: revisionId });
          setDelivery({ revisionId, state: plain(result) && typeof result.status === "string" ? result.status : "unconfirmed" });
        } catch { setDelivery({ revisionId, state: "unconfirmed" }); }
        finally { refresh(); }
      }}>Main 검토 요청 확인</button>
      {deliveryState === "run-accepted" && <p role="status">Main 실행 요청이 접수됐습니다. 공식 발행은 아직 확인되지 않았습니다.</p>}
      {deliveryState === "unconfirmed" && <p role="status">승인 기록은 보존됐습니다. Main 실행 접수는 확인되지 않았습니다.</p>}
    </div>}
    <UiHtmlReview artifactId={proposal?.artifact.artifactId ?? null} revisionId={proposal?.revisionId ?? null}
      htmlSha256={proposal?.artifact.htmlSha256 ?? null} html={proposal?.artifact.html ?? null}
      source={proposal?.source ?? null} contractRevisionId={proposal?.contract.revisionId ?? null}
      interactions={proposal?.contract.interactions as readonly UiInteraction[] | undefined} loading={loading}
      error={parsed.error ?? (unavailable ? "UI 시안을 불러오지 못했습니다." : null)} reviewState={fullyReviewed ? "approved" : "pending"}
      approvalAction={canApprove ? { revisionId: displayRequest.current, expectedBaseRevisionId: view?.approvalHeadId ?? null } : null}
      onUserApprove={canApprove ? async input => {
        const key = JSON.stringify([workspaceId, input.proposalRevisionId, input.htmlSha256, [...input.approvedInteractionIds].sort()]);
        if (pending.current?.key !== key) pending.current = { key, input: { ...input, revisionId: crypto.randomUUID() } };
        const request = pending.current.input;
        try {
          const result = await approve(request);
          if (!plain(result) || result.status !== "published" && result.status !== "replayed") {
            if (plain(result) && result.status === "conflict") pending.current = null;
            throw new Error("UI approval was not confirmed.");
          }
          if (plain(result.mainNotification) && typeof result.mainNotification.status === "string") {
            setDelivery({ revisionId: request.revisionId, state: result.mainNotification.status });
          }
        } finally { refresh(); }
      } : undefined} />
  </section>;
}
