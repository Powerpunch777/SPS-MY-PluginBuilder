import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyBuilderSnapshot, parseBuilderSnapshot } from "../src/domain/snapshot.ts";
import { selectActiveActors, selectSessionTranscript } from "../src/domain/selectors.ts";

function empty() {
  return createEmptyBuilderSnapshot("workspace-a");
}

test("creates the empty workspace-scoped snapshot with no phantom state", () => {
  assert.deepEqual(empty(), {
    schemaVersion: 1,
    workspaceId: "workspace-a",
    revision: 0,
    leadSessions: { main: null, "cto-inbox": null, decisions: null },
    actors: [], messages: [], documents: [], questions: [],
    graph: { revisionId: null, entities: [], relations: [] },
    activity: [],
    integrations: { ai: "not_configured", github: "not_configured", htmlPreview: "unavailable" },
  });
});

test("parses to a detached copy and rejects unknown or foreign workspace data", () => {
  const input = empty();
  input.documents.push({ id: "doc-1", title: "Spec", revisionId: "rev-1", text: "body", createdAt: "now" });
  const parsed = parseBuilderSnapshot(input, "workspace-a");
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.documents, input.documents);
  assert.notEqual(parsed.documents[0], input.documents[0]);
  parsed.documents[0]!.text = "changed copy";
  assert.equal(input.documents[0]!.text, "body");
  assert.throws(() => parseBuilderSnapshot(input, "workspace-b"), /different Workspace/);
  assert.throws(() => parseBuilderSnapshot({ ...input, unexpected: true }, "workspace-a"), /unknown or missing fields/);
  assert.throws(() => parseBuilderSnapshot({ ...input, graph: { ...input.graph, extra: true } }, "workspace-a"), /unknown or missing fields/);
});

test("rejects accessors without evaluating them and rejects sparse or oversized data", () => {
  let getterCalled = false;
  const input = empty() as unknown as Record<string, unknown>;
  Object.defineProperty(input, "revision", { enumerable: true, get() { getterCalled = true; return 0; } });
  assert.throws(() => parseBuilderSnapshot(input, "workspace-a"), /data field/);
  assert.equal(getterCalled, false);

  const sparse = empty();
  sparse.actors = new Array(1);
  assert.throws(() => parseBuilderSnapshot(sparse, "workspace-a"), /dense plain array/);
  const oversized = empty();
  oversized.actors = Array.from({ length: 1_001 }, (_, index) => ({
    id: `actor-${index}`, role: "development" as const, label: "Worker", parentActorId: null,
    agentId: null, sessionId: null, status: "idle" as const,
  }));
  assert.throws(() => parseBuilderSnapshot(oversized, "workspace-a"), /at most 1000/);
});

test("rejects duplicate IDs and dangling actor, revision, question, and graph references", () => {
  const duplicateActor = empty();
  const actor = { id: "actor-1", role: "cto" as const, label: "CTO", parentActorId: null,
    agentId: null, sessionId: "session-1", status: "idle" as const };
  duplicateActor.actors = [actor, { ...actor }];
  assert.throws(() => parseBuilderSnapshot(duplicateActor, "workspace-a"), /duplicate ID/);

  const danglingMessage = empty();
  danglingMessage.messages.push({ id: "message-1", channel: "main", actorId: "missing", role: "assistant", text: "x", createdAt: "now", runId: null });
  assert.throws(() => parseBuilderSnapshot(danglingMessage, "workspace-a"), /dangling actor/);

  const danglingQuestionRevision = empty();
  danglingQuestionRevision.questions.push({ id: "question-1", title: "Q", text: "", status: "open", options: [], recommendation: null, answer: null, revisionId: "missing-revision" });
  assert.throws(() => parseBuilderSnapshot(danglingQuestionRevision, "workspace-a"), /dangling revision/);

  const danglingRelation = empty();
  danglingRelation.graph.relations.push({ id: "edge-1", sourceId: "missing", targetId: "also-missing", kind: "depends_on" });
  assert.throws(() => parseBuilderSnapshot(danglingRelation, "workspace-a"), /dangling entity reference/);

  const danglingQuestionActor = empty();
  danglingQuestionActor.graph.entities.push({ id: "node-1", kind: "feature", label: "Feature", ownerActorId: "missing", status: "planned", evidenceRefs: [] });
  assert.throws(() => parseBuilderSnapshot(danglingQuestionActor, "workspace-a"), /dangling actor/);
});

test("verified graph entities require at least one evidence reference", () => {
  const snapshot = empty();
  snapshot.graph.entities.push({ id: "node-1", kind: "feature", label: "Feature", ownerActorId: null, status: "verified", evidenceRefs: [] });
  assert.throws(() => parseBuilderSnapshot(snapshot, "workspace-a"), /without an evidence reference/);

  snapshot.graph.entities[0]!.evidenceRefs.push("evidence-1");
  assert.equal(parseBuilderSnapshot(snapshot, "workspace-a").graph.entities[0]!.evidenceRefs[0], "evidence-1");
});

test("selectors expose only active non-Lead actors and immutable session-scoped transcripts", () => {
  const snapshot = empty();
  snapshot.leadSessions.main = "lead-main";
  snapshot.leadSessions["cto-inbox"] = "lead-questions";
  snapshot.actors.push(
    { id: "lead-actor", role: "lead", label: "Lead", parentActorId: null, agentId: null, sessionId: "lead-other", status: "running" },
    { id: "cto-1", role: "cto", label: "CTO", parentActorId: null, agentId: null, sessionId: "cto-session", status: "running" },
    { id: "worker-1", role: "development", label: "Worker", parentActorId: "cto-1", agentId: null, sessionId: "worker-session", status: "waiting" },
    { id: "qa-1", role: "qa", label: "QA", parentActorId: "cto-1", agentId: null, sessionId: "qa-session", status: "idle" },
    { id: "old-1", role: "development", label: "Archived", parentActorId: "cto-1", agentId: null, sessionId: "old-session", status: "archived" },
  );
  snapshot.messages.push(
    { id: "m-main", channel: "main", actorId: null, role: "user", text: "main", createdAt: "now", runId: null },
    { id: "m-system", channel: "main", actorId: null, role: "system", text: "hidden", createdAt: "now", runId: null },
    { id: "m-question", channel: "cto-inbox", actorId: null, role: "user", text: "question", createdAt: "now", runId: null },
    { id: "m-cto", channel: "decisions", actorId: "cto-1", role: "assistant", text: "cto", createdAt: "now", runId: "run-1" },
    { id: "m-worker", channel: "main", actorId: "worker-1", role: "assistant", text: "worker", createdAt: "now", runId: "run-2" },
  );

  const active = selectActiveActors(snapshot);
  assert.deepEqual(active.map(actor => actor.id), ["cto-1", "worker-1"]);
  assert.ok(Object.isFrozen(active) && Object.isFrozen(active[0]));
  assert.deepEqual(selectSessionTranscript(snapshot, "lead-main").map(message => message.id), ["m-main"]);
  assert.deepEqual(selectSessionTranscript(snapshot, "lead-questions").map(message => message.id), ["m-question"]);
  assert.deepEqual(selectSessionTranscript(snapshot, "cto-session").map(message => message.id), ["m-cto"]);
  assert.deepEqual(selectSessionTranscript(snapshot, "worker-session").map(message => message.id), ["m-worker"]);
  assert.deepEqual(selectSessionTranscript(snapshot, "unknown-session"), []);
  assert.ok(Object.isFrozen(selectSessionTranscript(snapshot, "cto-session")));
});
