import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { build } from "esbuild";
import type { IntegrationReviewDTO, IntegrationReviewPanelProps, IntegrationReviewSnapshotDTO } from "../src/ui/IntegrationReviewPanel.tsx";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sha = "a".repeat(64);
const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const reviewSessionId = "66666666-6666-4666-8666-666666666666";
const runId = "44444444-4444-4444-8444-444444444444";
const reviewRunId = "77777777-7777-4777-8777-777777777777";

// TEST_FIXTURE_ONLY: synthetic data for renderer/action-gating tests; never connected to Builder production UI.
function fixture(eligible: "eligible" | "blocked" | "unknown" = "eligible"): Extract<IntegrationReviewDTO, { status: "ready" }> {
  const pin = (sourceId: string, revisionId: string) => ({ sourceId, revisionId, sha256: sha });
  const packet = {
    packetId: "packet-fixture", packetRevisionId: "packet-rev-fixture", packetSha256: sha,
    baseline: pin("baseline", "base-r7"), uiRevision: pin("ui", "ui-r4"), manifest: pin("manifest", "manifest-r3"),
    integration: { branch: "release/fixture", commitSha: "abc123fixture", build: pin("build", "build-r2"),
      ciEvidence: [pin("ci", "ci-r9")], e2eEvidence: [pin("e2e", "e2e-r2")] },
    files: [{ path: "dist/plugin.mjs", classification: "plugin", size: 2048, sha256: sha }],
    documents: [{ kind: "installation-guide" as const, pin: pin("install", "doc-r2") },
      { kind: "user-guide" as const, pin: pin("usage", "doc-r5") }],
    qaEvidence: [pin("qa", "qa-r2")], g6Evidence: [pin("g6", "g6-r1")], g7Evidence: [pin("g7", "g7-r1")],
    limits: ["Synthetic test fixture only; no real Host runtime evidence."], changeHistory: [pin("change", "history-r1")],
  };
  const mainAttestation = { eventId: "main-attestation-fixture", expectedBaseRevisionId: null,
    kind: "main-attestation" as const, requestId: "packet-rev-fixture", request: null, decision: null,
    attestation: { packet, snapshotSha256: sha, currentPinsSha256: sha, attestedAt: "2026-11-06T00:00:00.000Z",
      mainLeadAgentId: agentId, mainLeadSelectionRevision: 4, mainLeadRunId: runId, mainLeadSessionId: sessionId } };
  const request = { eventId: "request-event-fixture", expectedBaseRevisionId: "main-attestation-fixture",
    kind: "approval-request" as const, requestId: "packet-rev-fixture", attestation: null, decision: null,
    request: { packet, snapshotSha256: sha, currentPinsSha256: sha, requestedAt: "2026-11-06T00:00:00.000Z",
      attestationEventId: "main-attestation-fixture", mainLeadAgentId: agentId, mainLeadSelectionRevision: 4, mainLeadRunId: runId, mainLeadSessionId: sessionId,
      integrationReviewAgentId: agentId, integrationReviewRunId: reviewRunId, integrationReviewSessionId: reviewSessionId } };
  const snapshot: IntegrationReviewSnapshotDTO = {
    workspaceId, projectId: workspaceId, packet,
    integrationCodeAuthority: "verified", hostRuntimeAuthority: "verified",
    g6: "PASS", g7: "PASS", qa: "PASS", currentPinsSha256: sha };
  return { status: "ready", snapshot, mainAttestation, approvalRequest: request, decision: null,
    mainReceipt: { verification: "verified", workspaceId, agentId, sessionId, runId },
    integrationReviewReceipt: { verification: "verified", workspaceId, agentId, sessionId: reviewSessionId, runId: reviewRunId },
    approvalEligibility: { status: eligible, ...(eligible === "eligible" ? {} : { reason: "fixture gate is not eligible" }) },
    history: [{ eventId: "request-event-fixture", kind: "approval-request" as const, requestId: "packet-rev-fixture", decision: null }] };
}

async function loadPanel() {
  const temporary = await mkdtemp(path.join(projectRoot, "node_modules", ".ui-integration-review-test-"));
  const output = path.join(temporary, "IntegrationReviewPanel.mjs");
  await build({ entryPoints: [path.join(projectRoot, "src/ui/IntegrationReviewPanel.tsx")], outfile: output,
    bundle: true, external: ["react", "react/jsx-runtime"], platform: "node", format: "esm", jsx: "automatic" });
  const module = await import(pathToFileURL(output).href);
  return { Panel: module.IntegrationReviewPanel as typeof import("../src/ui/IntegrationReviewPanel.tsx").IntegrationReviewPanel,
    parseDTO: module.parseIntegrationReviewDTO as typeof import("../src/ui/IntegrationReviewPanel.tsx").parseIntegrationReviewDTO, temporary };
}

test("loading, missing authority, errors and empty state never reveal sample evidence or active actions", async () => {
  const { Panel, temporary } = await loadPanel();
  try {
    for (const view of [{ status: "loading" }, { status: "unknown", reason: "no authority" }, { status: "empty" }] as const) {
      const markup = renderToStaticMarkup(createElement(Panel, { view } as IntegrationReviewPanelProps));
      assert.match(markup, /최종 검토 자료|자료 또는 권위|현재 게시된/);
      assert.doesNotMatch(markup, /packet-fixture|release\/fixture|dist\/plugin\.mjs|<button[^>]*>최종 검토 승인/u);
    }
    const failed = renderToStaticMarkup(createElement(Panel, { view: fixture(), error: "internal adapter detail" }));
    assert.match(failed, /role="alert"/u);
    assert.doesNotMatch(failed, /packet-fixture|internal adapter detail/u);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("renders exact pins, files, guides, gates, limits and history as escaped read-only evidence", async () => {
  const { Panel, temporary } = await loadPanel();
  try {
    const html = renderToStaticMarkup(createElement(Panel, { view: fixture() }));
    assert.match(html, /packet-rev-fixture/u);
    assert.match(html, /release\/fixture/u);
    assert.match(html, /dist\/plugin\.mjs/u);
    assert.match(html, /install-r2|설치법/u);
    assert.match(html, /사용법/u);
    assert.match(html, /SHA-256/u);
    assert.match(html, /QA: PASS/u);
    assert.match(html, /Synthetic test fixture only/u);
    assert.match(html, /본문 확인은 unavailable/u);
    assert.match(html, /실제 고객 전달·배포와 별개/u);
    assert.match(html, /<button[^>]*disabled=""[^>]*>수정 요청/u);
    assert.match(html, /<button[^>]*disabled=""[^>]*>보류/u);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("read DTO rejects binary payloads and shows older decisions only as history", async () => {
  const { Panel, parseDTO, temporary } = await loadPanel();
  try {
  const read = parseDTO(fixture());
  assert.equal(read.status, "ready");
  if (read.status !== "ready") return;
  assert.equal("commitObjectBytes" in read.snapshot, false);
  assert.equal("fileBytes" in read.snapshot, false);
  const withBinary = { ...fixture(), snapshot: { ...fixture().snapshot, commitObjectBytes: [1, 2, 3] } };
  assert.deepEqual(parseDTO(withBinary), { status: "unknown", reason: "Final Review read data is incomplete or malformed." });
  const current = { ...fixture("blocked"), approvalRequest: null, mainAttestation: null, mainReceipt: null,
    integrationReviewReceipt: null, history: [{ eventId: "older-event", kind: "user-decision" as const,
      requestId: "another-packet", decision: { action: "approve" as const, userId: "approver-fixture", reason: null,
        decidedAt: "2026-11-05T00:00:00.000Z", sourceSnapshotSha256: sha } }] };
  const parsed = parseDTO(current);
  assert.equal(parsed.status, "ready");
  if (parsed.status !== "ready") throw new Error("Expected packet history.");
  assert.deepEqual(parsed.history, current.history);
  const html = renderToStaticMarkup(createElement(Panel, { view: parsed, onApprove() {} }));
  assert.match(html, /another-packet.*older-event.*approver-fixture.*2026-11-05/u);
  assert.doesNotMatch(html, /결정 기록: approve/u);
  assert.match(html, /type="button" disabled="">최종 검토 승인/u);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("approval needs eligibility, matching verified Main receipt and a connected callback", async () => {
  const { Panel, temporary } = await loadPanel();
  try {
    const render = (view: IntegrationReviewDTO, callbacks: Partial<IntegrationReviewPanelProps> = {}) =>
      renderToStaticMarkup(createElement(Panel, { view, ...callbacks }));
    const active = render(fixture(), { onApprove() {}, onRequestChanges() {}, onHold() {} });
    assert.match(active, /<button class="sps-ir-button is-primary" type="button">최종 검토 승인/u);
    assert.match(render(fixture()), /<button class="sps-ir-button is-primary" type="button" disabled="">최종 검토 승인/u);
    assert.match(render(fixture("unknown"), { onApprove() {} }), /<button class="sps-ir-button is-primary" type="button" disabled="">최종 검토 승인/u);
    const validView = fixture();
    const invalidReceipt = { ...validView, mainReceipt: { ...validView.mainReceipt!, runId: "different-run" } };
    assert.match(render(invalidReceipt, { onApprove() {} }), /정확한 Workspace·Agent·Session·Run receipt/u);
    const missingReviewReceipt = { ...validView, integrationReviewReceipt: null };
    assert.match(render(missingReviewReceipt, { onApprove() {} }), /정확한 Workspace·Agent·Session·Run receipt/u);
    const decided = { ...fixture(), decision: { eventId: "decision-1", expectedBaseRevisionId: "packet-rev-fixture", kind: "user-decision" as const,
      attestation: null,
      requestId: "packet-rev-fixture", request: null,
      decision: { action: "hold" as const, userId: "user-1", reason: "review", decidedAt: "2026-11-06T00:00:00.000Z", sourceSnapshotSha256: null } } };
    assert.match(render(decided, { onApprove() {}, onRequestChanges() {}, onHold() {} }), /disabled=""/u);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("browser keeps approve, request-changes and hold as distinct callbacks", async () => {
  const temporary = await mkdtemp(path.join(projectRoot, "node_modules", ".ui-integration-review-browser-"));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const bundle = await build({ stdin: { sourcefile: "review-harness.tsx", resolveDir: projectRoot, contents: `
      import { createElement } from "react";
      import { createRoot } from "react-dom/client";
      import { IntegrationReviewPanel } from "./src/ui/IntegrationReviewPanel.tsx";
      window.decisions = [];
      window.mountReview = (view) => { const rootElement = document.getElementById("root"); if (!rootElement) return;
        createRoot(rootElement).render(createElement(IntegrationReviewPanel, {
        view: view,
        onApprove: () => { window.decisions.push({ action: "approve" }); },
        onRequestChanges: (reason) => { window.decisions.push({ action: "request-changes", reason }); },
        onHold: (reason) => { window.decisions.push({ action: "hold", reason }); },
      })); };
    ` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic" });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent("<div id='root'></div>");
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await page.evaluate(view => (window as unknown as { mountReview: (value: unknown) => void }).mountReview(view), fixture());
    await page.getByRole("button", { name: "최종 검토 승인" }).click();
    await page.getByLabel("수정 요청 또는 보류 사유").fill("설치 안내를 갱신하세요");
    await page.getByRole("button", { name: "수정 요청" }).click();
    await page.getByLabel("수정 요청 또는 보류 사유").fill("외부 확인 대기");
    await page.getByRole("button", { name: "보류" }).click();
    assert.deepEqual(await page.evaluate(() => (window as unknown as { decisions: unknown[] }).decisions), [
      { action: "approve" }, { action: "request-changes", reason: "설치 안내를 갱신하세요" }, { action: "hold", reason: "외부 확인 대기" },
    ]);
    assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= innerWidth), true);
    assert.match(await page.locator("body").innerText(), /실제 고객 전달·배포와 별개/u);
  } finally {
    await browser?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
