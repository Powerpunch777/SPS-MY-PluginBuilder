import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { build } from "esbuild";
import { G5_DIMENSIONS, produceG5ChangeImpactCandidates, type G5Dimension, type G5Snapshot } from "../src/domain/g5-change-impact.ts";
import type { ChangeImpactPanelProps, G5ChangeImpactReadDTO, G5ChangeImpactRequest } from "../src/ui/ChangeImpactPanel.tsx";

const projectRoot = path.resolve(import.meta.dirname, "..");
const projectId = "project-fixture";
const request: G5ChangeImpactRequest = {
  projectId, oldBaselineRevisionId: "baseline-old-r3", newBaselineRevisionId: "baseline-new-r4",
  oldUiRevisionId: "ui-old-r2", newUiRevisionId: "ui-new-r3",
};

// TEST_FIXTURE_ONLY: synthetic published-revision-shaped inputs for local UI tests; never supplied to production UI.
function resultFixture(): G5ChangeImpactReadDTO {
  const dimensions: Partial<Record<G5Dimension, Readonly<{ old: G5Snapshot; new: G5Snapshot }>>> = {};
  for (const dimension of G5_DIMENSIONS) {
    const oldRevisionId = dimension === "requirements" ? "spec-old-r3"
      : dimension === "graph" ? "graph-old-r3" : dimension === "ui" ? request.oldUiRevisionId
      : dimension === "ctoWorkstreams" ? "workstreams-old-r1" : `${dimension}-old-r1`;
    const newRevisionId = dimension === "requirements" ? "spec-new-r4"
      : dimension === "graph" ? "graph-new-r4" : dimension === "ui" ? request.newUiRevisionId
      : dimension === "ctoWorkstreams" ? "workstreams-new-r2" : `${dimension}-new-r2`;
    const oldRecords = dimension === "requirements" ? [{ id: "REQ-1", text: "old" }]
      : dimension === "ui" ? [{ id: "interaction-1", requirementRefs: ["REQ-1"] }] : [];
    const newRecords = dimension === "requirements" ? [{ id: "REQ-1", text: "new" }]
      : dimension === "ui" ? [{ id: "interaction-1", requirementRefs: ["REQ-1"] }] : [];
    dimensions[dimension] = {
      old: { projectId, revisionId: oldRevisionId, records: oldRecords },
      new: { projectId, revisionId: newRevisionId, records: newRecords },
    };
  }
  const derived = produceG5ChangeImpactCandidates({ projectId, dimensions });
  return {
    ...derived,
    dimensions: { ...derived.dimensions, scheduleProductScope: { status: "UNKNOWN", oldRevisionId: null, newRevisionId: null, candidates: [] } },
    approvalCreated: false, executionAuthorized: false, productExecutionAuthorized: false,
    sourcePins: { ...request,
      baselines: [
        { revisionId: request.oldBaselineRevisionId, sequence: 1, specRevisionId: "spec-old-r3", graphRevisionId: "graph-old-r3" },
        { revisionId: request.newBaselineRevisionId, sequence: 2, specRevisionId: "spec-new-r4", graphRevisionId: "graph-new-r4" },
      ],
      formalUi: [
        { revisionId: request.oldUiRevisionId, proposalRevisionId: "proposal-old", approvalRevisionId: "approval-old",
          contractRevisionId: "contract-old", htmlSha256: "a".repeat(64) },
        { revisionId: request.newUiRevisionId, proposalRevisionId: "proposal-new", approvalRevisionId: "approval-new",
          contractRevisionId: "contract-new", htmlSha256: "b".repeat(64) },
      ],
      technology: { oldRevisionId: "technology-old-r1", newRevisionId: "technology-new-r2" },
      workstreams: { oldRevisionId: "workstreams-old-r1", newRevisionId: "workstreams-new-r2" },
      tasks: { ctoId: "cto-1", workstreamId: "workstream-1", oldRevisionId: "tasks-old-r1", newRevisionId: "tasks-new-r2" } },
    inventoryLimits: { technology: "exact-pair-only",
      ctoWorkstreams: "workstream-board-only; CTO registry not loaded",
      tasks: "one-CTO-workstream-board-only",
      scheduleProductScope: "UNKNOWN; no authoritative source reader registered" },
  };
}

async function loadPanel() {
  const temporary = await mkdtemp(path.join(projectRoot, ".g5-change-impact-panel-test-"));
  const output = path.join(temporary, "ChangeImpactPanel.mjs");
  await build({ entryPoints: [path.join(projectRoot, "src/ui/ChangeImpactPanel.tsx")], outfile: output,
    bundle: true, external: ["react", "react/jsx-runtime"], platform: "node", format: "esm", jsx: "automatic" });
  const module = await import(pathToFileURL(output).href);
  return { Panel: module.ChangeImpactPanel as typeof import("../src/ui/ChangeImpactPanel.tsx").ChangeImpactPanel, temporary };
}

test("unconnected callback renders an explicit unavailable state and disables querying", async () => {
  const { Panel, temporary } = await loadPanel();
  try {
    const html = renderToStaticMarkup(createElement(Panel, { projectId } satisfies ChangeImpactPanelProps));
    assert.match(html, /신뢰된 서버 조회 callback이 연결되지 않아/u);
    assert.match(html, /<button type="submit" disabled="">영향 후보 조회/u);
    assert.match(html, /승인, 실행, 전체 영향 목록 또는 무영향 증명이 아닙니다/u);
    assert.doesNotMatch(html, /REQ-1|UNKNOWN · 자료 불완전/u);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("browser queries exact revisions and distinguishes candidate, no observed candidate, partial unknown and adapter errors", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "g5-change-impact-browser-"));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const bundle = await build({ stdin: { sourcefile: "change-impact-harness.tsx", resolveDir: projectRoot, contents: `
      import { createElement } from "react";
      import { createRoot } from "react-dom/client";
      import { ChangeImpactPanel } from "./src/ui/ChangeImpactPanel.tsx";
      window.requests = [];
      window.readImpact = async (request) => { window.requests.push(request);
        if (window.delayImpact) await new Promise(resolve => setTimeout(resolve, 120));
        if (window.rejectImpact) throw new Error("private adapter failure");
        return window.impactResponse; };
      window.mountImpact = (projectId, connected = true) => { const root = document.getElementById("root"); if (!root) return;
        createRoot(root).render(createElement(ChangeImpactPanel, { projectId, onQueryImpact: connected ? window.readImpact : undefined })); };
    ` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic" });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(5_000);
    await page.setContent("<body style='margin:0'><div style='width:min(700px, 100vw)'><div id='root'></div></div></body>");
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await page.evaluate(({ projectId, response }) => {
      const target = window as unknown as { mountImpact: (id: string, connected?: boolean) => void; impactResponse: unknown };
      target.impactResponse = response; target.mountImpact(projectId, false);
    }, { projectId, response: resultFixture() });
    assert.match(await page.locator("body").innerText(), /조회 callback이 연결되지 않아/u);
    assert.equal(await page.getByRole("button", { name: "영향 후보 조회" }).isDisabled(), true);

    await page.evaluate(({ projectId, response }) => {
      const target = window as unknown as { mountImpact: (id: string) => void; impactResponse: unknown };
      target.impactResponse = response; target.mountImpact(projectId);
    }, { projectId, response: resultFixture() });
    await page.getByLabel("이전 Baseline Revision ID").fill(request.oldBaselineRevisionId);
    await page.getByLabel("신규 Baseline Revision ID").fill(request.newBaselineRevisionId);
    await page.getByLabel("이전 승인 UI Revision ID").fill(request.oldUiRevisionId);
    await page.getByLabel("신규 승인 UI Revision ID").fill(request.newUiRevisionId);
    await page.evaluate(() => { (window as unknown as { delayImpact: boolean }).delayImpact = true; });
    await page.getByRole("button", { name: "영향 후보 조회" }).click();
    await page.getByText("정확한 게시 Revision source를 조회하고 있습니다.", { exact: true }).waitFor();
    assert.match(await page.getByRole("status").innerText(), /Revision source를 조회하고 있습니다/u);
    const results = page.locator(".sps-g5-results");
    await page.getByText("후보 발견", { exact: true }).first().waitFor();
    assert.match(await results.innerText(), /후보 발견/u);
    assert.match(await results.innerText(), /관찰 후보 없음/u);
    assert.match(await results.innerText(), /REQ-1/u);
    assert.match(await results.innerText(), /참조 연결 후보 · 근거 경로: REQ-1/u);
    assert.match(await page.getByRole("region", { name: "조회 source 및 범위 한계" }).innerText(), /일정·상품 범위: UNKNOWN/u);
    assert.match(await page.locator("body").innerText(), /승인이나 실행 권한을 만들지 않습니다/u);
    assert.deepEqual(await page.evaluate(() => (window as unknown as { requests: unknown[] }).requests), [request]);
    assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await page.locator(".sps-g5-impact").evaluate(element => element.clientWidth), 700);
    assert.equal(await page.locator(".sps-g5-impact").evaluate(element => element.scrollWidth <= element.clientWidth), true);

    const mutable = (dto: G5ChangeImpactReadDTO) => dto as unknown as {
      dimensions: Record<string, { status: string; oldRevisionId: string | null; newRevisionId: string | null; candidates: readonly unknown[] }>;
      sourcePins: { formalUi: Array<{ revisionId: string }> };
    };
    const unknownWithCandidate = resultFixture();
    mutable(unknownWithCandidate).dimensions.requirements = { ...unknownWithCandidate.dimensions.requirements,
      status: "UNKNOWN" };
    await page.evaluate(response => {
      const target = window as unknown as { impactResponse: unknown; delayImpact: boolean };
      target.impactResponse = response; target.delayImpact = false;
    }, unknownWithCandidate);
    await page.getByRole("button", { name: "영향 후보 조회" }).click();
    await page.getByText("UNKNOWN · 자료 불완전", { exact: true }).first().waitFor();
    assert.match(await results.innerText(), /UNKNOWN · 자료 불완전/u);
    assert.match(await results.innerText(), /REQ-1/u);

    const malformedResponses: unknown[] = [];
    const wrongProject = resultFixture();
    (wrongProject as unknown as { projectId: string }).projectId = "another-project";
    malformedResponses.push(wrongProject);
    const mismatchedBaselineSource = resultFixture();
    (mutable(mismatchedBaselineSource).sourcePins as unknown as { baselines: Array<{ revisionId: string }> })
      .baselines[0]!.revisionId = "other-baseline";
    malformedResponses.push(mismatchedBaselineSource);
    const mismatchedSpec = resultFixture();
    mutable(mismatchedSpec).dimensions.requirements = { ...mutable(mismatchedSpec).dimensions.requirements, oldRevisionId: "other-spec" };
    malformedResponses.push(mismatchedSpec);
    const mismatchedGraph = resultFixture();
    mutable(mismatchedGraph).dimensions.graph = { ...mutable(mismatchedGraph).dimensions.graph, newRevisionId: "other-graph" };
    malformedResponses.push(mismatchedGraph);
    const mismatchedUi = resultFixture();
    mutable(mismatchedUi).sourcePins.formalUi[1].revisionId = "other-ui";
    malformedResponses.push(mismatchedUi);
    const unapprovedUi = resultFixture();
    (mutable(unapprovedUi).sourcePins.formalUi[0] as unknown as { approvalRevisionId: string | null }).approvalRevisionId = null;
    malformedResponses.push(unapprovedUi);
    const mismatchedTechnologyPin = resultFixture();
    (mutable(mismatchedTechnologyPin).sourcePins as unknown as { technology: { oldRevisionId: string; newRevisionId: string } })
      .technology.newRevisionId = "other-technology";
    malformedResponses.push(mismatchedTechnologyPin);
    const mismatchedOptionalPair = resultFixture();
    mutable(mismatchedOptionalPair).dimensions.technology = { ...mutable(mismatchedOptionalPair).dimensions.technology, oldRevisionId: "other-technology" };
    malformedResponses.push(mismatchedOptionalPair);
    const inventedSchedulePair = resultFixture();
    mutable(inventedSchedulePair).dimensions.scheduleProductScope = { status: "UNKNOWN", oldRevisionId: "unregistered-old",
      newRevisionId: "unregistered-new", candidates: [] };
    malformedResponses.push(inventedSchedulePair);
    const emptyCandidates = resultFixture();
    mutable(emptyCandidates).dimensions.requirements = { ...mutable(emptyCandidates).dimensions.requirements, status: "CANDIDATES", candidates: [] };
    malformedResponses.push(emptyCandidates);
    const contradictoryNoCandidate = resultFixture();
    mutable(contradictoryNoCandidate).dimensions.requirements = { ...mutable(contradictoryNoCandidate).dimensions.requirements,
      status: "NO_CANDIDATE_OBSERVED", candidates: [{ dimension: "requirements", recordId: "REQ-1", basis: "direct-revision-diff", via: ["REQ-1"] }] };
    malformedResponses.push(contradictoryNoCandidate);
    for (const response of malformedResponses) {
      await page.evaluate(value => {
        const target = window as unknown as { impactResponse: unknown; delayImpact: boolean };
        target.impactResponse = value; target.delayImpact = false;
      }, response);
      await page.getByRole("button", { name: "영향 후보 조회" }).click();
      await page.getByRole("alert").waitFor();
      assert.equal(await page.locator(".sps-g5-results").count(), 0);
    }
    await page.evaluate(() => { (window as unknown as { rejectImpact: boolean }).rejectImpact = true; });
    await page.getByRole("button", { name: "영향 후보 조회" }).click();
    await page.getByRole("alert").waitFor();
    assert.match(await page.getByRole("alert").innerText(), /결과를 추정하지 않았습니다/u);
    assert.equal(await page.locator(".sps-g5-results").count(), 0);
  } finally {
    await browser?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
