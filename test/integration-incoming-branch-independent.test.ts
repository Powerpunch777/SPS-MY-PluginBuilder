import assert from "node:assert/strict";
import test from "node:test";
import { createIntegrationAttemptStore } from "../src/builder-gates/integration-progress.ts";
import { W } from "./fixtures/cto-platform.ts";
import { BASE_COMMIT, BASE_TREE, hash, integrationTool, preparedFixture, validationFixture, validationTool } from "./fixtures/integration-manager-platform.ts";

// Registered Builder producers/handler over fixture Core DTOs only. No actual
// Git effect, SDK Worker, provider, Agent execution or Host advertisement is proven.
const operation = "localFolders.integrateWorkspaceSourceCommitV2";
for (const [label, hostSupport] of [
  ["unknown Host", { state: "unknown" }],
  ["reported Host missing V2", { state: "reported", contractVersion: "1.0", operations: ["localFolders.integrateWorkspaceSourceCommitV1"] }],
  ["unsupported contract", { state: "reported", contractVersion: "0.9", operations: [operation] }],
] as const) {
  test(`incoming branch V2 facade presence alone cannot reserve or dispatch on ${label}`, async () => {
    const f = await preparedFixture();
    let tipReads = 0, v2Calls = 0, oldCalls = 0;
    Object.assign(f.f.platform, { hostSupport, localFolders: {
      async readWorkspaceSourceGitTipV1(sourceId: string, folderKey: string, branch: string) {
        tipReads++;
        return branch === f.plan.baseBranch
          ? { status: "current", sourceId, folderKey, branch, commitSha: BASE_COMMIT, treeSha: BASE_TREE,
            observedAt: "2026-11-09T00:00:00.000Z" }
          : { status: "denied", reason: "branch_unavailable" };
      },
      async integrateWorkspaceSourceCommitV2() {
        v2Calls++;
        // Matches the candidate SDK facade's unadvertised-Host rejection.
        throw new Error("This Host does not advertise Workspace Git integration V2.");
      },
      async integrateWorkspaceSourceCommitV1() {
        oldCalls++;
        assert.fail("An incoming branch proof must never fall back to V1.");
      },
    } });
    const input = { workstreamId: "ws-1", eventId: f.eventId, taskId: "task-dev" };
    const result = await integrationTool()!.handler(input, f.managerContext, f.f.platform) as {
      data: { status: string; reason: string };
    };
    const reservation = await createIntegrationAttemptStore({ workspaceId: W, ...input }, f.f.state).current();
    assert.deepEqual({ status: result.data.status, tipReads, v2Calls, oldCalls, reserved: reservation !== null },
      { status: "unsupported", tipReads: 0, v2Calls: 0, oldCalls: 0, reserved: false },
      `Optional Host support must be known before an effect reservation: ${JSON.stringify(result.data)}`);
  });
}

test("a legacy V1 attempt remains read-only and cannot admit a new registered CI validation", async () => {
  const f = await validationFixture();
  const store = createIntegrationAttemptStore({ workspaceId: W, ...f.input }, f.f.state);
  const current = (await store.current())!.revision;
  const { incomingBranch: _branch, ...effect } = current.effect;
  const { revisionId: _id, ...content } = { ...current, effect };
  const legacy = { ...content, revisionId: `integration-attempt-v1:${hash(content)}` };
  assert.equal((await store.publish({ expectedBaseRevisionId: current.revisionId, revision: legacy })).status, "published");
  let admitted = false;
  try {
    const result = await validationTool().handler({ ...f.input, phase: "ci" }, f.managerContext, f.f.platform) as {
      data: { admission?: string };
    };
    admitted = result.data.admission === "confirmed";
  } catch {
    // A rejection is valid here, but cannot conceal a write or enqueue.
  }
  assert.deepEqual({ enqueueCalls: f.enqueueCalls, admitted, unchanged: (await store.current())!.revision.revisionId === legacy.revisionId },
    { enqueueCalls: 0, admitted: false, unchanged: true },
    "Reading historical V1 evidence must not create current validation authority or rewrite its journal.");
});
