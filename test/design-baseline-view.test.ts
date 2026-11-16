import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createEmptyBuilderSnapshot } from "../src/domain/snapshot.ts";
import { projectDesignBaseline, verifyDesignBaselineDigest } from "../src/domain/design-baseline-view.ts";
import { resolveDocumentReference } from "../src/domain/document-reference-navigation.ts";

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

const baselineDigest = () => createHash("sha256").update(JSON.stringify(baseline()), "utf8").digest("hex");

test("adds the scoped baseline as an interpreted document without changing graph or activity state", async () => {
  const snapshot = createEmptyBuilderSnapshot(workspace);
  snapshot.actors.push({ id: "lead", role: "lead", label: "Lead", parentActorId: null, agentId: null, sessionId: null, status: "idle" });
  snapshot.graph.entities.push({ id: "existing", kind: "feature", label: "Existing", ownerActorId: "lead", status: "planned", evidenceRefs: [] });
  snapshot.activity.push({ id: "activity-1", actorId: "lead", label: "Existing activity", createdAt: "2026-11-02T00:00:00.000Z", evidenceRef: null });
  const untouched = structuredClone({ actors: snapshot.actors, graph: snapshot.graph, activity: snapshot.activity, messages: snapshot.messages });

  const projected = await projectDesignBaseline(snapshot, view({ baselineDigest: baselineDigest() }));
  assert.equal(projected.documents.length, 1);
  assert.equal(projected.documents[0]?.id, "design-baseline:baseline-r01");
  assert.equal(projected.documents[0]?.title, "설계 기준 · Lead 해석 기록");
  assert.equal(projected.documents[0]?.revisionId, "baseline-r01");
  assert.equal(projected.documents[0]?.createdAt, baseline().createdAt);
  assert.equal(projected.documents[0]?.category, "design");
  assert.equal(projected.documents[0]?.approvalStatus, "unknown");
  assert.equal(projected.documents[0]?.freshnessStatus, "unknown");
  assert.deepEqual(projected.documents[0]?.sourcePins?.[0], { sourceId: "design-draft:draft-r01",
    revisionId: "draft-r01", sha256: digest });
  assert.deepEqual(projected.documents[0]?.relatedIds, ["draft-r01", "spec-r01", "graph-r01", "REQ-1"]);
  assert.deepEqual({ actors: projected.actors, graph: projected.graph, activity: projected.activity, messages: projected.messages }, untouched);
  const text = JSON.parse(projected.documents[0]!.text) as { notice: string; projectId: string; graph: { entities: unknown[] } };
  assert.match(text.notice, /외부 계약 체결이나 코드 실행 권한이 아닙니다/);
  assert.equal(text.projectId, workspace);
  assert.equal(text.graph.entities.length, 1);
  assert.equal(await projectDesignBaseline(snapshot, null), snapshot);
});

test("projects immediately without a self pin and adds one only after canonical digest verification", async () => {
  const snapshot = createEmptyBuilderSnapshot(workspace);
  const digestValue = baselineDigest();
  const pendingProjection = projectDesignBaseline(snapshot, view({ baselineDigest: digestValue }));
  const pendingDocument = pendingProjection.documents[0]!;
  assert.equal(pendingDocument.sourcePins?.some(pin => pin.sourceId === pendingDocument.id), false);
  const baselineDocument = (await verifyDesignBaselineDigest(snapshot, view({ baselineDigest: digestValue }))).documents[0]!;
  const consumers = ["workstream:WS-1", "technology-decisions:TECH-1"].map((id, index) => ({
    id, title: id, revisionId: `consumer-r${index + 1}`, text: "", createdAt: baseline().createdAt,
    sourcePins: [{ sourceId: baselineDocument.id, revisionId: baselineDocument.revisionId, sha256: digestValue }],
  }));
  for (const consumer of consumers) {
    assert.deepEqual(resolveDocumentReference([consumer, baselineDocument], consumer.id,
      { kind: "source-pin", sourceId: baselineDocument.id, revisionId: baselineDocument.revisionId, sha256: digestValue }),
    { status: "linked", targetId: baselineDocument.id, targetTitle: baselineDocument.title });
  }
  const stale = { ...consumers[0]!, sourcePins: [{ ...consumers[0]!.sourcePins[0]!, sha256: "b".repeat(64) }] };
  assert.deepEqual(resolveDocumentReference([stale, baselineDocument], stale.id,
    { kind: "source-pin", ...stale.sourcePins[0]! }), { status: "unlinked" });
  await assert.rejects(() => verifyDesignBaselineDigest(snapshot, view({ baselineDigest: "c".repeat(64) })),
    /does not match the normalized baseline/u);
  const legacy = projectDesignBaseline(snapshot, view()).documents[0]!;
  assert.equal(legacy.sourcePins?.some(pin => pin.sourceId === legacy.id && pin.revisionId === legacy.revisionId), false);
  assert.deepEqual(resolveDocumentReference([consumers[0]!, legacy], consumers[0]!.id,
    { kind: "source-pin", ...consumers[0]!.sourcePins[0]! }), { status: "unlinked" });
});

test("same Baseline ID and revision with changed content cannot reuse the previous digest or link", async () => {
  const snapshot = createEmptyBuilderSnapshot(workspace);
  const previousDigest = baselineDigest();
  const changed = baseline();
  changed.specification.requirements[0]!.description = "Changed without a new revision";
  const consumer = { id: "workstream:WS-1", title: "Workstream", revisionId: "ws-r1", createdAt: baseline().createdAt,
    text: "", sourcePins: [{ sourceId: "design-baseline:baseline-r01", revisionId: "baseline-r01", sha256: previousDigest }] };
  assert.equal(projectDesignBaseline(snapshot, view({ baseline: changed, baselineDigest: previousDigest })).documents[0]?.id,
    "design-baseline:baseline-r01");
  await assert.rejects(() => verifyDesignBaselineDigest(snapshot, view({ baseline: changed, baselineDigest: previousDigest })),
    /does not match the normalized baseline/u);
  assert.deepEqual(resolveDocumentReference([consumer], consumer.id, { kind: "source-pin", ...consumer.sourcePins[0] }),
    { status: "unlinked" });
});

test("legacy DTOs and unavailable WebCrypto remain readable without a Baseline self pin", async () => {
  const snapshot = createEmptyBuilderSnapshot(workspace);
  const legacy = projectDesignBaseline(snapshot, view()).documents[0]!;
  assert.ok(legacy);
  assert.equal(legacy.sourcePins?.some(pin => pin.sourceId === legacy.id && pin.revisionId === legacy.revisionId), false);

  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    const unsupported = (await verifyDesignBaselineDigest(snapshot, view({ baselineDigest: baselineDigest() }))).documents[0]!;
    assert.ok(unsupported);
    assert.equal(unsupported.sourcePins?.some(pin => pin.sourceId === unsupported.id && pin.revisionId === unsupported.revisionId), false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});

test("rejects foreign scopes, unsafe sequences, extra fields and accessors", async () => {
  const snapshot = createEmptyBuilderSnapshot(workspace);
  assert.throws(() => projectDesignBaseline(snapshot, view({ workspaceId: "other" })), /cross-scope/);
  assert.throws(() => projectDesignBaseline(snapshot, view({ projectId: "other" })), /cross-scope/);
  assert.throws(() => projectDesignBaseline(snapshot, view({ sequence: 0 })), /cross-scope/);
  assert.throws(() => projectDesignBaseline(snapshot, view({ sequence: Number.MAX_SAFE_INTEGER + 1 })), /cross-scope/);
  assert.throws(() => projectDesignBaseline(snapshot, view({ approved: true })), /fields/);
  assert.throws(() => projectDesignBaseline(snapshot, view({ baselineDigest: "A".repeat(64) })), /digest/u);

  const withSymbol = view();
  Object.defineProperty(withSymbol, Symbol("extra"), { value: true, enumerable: true });
  assert.throws(() => projectDesignBaseline(snapshot, withSymbol), /fields/);

  let invoked = false;
  const withGetter = view();
  Object.defineProperty(withGetter, "baseline", { enumerable: true, get() { invoked = true; return baseline(); } });
  assert.throws(() => projectDesignBaseline(snapshot, withGetter), /field/);
  assert.equal(invoked, false);
});

test("validates the complete baseline schema and rejects invalid or cross-project baselines", async () => {
  const snapshot = createEmptyBuilderSnapshot(workspace);
  assert.throws(() => projectDesignBaseline(snapshot, view({ baseline: { ...baseline(), unexpected: true } })));
  assert.throws(() => projectDesignBaseline(snapshot, view({ baseline: { ...baseline(), projectId: "other" } })));
  assert.throws(() => projectDesignBaseline(snapshot, view({ baseline: {
    ...baseline(), graph: { ...baseline().graph, entities: [{ id: "feature-a", kind: "feature", specRef: "REQ-404" }] },
  } })));
});
