import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

// Development UI only. No SPS account, Host, Runner or AI is connected here.
const origin = "http://127.0.0.1:4174";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  await mkdir(path.resolve("artifacts/screenshots"), { recursive: true });
  for (const [name, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(origin);
      await page.getByRole("heading", { level: 1, name: "Lead 대화", exact: true }).waitFor();
      assert.equal(await page.getByRole("textbox", { name: "Lead에게 메시지" }).isDisabled(), true);
      const bounds = await page.locator(".builder-composer").boundingBox();
      assert.ok(bounds && bounds.y + bounds.height <= height + 1, "Composer must remain inside the viewport.");
      for (const label of ["설계 시각화", "조직도", "설계 문서", "미결정사항", "시스템", "Lead 대화"]) {
        await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: label, exact: true }).click();
        await page.getByRole("heading", { level: 1, name: label, exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      }
      await page.getByRole("button", { name: "상담 텍스트 가져오기", exact: true }).click();
      await page.getByRole("textbox", { name: "상담 텍스트", exact: true }).fill("브라우저 검증용 상담 원문");
      await page.getByRole("button", { name: "저장된 입력으로 전달", exact: true }).click();
      await page.getByText("브라우저 검증용 상담 원문", { exact: true }).waitFor();
      await page.getByRole("button", { name: "상담 텍스트 가져오기", exact: true }).click();
      await page.getByRole("button", { name: "작업 기록 열기", exact: true }).click();
      if (name === "mobile") {
        await page.getByRole("complementary", { name: "최근 작업 기록" }).waitFor({ state: "visible" });
        await page.getByRole("button", { name: "작업 기록 닫기", exact: true }).last().click();
      } else {
        await page.getByRole("button", { name: "사이드바 접기", exact: true }).click();
        await page.getByRole("button", { name: "사이드바 펼치기", exact: true }).click();
      }
      await page.screenshot({ path: path.resolve(`artifacts/screenshots/builder-${name}.png`) });
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ builderUi: name, views: 6, selectedTextImport: true,
        composerVisible: true, noOverflow: true, coreHostTested: false, realAi: false }));
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
