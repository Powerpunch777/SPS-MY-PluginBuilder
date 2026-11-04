import assert from "node:assert/strict";
import test from "node:test";
import { deriveUiReviewStatuses, parseUiRevision, parseUiContract, sha256Utf8 } from "./domain.ts";

const projectId = "sample-project";
const mainSession = "33333333-3333-4333-8333-333333333333";
const approvalSourceId = "lead-turn:11111111-1111-4111-8111-111111111111";

function contract() {
  return {
    projectId, revisionId: "contract-r1", screenIds: ["home"], interactions: [
      { id: "save-button", screenId: "home", requirementRefs: ["REQ-1"], behaviorRefs: ["ACT-1"], stateRefs: [], apiRefs: ["API-1"],
        preconditions: ["form valid"], outcomes: ["saved"], prohibited: ["no implicit publish"],
        validationCriteria: ["save is explicit"], status: "specified" },
      { id: "empty-state", screenId: "home", requirementRefs: ["REQ-2"], behaviorRefs: [], stateRefs: ["STATE-EMPTY"], apiRefs: [],
        preconditions: [], outcomes: ["show empty"], prohibited: [], validationCriteria: ["no sample data"], status: "specified" },
      { id: "future-control", screenId: "home", requirementRefs: [], behaviorRefs: [], stateRefs: [], apiRefs: [], preconditions: [],
        outcomes: [], prohibited: [], validationCriteria: [], status: "unconnected" },
    ],
  };
}

function revision(overrides: Record<string, unknown> = {}) {
  const html = "<main><button data-ui-id=\"save-button\">Save</button></main>";
  return {
    projectId, revisionId: "ui-r1", sourceBaselineRevisionId: "baseline-r1", sourceBaselineDigest: "b".repeat(64),
    sourceSpecRevisionId: "spec-r1", sourceProposalRevisionId: "proposal-r1", previousRevisionId: null,
    artifact: { artifactId: "artifact-r1", html, htmlSha256: sha256Utf8(html), screenIds: ["home"],
      viewport: { width: 1280, height: 800 }, sourceSessionId: mainSession, sourceSpecRevisionId: "spec-r1" },
    contract: contract(), approvalSource: { sourceId: approvalSourceId, sourceSha256: "a".repeat(64) },
    publication: "formal", reviewByInteractionId: { "save-button": "UNKNOWN", "empty-state": "UNKNOWN", "future-control": "UNCONNECTED" },
    ...overrides,
  };
}

test("HTML hash covers exact UTF-8 bytes and preserves the artifact text", () => {
  const parsed = parseUiRevision(revision(), projectId);
  assert.equal(parsed.artifact.html, revision().artifact.html);
  assert.equal(parsed.artifact.htmlSha256, sha256Utf8(parsed.artifact.html));
  assert.throws(() => parseUiRevision({ ...revision(), artifact: { ...revision().artifact, htmlSha256: "0".repeat(64) } }, projectId), /does not match/);
  const invalidHtml = "<main>\ud800</main>";
  assert.throws(() => parseUiRevision({ ...revision(), artifact: { ...revision().artifact, html: invalidHtml,
    htmlSha256: sha256Utf8(invalidHtml) } }, projectId), /512 KiB/);
});

test("revision and contract reject a forged Workspace or mismatched Spec revision", () => {
  assert.throws(() => parseUiRevision({ ...revision(), projectId: "other-project" }, projectId), /another project/);
  assert.throws(() => parseUiRevision({ ...revision(), artifact: { ...revision().artifact, sourceSpecRevisionId: "spec-r2" } }, projectId), /another Spec revision/);
});

test("interaction records reject unsupported behavior and preserve explicit UNKNOWN or unconnected state", () => {
  const parsed = parseUiContract(contract(), projectId);
  assert.equal(parsed.interactions[2]?.status, "unconnected");
  const bad = contract();
  bad.interactions[2]!.status = "specified";
  assert.throws(() => parseUiContract(bad, projectId), /needs reference links/);
});

test("partial impact marks only matching linked interactions for review", () => {
  const parsed = parseUiContract(contract(), projectId);
  const statuses = deriveUiReviewStatuses(parsed, ["API-1"], {
    "save-button": "APPROVED", "empty-state": "APPROVED", "future-control": "UNCONNECTED",
  });
  assert.deepEqual({ ...statuses }, { "save-button": "REVIEW_REQUIRED", "empty-state": "APPROVED", "future-control": "UNCONNECTED" });
});

test("unchanged review-required history remains required and unrelated approved history remains approved", () => {
  const parsed = parseUiContract(contract(), projectId);
  const statuses = deriveUiReviewStatuses(parsed, [], {
    "save-button": "REVIEW_REQUIRED", "empty-state": "APPROVED", "future-control": "UNCONNECTED",
  }, parsed);
  assert.deepEqual({ ...statuses }, { "save-button": "REVIEW_REQUIRED", "empty-state": "APPROVED", "future-control": "UNCONNECTED" });
});

test("a reference with no interaction coverage stays UNKNOWN instead of claiming no impact", () => {
  const parsed = parseUiContract(contract(), projectId);
  const statuses = deriveUiReviewStatuses(parsed, ["API-NOT-MAPPED"], {
    "save-button": "APPROVED", "empty-state": "APPROVED", "future-control": "UNCONNECTED",
  });
  assert.equal(statuses["save-button"], "UNKNOWN");
  assert.equal(statuses["empty-state"], "UNKNOWN");
  assert.equal(statuses["future-control"], "UNCONNECTED");
});

test("removed and moved references affect old and new interaction owners", () => {
  const previousContract = parseUiContract(contract(), projectId);
  const currentRaw = contract();
  currentRaw.interactions[0]!.requirementRefs = ["REQ-2"];
  currentRaw.interactions[2]!.status = "unconnected";
  const emptyState = currentRaw.interactions[1]!;
  emptyState.requirementRefs = ["REQ-1"];
  emptyState.stateRefs = [];
  const current = parseUiContract(currentRaw, projectId);
  const moved = deriveUiReviewStatuses(current, ["REQ-1"], {
    "save-button": "APPROVED", "empty-state": "APPROVED", "future-control": "UNCONNECTED",
  }, previousContract);
  assert.equal(moved["save-button"], "REVIEW_REQUIRED");
  assert.equal(moved["empty-state"], "REVIEW_REQUIRED");
  assert.equal(moved["future-control"], "UNCONNECTED");

  const oldOnlyRaw = contract();
  oldOnlyRaw.interactions[0]!.apiRefs = ["API-REMOVED"];
  const oldOnly = parseUiContract(oldOnlyRaw, projectId);
  const afterRemoval = parseUiContract(contract(), projectId);
  const removed = deriveUiReviewStatuses(afterRemoval, ["API-REMOVED"], {
    "save-button": "APPROVED", "empty-state": "APPROVED", "future-control": "UNCONNECTED",
  }, oldOnly);
  assert.equal(removed["save-button"], "REVIEW_REQUIRED");
  assert.equal(removed["empty-state"], "UNKNOWN");
});

test("a reused interaction ID with changed content or status requires review", () => {
  const previousContract = parseUiContract(contract(), projectId);
  const updatedRaw = contract();
  updatedRaw.interactions[0]!.outcomes = ["saved and audited"];
  updatedRaw.interactions[0]!.status = "unknown";
  const updated = parseUiContract(updatedRaw, projectId);
  const statuses = deriveUiReviewStatuses(updated, [], {
    "save-button": "APPROVED", "empty-state": "APPROVED", "future-control": "UNCONNECTED",
  }, previousContract);
  assert.equal(statuses["save-button"], "REVIEW_REQUIRED");
  assert.equal(statuses["empty-state"], "APPROVED");
});

test("caller supplied review state must cover exactly known interactions", () => {
  assert.throws(() => parseUiRevision(revision({ reviewByInteractionId: { "save-button": "APPROVED" } }), projectId), /each interaction/);
  assert.throws(() => parseUiRevision(revision({ reviewByInteractionId: {
    "save-button": "APPROVED", "empty-state": "APPROVED", "future-control": "UNCONNECTED", invented: "APPROVED",
  } }), projectId), /unknown interaction/);
});
