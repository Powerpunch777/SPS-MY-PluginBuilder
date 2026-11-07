import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue } from "@sonparkserver/plugin-sdk/platform";
import { recordTaskQaRunReference } from "../src/task-qa-run-references.ts";
import { createTaskQaReportStore, parseTaskQaReport, taskQaCriteria } from "../src/task-qa-reports.ts";
import type { RevisionState } from "../src/solution-revision-store.ts";
import { createBuilderPlatform } from "../src/platform.ts";
import { SPS_PLATFORM_CAPABILITIES } from "@sonparkserver/plugin-sdk/platform";
import { PUBLISH_TASK_QA_REPORT_TOOL } from "../src/task-packet-tool-declarations.mjs";
import { CTO_SESSION_EXECUTION_POLICY, TASK_WORKER_SESSION_EXECUTION_POLICY } from "../src/session-execution-policy.ts";

const W = "11111111-1111-4111-8111-111111111111", RUN = "22222222-2222-4222-8222-222222222222";
const QA = "33333333-3333-4333-8333-333333333333", SESSION = "44444444-4444-4444-8444-444444444444";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const { default: manifest } = await import(new URL("../src/manifest.mjs", import.meta.url).href) as {
  default: { tools: readonly { name: string }[]; capabilities: readonly string[] } };
test("registers QA reporting only in Task sessions and declares actual supported protected-run capabilities", () => {
  const platform = createBuilderPlatform();
  assert.ok(platform.tools.some(tool => tool.name === PUBLISH_TASK_QA_REPORT_TOOL.name));
  assert.ok(manifest.tools.some(tool => tool.name === PUBLISH_TASK_QA_REPORT_TOOL.name));
  assert.ok(TASK_WORKER_SESSION_EXECUTION_POLICY.toolNames.includes(PUBLISH_TASK_QA_REPORT_TOOL.name));
  assert.ok(!CTO_SESSION_EXECUTION_POLICY.toolNames.includes(PUBLISH_TASK_QA_REPORT_TOOL.name));
  for (const capability of ["sps.runs.dispatch", "sps.executions.read"]) {
    if ((SPS_PLATFORM_CAPABILITIES as readonly string[]).includes(capability)) {
      assert.ok((platform.capabilities as readonly string[]).includes(capability));
      assert.ok((manifest.capabilities as readonly string[]).includes(capability));
    }
  }
});
async function fixture() {
  const rows = new Map<string, JsonValue>();
  const state: RevisionState = { async get(key) { return structuredClone(rows.get(key.stateKey) ?? null); },
    async compareAndSet(key, expected, value) {
      const current = rows.get(key.stateKey) ?? null;
      if (expected.exists ? JSON.stringify(current) !== JSON.stringify(expected.value) : current !== null) return { swapped: false };
      rows.set(key.stateKey, structuredClone(value)); return { swapped: true };
    } };
  const subjectKey = "builder-task-qa-v1:" + "1".repeat(64);
  const target = { workspaceId: W, projectId: W, ctoId: "cto-1", workstreamId: "ws-1",
    implementation: { packet: { taskId: "dev-1", revision: 1 } }, implementationDigest: "2".repeat(64),
    qa: { packet: { taskId: "qa-1", revision: 1 } }, qaDigest: "3".repeat(64), qaWorker: { agentId: QA, sessionId: SESSION },
    source: { sourceId: "55555555-5555-4555-8555-555555555555", folderKey: "workspace", branch: "task/one" },
    commitSha: "4".repeat(40), treeSha: "5".repeat(40), acceptanceId: "6".repeat(64), submissionId: "7".repeat(64),
    approvalId: "66666666-6666-4666-8666-666666666666", planSha256: "8".repeat(64), requestId: subjectKey, subjectKey,
    subjectKeySha256: createHash("sha256").update(subjectKey, "utf8").digest("hex"), async assertCurrent() {} };
  const recorded = await recordTaskQaRunReference(state, target, RUN);
  if (!("reference" in recorded) || !recorded.reference) throw new Error("fixture reference missing");
  const criteria = taskQaCriteria(["Feature behavior matches its contract"], ["All pinned checks pass"]);
  const body = { schemaVersion: 1 as const, reference: recorded.reference, coreReceiptDigest: "9".repeat(64),
    coreStatus: "succeeded" as const, author: { agentId: QA, sessionId: SESSION, runId: "77777777-7777-4777-8777-777777777777" },
    checks: criteria.map(criterion => ({ ...criterion, verdict: "passed" as const, note: "Observed the exact pinned execution and criterion." })),
    summary: "All assigned criteria were checked.", verdict: "passed" as const };
  return { state, scope: recorded.reference.scope, body,
    report(override: Record<string, unknown> = {}) {
      const content = { ...body, ...override };
      return { ...content, revisionId: `task-qa-report-v1:${hash(content)}` };
    } };
}

test("stores a content-bound independent QA report without publishing Workstream VERIFIED", async () => {
  const f = await fixture();
  const parsed = parseTaskQaReport(f.report());
  const store = createTaskQaReportStore(f.scope, f.state);
  assert.equal((await store.publish({ expectedBaseRevisionId: null, revision: parsed })).status, "published");
  assert.equal((await store.current())?.revision.verdict, "passed");
  const reversedScope = Object.fromEntries(Object.entries(f.scope).reverse()) as typeof f.scope;
  assert.equal((await createTaskQaReportStore(reversedScope, f.state).current())?.revision.revisionId, parsed.revisionId);
  assert.equal("verificationStatus" in parsed, false);
  assert.equal("integrationStatus" in parsed, false);
});

test("a failed Core run cannot be relabeled as passed by all-passed check rows", async () => {
  const f = await fixture();
  assert.throws(() => parseTaskQaReport(f.report({ coreStatus: "failed" })), /verdict mismatch/);
  assert.equal(parseTaskQaReport(f.report({ coreStatus: "failed", verdict: "failed" })).verdict, "failed");
});

test("untested criteria remain incomplete and changed criteria obtain different identities", async () => {
  const f = await fixture();
  const checks = f.body.checks.map((row, index) => ({ ...row, verdict: index === 0 ? "not-tested" : "passed" }));
  assert.throws(() => parseTaskQaReport(f.report({ checks })), /verdict mismatch/);
  assert.equal(parseTaskQaReport(f.report({ checks, verdict: "incomplete" })).verdict, "incomplete");
  assert.notDeepEqual(taskQaCriteria(["Changed behavior"], ["All pinned checks pass"]),
    taskQaCriteria(["Feature behavior matches its contract"], ["All pinned checks pass"]));
});

test("different QA identity, duplicate criteria, and edited content retain no valid original digest", async () => {
  const f = await fixture();
  assert.throws(() => parseTaskQaReport(f.report({ author: { ...f.body.author, agentId: RUN } })), /binding/);
  assert.throws(() => parseTaskQaReport(f.report({ checks: [f.body.checks[0], f.body.checks[0]] })), /Duplicate/);
  assert.throws(() => parseTaskQaReport({ ...f.report(), summary: "Changed after signing" }), /digest/);
});

test("report history stays distinct across QA outcomes and cannot be read under another Task scope", async () => {
  const f = await fixture();
  const store = createTaskQaReportStore(f.scope, f.state);
  const first = parseTaskQaReport(f.report());
  await store.publish({ expectedBaseRevisionId: null, revision: first });
  const checks = f.body.checks.map(row => ({ ...row, verdict: "failed", note: "Specific regression observed." }));
  const second = parseTaskQaReport(f.report({ checks, verdict: "failed", summary: "A regression was found." }));
  await store.publish({ expectedBaseRevisionId: first.revisionId, revision: second });
  assert.equal((await store.recent()).revisions.length, 2);
  await assert.rejects(createTaskQaReportStore({ ...f.scope, qaTaskId: "other" }, f.state)
    .publish({ expectedBaseRevisionId: null, revision: first }), /another Task/);
});
