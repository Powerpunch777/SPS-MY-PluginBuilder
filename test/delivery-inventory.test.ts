import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readDeliveryInventory } from "../src/delivery-evidence/delivery-inventory.ts";
import { A, S, W, ctx, key, mapKey, now } from "./fixtures/cto-platform.ts";
import { progressTool, validationFixture, validationTool } from "./fixtures/integration-manager-platform.ts";
import { createBuilderPlatform } from "../src/platform.ts";
import { createFinalPacketStore } from "../src/delivery-evidence/final-packet.ts";
import { proposeDeliveryDocuments } from "../src/project-documents/delivery-documents.ts";
import type { RevisionState } from "../src/solution-revision-store.ts";
import { createCurrentFinalEvidenceReader } from "../src/delivery-evidence/current-final-evidence.ts";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const objectId = (type: string, bytes: Buffer) =>
  createHash("sha1").update(`${type} ${bytes.length}\0`, "ascii").update(bytes).digest("hex");
const manifestPath = "inventory.json";
const file = { path: "app.js", source: "git", classification: "source-launcher", target: "desktop", requirementIds: ["REQ-1"] };
const output = { path: "bundle.bin", source: "ci-output", classification: "build-bundle", target: "desktop", requirementIds: ["REQ-1"] };

// Exact Git object bytes and protected Run/Artifact DTOs, not live Core or CI.
async function setup(files = [file, output], includeArtifact = true, withRegression = true, leadReviewSession?: string) {
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, files }));
  const launcher = Buffer.from("export const ready = true;\n");
  const blobs = [[file.path, launcher], [manifestPath, manifest]] as const;
  const entries = blobs.map(([path, bytes]) => ({ path, type: "blob", mode: "100644", objectId: objectId("blob", bytes), byteLength: bytes.length }));
  const treeSha = objectId("tree", Buffer.concat(entries.flatMap(entry => [Buffer.from(`100644 ${entry.path}\0`), Buffer.from(entry.objectId, "hex")])));
  const commit = Buffer.from(`tree ${treeSha}\nauthor Test <test@example.invalid> 0 +0000\ncommitter Test <test@example.invalid> 0 +0000\n\nfixture\n`);
  const commitSha = objectId("commit", commit);
  const f = await validationFixture(withRegression, false, true, { inventoryPath: manifestPath, commitSha, treeSha, leadReviewSession });
  const { localFolders } = f.f.platform as unknown as { localFolders: { readWorkspaceSourceGitSnapshotV1?: (input: { paths: string[] }) => Promise<unknown>;
    matchWorkspaceSourceV1?: (folderKey: string, sourceId: string) => Promise<unknown> } };
  localFolders.matchWorkspaceSourceV1 = async (folderKey, workspaceSourceId) => ({ folderKey, workspaceSourceId, match: "same_root" });
  const snapshotManifest = sha(JSON.stringify({ schemaVersion: 1, sourceId: f.plan.sourceId, commitSha, treeSha, entries }));
  localFolders.readWorkspaceSourceGitSnapshotV1 = async ({ paths }) => ({
    status: "current", complete: true, sourceId: f.plan.sourceId, folderKey: f.plan.folderKey, branch: f.plan.candidateBranch,
    commitSha, treeSha, manifestSha256: snapshotManifest, observedAt: now, entries,
    commitObject: { objectId: commitSha, sha256: sha(commit), byteLength: commit.length, contentBase64: commit.toString("base64") },
    files: blobs.filter(([path]) => paths.includes(path)).map(([path, bytes]) => ({
      path, mode: "100644", objectId: objectId("blob", bytes), byteLength: bytes.length, sha256: sha(bytes), contentBase64: bytes.toString("base64"),
    })),
  });
  for (const phase of withRegression ? ["ci", "e2e", "regression"] as const : ["ci", "e2e"] as const) {
    const result = await validationTool().handler({ ...f.input, phase }, f.managerContext, f.f.platform);
    const { reference } = result.data as unknown as { reference: { runId: string; subjectKey: string } };
    const run = f.runs.get(reference.runId);
    run.status = "succeeded"; run.termination = "confirmed";
    run.receipt = { digest: sha(`receipt-${phase}`), status: "completed", stdoutSha256: sha(""), stderrSha256: sha(""),
      stdoutBytes: 0, stderrBytes: 0, processExitCode: 0, timedOut: false, cancelled: false, outputLimit: false, appContainerVerified: true,
      capabilitiesCount: 0, childTerminationConfirmed: true, jobEmpty: true, profileCleanupSucceeded: true, sandboxCleanupSucceeded: true, fixtureMustBeRetained: false };
    if (phase !== "ci" || !includeArtifact) continue;
    const bytes = Buffer.from("ci bundle bytes"), row = { path: output.path, byteLength: bytes.length, sha256: sha(bytes) };
    run.receipt.outputManifest = [row];
    run.receipt.outputBytes = bytes.length;
    run.receipt.outputManifestSha256 = sha(`F\0${row.path}\0${row.byteLength}\0${row.sha256}`);
    Object.assign(f.f.platform, { artifacts: { async list() { return [{
      id: "18181818-1818-4818-8818-181818181818", companyId: W, pluginKey: "com.sonparkserver.my-plugin-builder",
      subjectKey: reference.subjectKey, runId: run.id, title: output.path, kind: "sps.protected-test-output-v1", referenceUrl: null, summary: null,
      data: { schemaVersion: 1, kind: "sps.protected-test-output-v1", ...row, contentBase64: bytes.toString("base64"),
        runId: run.id, approvalId: run.pins.approvalId, sourceId: f.plan.sourceId, commitSha, treeSha,
        planSha256: run.pins.planSha256, inputTreeSha256: run.pins.inputTreeSha256 }, createdAt: now, updatedAt: now,
    }]; } } });
  }
  return { f, commitSha, treeSha, launcher, manifest, localFolders, read: () => readDeliveryInventory(W, f.f.platform) };
}

test("Manager resolves only the declared candidate Git bytes and exact CI Artifact", async () => {
  const { f, commitSha, launcher, manifest } = await setup();
  const result = await progressTool().handler({ workstreamId: f.input.workstreamId, eventId: f.eventId, projection: "delivery-inventory" },
    f.managerContext, f.f.platform);
  const inventory = result.data as unknown as Awaited<ReturnType<typeof readDeliveryInventory>>;
  assert.equal(inventory.status, "observed");
  if (inventory.status !== "observed") return;
  assert.equal(inventory.candidate.commitSha, commitSha);
  assert.equal(inventory.manifest.sha256, sha(manifest));
  assert.deepEqual(inventory.files.map(item => [item.path, item.sha256, item.artifactId]), [
    [file.path, sha(launcher), null], [output.path, sha("ci bundle bytes"), "18181818-1818-4818-8818-181818181818"],
  ]);
  assert.equal(inventory.deliveryAuthority, "not-established");
  assert.doesNotMatch(JSON.stringify(inventory), /contentBase64|ci bundle bytes/u);
  assert.equal(f.enqueueCalls, 3, "inventory only reads existing evidence");
});

test("inventory refuses unknown targets, path collisions and unproven CI outputs", async t => {
  for (const [label, files, includeArtifact, reason] of [
    ["foreign target", [{ ...file, target: "web-api" }], true, "delivery-inventory-manifest-invalid-or-unconfirmed"],
    ["case collision", [file, { ...output, path: file.path.toUpperCase() }], true, "delivery-inventory-manifest-invalid-or-unconfirmed"],
    ["missing artifact", [output], false, "delivery-inventory-ci-artifact-unconfirmed"],
  ] as const) await t.test(label, async () => {
    const { read } = await setup([...files], includeArtifact);
    assert.deepEqual(await read(), { status: "unknown", reason });
  });
});

test("a candidate change during selected file reads never returns the old inventory", async () => {
  const { f, localFolders, read } = await setup();
  const original = localFolders.readWorkspaceSourceGitSnapshotV1!;
  localFolders.readWorkspaceSourceGitSnapshotV1 = async input => {
    const result = await original(input);
    if (input.paths.includes(file.path)) f.moveCandidate();
    return result;
  };
  assert.deepEqual(await read(), { status: "stale", reason: "delivery-inventory-git-files-unavailable" });
  assert.equal(f.enqueueCalls, 3);
});

const guides = [
  { kind: "installation-guide", path: "docs/install.md", classification: "guide", scope: "desktop", body: "# Installation\n\nUse the approved installer." },
  { kind: "user-guide", path: "docs/use.md", classification: "guide", scope: "desktop", body: "# Usage\n\nOpen the application." },
];
const preparation = { packageVersion: "1.0.0", targets: [{ target: "desktop", environments: ["Windows 11 x64"],
  dependencies: ["Declared fixture runtime"], entryPaths: ["bundle.bin"], supplementaryPaths: ["docs/install.md", "docs/use.md"] }],
  limitationStatement: "This test uses synthetic QA and runtime receipts.", limitations: [],
  changeNotes: ["Initial fixture package; not a real application acceptance."] };
const packetTool = () => createBuilderPlatform().tools.find(tool => tool.name === "builder.publish-integration-packet")!;
const mainTool = () => createBuilderPlatform().tools.find(tool => tool.name === "builder.read-final-review")!;

test("admitted Manager hands exact evidence to Main once, with no G7 or approval request", async () => {
  const { f, commitSha } = await setup();
  const platform = f.f.platform;
  const docs = await proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: null, documents: guides }, ctx(), platform);
  assert.equal(docs.status, "published", JSON.stringify(docs));
  const params = { workstreamId: f.input.workstreamId, eventId: f.eventId, expectedBaseRevisionId: null };
  await assert.rejects(async () => packetTool().handler(params, ctx(), platform), /manager/i);
  const first = await packetTool().handler(params, f.managerContext, platform) as any;
  assert.equal(first.data.status, "published", JSON.stringify(first.data));
  const replay = await packetTool().handler(params, f.managerContext, platform) as any;
  assert.deepEqual(replay.data, { ...first.data, status: "existing" });
  const main = async () => (await mainTool().handler({ projection: "integration-packet" }, ctx(), platform) as any).data;
  const review = await main();
  assert.equal(review.status, "available", JSON.stringify(review));
  assert.equal(review.packet.evidence.candidate.commitSha, commitSha);
  assert.deepEqual(review.packet.evidence.validation.map((run: { phase: string; receiptSha256: string }) => [run.phase, run.receiptSha256]),
    ["ci", "e2e", "regression"].map(phase => [phase, sha(`receipt-${phase}`)]));
  assert.equal(review.packet.evidence.finalReadiness, "main-g7-required");
  assert.equal(review.approvalEligibility, "not-established");
  assert.doesNotMatch(JSON.stringify(review), /contentBase64|Use the approved installer/u);
  assert.equal(f.enqueueCalls, 3);

  if (docs.status !== "published") throw new Error("Missing guide draft.");
  const replacement = await proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: docs.revision.revisionId,
    documents: [{ ...guides[0]!, body: "# Installation\n\nUpdated steps." }, guides[1]!] }, ctx(), platform);
  assert.equal(replacement.status, "published");
  assert.equal((await main()).status, "stale");
  const next = await packetTool().handler({ ...params, expectedBaseRevisionId: first.data.eventId }, f.managerContext, platform) as any;
  assert.equal(next.data.status, "published");
  assert.notEqual(next.data.packetRevisionId, first.data.packetRevisionId);
  const history = await createFinalPacketStore(W, W, platform.state).current();
  assert.deepEqual(history.revisions.map(item => item.revision.kind), ["manager-packet", "manager-packet"]);
  f.moveCandidate();
  assert.equal((await main()).status, "stale");
});

test("missing regression or guide evidence cannot publish a Manager packet", async () => {
  for (const [regression, reason] of [[false, "integration-packet-regression-not-configured"],
    [true, "integration-packet-current-guides-unavailable"]] as const) {
    const { f } = await setup(undefined, true, regression);
    const params = { workstreamId: f.input.workstreamId, eventId: f.eventId, expectedBaseRevisionId: null };
    const reply = await packetTool().handler(params, f.managerContext, f.f.platform) as any;
    assert.deepEqual(reply.data, { status: "pending", reason });
    assert.equal(await createFinalPacketStore(W, W, f.f.platform.state).headRevisionId(), null);
  }
});

test("uncertain packet write reconciles the same immutable receipt instead of publishing twice", async () => {
  const { f } = await setup();
  const platform = f.f.platform, state = platform.state as RevisionState;
  const docs = await proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: null, documents: guides }, ctx(), platform);
  assert.equal(docs.status, "published");
  const guarded = state.guardedCompareAndSetWithJobWakeV1!;
  state.guardedCompareAndSetWithJobWakeV1 = async (target, expected, value, wake) => {
    const result = await guarded(target, expected, value, wake);
    if (target.stateKey.startsWith("final-delivery-head") && result.status === "committed") throw new Error("Lost packet receipt");
    return result;
  };
  const params = { workstreamId: f.input.workstreamId, eventId: f.eventId, expectedBaseRevisionId: null };
  assert.equal((await packetTool().handler(params, f.managerContext, platform) as any).data.status, "unknown");
  const recovered = (await packetTool().handler(params, f.managerContext, platform) as any).data;
  assert.equal(recovered.status, "existing");
  assert.equal(recovered.sequence, 1);
});

test("registered atomic packet event dispatches the current Main exactly once and ignores a stale candidate", async () => {
  const { f } = await setup(), platform = f.f.platform;
  const docs = await proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: null, documents: guides }, ctx(), platform);
  assert.equal(docs.status, "published");
  const state = platform.state as RevisionState, original = state.guardedCompareAndSetWithJobWakeV1!, wakes: any[] = [];
  state.guardedCompareAndSetWithJobWakeV1 = async (target, expected, value, wake) => {
    const result = await original(target, expected, value, wake);
    if (result.status === "committed") wakes.push(wake);
    return result;
  };
  const params = { workstreamId: f.input.workstreamId, eventId: f.eventId, expectedBaseRevisionId: null };
  const packet = (await packetTool().handler(params, f.managerContext, platform) as any).data;
  assert.equal(packet.status, "published");
  await packetTool().handler(params, f.managerContext, platform);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].eventId, packet.eventId);
  assert.equal(wakes[0].jobKey, "builder.review-integration-packet");
  const sessions = platform.agents.sessions as any, priorGet = sessions.getRequest, priorRun = sessions.getRun;
  const receipts = new Map<string, any>();
  let mainSends = 0;
  platform.state.set = async (key, value) => { f.f.values.set(mapKey(key), structuredClone(value)); };
  Object.assign(platform.agents, { async list() { return [{ id: A, companyId: W, name: "Lead", status: "idle" }]; } });
  sessions.getRequest = async (sessionId: string, companyId: string, requestId: string) => sessionId === S
    ? receipts.get(requestId) ?? null : priorGet(sessionId, companyId, requestId);
  sessions.getRun = async (sessionId: string, companyId: string, runId: string) => sessionId === S
    ? { runId, status: "running", cancellationRequested: false, termination: "not_applicable", error: null, errorCode: null,
      output: { state: "not_ready", text: null } } : priorRun(sessionId, companyId, runId);
  sessions.sendMessage = async (sessionId: string, companyId: string, input: any) => {
    assert.equal(sessionId, S); assert.equal(companyId, W);
    assert.match(input.prompt, /not a user instruction/u);
    assert.ok(input.executionPolicy.toolNames.includes("builder.read-final-review"));
    mainSends++;
    const runId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    receipts.set(input.requestId, { requestId: input.requestId, state: "submitted", runId });
    return { runId };
  };
  const handler = createBuilderPlatform().jobs!.find(job => job.jobKey === wakes[0].jobKey)!.handler;
  const job = { jobKey: wakes[0].jobKey, eventId: packet.eventId, companyId: W, trigger: "event",
    runId: "ffffffff-ffff-4fff-8fff-ffffffffffff" } as any;
  await handler(job, platform);
  await handler(job, platform);
  assert.equal(mainSends, 1);
  f.moveCandidate();
  await handler(job, platform);
  assert.equal(mainSends, 1);
});

test("Host without atomic packet plus wake support cannot create a silent handoff", async () => {
  const { f } = await setup();
  delete (f.f.platform.state as RevisionState).guardedCompareAndSetWithJobWakeV1;
  const result = await packetTool().handler({ workstreamId: f.input.workstreamId, eventId: f.eventId, expectedBaseRevisionId: null },
    f.managerContext, f.f.platform) as any;
  assert.equal(result.data.status, "unsupported");
  assert.equal(await createFinalPacketStore(W, W, f.f.platform.state).headRevisionId(), null);
});

test("registered Main attests only a byte-checked current package and user approval stays unavailable without a writer", async () => {
  const { f } = await setup(), platform = f.f.platform;
  const documents = await proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: null, documents: guides, preparation }, ctx(), platform);
  assert.equal(documents.status, "published", JSON.stringify(documents));
  const handoff = (await packetTool().handler({ workstreamId: f.input.workstreamId, eventId: f.eventId, expectedBaseRevisionId: null },
    f.managerContext, platform) as any).data;
  assert.equal(handoff.status, "published");
  const reader = createCurrentFinalEvidenceReader(W, platform);
  const snapshot = await reader();
  assert.equal(snapshot.status, "available", JSON.stringify(snapshot));
  if (snapshot.status !== "available") throw new Error("Missing current snapshot");
  assert.deepEqual(snapshot.value.packet.preparation, preparation);
  assert.equal(snapshot.value.packet.integration.regressionEvidence?.length, 1);
  assert.equal(snapshot.value.fileBytes.length, 4);
  assert.ok(snapshot.value.fileBytes.some(file => file.path === "bundle.bin" && Buffer.from(file.bytes).toString() === "ci bundle bytes"));
  const ui = await mainTool().handler({}, ctx(), platform) as any;
  const view = ui.data;
  assert.equal(view.status, "ready", JSON.stringify(ui.data));
  if (view.status !== "ready") throw new Error("Missing final view");
  assert.equal(view.approvalEligibility.status, "blocked");
  assert.equal(view.history[0]?.kind, "manager-packet");
  assert.doesNotMatch(JSON.stringify(ui.data), /contentBase64|commitObjectBytes|fileBytes/u);
  const attest = createBuilderPlatform().tools.find(tool => tool.name === "builder.attest-final-packet")!;
  const result = (await attest.handler({ eventId: "main-fixture-attestation", requestId: snapshot.value.packet.packetRevisionId,
    expectedBaseRevisionId: handoff.eventId }, ctx(), platform) as any).data;
  assert.equal(result.status, "attested", JSON.stringify(result));
  assert.equal((await createFinalPacketStore(W, W, platform.state).current()).revisions[0]?.revision.kind, "main-attestation");
  f.moveCandidate();
  assert.equal((await reader()).status, "unknown");
});

test("missing preparation and unproven entry paths never become a current final evidence snapshot", async () => {
  for (const declared of [undefined, { ...preparation, targets: [{ ...preparation.targets[0]!, entryPaths: ["not-produced.exe"] }] }]) {
    const { f } = await setup(), platform = f.f.platform;
    const docs = await proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: null, documents: guides,
      ...(declared ? { preparation: declared } : {}) }, ctx(), platform);
    assert.equal(docs.status, "published");
    const result = (await packetTool().handler({ workstreamId: f.input.workstreamId, eventId: f.eventId, expectedBaseRevisionId: null },
      f.managerContext, platform) as any).data;
    assert.equal(result.status, "published");
    assert.equal((await createCurrentFinalEvidenceReader(W, platform)()).status, "unknown");
  }
});

test("current final reader rejects altered Artifact bytes instead of retaining an older successful snapshot", async () => {
  const { f } = await setup(), platform = f.f.platform;
  const docs = await proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: null, documents: guides, preparation }, ctx(), platform);
  assert.equal(docs.status, "published");
  const packet = (await packetTool().handler({ workstreamId: f.input.workstreamId, eventId: f.eventId, expectedBaseRevisionId: null },
    f.managerContext, platform) as any).data;
  assert.equal(packet.status, "published");
  const reader = createCurrentFinalEvidenceReader(W, platform);
  assert.equal((await reader()).status, "available");
  const artifacts = (platform as any).artifacts, original = artifacts.list;
  artifacts.list = async (input: any) => (await original(input)).map((row: any) => ({ ...row,
    data: { ...row.data, contentBase64: Buffer.from("changed artifact bytes").toString("base64") } }));
  assert.equal((await reader()).status, "unknown");
  assert.equal((await mainTool().handler({}, ctx(), platform) as any).data.status, "unknown");
});

test("Main attestation atomically queues the existing Review session, which can request but never approve", async () => {
  const reviewSession = "adadadad-adad-4dad-8dad-adadadadadad", reviewRun = "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae";
  const { f } = await setup(undefined, true, true, reviewSession), platform = f.f.platform, state = platform.state as RevisionState;
  const docs = await proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: null, documents: guides, preparation }, ctx(), platform);
  assert.equal(docs.status, "published");
  const handoff = (await packetTool().handler({ workstreamId: f.input.workstreamId, eventId: f.eventId, expectedBaseRevisionId: null },
    f.managerContext, platform) as any).data;
  const snapshot = await createCurrentFinalEvidenceReader(W, platform)();
  if (snapshot.status !== "available") throw new Error(JSON.stringify(snapshot));
  const wakes: any[] = [], original = state.guardedCompareAndSetWithJobWakeV1!;
  state.guardedCompareAndSetWithJobWakeV1 = async (target, expected, value, wake) => {
    const result = await original(target, expected, value, wake);
    if (result.status === "committed") wakes.push(wake);
    return result;
  };
  const attest = createBuilderPlatform().tools.find(tool => tool.name === "builder.attest-final-packet")!;
  const input = { eventId: "main-atomic-review-attestation", requestId: snapshot.value.packet.packetRevisionId, expectedBaseRevisionId: handoff.eventId };
  assert.equal((await attest.handler(input, ctx(), platform) as any).data.status, "attested");
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].jobKey, "builder.request-packet-user-review");
  assert.equal(wakes[0].eventId, input.eventId);
  const originalAgents = platform.agents.list;
  Object.assign(platform.agents, { async list(query: any) {
    const rows = await originalAgents(query);
    return [{ id: A, companyId: W, name: "Lead", status: "idle" }, ...rows.map(row => ({ ...row, name: "Manager" }))];
  } });
  platform.state.set = async (key, value) => { f.f.values.set(mapKey(key), structuredClone(value)); };
  const sessions = platform.agents.sessions as any, getRequest = sessions.getRequest, getRun = sessions.getRun;
  const requests = new Map<string, any>();
  let reviewSends = 0;
  sessions.getRequest = async (session: string, company: string, request: string) => session === reviewSession
    ? requests.get(request) ?? null : getRequest(session, company, request);
  let mainStatus = "running";
  sessions.getRun = async (session: string, company: string, run: string) => session === reviewSession || session === S
    ? { runId: run, status: session === S ? mainStatus : "running", cancellationRequested: false, termination: "not_applicable",
      error: null, errorCode: null, output: { state: "not_ready", text: null } } : getRun(session, company, run);
  sessions.sendMessage = async (session: string, company: string, options: any) => {
    assert.equal(session, reviewSession); assert.equal(company, W);
    assert.ok(options.executionPolicy.toolNames.includes("builder.request-final-review"));
    assert.ok(!options.executionPolicy.toolNames.includes("builder.attest-final-packet"));
    reviewSends++;
    requests.set(options.requestId, { requestId: options.requestId, state: "submitted", runId: reviewRun });
    return { runId: reviewRun };
  };
  const job = createBuilderPlatform().jobs!.find(job => job.jobKey === wakes[0].jobKey)!;
  const event = { jobKey: job.jobKey, eventId: input.eventId, companyId: W, trigger: "event", runId: "ffffffff-ffff-4fff-8fff-ffffffffffff" } as any;
  await assert.rejects(async () => job.handler(event, platform), /not completed successfully/u);
  mainStatus = "failed";
  await assert.rejects(async () => job.handler(event, platform), /not completed successfully/u);
  assert.equal(reviewSends, 0);
  mainStatus = "succeeded";
  const artifacts = (platform as any).artifacts, listArtifacts = artifacts.list;
  artifacts.list = async () => { throw new Error("temporary receipt read failure"); };
  await assert.rejects(async () => job.handler(event, platform), /unconfirmed|unavailable/u);
  assert.equal(reviewSends, 0);
  artifacts.list = listArtifacts;
  const leadKey = mapKey(key("lead-agent.v1")), initialLead = f.f.values.get(leadKey)!;
  const initialSessions = f.f.values.get(mapKey(key("lead-sessions.v1.1")))! as any;
  f.f.values.set(leadKey, { workspaceId: W, revision: 2, selectedAgentId: A });
  f.f.values.set(mapKey(key("lead-sessions.v1.2")), { ...initialSessions, selectionRevision: 2 });
  await job.handler(event, platform);
  assert.equal(reviewSends, 0, "a later Lead selection never receives the previous selection's review wake");
  f.f.values.set(leadKey, initialLead);
  f.f.values.delete(mapKey(key("lead-sessions.v1.2")));
  await job.handler(event, platform);
  await job.handler(event, platform);
  assert.equal(reviewSends, 1);
  const requestTool = createBuilderPlatform().tools.find(tool => tool.name === "builder.request-final-review")!;
  const result = (await requestTool.handler({ eventId: "registered-review-request", requestId: input.requestId,
    expectedBaseRevisionId: input.eventId, attestationEventId: input.eventId }, ctx(reviewSession, reviewRun), platform) as any).data;
  assert.equal(result.status, "published", JSON.stringify(result));
  const view = (await mainTool().handler({}, ctx(), platform) as any).data;
  assert.equal(view.approvalRequest.eventId, "registered-review-request");
  assert.equal(view.approvalEligibility.status, "blocked");
  assert.equal(view.decision, null);
});

test("Main publication rejects document races and cannot silently omit the Review wake", async t => {
  for (const mode of ["changed-document", "unsupported-wake"] as const) await t.test(mode, async () => {
    const { f } = await setup(), platform = f.f.platform, state = platform.state as RevisionState;
    const docs = await proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: null, documents: guides, preparation }, ctx(), platform);
    if (docs.status !== "published") throw new Error("Missing guides");
    const handoff = (await packetTool().handler({ workstreamId: f.input.workstreamId, eventId: f.eventId, expectedBaseRevisionId: null },
      f.managerContext, platform) as any).data;
    const snapshot = await createCurrentFinalEvidenceReader(W, platform)();
    if (snapshot.status !== "available") throw new Error("Missing snapshot");
    if (mode === "unsupported-wake") delete state.guardedCompareAndSetWithJobWakeV1;
    else {
      const original = state.guardedCompareAndSetWithJobWakeV1!;
      state.guardedCompareAndSetWithJobWakeV1 = async (target, expected, value, wake) => {
        const updated = await proposeDeliveryDocuments({ projectId: W, expectedBaseRevisionId: docs.revision.revisionId,
          documents: guides, preparation: { ...preparation, packageVersion: "2.0.0" } }, ctx(), platform);
        assert.equal(updated.status, "published");
        return original(target, expected, value, wake);
      };
    }
    const tool = createBuilderPlatform().tools.find(tool => tool.name === "builder.attest-final-packet")!;
    const result = (await tool.handler({ eventId: `main-guard-${mode}`, requestId: snapshot.value.packet.packetRevisionId,
      expectedBaseRevisionId: handoff.eventId }, ctx(), platform) as any).data;
    assert.equal(result.status, mode === "unsupported-wake" ? "unsupported" : "conflict", JSON.stringify(result));
    const [head] = (await createFinalPacketStore(W, W, platform.state).current()).revisions;
    assert.equal(head?.revision.eventId, handoff.eventId);
    assert.equal(head?.revision.kind, "manager-packet");
  });
});
