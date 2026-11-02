import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { access, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createCtoDeliveryStore, workstreamInstructionDigest } from "../src/cto-delivery-store.ts";
import { ctoDeliveryRequestId, parseCtoDelivery } from "../src/domain/cto-deliveries.ts";
import { CTO_SESSION_EXECUTION_POLICY } from "../src/session-execution-policy.ts";

const workspaceA = "11111111-1111-4111-8111-111111111111";
const leadId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const decisionsSessionId = "88888888-8888-4888-8888-888888888888";
const ctoSessionId = "12121212-1212-4212-8212-121212121212";
const runId = "55555555-5555-4555-8555-555555555555";
const ctoContext = { companyId: workspaceA, agentId: leadId, sessionId: ctoSessionId,
  runId: "13131313-1313-4313-8313-131313131313" };
const answerTurnId = "20202020-2020-4020-8020-202020202020";
const invocationId = "design-draft-rpc-invocation-a";
const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const consultationId = `consultation-${requestId}`;
const namespace = "sonpark.my-builder";
const stateKey = name => ({ scopeKind: "company", scopeId: workspaceA, namespace, stateKey: name });
const clone = value => value === undefined ? null : JSON.parse(JSON.stringify(value));
const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");

const designQuestion = { id: "question-1", title: "Choose a target", text: "Which target should the draft use?",
  options: [{ id: "desktop", label: "Desktop", tradeoff: "Local installation" }], recommendation: "desktop" };

function createFakeHostState() {
  const values = new Map();
  values.set(JSON.stringify(stateKey("lead-agent.v1")), {
    workspaceId: workspaceA, revision: 1, selectedAgentId: leadId,
  });
  values.set(JSON.stringify(stateKey("lead-sessions.v1.1")), {
    workspaceId: workspaceA, selectionRevision: 1, agentId: leadId,
    sessions: { main: sessionId, "cto-inbox": null, decisions: decisionsSessionId },
  });
  values.set(JSON.stringify(stateKey("snapshot.v1")), {
    schemaVersion: 1, workspaceId: workspaceA, revision: 1,
    leadSessions: { main: sessionId, "cto-inbox": null, decisions: decisionsSessionId },
    actors: [],
    messages: [{ id: consultationId, channel: "main", actorId: null, role: "user",
      text: "Build a private project tracker with clear ownership and an audit history.",
      createdAt: "2026-11-02T00:00:00.000Z", runId: null }],
    documents: [], questions: [], graph: { revisionId: null, entities: [], relations: [] }, activity: [],
    integrations: { ai: "not_configured", github: "not_configured", htmlPreview: "unavailable" },
  });
  return values;
}

const draft = {
  projectId: workspaceA,
  revisionId: "design-draft-1",
  sourceIds: [consultationId],
  specification: {
    revisionId: "spec-1", productTier: "M",
    requirements: [{ id: "req-1", description: "Track projects, owners and changes.", acceptanceCriteriaIds: [] }],
    targets: ["desktop"], dataPolicyRef: "policy-to-review",
  },
  graph: { graphRevisionId: "graph-1", entities: [], relations: [], viewLayoutRef: "layout-to-review" },
  questions: [designQuestion],
};

test("built Worker routes design sources to an unapproved draft and back without implicit writes or Agent sends", { timeout: 20_000 }, async () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(testDirectory, "..");
  const workerPath = path.join(projectRoot, "dist", "worker.js");
  await access(workerPath);
  assert.equal((await stat(workerPath)).isFile(), true);

  // This is a deterministic fake Host for invocation A, not actualHost and not realAI.
  const hostState = createFakeHostState();
  const child = spawn(process.execPath, [workerPath], {
    cwd: projectRoot,
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const stderr = [];
  child.stderr.on("data", chunk => {
    if (stderr.reduce((size, item) => size + item.length, 0) < 8_192) stderr.push(chunk.toString("utf8"));
  });
  const messages = [];
  const waiting = [];
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); }
    catch (error) {
      for (const waiter of waiting.splice(0)) waiter.reject(new Error(`Worker emitted invalid JSONL: ${error.message}`));
      return;
    }
    const index = waiting.findIndex(waiter => waiter.predicate(message));
    const waiter = index < 0 ? undefined : waiting.splice(index, 1)[0];
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else messages.push(message);
  });
  const closed = once(child, "close").then(([code, signal]) => ({ code, signal }));
  const waitForMessage = (description, predicate) => {
    const index = messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: undefined };
      waiting.push(waiter);
      waiter.timer = setTimeout(() => {
        const position = waiting.indexOf(waiter);
        if (position >= 0) waiting.splice(position, 1);
        reject(new Error(`Timed out waiting for ${description}. stderr: ${stderr.join("")}`));
      }, 4_000);
    });
  };
  const send = message => {
    assert.equal(child.stdin.destroyed, false, "Worker stdin must remain open for JSONL requests");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const response = id => waitForMessage(`Worker response ${id}`, message => message.id === id);
  const calls = [];
  let ctoRequestId;
  const answerHostCall = async call => {
    assert.equal(call.jsonrpc, "2.0");
    assert.equal(call.paperclipInvocationId, invocationId, "fake Host only serves the declared invocation");
    assert.ok(typeof call.id === "number" || typeof call.id === "string");
    calls.push(call.method);
    assert.ok(call.params && typeof call.params === "object" && !Array.isArray(call.params));
    if (call.method === "agents.sessions.getRequest") {
      assert.deepEqual(Object.keys(call.params).sort(), ["companyId", "requestId", "sessionId"]);
      assert.equal(call.params.companyId, workspaceA);
      assert.equal(call.params.sessionId, ctoSessionId, "Only the seeded CTO session may reconcile its request.");
      assert.equal(call.params.requestId, ctoRequestId, "Only the exact seeded Core request may be read.");
      send({ jsonrpc: "2.0", id: call.id, result: { requestId: ctoRequestId, state: "submitted", runId: ctoContext.runId } });
      return;
    }
    if (call.method === "agents.sessions.getRun") {
      assert.deepEqual(Object.keys(call.params).sort(), ["companyId", "runId", "sessionId"]);
      assert.equal(call.params.companyId, workspaceA);
      assert.equal(call.params.sessionId, ctoSessionId, "Only the registered CTO session may inspect its run.");
      assert.equal(call.params.runId, ctoContext.runId, "Only the exact Core-bound CTO run may be inspected.");
      send({ jsonrpc: "2.0", id: call.id, result: { runId: ctoContext.runId, status: "running",
        cancellationRequested: false, termination: "not_applicable", error: null, errorCode: null,
        output: { state: "not_ready", text: null } } });
      return;
    }
    assert.ok(call.method === "state.get" || call.method === "state.compareAndSet",
      `unexpected Host RPC ${call.method}; state.set and Agent send are forbidden`);
    const { scopeKind, scopeId, namespace: requestedNamespace, stateKey: requestedKey } = call.params;
    assert.equal(scopeKind, "company");
    assert.equal(scopeId, workspaceA, "fake Host only permits invocation scope A");
    assert.equal(requestedNamespace, namespace, "exact Builder namespace required");
    assert.equal(typeof requestedKey, "string");
    assert.deepEqual(Object.keys(call.params).sort(), call.method === "state.get"
      ? ["namespace", "scopeId", "scopeKind", "stateKey"]
      : ["expected", "namespace", "scopeId", "scopeKind", "stateKey", "value"].sort());
    const key = stateKey(requestedKey);
    const id = JSON.stringify(key);
    if (call.method === "state.get") {
      send({ jsonrpc: "2.0", id: call.id, result: clone(hostState.get(id)) });
      return;
    }
    const expected = call.params.expected;
    assert.ok(expected && typeof expected === "object" && typeof expected.exists === "boolean");
    assert.deepEqual(Object.keys(expected).sort(), expected.exists ? ["exists", "value"] : ["exists"]);
    const exists = hostState.has(id);
    const current = hostState.get(id);
    const matches = expected.exists
      ? exists && JSON.stringify(current) === JSON.stringify(expected.value)
      : !exists;
    if (matches) hostState.set(id, clone(call.params.value));
    send({ jsonrpc: "2.0", id: call.id, result: { swapped: matches } });
  };
  const serviceUntil = async responseId => {
    while (true) {
      const next = await waitForMessage(`Host RPC or Worker response ${responseId}`,
        message => message.id === responseId || typeof message.method === "string");
      if (next.id === responseId) return next;
      await answerHostCall(next);
    }
  };

  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const initialized = await response(1);
    assert.deepEqual(initialized.result, { ok: true,
      supportedMethods: ["health", "shutdown", "executeTool", "onEvent", "runJob", "getData", "performAction"] });

    const runContext = { companyId: workspaceA, agentId: leadId, sessionId, runId };
    const invoke = (id, toolName, parameters, context = runContext) => send({ jsonrpc: "2.0", id, method: "executeTool",
      paperclipInvocation: { id: invocationId, scope: { companyId: workspaceA } },
      params: { toolName, parameters, runContext: context } });
    invoke(2, "builder.read-design-sources", { channel: "consultation", cursor: null });
    const sourceReply = await serviceUntil(2);
    assert.equal(sourceReply.error, undefined, JSON.stringify(sourceReply.error));
    assert.deepEqual(sourceReply.result.data.sources, [{ id: consultationId,
      text: "Build a private project tracker with clear ownership and an audit history." }]);
    assert.equal(sourceReply.result.data.channel, "consultation");

    invoke(3, "builder.propose-design", { projectId: workspaceA, expectedBaseRevisionId: null, draft });
    const proposalReply = await serviceUntil(3);
    assert.equal(proposalReply.error, undefined, JSON.stringify(proposalReply.error));
    assert.equal(proposalReply.result.data.status, "published");
    assert.equal(proposalReply.result.data.revision.status, "draft");
    assert.deepEqual(proposalReply.result.data.revision.sourceDigests, [{ id: consultationId,
      sha256: sha256("Build a private project tracker with clear ownership and an audit history.") }]);
    assert.match(proposalReply.result.content, /not customer approval, execution authorization/);

    invoke(4, "builder.read-design-draft", { projectId: workspaceA });
    const readReply = await serviceUntil(4);
    assert.equal(readReply.error, undefined, JSON.stringify(readReply.error));
    assert.equal(readReply.result.data.current.sequence, 1);
    assert.equal(readReply.result.data.current.revision.status, "draft");
    assert.equal(readReply.result.data.current.revision.draft.revisionId, "design-draft-1");
    assert.match(readReply.result.content, /unapproved/);

    const answerText = "The user selected a desktop product.";
    const answerSourceId = `lead-turn:${answerTurnId}`;
    hostState.set(JSON.stringify(stateKey(`lead-chat.turn.v1.${answerTurnId}`)), {
      workspaceId: workspaceA, selectionRevision: 1, agentId: leadId, sessionId: decisionsSessionId,
      channel: "decisions", schemaVersion: 1, requestId: answerTurnId, previousRequestId: null, sequence: 0,
      text: "Use the desktop target.", createdAt: "2026-11-02T00:00:00.000Z", state: "prepared", runId: null,
      answer: null, outputState: "not_ready", cancellationRequested: false, termination: "not_applicable",
      questionContext: { projectId: workspaceA, draftRevisionId: draft.revisionId, questionId: designQuestion.id },
    });
    const resolvedDraft = {
      ...draft,
      revisionId: "design-draft-2",
      sourceIds: [consultationId, answerSourceId],
      specification: { ...draft.specification, revisionId: "spec-2" },
      graph: { ...draft.graph, graphRevisionId: "graph-2", entities: [{ id: "rpc-feature", kind: "feature", specRef: "req-1", contractRefs: ["rpc-contract"] }] },
    };
    const resolution = { projectId: workspaceA, expectedBaseRevisionId: draft.revisionId, questionId: designQuestion.id,
      answerSourceId, answerText, draft: resolvedDraft };
    const writesBeforeMainAttempt = calls.filter(method => method === "state.compareAndSet").length;
    invoke(7, "builder.resolve-design-question", resolution, runContext);
    const mainResolution = await serviceUntil(7);
    assert.ok(mainResolution.error, "main Lead session cannot apply a decisions answer");
    assert.equal(calls.filter(method => method === "state.compareAndSet").length, writesBeforeMainAttempt,
      "main-session rejection must happen without CAS");

    const decisionsRunContext = { ...runContext, sessionId: decisionsSessionId };
    const writesBeforeResolution = calls.filter(method => method === "state.compareAndSet").length;
    invoke(8, "builder.resolve-design-question", resolution, decisionsRunContext);
    const resolutionReply = await serviceUntil(8);
    assert.equal(resolutionReply.error, undefined, JSON.stringify(resolutionReply.error));
    assert.equal(resolutionReply.result.data.status, "published");
    assert.equal(resolutionReply.result.data.revision.draft.specification.revisionId, "spec-2");
    assert.equal(resolutionReply.result.data.revision.draft.graph.graphRevisionId, "graph-2");
    assert.deepEqual(resolutionReply.result.data.revision.decisions, [{ questionId: designQuestion.id,
      questionDigest: sha256(JSON.stringify(designQuestion)), answerSourceId,
      answerSourceSha256: sha256("Use the desktop target."), answerText,
      fromDraftRevisionId: draft.revisionId, appliedDraftRevisionId: resolvedDraft.revisionId }]);
    assert.equal(calls.filter(method => method === "state.compareAndSet").length, writesBeforeResolution + 2,
      "resolution publishes the revision and head with conditional writes");

    send({ jsonrpc: "2.0", id: 9, method: "getData", paperclipInvocation: { id: invocationId, scope: { companyId: workspaceA } },
      params: { key: "builder.design-draft", companyId: workspaceA, params: { projectId: workspaceA } } });
    const dto = await serviceUntil(9);
    assert.equal(dto.error, undefined, JSON.stringify(dto.error));
    assert.equal(dto.result.sequence, 2);
    assert.equal(dto.result.draft.specification.revisionId, "spec-2");
    assert.equal(dto.result.draft.graph.graphRevisionId, "graph-2");
    assert.deepEqual(dto.result.decisions, resolutionReply.result.data.revision.decisions);

    const writesBeforeDuplicate = calls.filter(method => method === "state.compareAndSet").length;
    invoke(10, "builder.resolve-design-question", resolution, decisionsRunContext);
    const duplicateResolution = await serviceUntil(10);
    assert.equal(duplicateResolution.error, undefined, JSON.stringify(duplicateResolution.error));
    assert.equal(duplicateResolution.result.data.status, "conflict", "the old base revision cannot be applied twice");
    assert.equal(calls.filter(method => method === "state.compareAndSet").length, writesBeforeDuplicate,
      "stale duplicate must not perform another CAS write");

    // Explicit fake user/run association, not a real provider or legal approval.
    const turnKey = JSON.stringify(stateKey(`lead-chat.turn.v1.${answerTurnId}`));
    hostState.set(turnKey, { ...hostState.get(turnKey), state: "submitted", runId });
    const baselineInput = { projectId: workspaceA, expectedBaseRevisionId: null, sourceDraftRevisionId: resolvedDraft.revisionId,
      revisionId: "baseline-rpc-1", userSourceId: answerSourceId, interpretation: "The user selected the desktop design." };
    invoke(14, "builder.publish-design-baseline", baselineInput, runContext);
    assert.ok((await serviceUntil(14)).error, "main cannot reuse a decisions user/run as its own");
    invoke(15, "builder.publish-design-baseline", baselineInput, decisionsRunContext);
    const baselineReply = await serviceUntil(15);
    assert.equal(baselineReply.error, undefined, JSON.stringify(baselineReply.error));
    assert.equal(baselineReply.result.data.status, "published");
    const baseline = baselineReply.result.data.revision;
    assert.deepEqual(baseline.specification.requirements, resolvedDraft.specification.requirements);
    assert.deepEqual(baseline.graph.entities, resolvedDraft.graph.entities);
    assert.equal(baseline.specification.approvalEvidenceRef, answerSourceId);
    assert.equal(baseline.graph.approvedSpecRevisionId, baseline.specification.revisionId);
    assert.equal(baseline.userDecision.sourceSha256, sha256("Use the desktop target."));
    assert.match(baselineReply.result.content, /not independently verified legal approval/);
    send({ jsonrpc: "2.0", id: 16, method: "getData", paperclipInvocation: { id: invocationId, scope: { companyId: workspaceA } },
      params: { key: "builder.design-baseline", companyId: workspaceA, params: { projectId: workspaceA } } });
    const baselineDto = await serviceUntil(16);
    assert.equal(baselineDto.error, undefined, JSON.stringify(baselineDto.error));
    assert.deepEqual(baselineDto.result, { workspaceId: workspaceA, projectId: workspaceA, sequence: 1, baseline });
    invoke(17, "builder.read-solution", { projectId: workspaceA });
    const canonicalGraph = await serviceUntil(17);
    assert.equal(canonicalGraph.error, undefined, JSON.stringify(canonicalGraph.error));
    assert.deepEqual(canonicalGraph.result.data.solution, { sequence: 1, revision: baseline.graph });

    const technologyRegister = { projectId: workspaceA, revisionId: "technology-rpc-1",
      sourceBaselineRevisionId: baseline.revisionId, sourceSpecRevisionId: baseline.specification.revisionId,
      sourceGraphRevisionId: baseline.graph.graphRevisionId,
      entries: ["required", "allowed", "prohibited", "undecided"].map((disposition, index) => ({
        id: `tech-${index}`, technology: `Example stack ${index}`, disposition,
        selectionReason: "Bounded contract-level research fixture, not actual research.", nonSelectionReason: "",
        scopeNodeIds: [], interoperability: [], constraints: [], cost: "Not measured.",
        versionCompatibility: "Not verified.", changeApprovalOwner: "Lead; external authority remains separate.",
        licenseReview: { status: "unreviewed", licenseExpression: null, evidenceRefs: [] },
        verification: { level: "not-verified", evidenceRefs: [], limitations: "Fake Host fixture only.", nextReviewCondition: "Actual integration evidence." },
      })) };
    invoke(18, "builder.publish-technology-decisions", { projectId: workspaceA, expectedBaseRevisionId: null, register: technologyRegister });
    const technologyReply = await serviceUntil(18);
    assert.equal(technologyReply.error, undefined, JSON.stringify(technologyReply.error));
    assert.equal(technologyReply.result.data.status, "published");
    assert.deepEqual(technologyReply.result.data.revision.register, technologyRegister);
    assert.match(technologyReply.result.content, /unspecified, not prohibited/);
    assert.match(technologyReply.result.content, /not independent/);
    invoke(19, "builder.read-technology-decisions", { projectId: workspaceA });
    const technologyRead = await serviceUntil(19);
    assert.equal(technologyRead.error, undefined, JSON.stringify(technologyRead.error));
    assert.deepEqual(technologyRead.result.data.current.revision, technologyReply.result.data.revision);
    send({ jsonrpc: "2.0", id: 20, method: "getData", paperclipInvocation: { id: invocationId, scope: { companyId: workspaceA } },
      params: { key: "builder.technology-decisions", companyId: workspaceA, params: { projectId: workspaceA } } });
    const technologyDto = await serviceUntil(20);
    assert.equal(technologyDto.error, undefined, JSON.stringify(technologyDto.error));
    assert.deepEqual(technologyDto.result, { workspaceId: workspaceA, projectId: workspaceA, sequence: 1, record: technologyReply.result.data.revision });

    hostState.set(JSON.stringify(stateKey(`project-ctos.v1.${sha256(workspaceA)}`)), {
      schemaVersion: 1, workspaceId: workspaceA, projectId: workspaceA, revision: 1,
      ctos: [{ ctoId: "rpc-cto", displayName: "Fake Host CTO", agentId: leadId, sessionId: ctoSessionId,
        status: "AVAILABLE", createdAt: "2026-11-02T00:00:00.000Z",
        createdBy: { agentId: leadId, sessionId, runId, selectionRevision: 1 } }],
    });
    const workstreamSpec = { projectId: workspaceA, id: "rpc-workstream", revision: 1,
      sourceSpecRevisionId: baseline.specification.revisionId, assignedCtoId: "rpc-cto", title: "Fake Host workstream",
      goal: "Verify versioned instruction and receipt, not execute code.", scopeNodeIds: ["rpc-feature"],
      included: ["Read assigned specification."], excluded: ["Code execution."], dependencies: [],
      interfaceContracts: ["rpc-contract"], technologyDecisionsRef: technologyRegister.revisionId, reuseCandidates: [],
      acceptance: ["Exact revision receipt."], evidenceRequired: ["Host receipt record."], openQuestions: [] };
    invoke(21, "builder.publish-workstream", { projectId: workspaceA, expectedBaseRevisionId: null, revisionId: "board-rpc-1",
      spec: workstreamSpec, change: { previousRevision: null, reason: "Initial instruction.", diff: "New workstream.",
        impactNodeIds: ["rpc-feature"], impactInterfaceContracts: ["rpc-contract"], impactTaskIds: [], effectiveFrom: "Receipt only; no dispatch." } });
    const workstreamReply = await serviceUntil(21);
    assert.equal(workstreamReply.error, undefined, JSON.stringify(workstreamReply.error));
    assert.equal(workstreamReply.result.data.status, "published");
    assert.equal(workstreamReply.result.data.executionStarted, false);
    assert.equal(workstreamReply.result.data.revision.workstreams[0].receipt, null);
    invoke(22, "builder.read-cto-workstream", { projectId: workspaceA, ctoId: "rpc-cto", workstreamId: "rpc-workstream" }, ctoContext);
    const assignedRead = await serviceUntil(22);
    assert.equal(assignedRead.error, undefined, JSON.stringify(assignedRead.error));
    assert.deepEqual(assignedRead.result.data.workstream.spec, workstreamSpec);
    assert.deepEqual(assignedRead.result.data.sources.baseline, baseline);
    const receiptInput = { projectId: workspaceA, ctoId: "rpc-cto", workstreamId: "rpc-workstream",
      expectedBaseRevisionId: "board-rpc-1", revisionId: "board-rpc-2", specRevision: 1, readiness: "ready",
      note: "Fake Host CTO understood this revision; no code or provider execution." };
    invoke(23, "builder.acknowledge-workstream", receiptInput, runContext);
    assert.ok((await serviceUntil(23)).error, "A Lead session cannot acknowledge as a CTO.");
    invoke(24, "builder.acknowledge-workstream", receiptInput, ctoContext);
    const receiptReply = await serviceUntil(24);
    assert.equal(receiptReply.error, undefined, JSON.stringify(receiptReply.error));
    assert.equal(receiptReply.result.data.status, "published");
    assert.equal(receiptReply.result.data.executionStarted, false);
    assert.equal(receiptReply.result.data.revision.workstreams[0].receipt.runId, ctoContext.runId);
    send({ jsonrpc: "2.0", id: 25, method: "getData", paperclipInvocation: { id: invocationId, scope: { companyId: workspaceA } },
      params: { key: "builder.workstreams", companyId: workspaceA, params: { projectId: workspaceA } } });
    const workstreamDto = await serviceUntil(25);
    assert.equal(workstreamDto.error, undefined, JSON.stringify(workstreamDto.error));
    assert.deepEqual(workstreamDto.result, { workspaceId: workspaceA, projectId: workspaceA, sequence: 2, board: receiptReply.result.data.revision });

    const instruction = { ...receiptReply.result.data.revision.workstreams[0], receipt: null };
    ctoRequestId = ctoDeliveryRequestId(workspaceA, workspaceA, "rpc-cto", instruction);
    const localRevisionState = {
      async get(key) { return clone(hostState.get(JSON.stringify(key))); },
      async compareAndSet(key, expected, value) {
        const keyId = JSON.stringify(key), exists = hostState.has(keyId), current = hostState.get(keyId);
        const matches = expected.exists
          ? exists && JSON.stringify(current) === JSON.stringify(expected.value)
          : !exists;
        if (matches) hostState.set(keyId, clone(value));
        return { swapped: matches };
      },
    };
    const delivery = parseCtoDelivery({ schemaVersion: 1, workspaceId: workspaceA, projectId: workspaceA, ctoId: "rpc-cto",
      revisionId: randomUUID(), requestId: ctoRequestId, boardRevisionId: "board-rpc-2", instruction,
      requestedBy: { agentId: leadId, sessionId, runId, selectionRevision: 1 },
      executionPolicy: CTO_SESSION_EXECUTION_POLICY, createdAt: new Date("2026-11-02T00:00:00.000Z").toISOString(),
      phase: "submitted", runId: ctoContext.runId, cancellationRequested: false, termination: "not_applicable",
      outputState: "not_ready", answer: null }, workspaceA, workspaceA, "rpc-cto");
    const deliveryStore = createCtoDeliveryStore(workspaceA, workspaceA, "rpc-cto", localRevisionState);
    const seededDelivery = await deliveryStore.publish({ expectedBaseRevisionId: null, revision: delivery });
    assert.equal(seededDelivery.status, "published");
    assert.equal(seededDelivery.revision.requestId, ctoRequestId);
    assert.equal(seededDelivery.revision.runId, ctoContext.runId);
    assert.deepEqual(seededDelivery.revision.executionPolicy, CTO_SESSION_EXECUTION_POLICY);
    assert.equal(workstreamInstructionDigest(instruction), workstreamInstructionDigest(seededDelivery.revision.instruction));

    const memoryInput = { projectId: workspaceA, ctoId: "rpc-cto", workstreamId: "rpc-workstream" };
    const ctoCallsBefore = calls.filter(method => method.startsWith("agents.sessions.")).length;
    invoke(26, "builder.read-cto-memory", memoryInput, ctoContext);
    const emptyCtoMemory = await serviceUntil(26);
    assert.equal(emptyCtoMemory.error, undefined, JSON.stringify(emptyCtoMemory.error));
    assert.equal(emptyCtoMemory.result.data.projectId, workspaceA);
    assert.equal(emptyCtoMemory.result.data.ctoId, "rpc-cto");
    assert.equal(emptyCtoMemory.result.data.current, null);
    assert.equal(emptyCtoMemory.result.data.currentSource.requestId, ctoRequestId);
    assert.ok(calls.filter(method => method.startsWith("agents.sessions.")).length > ctoCallsBefore,
      "CTO memory must reconcile its exact Core request and active run through the compiled Worker wire.");

    const ctoMemory = { projectId: workspaceA, ctoId: "rpc-cto", revisionId: "cto-memory-rpc-1",
      entries: [{ id: "note-1", kind: "context", text: "This exact Workstream was read; no implementation was performed.",
        sourceRequestIds: [ctoRequestId] }] };
    invoke(27, "builder.update-cto-memory", { ...memoryInput, expectedBaseRevisionId: null, memory: ctoMemory }, ctoContext);
    const updatedCtoMemory = await serviceUntil(27);
    assert.equal(updatedCtoMemory.error, undefined, JSON.stringify(updatedCtoMemory.error));
    assert.equal(updatedCtoMemory.result.data.status, "published");
    assert.deepEqual(updatedCtoMemory.result.data.revision.memory, ctoMemory);
    assert.deepEqual(updatedCtoMemory.result.data.revision.author, { agentId: leadId, sessionId: ctoSessionId, runId: ctoContext.runId });
    assert.deepEqual(updatedCtoMemory.result.data.revision.sourceDigests, [{ requestId: ctoRequestId,
      workstreamId: "rpc-workstream", specRevision: 1, sha256: workstreamInstructionDigest(instruction) }]);

    invoke(28, "builder.read-cto-memory", memoryInput, ctoContext);
    const exactCtoMemory = await serviceUntil(28);
    assert.equal(exactCtoMemory.error, undefined, JSON.stringify(exactCtoMemory.error));
    assert.deepEqual(exactCtoMemory.result.data.current.revision, updatedCtoMemory.result.data.revision);

    invoke(29, "builder.read-cto-memory", memoryInput, runContext);
    const rejectedLeadMemory = await serviceUntil(29);
    assert.ok(rejectedLeadMemory.error, "A Lead run cannot read private CTO memory.");
    send({ jsonrpc: "2.0", id: 30, method: "getData", paperclipInvocation: { id: invocationId, scope: { companyId: workspaceA } },
      params: { key: "builder.cto-memory", companyId: workspaceA, params: memoryInput } });
    const privateMemoryData = await serviceUntil(30);
    assert.ok(privateMemoryData.error, "CTO memory must not have a generic data/UI provider.");

    const taskPacketInput = { projectId: workspaceA, ctoId: "rpc-cto", workstreamId: "rpc-workstream" };
    invoke(31, "builder.read-task-packets", taskPacketInput, ctoContext);
    const emptyTaskPackets = await serviceUntil(31);
    assert.equal(emptyTaskPackets.error, undefined, JSON.stringify(emptyTaskPackets.error));
    assert.deepEqual(emptyTaskPackets.result.data, { projectId: workspaceA, ctoId: "rpc-cto",
      workstreamId: "rpc-workstream", current: null,
      currentSource: { requestId: ctoRequestId, workstreamId: "rpc-workstream", specRevision: 1,
        sha256: workstreamInstructionDigest(instruction) }, taskStates: [] });

    const taskPacket = { projectId: workspaceA, ctoId: "rpc-cto", workstreamId: "rpc-workstream",
      taskId: "task-rpc-1", revision: 1, kind: "development", title: "Implement the assigned feature",
      goal: "Implement only the exact assigned feature.", scopeNodeIds: ["rpc-feature"],
      requirementIds: [baseline.specification.requirements[0].id], dependencies: [],
      included: ["Implement the pinned feature."], excluded: ["Unrelated functionality."],
      constraints: ["Preserve the approved public contract."], acceptance: ["The exact feature behavior passes."],
      evidenceRequired: ["Record the focused test result."], reuse: [], testPlan: null };
    invoke(32, "builder.publish-task-packet", { ...taskPacketInput, expectedBaseRevisionId: null,
      revisionId: "packet-rpc-1", packet: taskPacket }, ctoContext);
    const publishedTaskPacket = await serviceUntil(32);
    assert.equal(publishedTaskPacket.error, undefined, JSON.stringify(publishedTaskPacket.error));
    assert.deepEqual(publishedTaskPacket.result.data,
      { status: "published", taskId: "task-rpc-1", boardRevisionId: "packet-rpc-1", executionStarted: false });
    const packetJournalProject = `packets:${sha256(JSON.stringify([workspaceA, "rpc-cto", "rpc-workstream"]))}`;
    const packetRecord = hostState.get(JSON.stringify(stateKey(
      `task-packets-revision.v1.${sha256(packetJournalProject)}.${sha256("packet-rpc-1")}`)));
    assert.equal(packetRecord.revision.revisionId, "packet-rpc-1");
    const storedPacket = packetRecord.revision.packets[0];
    assert.deepEqual(storedPacket.packet, taskPacket);
    assert.deepEqual(storedPacket.dependencyPins, [], "dependency pins are server-derived and are empty for an independent task");
    assert.deepEqual(storedPacket.author, { agentId: leadId, sessionId: ctoSessionId, runId: ctoContext.runId });
    assert.deepEqual(storedPacket.source, { requestId: ctoRequestId, workstreamId: "rpc-workstream", specRevision: 1,
      instructionSha256: workstreamInstructionDigest(instruction) });
    assert.ok(calls.filter(method => method === "agents.sessions.getRequest").length > ctoCallsBefore,
      "Task Packet publication must bind to the exact Core request receipt.");

    invoke(33, "builder.read-task-packets", taskPacketInput, ctoContext);
    const readTaskPackets = await serviceUntil(33);
    assert.equal(readTaskPackets.error, undefined, JSON.stringify(readTaskPackets.error));
    assert.equal(readTaskPackets.result.data.current.sequence, 1);
    assert.deepEqual(readTaskPackets.result.data.current.revision, packetRecord.revision);

    const casBeforeDeniedPacket = calls.filter(method => method === "state.compareAndSet").length;
    invoke(34, "builder.publish-task-packet", { ...taskPacketInput, expectedBaseRevisionId: null,
      revisionId: "packet-lead-denied", packet: { ...taskPacket, taskId: "task-lead-denied" } }, runContext);
    const deniedPacketPublish = await serviceUntil(34);
    assert.ok(deniedPacketPublish.error, "Lead main cannot publish as the assigned CTO.");
    invoke(35, "builder.read-task-packets", taskPacketInput, runContext);
    const deniedPacketRead = await serviceUntil(35);
    assert.ok(deniedPacketRead.error, "Lead main cannot read private CTO Task Packets.");
    assert.equal(calls.filter(method => method === "state.compareAndSet").length, casBeforeDeniedPacket,
      "Lead main authorization failures must not publish or mutate Task Packet state.");
    assert.equal(calls.some(method => method === "agents.sessions.sendMessage" || method === "agents.sessions.ensure"
      || method === "agents.sessions.create"), false, "The compiled Worker test must not send to or create a provider session.");

    assert.ok(calls.includes("state.compareAndSet"), "proposal publication must use conditional state writes");
    assert.equal(hostState.get(JSON.stringify(stateKey("snapshot.v1"))).revision, 1,
      "design flow must not implicitly write the consultation snapshot");
    assert.equal(messages.some(message => typeof message.method === "string"), false);

    const casCount = calls.filter(method => method === "state.compareAndSet").length;
    invoke(11, "builder.read-design-draft", { projectId: workspaceA }, { ...runContext,
      sessionId: "77777777-7777-4777-8777-777777777777" });
    const rejectedSession = await serviceUntil(11);
    assert.ok(rejectedSession.error, "an unprepared session must not read the current draft");
    assert.equal(calls.filter(method => method === "state.compareAndSet").length, casCount,
      "a rejected session must not create or update draft state");

    send({ jsonrpc: "2.0", id: 12, method: "shutdown", params: {} });
    const shutdown = await response(12);
    assert.equal(shutdown.error, undefined);
    assert.equal(shutdown.result, null);
    child.stdin.end();
    let closeTimer;
    const exit = await Promise.race([closed, new Promise((_, reject) => {
      closeTimer = setTimeout(() => reject(new Error("Worker did not close its JSONL pipes after shutdown.")), 3_000);
    })]).finally(() => clearTimeout(closeTimer));
    assert.deepEqual(exit, { code: 0, signal: null });
  } finally {
    for (const waiter of waiting.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Design draft Worker test is cleaning up."));
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      const graceful = await Promise.race([closed.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 500))]);
      if (!graceful && child.exitCode === null && child.signalCode === null) child.kill();
    }
  }
});
