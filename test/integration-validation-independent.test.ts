import assert from "node:assert/strict";
import test from "node:test";
import { progressTool, validationFixture, validationTool } from "./fixtures/integration-manager-platform.ts";

test("registered request fails closed on absent, null, or unsupported delegated-branch SDK versions", async t => {
  for (const version of [undefined, null, 0, 2]) {
    await t.test(`version ${String(version)}`, async () => {
      const f = await validationFixture();
      (f.f.platform as any).protectedTests.delegatedBranchInputVersion = version;
      const result = await validationTool().handler({ ...f.input, phase: "ci" }, f.managerContext, f.f.platform) as any;
      assert.equal(result.data.status, "unsupported");
      assert.equal(result.data.executionStarted, false);
      assert.equal(f.enqueueCalls, 0);
      const progress = await progressTool().handler({ workstreamId: "ws-1", eventId: f.eventId }, f.managerContext, f.f.platform) as any;
      assert.equal(progress.data.attempts[0].validationRuns, undefined);
    });
  }
});

test("reproduces acceptance of a Core run whose child approval pin impersonates the parent template", async () => {
  const f = await validationFixture();
  const api = (f.f.platform as any).protectedTests;
  const enqueue = api.enqueueApprovedV1.bind(api);
  api.enqueueApprovedV1 = async (input: unknown) => {
    const run = await enqueue(input);
    run.pins.approvalId = f.plan.validationPlans!.ci.approvalTemplateId;
    return run;
  };

  const result = await validationTool().handler({ ...f.input, phase: "ci" }, f.managerContext, f.f.platform) as any;
  assert.equal(result.data.status, "published");
  assert.equal(result.data.reference.approvalId, f.plan.validationPlans!.ci.approvalTemplateId);
  assert.equal(result.data.qaVerdict, "not-established");
});

test("rejects Core run DTOs with mismatched source, commit, tree, plan, or subject pins", async t => {
  for (const [label, mutate] of [
    ["source", (run: any) => { run.pins.sourceId = "99999999-9999-4999-8999-999999999998"; }],
    ["commit", (run: any) => { run.pins.commitSha = "9".repeat(40); }],
    ["tree", (run: any) => { run.pins.treeSha = "8".repeat(40); }],
    ["plan", (run: any) => { run.pins.planSha256 = "7".repeat(64); }],
    ["subject", (run: any) => { run.pins.subjectKeySha256 = "6".repeat(64); }],
  ] as const) {
    await t.test(label, async () => {
      const f = await validationFixture();
      const api = (f.f.platform as any).protectedTests;
      const enqueue = api.enqueueApprovedV1.bind(api);
      api.enqueueApprovedV1 = async (input: unknown) => {
        const run = await enqueue(input);
        mutate(run);
        return run;
      };

      const result = await validationTool().handler({ ...f.input, phase: "ci" }, f.managerContext, f.f.platform) as any;
      assert.equal(result.data.status, "unknown");
      assert.equal(result.data.executionStarted, null);
      const progress = await progressTool().handler({ workstreamId: "ws-1", eventId: f.eventId }, f.managerContext, f.f.platform) as any;
      assert.equal(progress.data.technicalValidation[0].status, "unknown");
      assert.equal(progress.data.technicalValidation[0].runId, null);
    });
  }
});

test("concurrent same-phase requests produce one Core enqueue and one existing result", async () => {
  const f = await validationFixture();
  const api = (f.f.platform as any).protectedTests;
  const enqueue = api.enqueueApprovedV1.bind(api);
  let releaseFirst!: () => void, firstEntered!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const entered = new Promise<void>(resolve => { firstEntered = resolve; });
  let calls = 0;
  api.enqueueApprovedV1 = async (input: unknown) => {
    calls++;
    if (calls === 1) { firstEntered(); await firstGate; }
    return enqueue(input);
  };

  const request = { ...f.input, phase: "ci" };
  const first = validationTool().handler(request, f.managerContext, f.f.platform);
  await entered;
  const second = validationTool().handler(request, f.managerContext, f.f.platform);
  await new Promise(resolve => setTimeout(resolve, 75));
  releaseFirst();
  const results = await Promise.all([first, second]) as any[];
  assert.equal(calls, 1);
  assert.deepEqual(results.map(result => result.data.status).sort(), ["existing", "published"]);
  assert.equal(f.requests.length, 1);
});
