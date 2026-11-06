import { createHash } from "node:crypto";
import type { PluginJobContext } from "@sonparkserver/plugin-sdk/platform";
import type { UiApproval } from "./domain.ts";

export const UI_REVIEW_DISPATCH_JOB_KEY = "builder.ui-review-dispatch";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted", "timed_out"]);

export type UiReviewDispatchRequest = Readonly<{
  state: "missing" | "prepared" | "dispatching" | "uncertain" | "submitted" | "succeeded" | "failed" | "cancelled" | "interrupted" | "timed_out";
  leadRunId: string | null;
  coreReceiptRunId: string | null;
}>;
export type UiReviewApprovalEntry = Readonly<{ cursor: string; approval: UiApproval }>;
export type UiReviewDispatchResult = Readonly<{
  status: "caught-up" | "waiting" | "saved-unconfirmed" | "run-accepted" | "already-accepted";
  approvalRevisionId?: string;
  requestId?: string;
  runId?: string;
}>;

/** These adapters must use the existing Workspace approval journal and Lead Main conversation. */
export type UiReviewDispatchAdapters = Readonly<{
  /** Published approval journal entries in ascending sequence, with a stable continuation cursor. */
  listApprovals(workspaceId: string, cursor: string | null): Promise<Readonly<{
    entries: readonly UiReviewApprovalEntry[];
    nextCursor: string | null;
  }>>;
  readRequest(workspaceId: string, requestId: string): Promise<UiReviewDispatchRequest>;
  reconcileRequest(workspaceId: string, requestId: string): Promise<void>;
  sendMain(workspaceId: string, requestId: string, prompt: string): Promise<void>;
}>;

export function uiReviewRequestId(workspaceId: string, approvalRevisionId: string): string {
  if (!UUID.test(workspaceId) || !approvalRevisionId.trim() || approvalRevisionId.length > 160) {
    throw new TypeError("A valid Workspace and approval revision are required.");
  }
  const bytes = createHash("sha256").update(JSON.stringify(["builder-ui-approval-v1", workspaceId, approvalRevisionId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uiReviewApprovalPrompt(approval: UiApproval): string {
  return [
    "An authenticated user action stored a UI review approval in this Workspace.",
    `Read builder.read-ui-contracts with proposalRevisionId ${JSON.stringify(approval.proposalRevisionId)} and approvalRevisionId ${JSON.stringify(approval.revisionId)}.`,
    "Verify the exact stored user approval, proposal HTML hash and source currentness before publishing a formal UI revision using builder.publish-ui-contract.",
    "This system notification is not a user statement, product design approval, QA, execution permission or final delivery approval. Do not modify the reviewed proposal.",
  ].join("\n");
}

function validRequest(value: UiReviewDispatchRequest): UiReviewDispatchRequest {
  if (!value || !["missing", "prepared", "dispatching", "uncertain", "submitted", ...TERMINAL].includes(value.state)
    || value.leadRunId !== null && (typeof value.leadRunId !== "string" || !value.leadRunId.trim())
    || value.coreReceiptRunId !== null && (typeof value.coreReceiptRunId !== "string" || !value.coreReceiptRunId.trim())) {
    throw new TypeError("Lead request state is malformed.");
  }
  if (value.coreReceiptRunId !== null && value.leadRunId !== null && value.coreReceiptRunId !== value.leadRunId) {
    throw new Error("Lead request and Core receipt identify different runs.");
  }
  return value;
}

function resultFor(approvalRevisionId: string, requestId: string, request: UiReviewDispatchRequest): UiReviewDispatchResult {
  const validated = validRequest(request);
  const runId = validated.coreReceiptRunId;
  if (runId) return Object.freeze({ status: "already-accepted", approvalRevisionId, requestId, runId });
  if (validated.state === "missing" || validated.state === "prepared") return Object.freeze({ status: "waiting", approvalRevisionId, requestId });
  return Object.freeze({ status: "saved-unconfirmed", approvalRevisionId, requestId });
}

/** Caller holds the Workspace write serialization boundary. Advances only over requests with an actual Core receipt. */
export async function dispatchNextUiReviewApproval(job: Pick<PluginJobContext, "jobKey" | "companyId">,
  adapters: UiReviewDispatchAdapters): Promise<UiReviewDispatchResult> {
  if (job.jobKey !== UI_REVIEW_DISPATCH_JOB_KEY) throw new Error("Unexpected UI review dispatch job key.");
  const workspaceId = job.companyId;
  if (typeof workspaceId !== "string" || !UUID.test(workspaceId)) {
    throw new Error("UI review dispatch requires a Workspace-scoped job; Host jobs are not supported.");
  }

  let cursor: string | null = null;
  let lastAccepted: UiReviewDispatchResult | null = null;
  const seenCursors = new Set<string>();
  for (let pageNumber = 0; pageNumber < 1_000; pageNumber += 1) {
    const page = await adapters.listApprovals(workspaceId, cursor);
    if (!page || !Array.isArray(page.entries) || page.entries.length > 50
      || page.nextCursor !== null && (typeof page.nextCursor !== "string" || !page.nextCursor.trim())) {
      throw new TypeError("Approval journal page is malformed.");
    }
    for (const entry of page.entries) {
      if (!entry || typeof entry.cursor !== "string" || !entry.cursor.trim()) throw new TypeError("Approval journal entry is malformed.");
      const approval = entry.approval;
      if (!approval || approval.projectId !== workspaceId || !UUID.test(approval.revisionId)) throw new Error("Approval journal identity is invalid.");
      const requestId = uiReviewRequestId(workspaceId, approval.revisionId);
      let request = validRequest(await adapters.readRequest(workspaceId, requestId));

      if (request.coreReceiptRunId !== null) {
        // Only a verified Core receipt is consumption. Keep the turn's Lead run ID consistent.
        if (request.leadRunId !== null && request.leadRunId !== request.coreReceiptRunId) throw new Error("Lead run differs from the Core request receipt.");
        lastAccepted = Object.freeze({ status: "already-accepted", approvalRevisionId: approval.revisionId,
          requestId, runId: request.coreReceiptRunId });
        continue;
      }
      if (request.state === "dispatching" || request.state === "uncertain" || request.state === "submitted" || TERMINAL.has(request.state)) {
        await adapters.reconcileRequest(workspaceId, requestId);
        request = validRequest(await adapters.readRequest(workspaceId, requestId));
        if (request.coreReceiptRunId !== null) {
          lastAccepted = Object.freeze({ status: "already-accepted", approvalRevisionId: approval.revisionId,
            requestId, runId: request.coreReceiptRunId });
          continue;
        }
        return resultFor(approval.revisionId, requestId, request);
      }

      try {
        await adapters.sendMain(workspaceId, requestId, uiReviewApprovalPrompt(approval));
      } catch {
        // A failed attempt may already have reached Core. Reconcile the same key; never mint another request.
        await adapters.reconcileRequest(workspaceId, requestId).catch(() => undefined);
      }
      request = validRequest(await adapters.readRequest(workspaceId, requestId));
      if (request.coreReceiptRunId !== null) {
        return Object.freeze({ status: "run-accepted", approvalRevisionId: approval.revisionId, requestId, runId: request.coreReceiptRunId });
      }
      return resultFor(approval.revisionId, requestId, request);
    }
    if (page.nextCursor === null) return lastAccepted ?? Object.freeze({ status: "caught-up" });
    if (seenCursors.has(page.nextCursor) || page.nextCursor === cursor) throw new Error("Approval journal cursor did not advance.");
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("Approval journal scan exceeded the bounded history limit.");
}
