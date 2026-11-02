import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyBuilderSnapshot } from "../src/domain/snapshot.ts";
import { projectProjectCtos } from "../src/domain/project-ctos-view.ts";
import type { BuilderSnapshot } from "../src/domain/model.ts";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CREATOR_SESSION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function cto(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ctoId: "cto-1", displayName: "Build coordinator", agentId: AGENT, sessionId: SESSION,
    status: "ACTIVE", createdAt: "2026-11-02T03:04:05.006Z",
    createdBy: { agentId: AGENT, sessionId: CREATOR_SESSION, runId: RUN, selectionRevision: 1 },
    ...overrides,
  };
}

function registry(ctos: unknown[] = [cto()], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, workspaceId: WORKSPACE, projectId: WORKSPACE, revision: ctos.length ? 1 : 0, ctos, ...overrides };
}

function snapshot(): BuilderSnapshot {
  return createEmptyBuilderSnapshot(WORKSPACE);
}

test("projects registered CTOs as idle identities without claiming active execution", () => {
  const base = snapshot();
  const projected = projectProjectCtos(base, registry());
  assert.equal(projected.actors.length, 1);
  assert.deepEqual(projected.actors[0], {
    id: "cto-1", role: "cto", label: "Build coordinator", parentActorId: null,
    agentId: AGENT, sessionId: SESSION, status: "idle",
  });
  assert.deepEqual(projected.activity, []);
  assert.deepEqual(projected.messages, []);
  assert.equal(base.actors.length, 0);
  assert.equal(projected.documents, base.documents);
  assert.equal(projected.graph, base.graph);
});

test("projects empty registries and maps retired and session-pending CTOs conservatively", () => {
  const base = snapshot();
  assert.deepEqual(projectProjectCtos(base, registry([])).actors, []);
  const projected = projectProjectCtos(base, registry([
    cto({ ctoId: "retired", status: "RETIRED", sessionId: null }),
    cto({ ctoId: "pending", status: "AVAILABLE", sessionId: null }),
  ]));
  assert.deepEqual(projected.actors.map(actor => [actor.id, actor.status, actor.sessionId]), [
    ["retired", "archived", null], ["pending", "idle", null],
  ]);
});

test("rejects workspace, project, actor-ID, and actor/lead-session collisions", () => {
  const base = snapshot();
  const otherWorkspace = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  assert.throws(() => projectProjectCtos(base, registry([cto()], { workspaceId: otherWorkspace })), /cross-workspace\/project/);
  assert.throws(() => projectProjectCtos(base, registry([cto()], { projectId: "other-project" })), /cross-workspace\/project/);

  const actorCollision = snapshot();
  actorCollision.actors.push({ id: "cto-1", role: "development", label: "Existing", parentActorId: null,
    agentId: null, sessionId: null, status: "idle" });
  assert.throws(() => projectProjectCtos(actorCollision, registry()), /collides with a snapshot actor/);

  const actorSessionCollision = snapshot();
  actorSessionCollision.actors.push({ id: "existing", role: "development", label: "Existing", parentActorId: null,
    agentId: null, sessionId: SESSION, status: "idle" });
  assert.throws(() => projectProjectCtos(actorSessionCollision, registry()), /collides with a snapshot session/);

  const leadSessionCollision = snapshot();
  leadSessionCollision.leadSessions.main = SESSION;
  assert.throws(() => projectProjectCtos(leadSessionCollision, registry()), /collides with a snapshot session/);
});

test("strictly parses and freezes a detached registry without mutating its source", () => {
  const raw = registry();
  const projected = projectProjectCtos(snapshot(), raw);
  const sourceCto = (raw.ctos as Record<string, unknown>[])[0]!;
  assert.equal(Object.isFrozen(raw), false);
  assert.equal(projected.actors[0]!.label, "Build coordinator");
  sourceCto.displayName = "Changed after projection";
  assert.equal(projected.actors[0]!.label, "Build coordinator");
  assert.throws(() => projectProjectCtos(snapshot(), { ...registry(), extra: true }), /unknown or missing fields/);
});
