import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { readHistoricalTaskQaEvidence, type HistoricalTaskQaEvidenceInput } from "../src/builder-gates/historical-task-qa-evidence.ts";
import { taskPacketRecordDigest } from "../src/domain/task-packets.ts";
import { createTaskPacketStore, publishCtoTaskPacket } from "../src/task-packet-tools.ts";
import { createTaskQaRunReferenceStore, recordDeferredTaskQaEvent } from "../src/task-qa-run-references.ts";
import { publishTaskQaReport } from "../src/task-qa-reports.ts";
import { setupVerifiedWorkstreamPlatform } from "./fixtures/verified-workstream-platform.ts";
import { CTO, W } from "./fixtures/cto-platform.ts";

const scope = { workspaceId: W, projectId: W, workstreamId: "ws-1", taskId: "task-dev" };
const refScope = { workspaceId: W, projectId: W, workstreamId: scope.workstreamId, ctoId: CTO, qaTaskId: "task-qa" };
const digest = (value: unknown) => taskPacketRecordDigest(value, W, CTO, scope.workstreamId);

/** Real Builder submit, acceptance, QA report and Task producers. Core, Git and
 * AgentSession replies here are fixture DTOs, not a live runtime or protected test. */
async function setup(mode: "original" | "failed-head" | "continuation" = "original") {
  const fixture = await setupVerifiedWorkstreamPlatform(), { f, ctoContext } = fixture;
  const packets = createTaskPacketStore(W, W, CTO, scope.workstreamId, f.state);
  const historical = (await packets.current())!.revision;
  const implementation = historical.packets.find(row => row.packet.taskId === scope.taskId)!;
  const qa = historical.packets.find(row => row.packet.taskId === refScope.qaTaskId)!;
  const reports = fixture.reportStore(), original = (await reports.current())!.revision;
  const references = createTaskQaRunReferenceStore(refScope, f.state);
  const sessions = f.platform.agents.sessions, originalGetRun = sessions.getRun.bind(sessions);
  let authorRunId = original.author.runId;
  let authorStatus = mode === "failed-head" ? "running" : "succeeded", ctoStatus = "running", originStatus = "succeeded";
  let termination: "not_applicable" | "pending" | "confirmed" = "not_applicable";
  let cancelled = false, systemEvent: Record<string, unknown> | undefined;
  sessions.getRun = async (sessionId, companyId, runId) => {
    assert.equal(companyId, W);
    if (runId === authorRunId || runId === original.author.runId) {
      assert.equal(sessionId, original.author.sessionId);
      return { runId, status: runId === authorRunId ? authorStatus : originStatus, cancellationRequested: runId === authorRunId && cancelled,
        termination: runId === authorRunId ? termination : "not_applicable", errorCode: null, error: null,
        ...(runId === authorRunId && systemEvent ? { systemEvent: structuredClone(systemEvent) } : {}) } as Awaited<ReturnType<typeof sessions.getRun>>;
    }
    const row = await originalGetRun(sessionId, companyId, runId);
    return runId === ctoContext.runId ? { ...row, status: ctoStatus } : row;
  };
  if (mode === "continuation") {
    const { binding } = original.reference;
    const eventId = `sps-protected-test-terminal-v1:${binding.runId}:${original.coreReceiptDigest}:${binding.subjectKeySha256}:${randomUUID()}`;
    const previousRunId = original.author.runId, requestId = randomUUID();
    const guardKey = [...f.values.keys()].map(key => JSON.parse(key)).find(key => key.stateKey.startsWith("task-packets-head.v1."));
    assert(guardKey);
    const linked = await recordDeferredTaskQaEvent(f.state, original.reference,
      { eventId, previousRunId, receiptDigest: original.coreReceiptDigest },
      [{ namespace: guardKey.namespace, stateKey: guardKey.stateKey, expectedValue: (await f.state.get(guardKey))! }]);
    assert.equal(linked.status, "recorded");
    authorRunId = randomUUID(); authorStatus = "running";
    systemEvent = { schemaVersion: 1, kind: "protected-test-terminal-event", requestId, previousRunId, eventId,
      protectedRunId: binding.runId, receiptDigest: original.coreReceiptDigest, subjectKeySha256: binding.subjectKeySha256 };
    fixture.requests.set(`${original.author.sessionId}:${requestId}`, { requestId, state: "submitted", runId: authorRunId });
  }
  if (mode !== "original") {
    const binding = original.reference.binding;
    const published = await publishTaskQaReport({ projectId: W, ctoId: CTO, workstreamId: scope.workstreamId,
      qaTaskId: refScope.qaTaskId, approvalId: binding.approvalId, planSha256: binding.planSha256, runId: binding.runId,
      expectedBaseRevisionId: original.revisionId, summary: "New independent fixture assessment.",
      checks: original.checks.map(check => ({ criterionId: check.criterionId,
        verdict: mode === "failed-head" ? "failed" : "passed", note: "Fixture assessment." })) },
    { companyId: W, projectId: W, ...original.author, runId: authorRunId }, f.platform);
    assert.equal(published.status, "published", JSON.stringify(published));
    authorStatus = "succeeded";
  }
  for (const record of [implementation, qa]) {
    const published = await publishCtoTaskPacket({ projectId: W, ctoId: CTO, workstreamId: scope.workstreamId,
      expectedBaseRevisionId: (await packets.current())!.revision.revisionId, revisionId: `history-qa-next-${record.packet.taskId}`,
      packet: { ...record.packet, revision: 2 } }, ctoContext, f.platform);
    assert.equal((published.data as { status: string }).status, "published", JSON.stringify(published));
  }
  const input: HistoricalTaskQaEvidenceInput = { scope, ctoId: CTO, taskBoardRevisionId: historical.revisionId,
    implementationDigest: digest(implementation), qaTaskId: refScope.qaTaskId, qaDigest: digest(qa),
    runContext: ctoContext, platform: f.platform };
  const host = f.platform as unknown as { protectedTests: Record<string, (...args: any[]) => any>;
    localFolders: Record<string, (...args: any[]) => any> };
  host.protectedTests.enqueueApprovedV1 = async () => assert.fail("Historical reads never enqueue protected runs");
  sessions.sendMessage = async () => assert.fail("Historical reads never send messages");
  return { ...fixture, input, original, references, reports, packets, host, authorRunId,
    setAuthor(status: string, term = termination, cancel = false) { authorStatus = status; termination = term; cancelled = cancel; },
    setCtoStatus(status: string) { ctoStatus = status; },
    setOriginStatus(status: string) { originStatus = status; },
    setLineage(patch: Record<string, unknown>) { assert(systemEvent); Object.assign(systemEvent, patch); } };
}

test("current authorized CTO reads exact older Task and original immutable QA/CTO/Core provenance without current promotion or writes", async () => {
  const f = await setup(), before = structuredClone(f.f.values);
  const result = await readHistoricalTaskQaEvidence(f.input);
  assert.equal(result.status, "available", JSON.stringify(result)); if (result.status !== "available") return;
  assert.equal(result.value.taskBoardRevisionId, f.input.taskBoardRevisionId);
  assert.equal(result.value.taskBoardSequence, 1);
  assert.equal(result.value.implementationRecord.packet.revision, 1); assert.equal(result.value.qaRecord.packet.revision, 1);
  assert.equal(result.value.implementationDigest, f.input.implementationDigest); assert.equal(result.value.qaDigest, f.input.qaDigest);
  assert.equal(result.value.report.revisionId, f.original.revisionId);
  assert.equal(result.value.reference.revisionId, f.original.reference.revisionId);
  assert.equal(result.value.submission.submissionId, f.original.reference.binding.submissionId);
  assert.equal(result.value.acceptance.acceptanceId, f.original.reference.binding.acceptanceId);
  assert.equal(result.value.coreRun.id, f.original.reference.binding.runId);
  assert.equal(result.value.coreRun.qaVerdict, "not-established");
  assert.equal(result.value.evidenceKind, "historical-exact-task-qa"); assert.equal(result.value.currentGate, "not-established");
  await result.check();
  assert.deepEqual(f.f.values, before);
  assert.equal(f.wakes.length, 0);
});

test("a newer failed report blocks reuse instead of searching the published history for an older pass", async () => {
  const f = await setup("failed-head");
  assert.equal((await f.reports.publishedRevision(f.original.revisionId))!.revision.verdict, "passed");
  assert.equal((await f.reports.current())!.revision.verdict, "failed");
  assert.deepEqual(await readHistoricalTaskQaEvidence(f.input), { status: "unknown", reason: "historical-qa-head-is-not-exact-passing-report" });
});

test("terminal continuation author is accepted only with exact original request, deferred event and Core continuation receipt", async () => {
  const f = await setup("continuation");
  const read = await readHistoricalTaskQaEvidence(f.input);
  assert.equal(read.status, "available", JSON.stringify(read)); if (read.status !== "available") return;
  assert.equal(read.value.report.author.runId, f.authorRunId);
  assert.notEqual(read.value.report.author.runId, f.original.author.runId);
  assert.equal(read.value.reference.deferredEvent?.previousRunId, f.original.author.runId);
  f.setOriginStatus("running");
  await assert.rejects(read.check(), /current observation authority changed/u);
  f.setOriginStatus("succeeded");
  f.setLineage({ eventId: "unrelated" });
  assert.deepEqual(await readHistoricalTaskQaEvidence(f.input), { status: "unknown", reason: "historical-qa-author-lineage-mismatch" });
});

test("source producer requires its own exact observed Run while preserving accepted-commit provenance for failed or cancelled producers", async t => {
  for (const scenario of ["missing", "foreign-run", "queued", "failed", "cancelled", "changes-during-recheck"] as const) {
    await t.test(scenario, async () => {
      const f = await setup(), sessions = f.f.platform.agents.sessions, get = sessions.getRun.bind(sessions);
      const producers = [...f.requests.entries()].filter(([address]) => !address.startsWith(`${f.original.author.sessionId}:`));
      assert.equal(producers.length, 1);
      const [address, request] = producers[0]!;
      const sessionId = address.slice(0, address.indexOf(":"));
      let reads = 0, changed = false;
      Object.assign(sessions, { async getRun(observedSession: string, workspaceId: string, runId: string) {
        if (runId !== request.runId) return get(observedSession, workspaceId, runId);
        assert.equal(observedSession, sessionId); assert.equal(workspaceId, W);
        reads++;
        if (scenario === "missing") return null;
        const row = await get(observedSession, workspaceId, runId);
        if (scenario === "foreign-run") return { ...row, runId: randomUUID() };
        if (scenario === "queued") return { ...row, status: "queued" };
        if (scenario === "failed" || changed) return { ...row, status: "failed" };
        if (scenario === "cancelled") return { ...row, status: "cancelled", cancellationRequested: true, termination: "confirmed" };
        return row;
      } });
      const read = await readHistoricalTaskQaEvidence(f.input);
      assert.equal(reads, 1, "the receipt alone is not enough: getRun must observe this exact producer");
      if (scenario === "missing" || scenario === "foreign-run" || scenario === "queued") {
        assert.deepEqual(read, { status: "unknown", reason: scenario === "missing" ? "historical-qa-source-producer-run-unavailable"
          : "historical-qa-source-producer-run-mismatch" });
        return;
      }
      assert.equal(read.status, "available", JSON.stringify(read)); if (read.status !== "available") return;
      assert.equal(read.value.submission.producer.runId, request.runId);
      assert.equal(read.value.currentGate, "not-established");
      if (scenario === "changes-during-recheck") {
        changed = true;
        await assert.rejects(read.check(), /current observation authority changed/u);
      } else await read.check();
      assert.equal(reads, 2);
    });
  }
});

test("check pins the initial exact protected Core observation even when the receipt ID and business pins are unchanged", async () => {
  const f = await setup(), get = f.host.protectedTests.getRunV1!;
  const read = await readHistoricalTaskQaEvidence(f.input);
  assert.equal(read.status, "available", JSON.stringify(read)); if (read.status !== "available") return;
  let changed = false;
  f.host.protectedTests.getRunV1 = async (...args) => {
    const run = structuredClone(await get(...args)); assert(run);
    run.pins.profileSha256 = "f".repeat(64);
    changed = true;
    return run;
  };
  await assert.rejects(read.check(), /current observation authority changed/u);
  assert.equal(changed, true);
});

test("foreign or stale CTO, non-published board, and incorrect Task digests fail closed", async t => {
  for (const invalid of ["foreign-workspace", "qa-caller", "old-cto-run", "ended-cto", "wrong-tool-policy", "unknown-board",
    "current-board", "development-digest", "qa-digest", "changed-baseline"] as const) {
    await t.test(invalid, async () => {
      const f = await setup(); let input = { ...f.input };
      if (invalid === "foreign-workspace") input.scope = { ...scope, workspaceId: randomUUID() };
      if (invalid === "qa-caller") input.runContext = { companyId: W, projectId: W, ...f.original.author };
      if (invalid === "old-cto-run") input.runContext = { ...f.ctoContext, runId: randomUUID() };
      if (invalid === "ended-cto") f.setCtoStatus("succeeded");
      if (invalid === "wrong-tool-policy") {
        const deliveries = f.f.deliveryStore(), current = (await deliveries.current())!.revision;
        const legacy = { ...current, revisionId: "history-qa-legacy-cto-policy", executionPolicy: {
          ...current.executionPolicy, toolNames: current.executionPolicy.toolNames.filter(name => name !== "builder.verify-workstream"),
        } };
        assert.equal((await deliveries.publish({ expectedBaseRevisionId: current.revisionId, revision: legacy })).status, "published");
        assert.equal((await deliveries.current())!.revision.runId, current.runId);
      }
      if (invalid === "unknown-board") input.taskBoardRevisionId = "never-published-board";
      if (invalid === "current-board") input.taskBoardRevisionId = (await f.packets.current())!.revision.revisionId;
      if (invalid === "development-digest") input.implementationDigest = "f".repeat(64);
      if (invalid === "qa-digest") input.qaDigest = "f".repeat(64);
      if (invalid === "changed-baseline") {
        const address = [...f.f.values.keys()].find(key => JSON.parse(key).stateKey.startsWith("design-baseline-head.v1."));
        assert(address); f.f.values.delete(address);
      }
      assert.equal((await readHistoricalTaskQaEvidence(input)).status, "unknown");
    });
  }
});

test("exact receipt, normal independent QA closure, acceptance and current source grant remain mandatory", async t => {
  for (const invalid of ["foreign-subject", "foreign-approval", "foreign-source", "foreign-plan", "foreign-commit", "foreign-tree", "wrong-receipt", "unclean-exit",
    "missing-acceptance", "failed-author", "cancelled-author", "confirmed-author", "pending-author", "denied-tip", "moved-tip", "different-root", "missing-tip-api"] as const) {
    await t.test(invalid, async () => {
      const f = await setup();
      if (invalid === "failed-author") f.setAuthor("failed");
      if (invalid === "cancelled-author") f.setAuthor("succeeded", "not_applicable", true);
      if (invalid === "confirmed-author") f.setAuthor("succeeded", "confirmed");
      if (invalid === "pending-author") f.setAuthor("succeeded", "pending");
      if (invalid === "missing-acceptance") {
        const address = [...f.f.values.keys()].find(key => JSON.parse(key).stateKey.startsWith("task-source-acceptance.v1."));
        assert(address); f.f.values.delete(address);
      }
      if (invalid === "denied-tip") f.host.localFolders.readWorkspaceSourceGitTipV1 = async () => ({ status: "denied", reason: "branch_not_authorized" });
      if (invalid === "moved-tip") {
        const original = f.host.localFolders.readWorkspaceSourceGitTipV1!;
        f.host.localFolders.readWorkspaceSourceGitTipV1 = async (...args) => ({ ...await original(...args), commitSha: "f".repeat(40) });
      }
      if (invalid === "different-root") f.host.localFolders.matchWorkspaceSourceV1 = async (folderKey, workspaceSourceId) =>
        ({ folderKey, workspaceSourceId, match: "different_root" });
      if (invalid === "missing-tip-api") delete f.host.localFolders.readWorkspaceSourceGitTipV1;
      const core = f.host.protectedTests.getRunV1!;
      f.host.protectedTests.getRunV1 = async (...args) => {
        const result = structuredClone(await core(...args)); assert(result);
        if (invalid === "foreign-subject") result.pins.subjectKeySha256 = "f".repeat(64);
        if (invalid === "foreign-approval") result.pins.approvalId = randomUUID();
        if (invalid === "foreign-source") result.pins.sourceId = randomUUID();
        if (invalid === "foreign-plan") result.pins.planSha256 = "f".repeat(64);
        if (invalid === "foreign-commit") result.pins.commitSha = "f".repeat(40);
        if (invalid === "foreign-tree") result.pins.treeSha = "f".repeat(40);
        if (invalid === "wrong-receipt") result.receipt.digest = "f".repeat(64);
        if (invalid === "unclean-exit") result.receipt.jobEmpty = false;
        return result;
      };
      assert.equal((await readHistoricalTaskQaEvidence(f.input)).status, "unknown");
    });
  }
});

test("report/reference head or CTO changes during remote evidence reads invalidate the observation", async t => {
  for (const changed of ["task-qa-reports-head.v1.", "task-protected-qa-runs-head.v1.", "cto-run"] as const) {
    await t.test(changed, async () => {
      const f = await setup(), get = f.host.protectedTests.getRunV1!;
      let injected = false;
      f.host.protectedTests.getRunV1 = async (...args) => {
        const result = await get(...args);
        if (changed === "cto-run") f.setCtoStatus("cancelled");
        else {
          const address = [...f.f.values.keys()].find(key => JSON.parse(key).stateKey.startsWith(changed));
          assert(address); f.f.values.delete(address);
        }
        injected = true;
        return result;
      };
      assert.equal((await readHistoricalTaskQaEvidence(f.input)).status, "unknown");
      assert.equal(injected, true);
    });
  }
});
