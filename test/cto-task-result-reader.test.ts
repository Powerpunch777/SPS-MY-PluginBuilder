import assert from "node:assert/strict";
import test from "node:test";
import { createBuilderPlatform } from "../src/platform.ts";
import { MANAGER_SESSION_TERMINAL_JOB } from "../src/builder-gates/integration-manager-job.ts";
import { workerResultFixture } from "./fixtures/cto-task-result-independent.ts";
import { A, C, CTO, W } from "./fixtures/cto-platform.ts";

test("the existing CTO read tool exposes only the exact child Task result without accepting the source", async () => {
  const f = await workerResultFixture();
  const contract = createBuilderPlatform();
  const job = contract.jobs.find(item => item.jobKey === MANAGER_SESSION_TERMINAL_JOB)!;
  await job.handler(f.childJob() as never, f.f.platform);
  await job.handler(f.terminalParent() as never, f.f.platform);
  const child = f.dispatches[0]!;
  const head = (await f.f.deliveryStore().current())!.revision.revisionId;
  const tool = contract.tools.find(item => item.name === "builder.read-cto-workstream")!;
  const read = await tool.handler({ projectId: W, ctoId: CTO, workstreamId: "ws-1" },
    { companyId: W, projectId: W, agentId: A, sessionId: C, runId: child.runId } as never,
    f.f.platform) as { data: { currentTaskResult: { taskId: string; sourceCommitSha: string;
      sourceRunId: string; eventId: string; runId: string } } };
  assert.equal(read.data.currentTaskResult.taskId, f.results[0]!.worker.taskId);
  assert.equal(read.data.currentTaskResult.sourceCommitSha, f.tips.values().next().value!.commitSha);
  assert.equal(read.data.currentTaskResult.sourceRunId, f.results[0]!.runId);
  assert.equal(read.data.currentTaskResult.eventId, f.results[0]!.eventId);
  assert.equal(read.data.currentTaskResult.runId, child.runId);
  assert.equal((await f.f.deliveryStore().current())!.revision.revisionId, head);
  assert.equal(f.dispatches.length, 1);
});

test("a child cannot read an altered Task with a reused revision number", async () => {
  const f = await workerResultFixture();
  const contract = createBuilderPlatform();
  const job = contract.jobs.find(item => item.jobKey === MANAGER_SESSION_TERMINAL_JOB)!;
  await job.handler(f.childJob() as never, f.f.platform);
  await job.handler(f.terminalParent() as never, f.f.platform);
  const child = f.dispatches[0]!;
  const board = (await f.packetStore.current())!.revision;
  assert.equal((await f.packetStore.publish({ expectedBaseRevisionId: board.revisionId,
    revision: { ...board, revisionId: "altered-same-revision-task-board", packets: board.packets.map(row =>
      ({ ...row, packet: { ...row.packet, goal: "Changed scope using the same revision number." } })) } })).status, "published");
  const tool = contract.tools.find(item => item.name === "builder.read-cto-workstream")!;
  await assert.rejects(async () => tool.handler({ projectId: W, ctoId: CTO, workstreamId: "ws-1" },
    { companyId: W, projectId: W, agentId: A, sessionId: C, runId: child.runId } as never,
    f.f.platform), /current Workstream, Task, or Worker registration/u);
  assert.equal(f.dispatches.length, 1);
});
