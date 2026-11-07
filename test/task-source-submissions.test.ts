import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import type { RevisionState } from "../src/solution-revision-store.ts";
import { parseTaskPacket } from "../src/domain/task-packets.ts";
import { readTaskSourceClaim, readTaskSourceSubmission, submitTaskSourceFiles, type TaskSourceSubmissionBinding } from "../src/task-source-submissions.ts";

const W = "10000000-0000-4000-8000-000000000001";
const P = "20000000-0000-4000-8000-000000000002";
const CTO = "cto-one";
const AGENT = "40000000-0000-4000-8000-000000000004";
const SESSION = "50000000-0000-4000-8000-000000000005";
const RUN = "60000000-0000-4000-8000-000000000006";
const SOURCE = "70000000-0000-4000-8000-000000000007";
const HEAD = "a".repeat(40);
const COMMIT = "b".repeat(40);
const TREE = "c".repeat(40);
const hostRunContext = Object.freeze({ companyId: W, projectId: P, agentId: AGENT, sessionId: SESSION, runId: RUN });

function binding(role: "worker" | "qa" = "worker"): TaskSourceSubmissionBinding {
  return Object.freeze({ schemaVersion: 1, workspaceId: W, projectId: P, ctoId: CTO, workstreamId: "ws-current",
    taskId: role === "worker" ? "task-impl" : "task-qa", packetRevision: 3, packetRecordSha256: "d".repeat(64),
    dependencyPins: Object.freeze([{ taskId: "task-base", revision: 2, recordSha256: "e".repeat(64) }]), role,
    agentId: AGENT, sessionId: SESSION, runId: RUN,
    source: Object.freeze({ sourceId: SOURCE, folderKey: "project-source", branch: "builder/task-impl",
      expectedHead: HEAD }), readPaths: Object.freeze(["src/main.ts", "test/main.test.ts"]),
    writePaths: Object.freeze(role === "worker" ? ["src/main.ts", "src/alternate.ts"] : []),
    qaWritePaths: Object.freeze(role === "qa" ? ["test/main.test.ts"] : []) });
}

function fixture(options: Readonly<{ result?: unknown; commitThrows?: boolean; status?: unknown; match?: unknown;
  casThrowsAt?: "intent" | "outcome"; casResponseLostAfterWriteAt?: "intent" | "outcome"; authorityThrowsAt?: number }> = {}) {
  const rows = new Map<string, JsonValue>();
  const operations: Array<{ method: string; input?: unknown }> = [];
  const workingFiles = new Map([["src/main.ts", "worker-wip-main"], ["src/alternate.ts", "worker-wip-alternate"]]);
  let commits = 0, checks = 0;
  const state: RevisionState = {
    async get(key) { return structuredClone(rows.get(key.namespace + "/" + key.stateKey) ?? null); },
    async compareAndSet(key, expected, value) {
      const id = key.namespace + "/" + key.stateKey;
      const current = rows.get(id) ?? null;
      if (options.casThrowsAt && key.stateKey.startsWith("task-source-" + options.casThrowsAt)) throw new Error("CAS response lost");
      if (expected.exists ? JSON.stringify(current) !== JSON.stringify(expected.value) : current !== null) return { swapped: false };
      rows.set(id, structuredClone(value));
      if (options.casResponseLostAfterWriteAt && key.stateKey.startsWith(`task-source-${options.casResponseLostAfterWriteAt}.v2.`)) {
        throw new Error("CAS response lost after write");
      }
      return { swapped: true };
    },
  };
  const platform = { localFolders: {
    async status(folderKey: string) {
      operations.push({ method: "status", input: folderKey });
      return options.status ?? { folderKey, configured: true, access: "readWrite", readable: true, writable: true,
        healthy: true, requiredDirectories: [], requiredFiles: [], missingDirectories: [], missingFiles: [], checkedAt: "2026-11-07T00:00:00.000Z" };
    },
    async matchWorkspaceSourceV1(folderKey: string, workspaceSourceId: string) {
      operations.push({ method: "match", input: { folderKey, workspaceSourceId } });
      return options.match ?? { folderKey, workspaceSourceId, match: "same_root" };
    },
    async commitTaskFilesV1(input: unknown) {
      commits += 1;
      operations.push({ method: "commit", input });
      if (options.commitThrows) throw new Error("response lost after host may have committed");
      const requested = input as { paths: string[] };
      return options.result ?? { status: "committed", commitSha: COMMIT, treeSha: TREE, changedPaths: requested.paths };
    },
  } } as unknown as SpsPlatformInvocationContext;
  const authority = async (runContext: unknown) => {
    assert.equal(runContext, hostRunContext);
    return { binding: binding(), async assertCurrent() {
      checks += 1;
      if (options.authorityThrowsAt === checks) throw new Error("Task or dependency pin changed");
    } };
  };
  const submit = (paths: unknown = ["src/main.ts"]) => submitTaskSourceFiles({ runContext: hostRunContext,
    paths, platform, state, resolveAuthority: authority });
  return { rows, operations, workingFiles, state, platform, submit, get commits() { return commits; }, get checks() { return checks; } };
}

test("Core commit receipt becomes an immutable Task source submission, not QA or completion", async () => {
  const f = fixture();
  const result = await f.submit();
  assert.equal(result.status, "submitted");
  if (result.status !== "submitted") return;
  assert.equal(result.submission.commitSha, COMMIT);
  assert.equal(result.submission.treeSha, TREE);
  assert.equal(result.submission.packetRevision, 3);
  assert.equal(result.submission.packetRecordSha256, "d".repeat(64));
  assert.deepEqual(result.submission.dependencyPins, [{ taskId: "task-base", revision: 2, recordSha256: "e".repeat(64) }]);
  assert.deepEqual(result.submission.producer, { agentId: AGENT, sessionId: SESSION, runId: RUN });
  assert.equal(result.submission.role, "worker");
  assert.deepEqual(result.submission.requestedPaths, ["src/main.ts"]);
  assert.equal("qaVerdict" in result, false);
  assert.equal("completion" in result, false);
  const commit = f.operations.find(row => row.method === "commit")?.input as Record<string, unknown>;
  assert.deepEqual(commit, { sourceId: SOURCE, folderKey: "project-source", branch: "builder/task-impl",
    expectedHead: HEAD, paths: ["src/main.ts"] });
  assert.equal([...f.rows.values()].length, 2, "intent and immutable outcome are separate records");
});

test("CTO discovers the exact submission by binding; legacy unbound receipts remain ineligible", async () => {
  const f = fixture();
  const result = await f.submit();
  assert.equal(result.status, "submitted");
  if (result.status !== "submitted") return;
  const { runId: _runId, ...base } = binding();
  const discovered = await readTaskSourceClaim({ state: f.state, binding: base });
  assert.equal(discovered.status, "submitted");
  if (discovered.status === "submitted") assert.equal(discovered.submission.submissionId, result.submission.submissionId);
  const read = await readTaskSourceSubmission({ state: f.state, binding: base, submissionId: result.submission.submissionId });
  assert.equal(read.status, "submitted");
  if (read.status === "submitted") assert.deepEqual(read.submission.requestedPaths, ["src/main.ts"]);
  assert.deepEqual(await readTaskSourceSubmission({ state: f.state, binding: base, submissionId: "f".repeat(64) }),
    { status: "not-found" });

  const outcomeKey = [...f.rows.keys()].find(key => key.includes("task-source-outcome.v2."))!;
  const stored = f.rows.get(outcomeKey)! as Record<string, unknown>;
  const outcome = stored.outcome as Record<string, unknown>;
  const receipt = outcome.submission as Record<string, unknown>;
  const { requestedPaths: _requestedPaths, ...legacyReceipt } = receipt;
  f.rows.delete(outcomeKey);
  for (const key of [...f.rows.keys()]) if (key.includes("task-source-intent.v2.")) f.rows.delete(key);
  const legacyState = { schemaVersion: 1, workspaceId: W, projectId: P, submissionId: result.submission.submissionId,
    bindingSha256: stored.bindingSha256, phase: "outcome", producerRunId: stored.producerRunId,
    outcome: { status: "submitted", submission: legacyReceipt } };
  f.rows.set(`sonpark.my-builder/task-source-outcome.v1.${result.submission.submissionId}`, legacyState as JsonValue);
  assert.deepEqual(await readTaskSourceSubmission({ state: f.state, binding: base, submissionId: result.submission.submissionId }),
    { status: "ineligible", reason: "legacy-receipt-unbound-paths" });
});

test("different path subsets share one durable claim and the first exact receipt", async () => {
  const f = fixture();
  const first = await f.submit(["src/main.ts"]);
  const second = await f.submit(["src/alternate.ts"]);
  assert.equal(first.status, "submitted");
  assert.equal(second.status, "existing");
  if (first.status === "submitted" && second.status === "existing") {
    assert.equal(second.submission.submissionId, first.submission.submissionId);
    assert.deepEqual(second.submission.requestedPaths, ["src/main.ts"]);
    assert.equal(second.duplicateCommitPrevented, true);
  }
  assert.equal(f.commits, 1);
  const { runId: _runId, ...base } = binding();
  const discovered = await readTaskSourceClaim({ state: f.state, binding: base });
  assert.equal(discovered.status, "submitted");
  if (discovered.status === "submitted") assert.deepEqual(discovered.submission.requestedPaths, ["src/main.ts"]);

  const otherHead = { ...base, source: { ...base.source, expectedHead: "f".repeat(40) } };
  assert.deepEqual(await readTaskSourceClaim({ state: f.state, binding: otherHead }), { status: "not-found" });
});

test("concurrent path subsets race on one claim before either can commit twice", async () => {
  const f = fixture();
  const results = await Promise.all([f.submit(["src/main.ts"]), f.submit(["src/alternate.ts"])]);
  assert.equal(f.commits, 1);
  assert.equal(results.filter(result => result.status === "submitted").length, 1);
  assert.equal(results.filter(result => result.status === "unknown").length, 1);
});

test("unchanged and conflicted Core outcomes are not submission receipts", async t => {
  for (const [label, result] of [["unchanged", { status: "unchanged", headSha: HEAD }],
    ["conflict", { status: "conflict", reason: "head_changed", actualHead: "f".repeat(40) }]] as const) {
    await t.test(label, async () => {
      const f = fixture({ result });
      const submitted = await f.submit();
      assert.ok(submitted.status === "unchanged" || submitted.status === "conflict");
      if (submitted.status === "unchanged" || submitted.status === "conflict") {
        const { runId: _runId, ...base } = binding();
        assert.deepEqual(await readTaskSourceSubmission({ state: f.state, binding: base, submissionId: submitted.submissionId }),
          { status: "ineligible", reason: "not-a-definitive-submission" });
      }
    });
  }
});

test("lost Core reply leaves a durable intent and never repeats the commit", async () => {
  const f = fixture({ commitThrows: true });
  const first = await f.submit();
  assert.equal(first.status, "unknown");
  const second = await f.submit(["src/alternate.ts"]);
  assert.equal(second.status, "unknown");
  assert.equal(f.commits, 1);
  assert.equal([...f.rows.keys()].filter(key => key.includes("task-source-intent.v2.")).length, 1);
  assert.equal([...f.rows.keys()].filter(key => key.includes("task-source-outcome.v2.")).length, 1);
  assert.equal(f.workingFiles.get("src/main.ts"), "worker-wip-main");
  assert.equal(f.workingFiles.get("src/alternate.ts"), "worker-wip-alternate");
});

test("lost intent reply after the claim write blocks all path subsets before Core", async () => {
  const f = fixture({ casResponseLostAfterWriteAt: "intent" });
  assert.equal((await f.submit()).status, "unknown");
  assert.equal((await f.submit(["src/alternate.ts"])).status, "unknown");
  assert.equal(f.commits, 0);
  assert.equal([...f.rows.keys()].filter(key => key.includes("task-source-intent.v2.")).length, 1);
  assert.deepEqual([...f.workingFiles], [["src/main.ts", "worker-wip-main"], ["src/alternate.ts", "worker-wip-alternate"]]);
});

test("lost outcome reply after persistence is discoverable and never recommits", async () => {
  const f = fixture({ casResponseLostAfterWriteAt: "outcome" });
  assert.equal((await f.submit()).status, "unknown");
  const retry = await f.submit(["src/alternate.ts"]);
  assert.equal(retry.status, "existing");
  assert.equal(f.commits, 1);
  const { runId: _runId, ...base } = binding();
  assert.equal((await readTaskSourceClaim({ state: f.state, binding: base })).status, "submitted");
});

test("lost outcome write without persistence leaves a no-retry claim", async () => {
  const f = fixture({ casThrowsAt: "outcome" });
  assert.equal((await f.submit()).status, "unknown");
  assert.equal((await f.submit(["src/alternate.ts"])).status, "unknown");
  assert.equal(f.commits, 1);
  assert.equal([...f.rows.keys()].filter(key => key.includes("task-source-intent.v2.")).length, 1);
  assert.equal([...f.rows.keys()].filter(key => key.includes("task-source-outcome.v2.")).length, 0);
});

test("retry from a later Host Run reuses the stable Task submission key and attributes the original producer", async () => {
  const f = fixture();
  const first = await f.submit();
  assert.equal(first.status, "submitted");
  const laterContext = Object.freeze({ ...hostRunContext, runId: "80000000-0000-4000-8000-000000000008" });
  const second = await submitTaskSourceFiles({ runContext: laterContext, paths: ["src/main.ts"],
    platform: f.platform, state: f.state, resolveAuthority: async context => {
      assert.equal(context, laterContext);
      return { binding: Object.freeze({ ...binding(), runId: laterContext.runId }), async assertCurrent() {} };
    } });
  assert.equal(second.status, "existing");
  if (first.status === "submitted" && second.status === "existing") {
    assert.equal(second.submission.submissionId, first.submission.submissionId);
    assert.equal(second.submission.producer.runId, RUN);
    assert.equal(second.duplicateCommitPrevented, true);
  }
  assert.equal(f.commits, 1);
});

test("Core head conflicts and unchanged results remain distinct and idempotent", async t => {
  await t.test("head conflict", async () => {
    const f = fixture({ result: { status: "conflict", reason: "head_changed", actualHead: "f".repeat(40) } });
    const first = await f.submit();
    assert.equal(first.status, "conflict");
    if (first.status === "conflict") assert.deepEqual(first, { status: "conflict", submissionId: first.submissionId,
      reason: "head_changed", actualHead: "f".repeat(40) });
    assert.equal((await f.submit()).status, "conflict");
    assert.equal(f.commits, 1);
  });
  await t.test("unchanged", async () => {
    const f = fixture({ result: { status: "unchanged", headSha: HEAD } });
    const result = await f.submit();
    assert.equal(result.status, "unchanged");
    if (result.status === "unchanged") assert.deepEqual(result, { status: "unchanged", submissionId: result.submissionId, headSha: HEAD });
    assert.equal((await f.submit()).status, "unchanged");
    assert.equal(f.commits, 1);
  });
});

test("only exact role-scoped Task paths reach Core", async () => {
  const f = fixture();
  await assert.rejects(f.submit(["src/other.ts"]), /exact subset/u);
  await assert.rejects(f.submit(["../escape.ts"]), /exact subset/u);
  assert.equal(f.commits, 0);
  assert.equal(f.rows.size, 0);
});

test("QA source submission stays attributed to its role and is not a QA verdict", async () => {
  const f = fixture();
  const result = await submitTaskSourceFiles({ runContext: hostRunContext, paths: ["test/main.test.ts"],
    platform: f.platform, state: f.state, resolveAuthority: async context => {
      assert.equal(context, hostRunContext);
      return { binding: binding("qa"), async assertCurrent() {} };
    } });
  assert.equal(result.status, "submitted");
  if (result.status === "submitted") {
    assert.equal(result.submission.role, "qa");
    assert.equal(result.submission.producer.agentId, AGENT);
    assert.equal("qaVerdict" in result, false);
  }
  assert.equal(f.commits, 1);
});

test("missing commit API, wrong alias, stale authority and uncertain CAS fail closed", async t => {
  await t.test("old SDK", async () => {
    const f = fixture();
    const result = await submitTaskSourceFiles({ runContext: hostRunContext, paths: ["src/main.ts"],
      platform: {} as SpsPlatformInvocationContext, state: f.state,
      resolveAuthority: async () => { throw new Error("must not resolve without commit API"); } });
    assert.equal(result.status, "unsupported");
    assert.equal(f.commits, 0);
  });
  await t.test("wrong declared Source alias", async () => {
    const f = fixture({ match: { folderKey: "project-source", workspaceSourceId: SOURCE, match: "different_root" } });
    assert.equal((await f.submit()).status, "unsupported");
    assert.equal(f.commits, 0);
    assert.equal(f.rows.size, 0);
  });
  await t.test("stale Task pin", async () => {
    const f = fixture({ authorityThrowsAt: 2 });
    await assert.rejects(f.submit(), /Task or dependency pin changed/u);
    assert.equal(f.commits, 0);
    assert.equal(f.rows.size, 0);
  });
  await t.test("intent CAS uncertainty", async () => {
    const f = fixture({ casThrowsAt: "intent" });
    assert.equal((await f.submit()).status, "unknown");
    assert.equal(f.commits, 0);
  });
});

test("branch and expected head must be explicit together; nothing is inferred", async () => {
  const f = fixture();
  const invalid = { ...binding(), source: { sourceId: SOURCE, folderKey: "project-source", branch: "builder/task-impl" } };
  await assert.rejects(submitTaskSourceFiles({ runContext: hostRunContext, paths: ["src/main.ts"],
    platform: f.platform, state: f.state, resolveAuthority: async () => ({ binding: invalid as TaskSourceSubmissionBinding,
      async assertCurrent() {} }) }), /Task source contract has unknown or missing fields/u);
  assert.equal(f.commits, 0);
  assert.equal(f.rows.size, 0);
});

test("Task Packet accepts only an explicit branch/head pair for source submission", () => {
  const fields = { projectId: P, ctoId: CTO, workstreamId: "ws-current", taskId: "task-impl", revision: 1,
    kind: "development" as const, title: "Task", goal: "Implement the exact packet.", scopeNodeIds: ["node"],
    requirementIds: ["REQ-1"], dependencies: [], included: ["src/main.ts"], excluded: [], constraints: [],
    acceptance: ["Exact change"], evidenceRequired: ["Commit receipt"], reuse: [], testPlan: null };
  const sourceAccess = { sourceId: SOURCE, folderKey: "project-source", branch: "builder/task-impl",
    expectedHead: HEAD, readPaths: ["src/main.ts"], writePaths: ["src/main.ts"], qaWritePaths: [] };
  const parsed = parseTaskPacket({ ...fields, sourceAccess }, P, CTO, "ws-current");
  assert.equal(parsed.sourceAccess?.branch, "builder/task-impl");
  assert.equal(parsed.sourceAccess?.expectedHead, HEAD);
  assert.throws(() => parseTaskPacket({ ...fields, sourceAccess: { ...sourceAccess, expectedHead: undefined } }, P, CTO, "ws-current"),
    /expectedHead must be an exact Git object ID/u);
  assert.throws(() => parseTaskPacket({ ...fields, sourceAccess: { ...sourceAccess, branch: "builder/../escape" } }, P, CTO, "ws-current"),
    /valid exact branch name/u);
});

test("lost immutable outcome write never repeats a known Core commit", async () => {
  const f = fixture({ casThrowsAt: "outcome" });
  assert.equal((await f.submit()).status, "unknown");
  assert.equal((await f.submit()).status, "unknown");
  assert.equal(f.commits, 1);
});

test("a Core commit remains historically recorded if Task authority changes during the commit", async () => {
  const f = fixture({ authorityThrowsAt: 4 });
  const result = await f.submit();
  assert.equal(result.status, "submitted");
  if (result.status === "submitted") assert.equal(result.submission.authorityAfterCommit, "changed");
  assert.equal(f.commits, 1);
});

test("malformed Core receipt cannot become a submission or trigger a second commit", async () => {
  const f = fixture({ result: { status: "committed", commitSha: "not-a-sha", treeSha: TREE, changedPaths: ["src/main.ts"] } });
  assert.equal((await f.submit()).status, "unknown");
  assert.equal((await f.submit()).status, "unknown");
  assert.equal(f.commits, 1);
});
