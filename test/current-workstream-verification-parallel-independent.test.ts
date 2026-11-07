import assert from "node:assert/strict";
import test from "node:test";
import { setupVerifiedWorkstreamPlatform } from "./fixtures/verified-workstream-platform.ts";
import { createWorkstreamStore } from "../src/workstream-tools.ts";
import { createWorkstreamVerificationPublication } from "../src/builder-gates/workstream-verification-publication.ts";
import type { RevisionState } from "../src/solution-revision-store.ts";
import { W, now } from "./fixtures/cto-platform.ts";

test("unrelated Workstream B publication invalidates A's whole-board verification guard despite exact A evidence", async () => {
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
  assert.equal(afterB.status, "stale", "A's source head guard is bound to the entire Workstream board revision");
  assert.equal(f.f.sends, sendsBefore, "B board update and A evidence observation did not start an Agent run");
  const reportBefore = (await f.reportStore().current())!.revision;
  const repro = await f.verify();
  assert.equal(repro.data.status, "existing", "the exact A evidence reuses its immutable verification event");
  assert.equal(f.f.sends, sendsBefore, "verification did not rerun Worker or QA sessions");
  assert.equal((await f.reportStore().current())!.revision.revisionId, reportBefore.revisionId,
    "A's authored QA history is preserved unchanged");
  assert.equal((await publication.readCurrent(scope)).status, "stale",
    "reusing the exact event does not refresh its stale whole-board publication guard");
});
