import assert from "node:assert/strict";
import test from "node:test";
import {
  PRODUCT_CATALOG,
  handoffProductSelectionDraft,
  parseProductSelectionDraft,
  projectSelectionForApprovedSpecConsumer,
} from "../src/product-selection/index.ts";

const expected = { workspaceId: "workspace-1", projectId: "project-1" };
const base = {
  ...expected,
  sourceContext: { sourceIds: ["consult-1"], revisionRefs: ["baseline-r2"] },
  productId: "S01",
  productTier: "S",
  route: "FAST",
  deliveryTargets: ["sps-plugin"],
  deliveredProductUsesAI: true,
};

test("seeded official catalog is exact and stable", () => {
  assert.deepEqual(PRODUCT_CATALOG.products.map(({ id, name }) => [id, name]), [
    ["S01", "반복 업무 자동화"], ["S02", "개인 AI 비서 구축"], ["S03", "서비스 연동 자동화"], ["S04", "AI Agent 맞춤 제작"],
    ["M01", "1인 게임 개발"], ["M02", "AI 소프트웨어 개발"], ["M03", "1인 기업 운영"], ["M04", "콘텐츠 제작"], ["M05", "연구·전문업무"],
    ["L01", "팀 개발"], ["L02", "게임 개발팀"], ["L03", "팀 업무·협업"], ["L04", "AI Agent 협업 워크스테이션"],
    ["XL01", "기업 통합 업무"], ["XL02", "기업 AI 운영"], ["XL03", "산업별 특화 워크스테이션"],
  ]);
  assert.deepEqual(Object.fromEntries(["S", "M", "L", "XL"].map(tier => [tier, PRODUCT_CATALOG.products.filter(p => p.tier === tier).length])),
    { S: 4, M: 5, L: 4, XL: 3 });
  assert.deepEqual(PRODUCT_CATALOG.addOns.map(({ id, name }) => [id, name]), [
    ["A01", "컨설팅"], ["A02", "기능 추가"], ["A03", "외부 프로그램 연동"], ["A04", "이전·업그레이드"], ["A05", "유지보수"],
  ]);
  assert.equal(PRODUCT_CATALOG.products[0].id, "S01");
  assert.equal(PRODUCT_CATALOG.source.sha256, "7fd759a1c9f66e8145283ff804f149005eed842b6889d5dec69ee47f56444266");
});

test("product membership validates tier only; each tier can use each route", () => {
  for (const product of PRODUCT_CATALOG.products) {
    for (const route of ["FAST", "ASSEMBLY", "CUSTOM"]) {
      const result = parseProductSelectionDraft({ ...base, productId: product.id, productTier: product.tier, route }, expected);
      assert.equal(result.status, "complete", `${product.id}/${route}`);
    }
  }
  assert.equal(parseProductSelectionDraft({ ...base, productTier: "M" }, expected).status, "invalid");
});

test("unknown and wrong-axis IDs are invalid", () => {
  assert.equal(parseProductSelectionDraft({ ...base, productId: "missing" }, expected).status, "invalid");
  assert.equal(parseProductSelectionDraft({ ...base, productId: "A01" }, expected).status, "invalid");
  assert.equal(parseProductSelectionDraft({ ...base, addOnIds: ["S01"] }, expected).status, "invalid");
  assert.equal(parseProductSelectionDraft({ ...base, addOnIds: ["A99"] }, expected).status, "invalid");
});

test("targets and AI use are independent, including non-SPS and AI-free products", () => {
  for (const target of ["sps-plugin", "desktop", "web-api", "cli-automation", "agent-workflow", "hybrid"]) {
    const result = parseProductSelectionDraft({ ...base, productId: "S03", deliveryTargets: [target], deliveredProductUsesAI: false }, expected);
    assert.equal(result.status, "complete");
    assert.equal(result.draft?.deliveredProductUsesAI, false);
    assert.deepEqual(result.draft?.deliveryTargets, [target]);
  }
  const spsWithoutAI = parseProductSelectionDraft({ ...base, deliveryTargets: ["sps-plugin"], deliveredProductUsesAI: false }, expected);
  assert.equal(spsWithoutAI.status, "complete");
  assert.equal(spsWithoutAI.draft?.deliveredProductUsesAI, false);
  const nonSpsWithAI = parseProductSelectionDraft({ ...base, deliveryTargets: ["web-api"], deliveredProductUsesAI: true }, expected);
  assert.equal(nonSpsWithAI.status, "complete");
  assert.equal(nonSpsWithAI.draft?.deliveredProductUsesAI, true);
  assert.equal(parseProductSelectionDraft({ ...base, deliveryTargets: ["not-a-target"] }, expected).status, "invalid");
});

test("omitted choices stay unresolved, while valid unresolved drafts remain distinct from invalid", () => {
  const result = parseProductSelectionDraft({ ...expected, sourceContext: { sourceIds: [], revisionRefs: [] } }, expected);
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.missing, ["productId", "productTier", "route", "deliveryTargets", "deliveredProductUsesAI"]);
  assert.equal(result.draft?.productId, null);
  assert.equal(result.draft?.productTier, null);
  assert.equal(projectSelectionForApprovedSpecConsumer(result.draft!), null);
  assert.equal(parseProductSelectionDraft({ ...base, productId: "unknown" }, expected).status, "invalid");
});

test("reported source and revision references propagate without approval", () => {
  const result = parseProductSelectionDraft({ ...base, addOnIds: ["A01", "A03"] }, expected);
  assert.equal(result.status, "complete");
  assert.deepEqual(result.draft?.sourceContext.sourceIds, ["consult-1"]);
  assert.deepEqual(result.draft?.sourceContext.revisionRefs, ["baseline-r2"]);
  assert.equal(result.draft?.sourceContext.verification, "reported-unverified");
  assert.equal(result.draft?.approval, "not-approved");
  assert.deepEqual(projectSelectionForApprovedSpecConsumer(result.draft!), { productTier: "S", targets: ["sps-plugin"] });
});

test("consumer projection rejects drafts missing any required selection axis", () => {
  const complete = parseProductSelectionDraft(base, expected).draft!;
  const incompleteDrafts = [
    { ...complete, productId: null },
    { ...complete, productTier: null },
    { ...complete, route: null },
    { ...complete, deliveryTargets: [] },
    { ...complete, deliveredProductUsesAI: null },
  ];
  for (const draft of incompleteDrafts) assert.equal(projectSelectionForApprovedSpecConsumer(draft), null);
});

test("consumer projection rejects malformed or forged drafts", () => {
  const complete = parseProductSelectionDraft(base, expected).draft!;
  assert.equal(projectSelectionForApprovedSpecConsumer(null), null);
  assert.equal(projectSelectionForApprovedSpecConsumer({ ...complete, status: "complete" }), null);
  assert.equal(projectSelectionForApprovedSpecConsumer({ ...complete, approval: "approved" }), null);
  assert.equal(projectSelectionForApprovedSpecConsumer({ ...complete, productTier: "M" }), null);
  assert.equal(projectSelectionForApprovedSpecConsumer({ ...complete, route: "UNSUPPORTED" }), null);
  assert.equal(projectSelectionForApprovedSpecConsumer({ ...complete, deliveryTargets: ["unknown"] }), null);
  assert.equal(projectSelectionForApprovedSpecConsumer({ ...complete, unexpected: true }), null);
  const accessorDraft = Object.defineProperty({ ...complete }, "productTier", { enumerable: true, get: () => "S" });
  assert.equal(projectSelectionForApprovedSpecConsumer(accessorDraft), null);
  const hostileDraft = new Proxy(complete, { ownKeys() { throw new Error("uninspectable"); } });
  assert.equal(projectSelectionForApprovedSpecConsumer(hostileDraft), null);
});

test("complete consumer projection remains a non-approval field mapping", () => {
  const complete = parseProductSelectionDraft(base, expected).draft!;
  assert.deepEqual(projectSelectionForApprovedSpecConsumer(complete), { productTier: "S", targets: ["sps-plugin"] });
  assert.equal(complete.approval, "not-approved");
});

test("malformed shapes, values, duplicates and project substitutions are rejected", () => {
  assert.equal(parseProductSelectionDraft({ ...base, surprise: true }, expected).status, "invalid");
  assert.equal(parseProductSelectionDraft({ ...base, deliveryTargets: ["web-api", "web-api"] }, expected).status, "invalid");
  assert.equal(parseProductSelectionDraft({ ...base, addOnIds: ["A01", "A01"] }, expected).status, "invalid");
  assert.equal(parseProductSelectionDraft({ ...base, deliveredProductUsesAI: "unknown" }, expected).status, "invalid");
  const accessorSource = ["source-1"];
  Object.defineProperty(accessorSource, "0", { enumerable: true, get: () => "source-1" });
  assert.equal(parseProductSelectionDraft({ ...base, sourceContext: { sourceIds: accessorSource, revisionRefs: [] } }, expected).status, "invalid");
  const hostileDraft = new Proxy(base, { ownKeys() { throw new Error("uninspectable"); } });
  assert.equal(parseProductSelectionDraft(hostileDraft, expected).status, "invalid");
  assert.equal(parseProductSelectionDraft({ ...base, workspaceId: "workspace-2" }, expected).status, "invalid");
  assert.equal(parseProductSelectionDraft({ ...base, projectId: "project-2" }, expected).status, "invalid");
  assert.equal(parseProductSelectionDraft({ ...base, productTier: "not-tier" }, expected).status, "invalid");
});

test("selection is only a draft and never returns authorization or analysis status", () => {
  const result = parseProductSelectionDraft(base, expected);
  assert.equal(result.status, "complete");
  assert.equal(result.draft?.status, "draft");
  assert.equal("authorized" in result.draft!, false);
  assert.equal("analysisStarted" in result.draft!, false);
});

test("injected storage handoff writes only parser-approved project-bound drafts", async () => {
  const writes: unknown[] = [];
  const writer = { async writeDraft(value: unknown) { writes.push(value); return { stored: true }; } };
  const ok = await handoffProductSelectionDraft(base, expected, writer);
  assert.equal(ok.storage, "writer-called");
  assert.equal(writes.length, 1);
  const rejected = await handoffProductSelectionDraft({ ...base, projectId: "other-project" }, expected, writer);
  assert.equal(rejected.storage, "not-written");
  assert.equal(writes.length, 1);
});
