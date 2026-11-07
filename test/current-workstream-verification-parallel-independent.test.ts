import assert from "node:assert/strict";
import test from "node:test";
import { setupVerifiedWorkstreamPlatform } from "./fixtures/verified-workstream-platform.ts";
import { createWorkstreamStore } from "../src/workstream-tools.ts";
import { createWorkstreamVerificationPublication } from "../src/builder-gates/workstream-verification-publication.ts";
import type { RevisionState } from "../src/solution-revision-store.ts";
import { W, now } from "./fixtures/cto-platform.ts";

test("unrelated Workstream B publication preserves A's exact verification and QA without a new run or event", async () => {
  const f = await setupVerifiedWorkstreamPlatform();
  const verified = await f.verify();
  assert.equal(verified.data.status, "published", JSON.stringify(verified.data));
  const eventId = verified.data.eventId as string;
  const sendsBefore = f.f.sends;
  const publication = createWorkstreamVerificationPublication(f.f.state as unknown as RevisionState);
  const scope = { workspaceId: W, projectId: W, workstreamId: "ws-1", eventId };
  assert.equal((await publication.readCurrent(scope)).status, "current");

  const store = createWorkstreamStore(W, W, f.f.state as unknown as RevisionState);
  const board = (await store.current())!.revision;
  const a = board.workstreams.find(item => item.spec.id === "ws-1")!;
  const b = { ...a, spec: { ...a.spec, id: "ws-b", title: "Unrelated Workstream B", goal: "Independent scope" },
    change: { ...a.change, previousRevision: null, reason: "Independent B update", diff: "B-only change",
      impactNodeIds: [], impactTaskIds: [] },
    receipt: { revision: a.spec.revision, agentId: a.ctoAgentId, sessionId: a.ctoSessionId,
      runId: f.ctoContext.runId, createdAt: now, readiness: "ready" as const,
      note: "Independent B readiness fixture; not an A approval." } };
  await store.publish({ expectedBaseRevisionId: board.revisionId, revision: { ...board,
    revisionId: "parallel-b-updated-and-acknowledged", workstreams: [a, b] } });

  const afterB = await publication.readCurrent(scope);
  assert.equal(afterB.status, "current", "only the unrelated board head changed; exact A evidence remains current");
  assert.equal(f.f.sends, sendsBefore, "B board update and A evidence observation did not start an Agent run");
  const reportBefore = (await f.reportStore().current())!.revision;
  const repro = await f.verify();
  assert.equal(repro.data.status, "existing", "the exact A evidence reuses its immutable verification event");
  assert.equal(f.f.sends, sendsBefore, "verification did not rerun Worker or QA sessions");
  assert.equal((await f.reportStore().current())!.revision.revisionId, reportBefore.revisionId,
    "A's authored QA history is preserved unchanged");
  assert.equal((await publication.readCurrent(scope)).status, "current");
  assert.equal(f.wakes.length, 1, "observation and event reuse never create a new verification job");
});

test("a changed or removed A never inherits its earlier Workstream verification", async t => {
  for (const mode of ["changed", "removed"] as const) await t.test(mode, async () => {
    const f = await setupVerifiedWorkstreamPlatform(), verified = await f.verify();
    const state = f.f.state as unknown as RevisionState, store = createWorkstreamStore(W, W, state);
    const board = (await store.current())!.revision, a = board.workstreams[0]!;
    const changed = { ...a, spec: { ...a.spec, goal: "Changed A instruction", ...(mode === "removed" ? { id: "ws-b" } : {}) } };
    await store.publish({ expectedBaseRevisionId: board.revisionId, revision: { ...board, revisionId: `board-a-${mode}`,
      workstreams: [changed] } });
    const publication = createWorkstreamVerificationPublication(state);
    assert.equal((await publication.readCurrent({ workspaceId: W, projectId: W, workstreamId: "ws-1",
      eventId: verified.data.eventId })).status, "stale");
    assert.equal(f.wakes.length, 1);
  });
});

test("a board move during the scoped proof is rejected by the final atomic guard", async () => {
  const f = await setupVerifiedWorkstreamPlatform(), verified = await f.verify();
  const state = f.f.state as unknown as RevisionState, store = createWorkstreamStore(W, W, state);
  const board = (await store.current())!.revision, a = board.workstreams[0]!;
  const b = { ...a, spec: { ...a.spec, id: "ws-b" } };
  await store.publish({ expectedBaseRevisionId: board.revisionId, revision: { ...board, revisionId: "board-b-advance", workstreams: [a, b] } });
  const guarded = state.guardedCompareAndSet!;
  let raced = false;
  state.guardedCompareAndSet = async (...args) => {
    if (!raced && args[0].stateKey.startsWith("workstream-verification-head.v1.")) {
      raced = true;
      await store.publish({ expectedBaseRevisionId: "board-b-advance", revision: { ...board, revisionId: "board-a-raced",
        workstreams: [{ ...a, spec: { ...a.spec, goal: "Changed after proof" } }, b] } });
    }
    return guarded(...args);
  };
  const publication = createWorkstreamVerificationPublication(state);
  assert.equal((await publication.readCurrent({ workspaceId: W, projectId: W, workstreamId: "ws-1",
    eventId: verified.data.eventId })).status, "stale");
  assert.equal(raced, true);
});
