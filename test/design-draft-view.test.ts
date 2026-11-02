import assert from "node:assert/strict";
import test from "node:test";
import { parseDesignDraftView, projectDesignDraft } from "../src/domain/design-draft-view.ts";
import { createEmptyBuilderSnapshot } from "../src/domain/snapshot.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
function payload() {
  return { workspaceId, projectId: workspaceId, selectionRevision: 1, agentId, sequence: 1,
    createdAt: "2026-11-02T00:00:00.000Z", draft: { projectId: workspaceId, revisionId: "draft-1",
      sourceIds: ["consultation-33333333-3333-4333-8333-333333333333"],
      specification: { revisionId: "spec-1", productTier: "M", requirements: [{ id: "REQ-1",
        description: "Render <script> as plain text", acceptanceCriteriaIds: ["AC-1"] }], targets: ["desktop"], dataPolicyRef: "unreviewed-policy" },
      graph: { graphRevisionId: "graph-1", entities: [{ id: "REQ-1", kind: "requirement", specRef: "REQ-1" }],
        relations: [], viewLayoutRef: "layout-1" },
      questions: [{ id: "Q-1", title: "Choose", text: "Which option?", options: [{ id: "A", label: "First", tradeoff: "Simple" }], recommendation: "A" }] } };
}

test("draft projection is non-mutating, read-only and never invents verified work or approval", () => {
  const snapshot = createEmptyBuilderSnapshot(workspaceId);
  const original = structuredClone(snapshot);
  const input = payload();
  const view = parseDesignDraftView(input, workspaceId, 1, agentId);
  input.draft.specification.requirements[0]!.description = "mutated caller data";
  assert(Object.isFrozen(view.draft));
  const projected = projectDesignDraft(snapshot, view);
  assert.deepEqual(snapshot, original);
  assert.equal(projected.graph.revisionId, "graph-1");
  assert.equal(projected.graph.entities[0]?.label, "Render <script> as plain text");
  assert.equal(projected.graph.entities[0]?.status, "planned");
  assert.equal(projected.graph.entities[0]?.ownerActorId, null);
  assert.deepEqual(projected.graph.entities[0]?.evidenceRefs, []);
  assert.equal(projected.questions[0]?.status, "open");
  assert.equal(projected.questions[0]?.answer, null);
  assert.equal(projected.questions[0]?.recommendation, "First");
  assert.match(projected.documents[0]!.title, /초안.*승인 전/);
  assert.deepEqual(projected.actors, []);
  assert.deepEqual(projected.messages, []);
  assert.deepEqual(projected.integrations, original.integrations);
});

test("view rejects stale selection, cross-Workspace/project/Agent and malformed metadata", () => {
  for (const change of [{ workspaceId: agentId }, { projectId: "different-project" }, { selectionRevision: 2 },
    { agentId: workspaceId }, { sequence: 0 }, { sequence: Infinity }, { createdAt: "invalid" },
    { createdAt: "2026-11-02" }, { approved: true }]) {
    assert.throws(() => parseDesignDraftView({ ...payload(), ...change }, workspaceId, 1, agentId));
  }
  let accessed = false;
  const input = payload();
  Object.defineProperty(input, "draft", { enumerable: true, get() { accessed = true; throw new Error("getter"); } });
  assert.throws(() => parseDesignDraftView(input, workspaceId, 1, agentId));
  assert.equal(accessed, false);
  assert.throws(() => projectDesignDraft(createEmptyBuilderSnapshot(agentId),
    parseDesignDraftView(payload(), workspaceId, 1, agentId)), /different Workspace/);
});

test("stored answer interpretation projects answered status and exact current revision context, not approval", () => {
  const input = payload();
  const decisions = [{ questionId: "Q-1", questionDigest: "a".repeat(64),
    answerSourceId: "lead-turn:44444444-4444-4444-8444-444444444444", answerSourceSha256: "b".repeat(64),
    answerText: "Use the first option.", fromDraftRevisionId: "draft-0", appliedDraftRevisionId: "draft-1" }];
  const view = parseDesignDraftView({ ...input, decisions }, workspaceId, 1, agentId);
  decisions[0]!.answerText = "caller mutation";
  const projected = projectDesignDraft(createEmptyBuilderSnapshot(workspaceId), view);
  assert.equal(projected.questions[0]?.status, "answered");
  assert.equal(projected.questions[0]?.answer, "Use the first option.");
  assert.deepEqual(projected.questions[0]?.questionContext, { projectId: workspaceId, draftRevisionId: "draft-1", questionId: "Q-1" });
  assert.equal(projected.graph.entities[0]?.status, "planned");
  assert.match(projected.documents[0]!.title, /승인 전/);
});
