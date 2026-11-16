import assert from "node:assert/strict";
import test from "node:test";
import type { UiApproval } from "../src/ui-contracts/domain.ts";
import { dispatchNextUiReviewApproval, UI_REVIEW_DISPATCH_JOB_KEY, uiReviewRequestId,
  uiReviewApprovalPrompt, type UiReviewDispatchAdapters, type UiReviewDispatchRequest } from "../src/ui-contracts/review-dispatch.ts";

const workspaceId = "123e4567-e89b-42d3-a456-426614174000";
const approvalId = "223e4567-e89b-42d3-a456-426614174000";
const otherApprovalId = "323e4567-e89b-42d3-a456-426614174000";
const sha = "a".repeat(64);
function approval(revisionId = approvalId): UiApproval {
  return { projectId: workspaceId, revisionId, expectedBaseRevisionId: null, proposalRevisionId: "proposal-1",
    proposalDigest: sha, htmlSha256: sha, contractRevisionId: "contract-1", approvedInteractionIds: [],
    actorUserId: "user-1", approvedAt: "2026-11-06T00:00:00.000Z" };
}
const job = { jobKey: UI_REVIEW_DISPATCH_JOB_KEY, companyId: workspaceId };
const missing: UiReviewDispatchRequest = { state: "missing", leadRunId: null, coreReceiptRunId: null };
function adapters(overrides: Partial<UiReviewDispatchAdapters> = {}): UiReviewDispatchAdapters {
  return {
    async listApprovals() { return { entries: [{ cursor: "1", approval: approval() }], nextCursor: null }; },
    async readRequest() { return missing; },
    async reconcileRequest() {},
    async sendMain() {},
    ...overrides,
  };
}

test("derives a stable distinct Main request ID for each Workspace approval", () => {
  assert.equal(uiReviewRequestId(workspaceId, approvalId), uiReviewRequestId(workspaceId, approvalId));
  assert.notEqual(uiReviewRequestId(workspaceId, approvalId), uiReviewRequestId(workspaceId, otherApprovalId));
  assert.match(uiReviewRequestId(workspaceId, approvalId), /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(uiReviewApprovalPrompt(approval()), [
    "An authenticated user action stored a UI review approval in this Workspace.",
    `Read builder.read-ui-contracts with proposalRevisionId "proposal-1" and approvalRevisionId "${approvalId}".`,
    "Verify the exact stored user approval, proposal HTML hash and source currentness before publishing a formal UI revision using builder.publish-ui-contract.",
    "This system notification is not a user statement, product design approval, QA, execution permission or final delivery approval. Do not modify the reviewed proposal.",
  ].join("\n"));
});

test("rejects Host-scoped and mismatched job invocations before reading approvals", async () => {
  let reads = 0;
  const deps = adapters({ async listApprovals() { reads += 1; return { entries: [], nextCursor: null }; } });
  await assert.rejects(dispatchNextUiReviewApproval({ jobKey: UI_REVIEW_DISPATCH_JOB_KEY }, deps), /Workspace-scoped/u);
  await assert.rejects(dispatchNextUiReviewApproval({ jobKey: "other-job", companyId: workspaceId }, deps), /Unexpected/u);
  assert.equal(reads, 0);
});

test("does not report a saved conversation request as an accepted Core run", async () => {
  const sent: string[] = [];
  let readCount = 0;
  const result = await dispatchNextUiReviewApproval(job, adapters({
    async sendMain(_workspace, requestId) { sent.push(requestId); },
    async readRequest() {
      readCount += 1;
      return readCount === 1 ? { state: "prepared", leadRunId: null, coreReceiptRunId: null }
        : { state: "uncertain", leadRunId: null, coreReceiptRunId: null };
    },
  }));
  assert.equal(result.status, "saved-unconfirmed");
  assert.deepEqual(sent, [uiReviewRequestId(workspaceId, approvalId)]);
});

test("reconciles uncertain requests without resending and requires a verified Core receipt", async () => {
  let sendCalls = 0;
  let reconciles = 0;
  const result = await dispatchNextUiReviewApproval(job, adapters({
    async readRequest() { return { state: "uncertain", leadRunId: null, coreReceiptRunId: null }; },
    async reconcileRequest() { reconciles += 1; },
    async sendMain() { sendCalls += 1; },
  }));
  assert.equal(result.status, "saved-unconfirmed");
  assert.equal(sendCalls, 0);
  assert.equal(reconciles, 1);
});

test("reports a newly accepted run only after the keyed Core receipt exists", async () => {
  let sent = false;
  const result = await dispatchNextUiReviewApproval(job, adapters({
    async sendMain() { sent = true; },
    async readRequest() { return sent ? { state: "submitted", leadRunId: "run-1", coreReceiptRunId: "run-1" } : missing; },
  }));
  assert.deepEqual(result, { status: "run-accepted", approvalRevisionId: approvalId,
    requestId: uiReviewRequestId(workspaceId, approvalId), runId: "run-1" });
});

test("skips consumed approvals and advances to the next approval by journal cursor", async () => {
  const sent: string[] = [];
  let listedSecondPage = false;
  const result = await dispatchNextUiReviewApproval(job, adapters({
    async listApprovals(_workspaceId, cursor) {
      if (cursor === null) return { entries: [{ cursor: "approval-1", approval: approval() }], nextCursor: "approval-1" };
      listedSecondPage = true;
      return { entries: [{ cursor: "approval-2", approval: approval(otherApprovalId) }], nextCursor: null };
    },
    async readRequest(_workspaceId, requestId) {
      return requestId === uiReviewRequestId(workspaceId, approvalId)
        ? { state: "succeeded", leadRunId: "run-1", coreReceiptRunId: "run-1" } : missing;
    },
    async sendMain(_workspaceId, requestId) { sent.push(requestId); },
  }));
  assert.equal(listedSecondPage, true);
  assert.deepEqual(sent, [uiReviewRequestId(workspaceId, otherApprovalId)]);
  assert.equal(result.approvalRevisionId, otherApprovalId);
});

test("busy or transient send failure can be retried later with the same request key", async () => {
  let busy = true;
  const sent: string[] = [];
  let existing: UiReviewDispatchRequest = missing;
  const deps = adapters({
    async readRequest() { return existing; },
    async sendMain(_workspaceId, requestId) {
      sent.push(requestId);
      if (busy) throw new Error("Main is busy");
      existing = { state: "dispatching", leadRunId: null, coreReceiptRunId: null };
    },
  });
  assert.equal((await dispatchNextUiReviewApproval(job, deps)).status, "waiting");
  busy = false;
  assert.equal((await dispatchNextUiReviewApproval(job, deps)).status, "saved-unconfirmed");
  assert.deepEqual(sent, [uiReviewRequestId(workspaceId, approvalId), uiReviewRequestId(workspaceId, approvalId)]);
});

test("does not turn an unchanged uncertain attempt into a duplicate send on later job runs", async () => {
  let sendCalls = 0;
  const deps = adapters({
    async readRequest() { return { state: "uncertain", leadRunId: null, coreReceiptRunId: null }; },
    async sendMain() { sendCalls += 1; },
  });
  const first = await dispatchNextUiReviewApproval(job, deps);
  const later = await dispatchNextUiReviewApproval(job, deps);
  assert.equal(first.status, "saved-unconfirmed");
  assert.equal(later.status, "saved-unconfirmed");
  assert.equal(sendCalls, 0);
});
