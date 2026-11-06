import assert from "node:assert/strict";
import test from "node:test";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { dispatchCtoWorkstream } from "../src/cto-workstream-delivery.ts";
import { createWorkstreamStore } from "../src/workstream-tools.ts";
import { createTaskPacketStore } from "../src/task-packet-tools.ts";
import { prepareTaskWorker, readTaskWorkers } from "../src/task-worker-tools.ts";
import { workstreamInstructionDigest } from "../src/cto-delivery-store.ts";
import { fixture, W, A, C, P, CTO, ctx, now } from "./fixtures/cto-platform.ts";

test("Worker prepare and read reject a superseded Workstream before Host or registry effects", async () => {
  const f = await fixture();
  await dispatchCtoWorkstream(f.params, ctx(), f.platform);
  const runId = [...f.runs.keys()][0]!;
  const runContext = ctx(C, runId);
  const delivery = (await f.deliveryStore().current())!.revision;
  const source = { requestId: delivery.requestId, workstreamId: "ws-1", specRevision: 1,
    instructionSha256: workstreamInstructionDigest(f.instruction) };
  const author = { agentId: A, sessionId: C, runId };
  const packet = { projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId: "task-1", revision: 1,
    kind: "development" as const, title: "Task", goal: "Implement assigned scope", scopeNodeIds: ["feature"],
    requirementIds: ["REQ-1"], dependencies: [], included: ["Feature"], excluded: [], constraints: [],
    acceptance: ["Acceptance is met"], evidenceRequired: ["Evidence"], reuse: [], testPlan: null };
  const packets = createTaskPacketStore(W, P, CTO, "ws-1", f.state);
  await packets.publish({ expectedBaseRevisionId: null, revision: { projectId: P, ctoId: CTO,
    workstreamId: "ws-1", revisionId: "packet-board-1", packets: [{ packet, source, author,
      createdAtISO: now, dependencyPins: [] }] } });

  const workstreams = createWorkstreamStore(W, P, f.state);
  await workstreams.publish({ expectedBaseRevisionId: "board-1", revision: { projectId: P,
    revisionId: "board-supersedes-delivery", workstreams: [{ ...f.instruction,
      spec: { ...f.instruction.spec, revision: 2, goal: "Superseding instruction" },
      change: { ...f.instruction.change, previousRevision: 1 } }] } });

  const effects = { ownedLookups: 0, profileCreations: 0, sessionCreations: 0, registryReads: 0, registryWrites: 0 };
  const workerRegistryPrefix = "task-workers.v1.";
  const state = f.platform.state;
  const originalGet = state.get.bind(state);
  const originalCompareAndSet = state.compareAndSet!.bind(state);
  Object.assign(state, {
    async get(key: Parameters<typeof state.get>[0]) {
      if (key.stateKey.startsWith(workerRegistryPrefix)) effects.registryReads++;
      return originalGet(key);
    },
    async compareAndSet(key: Parameters<NonNullable<typeof state.compareAndSet>>[0], ...args: Parameters<NonNullable<typeof state.compareAndSet>> extends [unknown, ...infer Rest] ? Rest : never) {
      if (key.stateKey.startsWith(workerRegistryPrefix)) effects.registryWrites++;
      return originalCompareAndSet(key, ...args);
    },
  });
  const owned = {
    async get({ pluginAgentKey }: { companyId: string; pluginAgentKey: string }) {
      effects.ownedLookups++;
      return { status: "missing" };
    },
    async ensure({ config }: { companyId: string; pluginAgentKey: string; config: { name: string; role: "engineer"; title: string; instructions: string } }) {
      effects.profileCreations++;
      return { status: "missing" };
    },
  };
  Object.assign(f.platform.agents, {
    owned,
  });
  Object.assign(f.platform.agents.sessions, {
    async ensure() { effects.sessionCreations++; return { sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", created: true }; },
  });

  const writesBefore = f.writes;
  const params = { projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId: "task-1", packetRevision: 1, role: "worker" };
  const staleAuthority = /delivered Workstream is no longer current/iu;
  await assert.rejects(prepareTaskWorker(params, runContext, f.platform as SpsPlatformInvocationContext), staleAuthority);
  await assert.rejects(readTaskWorkers({ projectId: P, ctoId: CTO, workstreamId: "ws-1" }, runContext,
    f.platform as SpsPlatformInvocationContext), staleAuthority);
  assert.deepEqual(effects, { ownedLookups: 0, profileCreations: 0, sessionCreations: 0, registryReads: 0, registryWrites: 0 });
  assert.equal(f.writes, writesBefore, "stale authority must not write any state");
  assert.equal(f.sends, 1, "the only send is the fixture's CTO delivery; Worker operations start no AI Run");
});
