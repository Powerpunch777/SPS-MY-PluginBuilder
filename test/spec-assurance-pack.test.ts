import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createBuilderPlatform } from "../src/platform.ts";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createDesignBaselineStore } from "../src/design-baseline-tools.ts";
import type { RevisionState } from "../src/solution-revision-store.ts";
import { proposeSpecAssurancePack } from "../src/spec-assurance/pack-producer.ts";
import { createSpecAssurancePackStore, discoverSpecAssurancePackGaps, specAssurancePackRevisionId } from "../src/spec-assurance/pack-store.ts";
import type { CoverageRulesManifest } from "../src/spec-coverage/evaluator.ts";
import type { ApprovedSpecRevision } from "../src/domain/specification-revisions.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const AGENT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const TURN = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";
const SOURCE_ID = `lead-turn:${TURN}`;
const SOURCE_TEXT = "The user requires clear onboarding steps and a visible completion state.";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const keyId = (key: SpsStateKey) => JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);

function fixture() {
  const values = new Map<string, JsonValue>();
  const state: RevisionState = {
    async get(key) { return structuredClone(values.get(keyId(key)) ?? null); },
    async compareAndSet(key, expected, value) {
      const id = keyId(key), present = values.has(id), old = values.get(id);
      const match = expected.exists ? present && JSON.stringify(old) === JSON.stringify(expected.value) : !present;
      if (match) values.set(id, structuredClone(value));
      return { swapped: match };
    },
  };
  const platform = { state, events: {}, agents: {} } as unknown as SpsPlatformInvocationContext;
  const stateKey = (stateKey: string): SpsStateKey => ({ scopeKind: "company", scopeId: WORKSPACE,
    namespace: "sonpark.my-builder", stateKey });
  values.set(keyId(stateKey("lead-agent.v1")), { workspaceId: WORKSPACE, revision: 1, selectedAgentId: AGENT });
  values.set(keyId(stateKey("lead-sessions.v1.1")), { workspaceId: WORKSPACE, selectionRevision: 1, agentId: AGENT,
    sessions: { main: SESSION, "ui-design": null, background: null, "cto-inbox": null, decisions: null, "integration-review": null } });
  values.set(keyId(stateKey(`lead-chat.turn.v1.${TURN}`)), {
    workspaceId: WORKSPACE, selectionRevision: 1, agentId: AGENT, sessionId: SESSION, channel: "main", schemaVersion: 1,
    requestId: TURN, previousRequestId: null, sequence: 0, text: SOURCE_TEXT, createdAt: "2026-11-04T00:00:00.000Z",
    state: "submitted", runId: RUN, answer: null, outputState: "not_ready", cancellationRequested: false, termination: "not_applicable",
  });
  const spec: ApprovedSpecRevision = { projectId: WORKSPACE, revisionId: "spec-current", productTier: "M",
    requirements: [{ id: "REQ-ONBOARD", description: "Onboarding is clear.", acceptanceCriteriaIds: ["AC-COMPLETE"] }],
    targets: ["sps-plugin"], dataPolicyRef: "policy-1", approvalEvidenceRef: SOURCE_ID };
  const baseline = { projectId: WORKSPACE, revisionId: "baseline-1", sourceDraftRevisionId: "draft-1", draftDigest: "a".repeat(64),
    createdAt: "2026-11-04T00:00:01.000Z", author: { agentId: AGENT, sessionId: SESSION, runId: RUN, selectionRevision: 1 },
    userDecision: { sourceId: SOURCE_ID, sourceSha256: sha256(SOURCE_TEXT), interpretation: "Keep onboarding clear." },
    specification: spec,
    graph: { approvedSpecRevisionId: spec.revisionId, graphRevisionId: "graph-1", entities: [], relations: [], viewLayoutRef: "layout-1" } };
  const baselines = createDesignBaselineStore(WORKSPACE, WORKSPACE, state);
  const context = { companyId: WORKSPACE, agentId: AGENT, runId: RUN, sessionId: SESSION };
  const proposalInput = {
    projectId: WORKSPACE, expectedBaseRevisionId: null, packId: "onboarding", version: "1.0.0",
    applicability: { all: ["onboarding"] },
    rules: [{ id: "complete-rule", requirementIds: ["REQ-ONBOARD"], appliesWhen: { all: [] }, requiresCheck: true,
      modelCases: [{ when: { all: [] }, state: "started", event: "complete", allowedNextStates: ["done"] }] }],
    transitions: [{ from: "started", event: "complete", to: "done" }], exceptions: [], excludedCombinations: [],
    rulesVersion: "onboarding-coverage-1",
    coverageRules: [{ id: "source-rule", requiresCheck: true, requiredEvidenceKinds: ["source"] }],
    coverageTargets: [
      { targetId: "REQ-ONBOARD", targetKind: "requirement", ruleIds: ["source-rule"] },
      { targetId: "AC-COMPLETE", targetKind: "ac", ruleIds: ["source-rule"] },
    ],
    sourceRefs: [
      { requirementId: "REQ-ONBOARD", acId: null, sourceId: SOURCE_ID },
      { requirementId: "REQ-ONBOARD", acId: "AC-COMPLETE", sourceId: SOURCE_ID },
    ],
  };
  return { values, state, platform, context, baselines, baseline, spec, proposalInput };
}

async function publishFixture() {
  const f = fixture();
  const stored = await f.baselines.publish({ expectedBaseRevisionId: null, revision: f.baseline });
  assert.equal(stored.status, "published");
  const result = await proposeSpecAssurancePack(f.proposalInput, f.context, f.platform) as unknown as {
    data: { proposal: { status: string; sequence: number; revision: { status: string; identity: { specRevisionId: string; specDigest: string };
      revisionId: string; sourceRefs: readonly { sourceId: string; sourceDigest: string; revisionId: string }[];
      pack: { version: string; applicability: { all?: string[] } }; rulesManifest: CoverageRulesManifest } }; gaps: unknown[] };
  };
  return { ...f, proposal: result.data.proposal, gaps: result.data.gaps };
}

test("Main proposal stores a current-baseline-pinned, raw-source-digested version without asserting coverage", async () => {
  const f = await publishFixture();
  assert.equal(f.proposal.status, "published");
  assert.equal(f.proposal.revision.status, "PROPOSED");
  assert.equal(f.proposal.revision.identity.specDigest, sha256(JSON.stringify(f.spec)));
  assert.equal(f.proposal.revision.sourceRefs.length, 2);
  assert(f.proposal.revision.sourceRefs.every(ref => ref.sourceId === SOURCE_ID && ref.sourceDigest === sha256(SOURCE_TEXT)
    && ref.revisionId === f.spec.revisionId));
  assert.equal(f.proposal.revision.rulesManifest.digest.length, 64);
  assert.deepEqual(f.gaps, []);
  const current = await createSpecAssurancePackStore(WORKSPACE, WORKSPACE, f.state).current("onboarding");
  assert.equal(current?.revision.revisionId, f.proposal.revision.revisionId);
});

test("source tampering, non-Main authority, foreign project, and caller approval/check claims are rejected", async () => {
  const f = fixture();
  await f.baselines.publish({ expectedBaseRevisionId: null, revision: f.baseline });
  await assert.rejects(proposeSpecAssurancePack({ ...f.proposalInput, checks: [{ status: "passed" } ] }, f.context, f.platform));
  await assert.rejects(proposeSpecAssurancePack({ ...f.proposalInput, projectId: "foreign-project" }, f.context, f.platform));
  await assert.rejects(proposeSpecAssurancePack(f.proposalInput, { ...f.context, sessionId: "77777777-7777-4777-8777-777777777777" }, f.platform));
  const turnKey = [...f.values.keys()].find(key => key.includes(`lead-chat.turn.v1.${TURN}`))!;
  const original = f.values.get(turnKey) as Record<string, JsonValue>;
  f.values.set(turnKey, { ...original, text: "tampered source" });
  await assert.rejects(proposeSpecAssurancePack(f.proposalInput, f.context, f.platform), /source bytes|author binding/);
  assert.equal(await createSpecAssurancePackStore(WORKSPACE, WORKSPACE, f.state).current("onboarding"), null);
});

test("journal publication is CAS-bound and exact revision replays are idempotent", async () => {
  const f = await publishFixture();
  const store = createSpecAssurancePackStore(WORKSPACE, WORKSPACE, f.state);
  const replay = await store.publish("onboarding", { expectedBaseRevisionId: null, revision: f.proposal.revision });
  assert.equal(replay.status, "replayed");
  await new Promise(resolve => setTimeout(resolve, 5));
  const handlerReplay = await proposeSpecAssurancePack(f.proposalInput, f.context, f.platform) as unknown as {
    data: { proposal: { status: string; revision: { createdAt: string } } } };
  assert.equal(handlerReplay.data.proposal.status, "replayed");
  assert.equal(handlerReplay.data.proposal.revision.createdAt, (f.proposal.revision as unknown as { createdAt: string }).createdAt);
  await assert.rejects(store.publish("onboarding", { expectedBaseRevisionId: f.proposal.revision.revisionId,
    revision: { ...f.proposal.revision, pack: { ...f.proposal.revision.pack, applicability: { all: ["changed"] } } } }));
  const nextRevision = { ...f.proposal.revision, revisionId: specAssurancePackRevisionId("onboarding", "2.0.0", f.proposal.revision.identity),
    pack: { ...f.proposal.revision.pack, version: "2.0.0" }, createdAt: "2026-11-05T00:00:00.000Z" };
  const stale = await store.publish("onboarding", { expectedBaseRevisionId: null, revision: nextRevision });
  assert.equal(stale.status, "conflict");
  assert.equal((await store.current("onboarding"))?.revision.revisionId, f.proposal.revision.revisionId);
});

test("finite structural discovery emits scoped candidate gaps for missing links and target rules", () => {
  const f = fixture();
  const identity = { workspaceId: WORKSPACE, projectId: WORKSPACE, specRevisionId: f.spec.revisionId,
    specDigest: sha256(JSON.stringify(f.spec)) };
  const manifest: CoverageRulesManifest = { identity, scope: { requirementIds: ["REQ-ONBOARD"], acIds: ["AC-COMPLETE"] },
    rulesVersion: "rules-1", rules: [{ id: "rule", requiresCheck: true, requiredEvidenceKinds: ["source"] }],
    targets: [], digest: "" };
  const gaps = discoverSpecAssurancePackGaps(f.spec, manifest, []);
  assert.deepEqual(new Set(gaps.map(gap => `${gap.targetKind}:${gap.reason}`)), new Set([
    "requirement:source-link-missing", "requirement:coverage-rule-missing", "ac:source-link-missing", "ac:coverage-rule-missing",
  ]));
  assert(gaps.every(gap => gap.status === "candidate" && gap.detectionMethod === "bounded-pack-structure-check"));
});

test("registered Main proposal/read tools preserve proposal status and do not upgrade D3 assurance", async () => {
  const f = await publishFixture();
  const contract = createBuilderPlatform();
  const write = contract.tools!.find(tool => tool.name === "builder.propose-spec-assurance-pack")!;
  const read = contract.tools!.find(tool => tool.name === "builder.read-spec-assurance-pack")!;
  const replay = await write.handler!(f.proposalInput, f.context, f.platform) as { data: { proposal: { status: string } } };
  assert.equal(replay.data.proposal.status, "replayed");
  const result = await read.handler!({ projectId: WORKSPACE, packId: "onboarding" }, f.context, f.platform) as {
    data: { current: { revision: { status: string } }; matchesCurrentBaseline: boolean } };
  assert.equal(result.data.current.revision.status, "PROPOSED");
  assert.equal(result.data.matchesCurrentBaseline, true);
  const inspect = contract.tools!.find(tool => tool.name === "builder.inspect-spec-assurance")!;
  const assurance = await inspect.handler!({ projectId: WORKSPACE }, f.context, f.platform) as { data: { result: { status: string } } };
  assert.equal(assurance.data.result.status, "UNKNOWN");
});
