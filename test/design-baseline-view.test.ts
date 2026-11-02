import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyBuilderSnapshot } from "../src/domain/snapshot.ts";
import { projectDesignBaseline } from "../src/domain/design-baseline-view.ts";

const workspace = "project-1";
const digest = "a".repeat(64);
const leadTurnId = "lead-turn:44444444-4444-4444-8444-444444444444";

function baseline() {
  return {
    projectId: workspace,
    revisionId: "baseline-r01",
    sourceDraftRevisionId: "draft-r01",
    draftDigest: digest,
    createdAt: "2026-11-02T01:02:03.004Z",
    author: {
      agentId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      runId: "33333333-3333-4333-8333-333333333333",
      selectionRevision: 1,
    },
    userDecision: { sourceId: leadTurnId, sourceSha256: digest, interpretation: "Build the approved workflow." },
    specification: {
      projectId: workspace,
      revisionId: "spec-r01",
      productTier: "M",
      requirements: [{ id: "REQ-1", description: "A required feature", acceptanceCriteriaIds: ["AC-1"] }],
      targets: ["sps-plugin"],
      dataPolicyRef: "policy-r01",
      approvalEvidenceRef: leadTurnId,
    },
    graph: {
      approvedSpecRevisionId: "spec-r01",
      graphRevisionId: "graph-r01",
      entities: [{ id: "feature-a", kind: "feature", specRef: "REQ-1", contractRefs: ["API-1"] }],
      relations: [],
      viewLayoutRef: "layout-r01",
    },
  };
}

function view(overrides: Record<string, unknown> = {}) {
  return { workspaceId: workspace, projectId: workspace, sequence: 1, baseline: baseline(), ...overrides };
}

test("adds the scoped baseline as an interpreted document without changing graph or activity state", () => {
  const snapshot = createEmptyBuilderSnapshot(workspace);
  snapshot.actors.push({ id: "lead", role: "lead", label: "Lead", parentActorId: null, agentId: null, sessionId: null, status: "idle" });
  snapshot.graph.entities.push({ id: "existing", kind: "feature", label: "Existing", ownerActorId: "lead", status: "planned", evidenceRefs: [] });
  snapshot.activity.push({ id: "activity-1", actorId: "lead", label: "Existing activity", createdAt: "2026-11-02T00:00:00.000Z", evidenceRef: null });
  const untouched = structuredClone({ actors: snapshot.actors, graph: snapshot.graph, activity: snapshot.activity, messages: snapshot.messages });

  const projected = projectDesignBaseline(snapshot, view());
  assert.equal(projected.documents.length, 1);
  assert.equal(projected.documents[0]?.id, "design-baseline:baseline-r01");
  assert.equal(projected.documents[0]?.title, "설계 기준 · Lead 해석 기록");
  assert.equal(projected.documents[0]?.revisionId, "baseline-r01");
  assert.equal(projected.documents[0]?.createdAt, baseline().createdAt);
  assert.deepEqual({ actors: projected.actors, graph: projected.graph, activity: projected.activity, messages: projected.messages }, untouched);
  const text = JSON.parse(projected.documents[0]!.text) as { notice: string; projectId: string; graph: { entities: unknown[] } };
  assert.match(text.notice, /외부 계약 체결이나 코드 실행 권한이 아닙니다/);
  assert.equal(text.projectId, workspace);
  assert.equal(text.graph.entities.length, 1);
  assert.equal(projectDesignBaseline(snapshot, null), snapshot);
});

test("rejects foreign scopes, unsafe sequences, extra fields and accessors", () => {
  const snapshot = createEmptyBuilderSnapshot(workspace);
  assert.throws(() => projectDesignBaseline(snapshot, view({ workspaceId: "other" })), /cross-scope/);
  assert.throws(() => projectDesignBaseline(snapshot, view({ projectId: "other" })), /cross-scope/);
  assert.throws(() => projectDesignBaseline(snapshot, view({ sequence: 0 })), /cross-scope/);
  assert.throws(() => projectDesignBaseline(snapshot, view({ sequence: Number.MAX_SAFE_INTEGER + 1 })), /cross-scope/);
  assert.throws(() => projectDesignBaseline(snapshot, view({ approved: true })), /fields/);

  const withSymbol = view();
  Object.defineProperty(withSymbol, Symbol("extra"), { value: true, enumerable: true });
  assert.throws(() => projectDesignBaseline(snapshot, withSymbol), /fields/);

  let invoked = false;
  const withGetter = view();
  Object.defineProperty(withGetter, "baseline", { enumerable: true, get() { invoked = true; return baseline(); } });
  assert.throws(() => projectDesignBaseline(snapshot, withGetter), /field/);
  assert.equal(invoked, false);
});

test("validates the complete baseline schema and rejects invalid or cross-project baselines", () => {
  const snapshot = createEmptyBuilderSnapshot(workspace);
  assert.throws(() => projectDesignBaseline(snapshot, view({ baseline: { ...baseline(), unexpected: true } })));
  assert.throws(() => projectDesignBaseline(snapshot, view({ baseline: { ...baseline(), projectId: "other" } })));
  assert.throws(() => projectDesignBaseline(snapshot, view({ baseline: {
    ...baseline(), graph: { ...baseline().graph, entities: [{ id: "feature-a", kind: "feature", specRef: "REQ-404" }] },
  } })));
});
