import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "@sonparkserver/plugin-sdk/platform";
import type { RevisionState } from "../src/solution-revision-store.ts";
import { recordCtoTaskSourceAcceptance, type CurrentTaskSourceAcceptanceAuthority } from "../src/task-source-acceptance.ts";
import type { TaskPacketRecord } from "../src/domain/task-packets.ts";
import type { TaskSourceSubmission } from "../src/task-source-submissions.ts";

const W = "11111111-1111-4111-8111-111111111111";
const P = "project-one";
const CTO = "cto-alpha";
const CTO_AGENT = "22222222-2222-4222-8222-222222222222";
const CTO_SESSION = "33333333-3333-4333-8333-333333333333";
const CTO_RUN = "44444444-4444-4444-8444-444444444444";
const WORKER = "55555555-5555-4555-8555-555555555555";
const WORKER_SESSION = "66666666-6666-4666-8666-666666666666";
const WORKER_RUN = "77777777-7777-4777-8777-777777777777";
const SOURCE = "88888888-8888-4888-8888-888888888888";
const HEAD = "a".repeat(40);
const PACKET_SHA = "b".repeat(64);

function fixture(options: Readonly<{ stale?: boolean; afterCommitChanged?: boolean; taskHeadChanged?: boolean;
  dependencyChanged?: boolean; casLostAfterWrite?: boolean }> = {}) {
  const pins = Object.freeze([{ taskId: "dependency", revision: options.dependencyChanged ? 3 : 2,
    recordSha256: options.dependencyChanged ? "9".repeat(64) : "c".repeat(64) }]);
  const submittedPins = Object.freeze([{ taskId: "dependency", revision: 2, recordSha256: "c".repeat(64) }]);
  const task = { packet: { taskId: "task-1", revision: 3, sourceAccess: { sourceId: SOURCE, folderKey: "project-source",
    branch: "feature/task-1", expectedHead: options.taskHeadChanged ? "9".repeat(40) : HEAD,
    readPaths: ["src/a.ts"], writePaths: ["src/a.ts"], qaWritePaths: ["test/a.test.ts"] } },
    dependencyPins: pins } as unknown as TaskPacketRecord;
  let authorityChecks = 0;
  const current: CurrentTaskSourceAcceptanceAuthority = Object.freeze({ workspaceId: W, projectId: P, ctoId: CTO,
    workstreamId: "ws-1", taskId: "task-1", ctoAgentId: CTO_AGENT, ctoSessionId: CTO_SESSION, ctoRunId: CTO_RUN,
    task, packetDigest: PACKET_SHA, packets: [task], workerRecords: [], submissionCandidates: [], dependencyPins: pins,
    async assertCurrent() { authorityChecks += 1; if (options.stale) throw new Error("CTO authority changed"); } });
  const submission: TaskSourceSubmission = Object.freeze({ schemaVersion: 1, submissionId: "d".repeat(64), workspaceId: W,
    projectId: P, ctoId: CTO, workstreamId: "ws-1", taskId: "task-1", packetRevision: 3,
    packetRecordSha256: PACKET_SHA, dependencyPins: submittedPins, role: "worker",
    producer: { agentId: WORKER, sessionId: WORKER_SESSION, runId: WORKER_RUN },
    source: { sourceId: SOURCE, folderKey: "project-source", branch: "feature/task-1", expectedHead: HEAD },
    requestedPaths: ["src/a.ts"], commitSha: "e".repeat(40), treeSha: "f".repeat(40), changedPaths: ["src/a.ts"],
    coreStatus: "committed", authorityAfterCommit: options.afterCommitChanged ? "changed" : "current",
    submittedAt: "2026-11-07T01:02:03.000Z" });
  const rows = new Map<string, JsonValue>();
  let writes = 0;
  const state: RevisionState = {
    async get(key) { return structuredClone(rows.get(key.stateKey) ?? null); },
    async compareAndSet(key, expected, value) {
      const currentValue = rows.get(key.stateKey) ?? null;
      if (expected.exists ? JSON.stringify(expected.value) !== JSON.stringify(currentValue) : currentValue !== null) return { swapped: false };
      rows.set(key.stateKey, structuredClone(value)); writes += 1;
      if (options.casLostAfterWrite) throw new Error("CAS response lost after write");
      return { swapped: true };
    },
  };
  const receiver = { workspaceId: W, projectId: P, ctoId: CTO, agentId: CTO_AGENT, sessionId: CTO_SESSION, runId: CTO_RUN };
  const accept = (override: Partial<typeof receiver> = {}) => recordCtoTaskSourceAcceptance({ current, submission,
    receiver: { ...receiver, ...override }, state });
  return { current, submission, rows, accept, get writes() { return writes; }, get authorityChecks() { return authorityChecks; } };
}

test("CTO records receipt of the exact immutable commit once and replay is idempotent, not QA", async () => {
  const f = fixture();
  const first = await f.accept();
  assert.equal(first.status, "accepted");
  assert.equal(first.acceptance?.commitSha, f.submission.commitSha);
  assert.equal(first.acceptance?.meaning, "cto-received-exact-submitted-commit");
  assert.deepEqual(first.acceptance?.receivedBy, { agentId: CTO_AGENT, sessionId: CTO_SESSION, runId: CTO_RUN });
  assert.equal(JSON.stringify(first).includes("PASS"), false);
  assert.equal("qaVerdict" in (first.acceptance ?? {}), false);
  assert.equal(f.writes, 1);
  const replay = await f.accept();
  assert.equal(replay.status, "existing");
  assert.deepEqual(replay.acceptance, first.acceptance);
  assert.equal(f.writes, 1);
});

test("wrong Workspace, project, CTO, session or Run cannot accept", async t => {
  for (const [label, override] of [
    ["workspace", { workspaceId: "99999999-9999-4999-8999-999999999999" }],
    ["project", { projectId: "other-project" }],
    ["cto", { ctoId: "cto-other" }],
    ["session", { sessionId: "99999999-9999-4999-8999-999999999999" }],
    ["run", { runId: "99999999-9999-4999-8999-999999999999" }],
  ] as const) await t.test(label, async () => {
    const f = fixture();
    await assert.rejects(f.accept(override), /exact current CTO Agent, session and active Run/u);
    assert.equal(f.rows.size, 0);
    assert.equal(f.writes, 0);
  });
});

test("source/head/dependency/authority drift never creates an acceptance receipt", async t => {
  for (const [label, options] of [["post-commit authority", { afterCommitChanged: true }],
    ["source branch head", { taskHeadChanged: true }], ["dependency revision", { dependencyChanged: true }]] as const) {
    await t.test(label, async () => {
      const f = fixture(options);
      assert.deepEqual(await f.accept(), { status: "stale", reason: "task-source-or-authority-pins-changed" });
      assert.equal(f.rows.size, 0);
      assert.equal(f.writes, 0);
    });
  }
});

test("lost CAS reply reconciles the same exact receipt without creating another acceptance", async () => {
  const f = fixture({ casLostAfterWrite: true });
  const result = await f.accept();
  assert.equal(result.status, "existing");
  assert.equal(result.acceptance?.submissionId, f.submission.submissionId);
  assert.equal(f.writes, 1);
});

test("CTO authority change during acceptance prevents a false successful handoff", async () => {
  const f = fixture({ stale: true });
  await assert.rejects(f.accept(), /CTO authority changed/u);
  assert.equal(f.writes, 0);
});
