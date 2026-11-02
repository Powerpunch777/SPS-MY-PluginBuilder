import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyBuilderSnapshot } from "../src/domain/snapshot.ts";
import { projectTechnologyDecisions } from "../src/domain/technology-decisions-view.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const digest = "a".repeat(64);

function record() {
  return {
    register: {
      projectId: workspaceId,
      revisionId: "technology-r01",
      sourceBaselineRevisionId: "baseline-r03",
      sourceSpecRevisionId: "spec-r04",
      sourceGraphRevisionId: "graph-r02",
      entries: [{
        id: "tech-react",
        technology: "React",
        disposition: "required",
        selectionReason: "Existing supported UI framework.",
        nonSelectionReason: "",
        scopeNodeIds: ["ui"],
        interoperability: ["Browser UI"],
        constraints: ["No Node-only imports in the browser bundle."],
        cost: "Existing dependency.",
        versionCompatibility: "Current project range.",
        changeApprovalOwner: "Lead",
        licenseReview: { status: "unreviewed", licenseExpression: null, evidenceRefs: [] },
        verification: { level: "not-verified", evidenceRefs: [], limitations: "Not independently checked.", nextReviewCondition: "Before release." },
      }],
    },
    author: {
      agentId: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333",
      runId: "44444444-4444-4444-8444-444444444444",
      selectionRevision: 3,
    },
    createdAt: "2026-11-02T01:02:03.004Z",
    baselineDigest: digest,
  };
}

function view(overrides: Record<string, unknown> = {}) {
  return { workspaceId, projectId: workspaceId, sequence: 1, record: record(), ...overrides };
}

test("projects the authored record as a historical document without changing other snapshot state", () => {
  const snapshot = createEmptyBuilderSnapshot(workspaceId);
  snapshot.actors.push({ id: "lead", role: "lead", label: "Lead", parentActorId: null, agentId: null, sessionId: null, status: "idle" });
  snapshot.graph.entities.push({ id: "existing", kind: "feature", label: "Existing", ownerActorId: "lead", status: "planned", evidenceRefs: [] });
  snapshot.activity.push({ id: "activity-1", actorId: "lead", label: "Existing activity", createdAt: "2026-11-02T00:00:00.000Z", evidenceRef: null });
  const untouched = structuredClone({ actors: snapshot.actors, graph: snapshot.graph, activity: snapshot.activity,
    messages: snapshot.messages, questions: snapshot.questions, integrations: snapshot.integrations });

  const projected = projectTechnologyDecisions(snapshot, view());
  assert.deepEqual(snapshot.documents, []);
  assert.equal(projected.documents.length, 1);
  assert.equal(projected.documents[0]?.id, "technology-decisions:technology-r01");
  assert.equal(projected.documents[0]?.title, "기술 선정 명세 · Lead 기록");
  assert.equal(projected.documents[0]?.revisionId, "technology-r01");
  assert.equal(projected.documents[0]?.createdAt, record().createdAt);
  const text = projected.documents[0]!.text;
  assert.ok(text.includes("라이선스·보안·테스트의 독립 검증이나 실행 승인이 아닙니다."));
  assert.ok(text.includes("React · 필수 (required)"));
  assert.ok(text.includes(record().register.entries[0]!.selectionReason));
  assert.ok(text.includes(record().author.runId) && text.includes(digest));
  assert.ok(text.includes("라이선스: 검토 안 함") && text.includes("검증 상태: 검증 안 함"));
  assert.deepEqual({ actors: projected.actors, graph: projected.graph, activity: projected.activity,
    messages: projected.messages, questions: projected.questions, integrations: projected.integrations }, untouched);
  assert.equal(projectTechnologyDecisions(snapshot, null), snapshot);
});

test("rejects cross-scope, invalid sequence, extra fields and non-data DTO fields", () => {
  const snapshot = createEmptyBuilderSnapshot(workspaceId);
  for (const change of [{ workspaceId: "other" }, { projectId: "other" }, { sequence: 0 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 }, { sequence: 1.5 }, { approved: true }]) {
    assert.throws(() => projectTechnologyDecisions(snapshot, view(change)));
  }

  const withSymbol = view();
  Object.defineProperty(withSymbol, Symbol("extra"), { value: true, enumerable: true });
  assert.throws(() => projectTechnologyDecisions(snapshot, withSymbol), /fields/);

  let invoked = false;
  const withGetter = view();
  Object.defineProperty(withGetter, "record", { enumerable: true, get() { invoked = true; return record(); } });
  assert.throws(() => projectTechnologyDecisions(snapshot, withGetter), /field/);
  assert.equal(invoked, false);

  assert.throws(() => projectTechnologyDecisions(snapshot, Object.assign(Object.create({ inherited: true }), view())));
  assert.throws(() => projectTechnologyDecisions(snapshot, { ...view(), record: { ...record(), extra: true } }));
});

test("validates the complete authored register and keeps source references historical", () => {
  const snapshot = createEmptyBuilderSnapshot(workspaceId);
  assert.throws(() => projectTechnologyDecisions(snapshot, view({ record: {
    ...record(), register: { ...record().register, projectId: "other" },
  } })));
  assert.throws(() => projectTechnologyDecisions(snapshot, view({ record: {
    ...record(), register: { ...record().register, entries: [{ ...record().register.entries[0], disposition: "approved" }] },
  } })));

  const document = projectTechnologyDecisions(snapshot, view()).documents[0]!;
  assert.ok(document.text.includes("설계 기준: baseline-r03"));
  assert.ok(document.text.includes("명세: spec-r04 · Graph: graph-r02"));
  assert.deepEqual(snapshot.graph.entities, []);
});

test("empty and reported research documents never imply prohibition or independent verification", () => {
  const snapshot = createEmptyBuilderSnapshot(workspaceId);
  const empty = record();
  empty.register.entries = [];
  assert.ok(projectTechnologyDecisions(snapshot, view({ record: empty })).documents[0]!.text.includes("조사 완료나 전체 기술 금지를 뜻하지 않습니다"));
  const source = record();
  const reported = { ...source, register: { ...source.register, entries: [{ ...source.register.entries[0],
    licenseReview: { status: "reported-reviewed", licenseExpression: "MIT", evidenceRefs: ["reported-license"] },
    verification: { level: "reported-integration-test", evidenceRefs: ["reported-test"],
      limitations: "Model report only.", nextReviewCondition: "Actual validation." },
  }] } };
  const text = projectTechnologyDecisions(snapshot, view({ record: reported })).documents[0]!.text;
  assert.ok(text.includes("검토 보고 · MIT · 독립 검증 아님"));
  assert.ok(text.includes("통합 시험 보고 · 독립 검증 아님"));
  assert.ok(text.includes("reported-license") && text.includes("reported-test"));
});
