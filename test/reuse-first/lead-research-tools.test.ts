import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { readLeadReuseFirstCandidates, recordLeadReuseFirstCandidate } from "../../src/reuse-first/lead-research-tools.ts";
import { createBuilderPlatform } from "../../src/platform.ts";

const contract = createBuilderPlatform();
const recordTool = contract.tools.find(tool => tool.name === "builder.record-reuse-candidate")!.handler;
const readTool = contract.tools.find(tool => tool.name === "builder.read-reuse-candidates")!.handler;
const readData = contract.data.find(item => item.key === "builder.reuse-candidates")!.handler;

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const TURN = "55555555-5555-4555-8555-555555555555";
const MAIN = "66666666-6666-4666-8666-666666666666";
const BACKGROUND = "77777777-7777-4777-8777-777777777777";
const UI = "88888888-8888-4888-8888-888888888888";
const INTAKE = "99999999-9999-4999-8999-999999999999";
const DISCUSSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REVIEW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = WORKSPACE;
const SOURCE_TEXT = `Existing user research:
Use the approved SDK for this integration.
The project must also support the desktop delivery target.`;
const ADDRESS = (key: SpsStateKey) => JSON.stringify(key);

function fixture(workspaceId = WORKSPACE) {
  const values = new Map<string, JsonValue>();
  const sessions = { main: MAIN, "ui-design": UI, background: BACKGROUND, "cto-inbox": INTAKE,
    decisions: DISCUSSION, "integration-review": REVIEW };
  const selection = { workspaceId, selectionRevision: 1, agentId: AGENT, sessions };
  values.set(ADDRESS({ scopeKind: "company", scopeId: workspaceId, namespace: "sonpark.my-builder", stateKey: "lead-agent.v1" }),
    { workspaceId, revision: 1, selectedAgentId: AGENT });
  values.set(ADDRESS({ scopeKind: "company", scopeId: workspaceId, namespace: "sonpark.my-builder", stateKey: "lead-sessions.v1.1" }), selection);
  values.set(ADDRESS({ scopeKind: "company", scopeId: workspaceId, namespace: "sonpark.my-builder", stateKey: `lead-chat.turn.v1.${TURN}` }), {
    workspaceId, selectionRevision: 1, agentId: AGENT, sessionId: MAIN, channel: "main", schemaVersion: 1,
    requestId: TURN, previousRequestId: null, sequence: 0, text: SOURCE_TEXT, createdAt: "2026-11-06T00:00:00.000Z",
    state: "succeeded", runId: RUN, answer: null, outputState: "not_ready", cancellationRequested: false,
    termination: "not_applicable", inputKind: "user",
  });
  const state = {
    async get(key: SpsStateKey) { const value = values.get(ADDRESS(key)); return value === undefined ? null : structuredClone(value); },
    async compareAndSet(key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, next: JsonValue) {
      const address = ADDRESS(key), old = values.get(address);
      const matches = expected.exists ? old !== undefined && JSON.stringify(old) === JSON.stringify(expected.value) : old === undefined;
      if (matches) values.set(address, structuredClone(next));
      return { swapped: matches };
    },
  };
  const platform = { state, agents: {} } as unknown as SpsPlatformInvocationContext;
  const context = (channel: keyof typeof sessions, companyId = workspaceId) => ({ companyId, agentId: AGENT,
    runId: RUN, sessionId: sessions[channel] });
  return { values, platform, context };
}

const candidate = (overrides: Record<string, unknown> = {}) => ({ candidateId: "reuse-candidate-1",
  name: "Existing integration library", kind: "code", originUrl: "https://example.test/library", originVersion: "v2.4",
  source: { sourceId: `lead-turn:${TURN}`, fromLine: 2, throughLine: 3 }, productTier: "L", route: "CUSTOM",
  deliveryTargets: ["sps-plugin", "desktop"], ...overrides });

test("Background records exact current user-source lines with CAS; Main and Background read without license PASS", async () => {
  const f = fixture();
  const written = await recordTool({ projectId: PROJECT, expectedRevisionId: null, candidate: candidate() },
    f.context("background"), f.platform) as unknown as { data: { status: string; revision: { candidates: Array<Record<string, unknown>> } } };
  assert.equal(written.data.status, "published");
  const saved = written.data.revision.candidates[0] as unknown as {
    source: { quote: string; sha256: string }; license: unknown; reuse: unknown; product: unknown;
  };
  const excerpt = SOURCE_TEXT.split("\n").slice(1).join("\n");
  assert.equal(saved.source.quote, excerpt);
  assert.equal(saved.source.sha256, createHash("sha256").update(excerpt, "utf8").digest("hex"));
  assert.deepEqual(saved.license, { status: "unknown", evidenceRefs: [] });
  assert.deepEqual(saved.reuse, { status: "blocked-unverified", reusableAcrossProjects: false });
  assert.deepEqual(saved.product, { tier: "L", route: "CUSTOM", deliveryTargets: ["sps-plugin", "desktop"] });

  for (const reader of [f.context("main"), f.context("background")]) {
    const result = await readTool({ projectId: PROJECT }, reader, f.platform) as unknown as {
      data: { current: { revision: { candidates: Array<Record<string, unknown>> } } };
    };
    assert.deepEqual(result.data.current.revision.candidates[0], saved);
  }
  const readonlyPlatform = { state: { get: f.platform.state.get }, agents: {}, events: {} } as unknown as SpsPlatformInvocationContext;
  const fromData = await readData({ companyId: WORKSPACE }, readonlyPlatform) as unknown as {
    workspaceId: string; projectId: string; revision: { candidates: unknown[] };
  };
  assert.equal(fromData.workspaceId, WORKSPACE);
  assert.equal(fromData.projectId, WORKSPACE);
  assert.deepEqual(fromData.revision.candidates[0], saved);
  assert.deepEqual(await readData({ companyId: WORKSPACE, renderEnvironment: null }, readonlyPlatform), fromData);
  assert.equal(await readData({ companyId: OTHER_WORKSPACE }, readonlyPlatform), null);
  await assert.rejects(async () => readData({ companyId: WORKSPACE, projectId: OTHER_WORKSPACE }, readonlyPlatform));
});

test("a source changed after its read cannot yield a confirmed research publication", async () => {
  const f = fixture();
  const get = f.platform.state.get.bind(f.platform.state);
  let changed = false;
  f.platform.state.get = async key => {
    const value = await get(key);
    if (!changed && key.stateKey.startsWith("reuse-first-head.v1.")) {
      changed = true;
      const sourceKey = ADDRESS({ scopeKind: "company", scopeId: WORKSPACE, namespace: "sonpark.my-builder",
        stateKey: `lead-chat.turn.v1.${TURN}` });
      const source = f.values.get(sourceKey) as Record<string, JsonValue>;
      f.values.set(sourceKey, { ...source, text: "Unrelated replacement source" });
    }
    return value;
  };
  await assert.rejects(async () => recordTool({ projectId: PROJECT, expectedRevisionId: null, candidate: candidate() },
    f.context("background"), f.platform), /changed/);
  assert.equal(await readData({ companyId: WORKSPACE }, f.platform), null);
});

test("selected CRLF bytes are preserved and the Lead turn's 16 KiB source limit is not bypassed", async () => {
  const storeSource = (f: ReturnType<typeof fixture>, text: string) => {
    const key = ADDRESS({ scopeKind: "company", scopeId: WORKSPACE, namespace: "sonpark.my-builder",
      stateKey: `lead-chat.turn.v1.${TURN}` });
    f.values.set(key, { ...(f.values.get(key) as Record<string, JsonValue>), text });
  };
  const f = fixture();
  storeSource(f, "Header\r\nFirst selected line\r\nSecond selected line\r\nNot selected");
  const written = await recordTool({ projectId: PROJECT, expectedRevisionId: null, candidate: candidate() },
    f.context("background"), f.platform) as unknown as { data: { revision: { candidates: Array<{ source: { quote: string; sha256: string } }> } } };
  const excerpt = "First selected line\r\nSecond selected line";
  assert.equal(written.data.revision.candidates[0]?.source.quote, excerpt);
  assert.equal(written.data.revision.candidates[0]?.source.sha256, createHash("sha256").update(excerpt, "utf8").digest("hex"));

  const exact = fixture();
  const text = "x".repeat(16 * 1024);
  storeSource(exact, text);
  const input = { projectId: PROJECT, expectedRevisionId: null,
    candidate: candidate({ source: { sourceId: `lead-turn:${TURN}`, fromLine: 1, throughLine: 1 } }) };
  const result = await recordTool(input, exact.context("background"), exact.platform) as unknown as { data: { status: string } };
  assert.equal(result.data.status, "published");
  const oversized = fixture();
  storeSource(oversized, text + "x");
  await assert.rejects(async () => recordTool(input, oversized.context("background"), oversized.platform));
  assert.equal(await readData({ companyId: WORKSPACE }, oversized.platform), null);
});

test("candidate writes are Background-only and reject caller excerpts, digests, consultation IDs, and invented turns", async () => {
  const f = fixture();
  await assert.rejects(recordLeadReuseFirstCandidate({ projectId: PROJECT, expectedRevisionId: null, candidate: candidate() },
    f.context("main"), f.platform), /Background/);
  await assert.rejects(recordLeadReuseFirstCandidate({ projectId: PROJECT, expectedRevisionId: null,
    candidate: candidate({ source: { sourceId: `lead-turn:${TURN}`, fromLine: 2, throughLine: 3, quote: "forged", sha256: "a".repeat(64) } }) },
  f.context("background"), f.platform), /fields/);
  await assert.rejects(recordLeadReuseFirstCandidate({ projectId: PROJECT, expectedRevisionId: null,
    candidate: candidate({ licenseStatus: "permissive" }) }, f.context("background"), f.platform), /fields/);
  await assert.rejects(recordLeadReuseFirstCandidate({ projectId: PROJECT, expectedRevisionId: null,
    candidate: candidate({ source: { sourceId: `consultation-${TURN}`, fromLine: 1, throughLine: 1 } }) },
  f.context("background"), f.platform), /Lead user turn/);
  await assert.rejects(recordLeadReuseFirstCandidate({ projectId: PROJECT, expectedRevisionId: null,
    candidate: candidate({ source: { sourceId: "lead-turn:cccccccc-cccc-4ccc-8ccc-cccccccccccc", fromLine: 1, throughLine: 1 } }) },
  f.context("background"), f.platform));
  const empty = await readLeadReuseFirstCandidates({ projectId: PROJECT }, f.context("main"), f.platform) as unknown as { data: { current: unknown } };
  assert.equal(empty.data.current, null);
});

test("CAS conflicts do not retry and product, route, and delivery targets remain independent axes", async () => {
  const f = fixture();
  const first = await recordLeadReuseFirstCandidate({ projectId: PROJECT, expectedRevisionId: null, candidate: candidate() },
    f.context("background"), f.platform) as unknown as { data: { status: string; revision: { revisionId: string } } };
  assert.equal(first.data.status, "published");
  const stale = await recordLeadReuseFirstCandidate({ projectId: PROJECT, expectedRevisionId: null,
    candidate: candidate({ candidateId: "reuse-candidate-2", productTier: "S", route: "FAST", deliveryTargets: ["cli-automation"] }) },
  f.context("background"), f.platform) as unknown as { data: { status: string; actualRevisionId: string } };
  assert.deepEqual(stale.data, { status: "conflict", actualRevisionId: first.data.revision.revisionId });
  const current = await readLeadReuseFirstCandidates({ projectId: PROJECT }, f.context("main"), f.platform) as unknown as {
    data: { current: { revision: { candidates: unknown[] } } };
  };
  assert.equal(current.data.current.revision.candidates.length, 1);
});

test("journal reads and source resolution stay Workspace-bound; other Lead channels cannot read", async () => {
  const f = fixture();
  await recordLeadReuseFirstCandidate({ projectId: PROJECT, expectedRevisionId: null, candidate: candidate() },
    f.context("background"), f.platform);
  await assert.rejects(readLeadReuseFirstCandidates({ projectId: PROJECT }, f.context("ui-design"), f.platform), /Main or Background/);
  await assert.rejects(readLeadReuseFirstCandidates({ projectId: PROJECT }, f.context("main", OTHER_WORKSPACE), f.platform));
  await assert.rejects(recordLeadReuseFirstCandidate({ projectId: PROJECT, expectedRevisionId: null,
    candidate: candidate({ candidateId: "foreign-source", source: { sourceId: `lead-turn:${TURN}`, fromLine: 1, throughLine: 1 } }) },
  f.context("background", OTHER_WORKSPACE), f.platform));
  const current = await readLeadReuseFirstCandidates({ projectId: PROJECT }, f.context("main"), f.platform) as unknown as {
    data: { current: { revision: { candidates: unknown[] } } };
  };
  assert.equal(current.data.current.revision.candidates.length, 1);
});
