import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsActionContext, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { LEAD_CONTEXTS } from "../domain/lead-contexts.ts";
import { createDesignBaselineStore } from "../design-baseline-tools.ts";
import { createDesignDraftStore } from "../design-draft-store.ts";
import { createLeadMemoryStore } from "../lead-memory-store.ts";
import type { RevisionState } from "../solution-revision-store.ts";
import { createLeadContextKnowledge, createLeadContextKnowledgeForUserAction } from "./index.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const sessionIds = ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666",
  "77777777-7777-4777-8777-777777777777"];
const projectId = "sample-project";
const requestId = "88888888-8888-4888-8888-888888888888";
const runId = "99999999-9999-4999-8999-999999999999";
const sourceId = `lead-turn:${requestId}`;
const stateKey = (key: string) => `${workspaceId}/${key}`;
const sourceText = "first line\r\nsecond line\nthird line";
const sourceSha256 = createHash("sha256").update(sourceText, "utf8").digest("hex");

function makeFixture() {
  const values = new Map<string, JsonValue>();
  const state: RevisionState = {
    get: async (key: SpsStateKey) => values.get(`${key.scopeId}/${key.stateKey}`) ?? null,
    compareAndSet: async (key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) => {
      const id = `${key.scopeId}/${key.stateKey}`;
      const current = values.get(id);
      const matches = expected.exists ? current !== undefined && JSON.stringify(current) === JSON.stringify(expected.value)
        : current === undefined;
      if (matches) values.set(id, value);
      return { swapped: matches };
    },
  };
  const contexts = Object.fromEntries(LEAD_CONTEXTS.map((context, index) => [context, sessionIds[index]]));
  values.set(stateKey("lead-agent.v1"), { workspaceId, revision: 1, selectedAgentId: agentId });
  values.set(stateKey("lead-contexts.v2.1"), { schemaVersion: 2, workspaceId, selectionRevision: 1, agentId,
    requestId: "abababab-abab-4bab-8bab-abababababab", status: "ready", pendingContext: null, contexts });
  let agentCalls = 0;
  const sessions = new Proxy({}, { get: () => async () => { agentCalls += 1; throw new Error("AI/session method must not run during knowledge preparation."); } });
  const platform = { state, agents: { sessions } } as unknown as SpsPlatformInvocationContext;
  const runContext = { companyId: workspaceId, agentId, runId, sessionId: sessionIds[0] };
  return { values, state, platform, runContext, get agentCalls() { return agentCalls; } };
}

function baseline() {
  return { projectId, revisionId: "baseline-r1", sourceDraftRevisionId: "draft-r1", draftDigest: "a".repeat(64),
    createdAt: "2026-11-04T00:00:00.000Z",
    author: { agentId, sessionId: sessionIds[0], runId, selectionRevision: 1 },
    userDecision: { sourceId, sourceSha256, interpretation: "Recorded user decision" },
    specification: { projectId, revisionId: "spec-r1", productTier: "M",
      requirements: [{ id: "REQ-1", description: "One requirement", acceptanceCriteriaIds: ["AC-1"] }],
      targets: ["sps-plugin"], dataPolicyRef: "policy-r1", approvalEvidenceRef: sourceId },
    graph: { approvedSpecRevisionId: "spec-r1", graphRevisionId: "graph-r1", entities: [], relations: [], viewLayoutRef: "layout-r1" } };
}

function draft(revisionId: string, specificationRevisionId: string, graphRevisionId: string) {
  return { projectId, revisionId, sourceIds: [sourceId],
    specification: { revisionId: specificationRevisionId, productTier: "M", requirements: [
      { id: "REQ-1", description: "One requirement", acceptanceCriteriaIds: ["AC-1"] },
    ], targets: ["sps-plugin"], dataPolicyRef: "policy-r1" },
    graph: { graphRevisionId, entities: [], relations: [], viewLayoutRef: "layout-r1" },
    questions: [{ id: "question-1", title: "Question", text: "Which choice?", options: [], recommendation: null }] };
}

async function publishDraft(fixture: ReturnType<typeof makeFixture>, revisionId: string, specId: string, graphId: string,
  expectedBaseRevisionId: string | null, decisions?: readonly unknown[]) {
  const currentDraft = draft(revisionId, specId, graphId);
  const decisionField = decisions === undefined ? {} : { decisions };
  return createDesignDraftStore(workspaceId, projectId, { selectionRevision: 1, agentId }, fixture.state).publish({
    expectedBaseRevisionId,
    revision: { status: "draft", selectionRevision: 1,
      author: { agentId, sessionId: sessionIds[0], runId },
      sourceDigests: [{ id: sourceId, sha256: sourceSha256 }], createdAt: "2026-11-04T00:00:00.000Z",
      draft: currentDraft, ...decisionField },
  });
}

function persistedTurn() {
  return { workspaceId, selectionRevision: 1, agentId, sessionId: sessionIds[0], channel: "user_conversation",
    schemaVersion: 1, requestId, previousRequestId: null, sequence: 0, text: sourceText,
    createdAt: "2026-11-04T00:00:00.000Z", state: "succeeded", runId, answer: null,
    outputState: "not_ready", cancellationRequested: false, termination: "not_applicable" };
}

function actionContext(fixture: ReturnType<typeof makeFixture>, overrides: Record<string, unknown> = {}) {
  return { ...fixture.platform, companyId: workspaceId, actor: { type: "user", companyId: workspaceId, userId: "user-1" },
    ...overrides } as unknown as SpsActionContext;
}

test("preparation derives identities and current baseline from Host authority, not caller-supplied session records", async () => {
  const fixture = makeFixture();
  const service = await createLeadContextKnowledge({ runContext: fixture.runContext, projectId, platform: fixture.platform });
  const prepared = await service.prepare();
  assert.equal(prepared.identity.contextId, "user_conversation");
  assert.equal(prepared.identity.sessionId, sessionIds[0]);
  assert.equal(prepared.identity.workspaceId, workspaceId);
  assert.equal(prepared.identity.projectId, projectId);
  assert.equal(prepared.formalDesignRevision, null);
  assert.equal(prepared.sharedMemory, null);

  await createDesignBaselineStore(workspaceId, projectId, fixture.state).publish({ expectedBaseRevisionId: null, revision: baseline() });
  assert.equal((await publishDraft(fixture, "draft-r1", "draft-spec-r1", "draft-graph-r1", null)).status, "published");
  const refreshed = await service.prepare();
  assert.equal(refreshed.formalDesignRevision?.revisionId, "baseline-r1");
  assert.equal(refreshed.formalDesignRevision?.userDecision.sourceId, sourceId);
  assert.equal(refreshed.currentDraftRevisionId, "draft-r1");
  assert.deepEqual(refreshed.designDecisions, []);

  const updatedBaseline = { ...baseline(), revisionId: "baseline-r2", sourceDraftRevisionId: "draft-r2",
    draftDigest: "d".repeat(64), specification: { ...baseline().specification, revisionId: "spec-r2" },
    graph: { ...baseline().graph, approvedSpecRevisionId: "spec-r2", graphRevisionId: "graph-r2" } };
  assert.equal((await createDesignBaselineStore(workspaceId, projectId, fixture.state).publish({
    expectedBaseRevisionId: "baseline-r1", revision: updatedBaseline,
  })).status, "published");
  const question = draft("draft-r2", "draft-spec-r2", "draft-graph-r2").questions[0]!;
  const questionDigest = createHash("sha256").update(JSON.stringify(question), "utf8").digest("hex");
  const decision = { questionId: "question-1", questionDigest, answerSourceId: sourceId,
    answerSourceSha256: sourceSha256, answerText: "Use the first option.",
    fromDraftRevisionId: "draft-r1", appliedDraftRevisionId: "draft-r2" };
  assert.equal((await publishDraft(fixture, "draft-r2", "draft-spec-r2", "draft-graph-r2", "draft-r1", [decision])).status, "published");
  const refreshedAgain = await service.prepare();
  assert.equal(refreshedAgain.formalDesignRevision?.revisionId, "baseline-r2");
  assert.equal(refreshedAgain.currentDraftRevisionId, "draft-r2");
  assert.deepEqual(refreshedAgain.designDecisions.map(row => row.appliedDraftRevisionId), ["draft-r2"]);
  assert.equal(refreshed.consistency, "independent-current-journal-reads");
  assert.equal(fixture.agentCalls, 0);
});

test("selection changes and nonmember sessions invalidate preparation", async () => {
  const fixture = makeFixture();
  const service = await createLeadContextKnowledge({ runContext: fixture.runContext, projectId, platform: fixture.platform });
  fixture.values.set(stateKey("lead-agent.v1"), { workspaceId, revision: 2, selectedAgentId: agentId });
  await assert.rejects(service.prepare(), /selection changed|authority changed|selection is unavailable/i);

  const invalid = makeFixture();
  await assert.rejects(createLeadContextKnowledge({ runContext: { ...invalid.runContext,
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, projectId, platform: invalid.platform }), /authorized|prepared/);
  await assert.rejects(createLeadContextKnowledge({ runContext: { ...invalid.runContext,
    companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, projectId, platform: invalid.platform }), /current Builder Lead/);
});

test("preparation follows each of the five Host context identities and validates optional Host project binding", async () => {
  for (const [index, contextId] of LEAD_CONTEXTS.entries()) {
    const fixture = makeFixture();
    const service = await createLeadContextKnowledge({ runContext: { ...fixture.runContext, sessionId: sessionIds[index] },
      projectId, platform: fixture.platform });
    const prepared = await service.prepare();
    assert.equal(prepared.identity.contextId, contextId);
    assert.equal(prepared.identity.sessionId, sessionIds[index]);
  }
  const fixture = makeFixture();
  const hostProjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const bound = await createLeadContextKnowledge({ runContext: { ...fixture.runContext, projectId: hostProjectId },
    projectId: hostProjectId, platform: fixture.platform });
  assert.equal((await bound.prepare()).identity.projectId, hostProjectId);
  await assert.rejects(createLeadContextKnowledge({ runContext: { ...fixture.runContext, projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    projectId, platform: fixture.platform }), /project ID matching/);
});

test("source query verifies a current project citation and persisted selected-Workspace user turn", async () => {
  const fixture = makeFixture();
  await createDesignBaselineStore(workspaceId, projectId, fixture.state).publish({ expectedBaseRevisionId: null, revision: baseline() });
  fixture.values.set(stateKey(`lead-chat.turn.v1.${requestId}`), persistedTurn());
  const service = await createLeadContextKnowledge({ runContext: fixture.runContext, projectId, platform: fixture.platform });
  const result = await service.querySources([{ sourceId, fromLine: 2, throughLine: 3 }]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.sourceId, sourceId);
  assert.equal(result[0]?.text, "second line\nthird line");
  assert.equal(result[0]?.verification, "persisted-workspace-lead-turn-cited-by-current-project-record");
  assert.match(result[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(fixture.agentCalls, 0);
});

test("source query accepts the documented 200-line maximum", async () => {
  const fixture = makeFixture();
  const text = Array.from({ length: 200 }, (_, index) => `line-${index + 1}`).join("\n");
  const turn = { ...persistedTurn(), text };
  fixture.values.set(stateKey(`lead-chat.turn.v1.${requestId}`), turn);
  await createDesignBaselineStore(workspaceId, projectId, fixture.state).publish({ expectedBaseRevisionId: null,
    revision: { ...baseline(), userDecision: { ...baseline().userDecision,
      sourceSha256: createHash("sha256").update(text, "utf8").digest("hex") } } });
  const service = await createLeadContextKnowledge({ runContext: fixture.runContext, projectId, platform: fixture.platform });
  const result = await service.querySources([{ sourceId, fromLine: 1, throughLine: 200 }]);
  assert.equal(result[0]?.text, text);
});

test("source digests match persisted text across baseline, draft, decisions and shared memory", async () => {
  const fixture = makeFixture();
  await createDesignBaselineStore(workspaceId, projectId, fixture.state).publish({ expectedBaseRevisionId: null, revision: baseline() });
  assert.equal((await publishDraft(fixture, "draft-r1", "draft-spec-r1", "draft-graph-r1", null, [
    { questionId: "question-1", questionDigest: createHash("sha256").update(JSON.stringify(draft("draft-r1", "draft-spec-r1", "draft-graph-r1").questions[0]), "utf8").digest("hex"),
      answerSourceId: sourceId, answerSourceSha256: sourceSha256, answerText: "Use the first option.",
      fromDraftRevisionId: "draft-r0", appliedDraftRevisionId: "draft-r1" },
  ])).status, "published");
  assert.equal((await createLeadMemoryStore(workspaceId, projectId, fixture.state).publish({
    expectedBaseRevisionId: null,
    revision: { author: { agentId, sessionId: sessionIds[0], runId, selectionRevision: 1, channel: "user_conversation" },
      createdAt: "2026-11-04T00:00:00.000Z", sourceDigests: [{ id: sourceId, sha256: sourceSha256 }],
      memory: { projectId, revisionId: "memory-r1", entries: [{ id: "memory-entry-1", kind: "decision", text: "Remember this decision", sourceIds: [sourceId] }] } },
  })).status, "published");
  fixture.values.set(stateKey(`lead-chat.turn.v1.${requestId}`), persistedTurn());
  const service = await createLeadContextKnowledge({ runContext: fixture.runContext, projectId, platform: fixture.platform });
  const result = await service.querySources([{ sourceId, fromLine: 1, throughLine: 3 }]);
  assert.equal(result[0]?.sha256, sourceSha256);
  assert.equal(result[0]?.text, sourceText);
});

test("preparation refreshes the latest shared memory revision", async () => {
  const fixture = makeFixture();
  const service = await createLeadContextKnowledge({ runContext: fixture.runContext, projectId, platform: fixture.platform });
  assert.equal((await service.prepare()).sharedMemory, null);
  const store = createLeadMemoryStore(workspaceId, projectId, fixture.state);
  const publish = (revisionId: string, text: string, expectedBaseRevisionId: string | null) => store.publish({ expectedBaseRevisionId,
    revision: { author: { agentId, sessionId: sessionIds[0], runId, selectionRevision: 1, channel: "user_conversation" },
      createdAt: "2026-11-04T00:00:00.000Z", sourceDigests: [{ id: sourceId, sha256: sourceSha256 }],
      memory: { projectId, revisionId, entries: [{ id: "memory-entry-1", kind: "decision", text, sourceIds: [sourceId] }] } },
  });
  assert.equal((await publish("memory-r1", "First", null)).status, "published");
  assert.equal((await service.prepare()).sharedMemory?.entries[0]?.text, "First");
  assert.equal((await publish("memory-r2", "Updated", "memory-r1")).status, "published");
  const refreshed = await service.prepare();
  assert.equal(refreshed.sharedMemory?.revisionId, "memory-r2");
  assert.equal(refreshed.sharedMemory?.entries[0]?.text, "Updated");
});

test("source query rejects stale, missing and conflicting cited digest evidence", async t => {
  for (const owner of ["baseline", "draft", "memory", "conflict"] as const) {
    await t.test(owner, async () => {
      const fixture = makeFixture();
      const wrongDigest = "f".repeat(64);
      if (owner === "baseline" || owner === "conflict") {
        await createDesignBaselineStore(workspaceId, projectId, fixture.state).publish({ expectedBaseRevisionId: null,
          revision: { ...baseline(), userDecision: { ...baseline().userDecision, sourceSha256: wrongDigest } } });
      }
      if (owner === "draft" || owner === "conflict") {
        await createDesignDraftStore(workspaceId, projectId, { selectionRevision: 1, agentId }, fixture.state).publish({
          expectedBaseRevisionId: null,
          revision: { status: "draft", selectionRevision: 1, author: { agentId, sessionId: sessionIds[0], runId },
            sourceDigests: [{ id: sourceId, sha256: owner === "conflict" ? sourceSha256 : wrongDigest }],
            createdAt: "2026-11-04T00:00:00.000Z", draft: draft("draft-r1", "draft-spec-r1", "draft-graph-r1") },
        });
      }
      if (owner === "memory") {
        await createLeadMemoryStore(workspaceId, projectId, fixture.state).publish({ expectedBaseRevisionId: null,
          revision: { author: { agentId, sessionId: sessionIds[0], runId, selectionRevision: 1, channel: "user_conversation" },
            createdAt: "2026-11-04T00:00:00.000Z", sourceDigests: [{ id: sourceId, sha256: wrongDigest }],
            memory: { projectId, revisionId: "memory-r1", entries: [{ id: "memory-entry-1", kind: "decision", text: "Decision", sourceIds: [sourceId] }] } },
        });
      }
      fixture.values.set(stateKey(`lead-chat.turn.v1.${requestId}`), persistedTurn());
      const service = await createLeadContextKnowledge({ runContext: fixture.runContext, projectId, platform: fixture.platform });
      await assert.rejects(service.querySources([{ sourceId, fromLine: 1, throughLine: 1 }]), owner === "conflict"
        ? /conflicting digests/ : /does not match.*record digest/);
    });
  }
  const fixture = makeFixture();
  await createDesignBaselineStore(workspaceId, projectId, fixture.state).publish({ expectedBaseRevisionId: null, revision: baseline() });
  fixture.values.set(stateKey(`lead-chat.turn.v1.${requestId}`), { ...persistedTurn(), text: "changed source text" });
  const service = await createLeadContextKnowledge({ runContext: fixture.runContext, projectId, platform: fixture.platform });
  await assert.rejects(service.querySources([{ sourceId, fromLine: 1, throughLine: 1 }]), /does not match.*record digest/);
});

test("source query rejects uncited, missing, cross-project, malformed and unavailable original sources", async () => {
  const fixture = makeFixture();
  await createDesignBaselineStore(workspaceId, projectId, fixture.state).publish({ expectedBaseRevisionId: null, revision: baseline() });
  const service = await createLeadContextKnowledge({ runContext: fixture.runContext, projectId, platform: fixture.platform });
  await assert.rejects(service.querySources([{ sourceId: `lead-turn:${runId}`, fromLine: 1, throughLine: 1 }]), /absent from current Workspace\/project/);
  await assert.rejects(service.querySources([{ sourceId, fromLine: 1, throughLine: 1 }]), /unavailable|missing/i);
  const otherProject = await createLeadContextKnowledge({ runContext: fixture.runContext, projectId: "other-project", platform: fixture.platform });
  const otherProjectSnapshot = await otherProject.prepare();
  assert.equal(otherProjectSnapshot.formalDesignRevision, null);
  assert.equal(otherProjectSnapshot.currentDraftRevisionId, null);
  await assert.rejects(otherProject.querySources([{ sourceId, fromLine: 1, throughLine: 1 }]), /absent from current Workspace\/project/);
  await assert.rejects(service.querySources([{ sourceId, fromLine: 0, throughLine: 1 }]), /Invalid source range/);
  await assert.rejects(service.querySources([{ sourceId: "consultation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", fromLine: 1, throughLine: 1 }]), /unsupported|absent/);
});

test("source query enforces line and byte bounds and reports cited consultation text as unsupported", async () => {
  const fixture = makeFixture();
  const consultationId = "consultation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await publishDraft(fixture, "draft-r1", "draft-spec-r1", "draft-graph-r1", null);
  // Replace the draft citation with the consultation source to exercise the known but unsupported source API.
  const secondDraft = draft("draft-r2", "draft-spec-r2", "draft-graph-r2");
  const row = { status: "draft" as const, selectionRevision: 1, author: { agentId, sessionId: sessionIds[0], runId },
    sourceDigests: [{ id: consultationId, sha256: "a".repeat(64) }], createdAt: "2026-11-04T00:00:00.000Z",
    draft: { ...secondDraft, sourceIds: [consultationId] } };
  assert.equal((await createDesignDraftStore(workspaceId, projectId, { selectionRevision: 1, agentId }, fixture.state).publish({
    expectedBaseRevisionId: "draft-r1", revision: row,
  })).status, "published");
  fixture.values.set(stateKey(`lead-chat.turn.v1.${requestId}`), persistedTurn());
  await createDesignBaselineStore(workspaceId, projectId, fixture.state).publish({ expectedBaseRevisionId: null, revision: baseline() });
  const service = await createLeadContextKnowledge({ runContext: fixture.runContext, projectId, platform: fixture.platform });
  await assert.rejects(service.querySources([{ sourceId: consultationId, fromLine: 1, throughLine: 1 }]), /Consultation original-text lookup is unsupported/);
  await assert.rejects(service.querySources([{ sourceId, fromLine: 1, throughLine: 201 }]), /200|Invalid source range/);
  const text = "x".repeat(16 * 1024);
  const requestIds = ["10101010-1010-4010-8010-101010101010", "20202020-2020-4020-8020-202020202020",
    "30303030-3030-4030-8030-303030303030", "40404040-4040-4040-8040-404040404040",
    "50505050-5050-4050-8050-505050505050", "60606060-6060-4060-8060-606060606060",
    "70707070-7070-4070-8070-707070707070"];
  const sourceIds = requestIds.map(id => `lead-turn:${id}`);
  for (const id of requestIds) fixture.values.set(stateKey(`lead-chat.turn.v1.${id}`),
    { ...persistedTurn(), requestId: id, text });
  assert.equal((await createDesignDraftStore(workspaceId, projectId, { selectionRevision: 1, agentId }, fixture.state).publish({
    expectedBaseRevisionId: "draft-r2",
    revision: { status: "draft", selectionRevision: 1, author: { agentId, sessionId: sessionIds[0], runId },
      sourceDigests: [consultationId, ...sourceIds].map(id => ({ id, sha256: id === consultationId ? "a".repeat(64)
        : createHash("sha256").update(text, "utf8").digest("hex") })),
      createdAt: "2026-11-04T00:00:00.000Z",
      draft: { ...draft("draft-r3", "draft-spec-r3", "draft-graph-r3"), sourceIds: [consultationId, ...sourceIds] } },
  })).status, "published");
  await assert.rejects(service.querySources(sourceIds.map(id => ({ sourceId: id, fromLine: 1, throughLine: 1 }))), /bounded query size/);
});

test("source lookup rejects a persisted internal-context turn even when its ID is cited", async () => {
  const fixture = makeFixture();
  await createDesignBaselineStore(workspaceId, projectId, fixture.state).publish({ expectedBaseRevisionId: null, revision: baseline() });
  fixture.values.set(stateKey(`lead-chat.turn.v1.${requestId}`), { ...persistedTurn(),
    sessionId: sessionIds[2], channel: "background_planning" });
  const service = await createLeadContextKnowledge({ runContext: fixture.runContext, projectId, platform: fixture.platform });
  await assert.rejects(service.querySources([{ sourceId, fromLine: 1, throughLine: 1 }]), /unavailable|not.*source|user/i);
  assert.equal(fixture.agentCalls, 0);
});

test("authenticated user action reads current Knowledge and cited original source without starting AI", async () => {
  const fixture = makeFixture();
  await createDesignBaselineStore(workspaceId, projectId, fixture.state).publish({ expectedBaseRevisionId: null, revision: baseline() });
  fixture.values.set(stateKey(`lead-chat.turn.v1.${requestId}`), persistedTurn());
  const service = await createLeadContextKnowledgeForUserAction({ actionContext: actionContext(fixture), projectId,
    contextId: "user_conversation" });
  const snapshot = await service.prepare();
  assert.equal(snapshot.identity.contextId, "user_conversation");
  assert.equal(snapshot.identity.sessionId, sessionIds[0]);
  assert.equal(snapshot.formalDesignRevision?.revisionId, "baseline-r1");
  assert.equal((await service.querySources([{ sourceId, fromLine: 1, throughLine: 2 }]))[0]?.text, "first line\r\nsecond line");
  assert.equal(fixture.agentCalls, 0);
});

test("user action producer rejects foreign tenant, non-user actor, invalid context and invalid project", async () => {
  const fixture = makeFixture();
  const action = actionContext(fixture);
  await assert.rejects(createLeadContextKnowledgeForUserAction({ actionContext: { ...action, companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    projectId, contextId: "user_conversation" }), /authenticated user action/);
  await assert.rejects(createLeadContextKnowledgeForUserAction({ actionContext: actionContext(fixture,
    { actor: { type: "agent", companyId: workspaceId, agentId } }), projectId, contextId: "user_conversation" }), /authenticated user action/);
  await assert.rejects(createLeadContextKnowledgeForUserAction({ actionContext: action,
    projectId, contextId: "not-a-context" as never }), /context ID/);
  await assert.rejects(createLeadContextKnowledgeForUserAction({ actionContext: action,
    projectId: "bad\u0000project", contextId: "user_conversation" }), /project ID/);
});

test("user action producer enforces current selection and project source isolation", async () => {
  const fixture = makeFixture();
  const service = await createLeadContextKnowledgeForUserAction({ actionContext: actionContext(fixture), projectId,
    contextId: "user_conversation" });
  fixture.values.set(stateKey("lead-agent.v1"), { workspaceId, revision: 2, selectedAgentId: agentId });
  await assert.rejects(service.prepare(), /selection changed|authority changed|selection is unavailable/i);

  const other = makeFixture();
  await createDesignBaselineStore(workspaceId, projectId, other.state).publish({ expectedBaseRevisionId: null, revision: baseline() });
  const isolated = await createLeadContextKnowledgeForUserAction({ actionContext: actionContext(other), projectId: "other-project",
    contextId: "user_conversation" });
  assert.equal((await isolated.prepare()).formalDesignRevision, null);
  await assert.rejects(isolated.querySources([{ sourceId, fromLine: 1, throughLine: 1 }]), /absent from current Workspace\/project/);
});

test("user action source reads reject uncited, altered, unavailable, internal and invalid-range sources", async () => {
  const fixture = makeFixture();
  const service = await createLeadContextKnowledgeForUserAction({ actionContext: actionContext(fixture), projectId,
    contextId: "user_conversation" });
  await assert.rejects(service.querySources([{ sourceId, fromLine: 1, throughLine: 1 }]), /absent from current Workspace\/project/);
  await assert.rejects(service.querySources([{ sourceId, fromLine: 0, throughLine: 1 }]), /Invalid source range/);

  await createDesignBaselineStore(workspaceId, projectId, fixture.state).publish({ expectedBaseRevisionId: null, revision: baseline() });
  fixture.values.set(stateKey(`lead-chat.turn.v1.${requestId}`), { ...persistedTurn(), text: "altered" });
  await assert.rejects(service.querySources([{ sourceId, fromLine: 1, throughLine: 1 }]), /unavailable|does not match.*digest/i);

  const unavailable = makeFixture();
  await createDesignBaselineStore(workspaceId, projectId, unavailable.state).publish({ expectedBaseRevisionId: null, revision: baseline() });
  const unavailableService = await createLeadContextKnowledgeForUserAction({ actionContext: actionContext(unavailable), projectId,
    contextId: "user_conversation" });
  await assert.rejects(unavailableService.querySources([{ sourceId, fromLine: 1, throughLine: 1 }]), /unavailable|missing/i);
});

test("user action producer keeps consultation originals unsupported and does not relax tool authority", async () => {
  const fixture = makeFixture();
  const consultationId = "consultation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const currentDraft = draft("draft-r1", "spec-r1", "graph-r1");
  await createDesignDraftStore(workspaceId, projectId, { selectionRevision: 1, agentId }, fixture.state).publish({
    expectedBaseRevisionId: null,
    revision: { status: "draft", selectionRevision: 1, author: { agentId, sessionId: sessionIds[0], runId },
      sourceDigests: [{ id: consultationId, sha256: "a".repeat(64) }], createdAt: "2026-11-04T00:00:00.000Z",
      draft: { ...currentDraft, sourceIds: [consultationId] } },
  });
  const actionService = await createLeadContextKnowledgeForUserAction({ actionContext: actionContext(fixture), projectId,
    contextId: "user_conversation" });
  await assert.rejects(actionService.querySources([{ sourceId: consultationId, fromLine: 1, throughLine: 1 }]), /Consultation original-text lookup is unsupported/);
  await assert.rejects(createLeadContextKnowledge({ runContext: { companyId: workspaceId, agentId, runId }, projectId,
    platform: fixture.platform }), /Invalid Builder tool fields/);
  const strictToolService = await createLeadContextKnowledge({ runContext: fixture.runContext, projectId, platform: fixture.platform });
  assert.equal((await strictToolService.prepare()).identity.contextId, "user_conversation");
  assert.equal(fixture.agentCalls, 0);
});
