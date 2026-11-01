import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

// Development UI only. No SPS account, Host, Runner or AI is connected here.
const origin = process.env.BUILDER_SMOKE_ORIGIN ?? "http://127.0.0.1:4174";
const launchOptions = { headless: true };
if (process.env.BUILDER_SMOKE_BROWSER !== "chromium") launchOptions.channel = "chrome";
let browser;
let interrupted;
const closeOnSignal = signal => {
  interrupted = signal;
  void browser?.close();
};
process.once("SIGINT", closeOnSignal);
process.once("SIGTERM", closeOnSignal);
try {
  browser = await chromium.launch(launchOptions);
  if (interrupted) throw new Error(`Interrupted by ${interrupted}.`);
  await mkdir(path.resolve("artifacts/screenshots"), { recursive: true });
  for (const [name, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.addInitScript(() => {
        const read = File.prototype.arrayBuffer;
        const pending = new Map();
        Object.defineProperty(window, "__builderFileReadTest", { value: {
          pending,
          async release(name) {
            const finish = pending.get(name);
            if (!finish) throw new Error(`No pending test read for ${name}.`);
            await finish();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          },
        } });
        File.prototype.arrayBuffer = function () {
          if (!this.name.startsWith("pending-")) return read.call(this);
          return new Promise((resolve, reject) => pending.set(this.name, async () => {
            try { resolve(await read.call(this)); } catch (error) { reject(error); }
          }));
        };
      });
      await page.goto(origin);
      await page.getByRole("heading", { level: 1, name: "Lead와 대화", exact: true }).waitFor();
      assert.equal(await page.locator('.builder-view-header').count(), 0);
      const palette = await page.locator('.builder-shell').evaluate(element => ({
        background: getComputedStyle(element).backgroundColor, colorScheme: getComputedStyle(element).colorScheme,
        font: getComputedStyle(element).fontFamily,
      }));
      assert.equal(palette.background, 'rgb(24, 24, 24)');
      assert.equal(palette.colorScheme, 'dark');
      assert.ok(palette.font.includes('Pretendard'));
      if (width > 790) {
        assert.equal(Math.round((await page.locator('.builder-sidebar').boundingBox()).width), 240);
        assert.equal(Math.round((await page.locator('.builder-activity-rail').boundingBox()).width), 384);
      } else await page.getByRole('button', { name: '작업 기록 열기', exact: true }).click();
      const rail = page.getByRole('complementary', { name: 'AI 작업 기록', exact: true });
      for (const label of ['수정사항', '작업 지시', '작업 파일']) assert.equal(await rail.getByRole('tab', {name:label,exact:true}).isDisabled(), true);
      await rail.getByRole('tab', {name:'기록',exact:true}).focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await rail.getByRole('tab', {name:'설계',exact:true}).getAttribute('aria-selected'), 'true');
      await page.keyboard.press('Home');
      assert.equal(await rail.getByRole('tab', {name:'기록',exact:true}).getAttribute('aria-selected'), 'true');
      if (width <= 790) await rail.getByRole('button', {name:'작업 기록 닫기',exact:true}).click();
      await page.getByRole('button', { name:'프로필 메뉴',exact:true }).click();
      assert.equal(await page.getByRole('button', {name:'SPS Core 설정 열기',exact:true}).isDisabled(), true);
      await page.getByRole('button', {name:'프로필 메뉴',exact:true}).press('Escape');
      assert.equal(await page.getByRole('button', {name:'프로필 메뉴',exact:true}).getAttribute('aria-expanded'), 'false');
      assert.equal(await page.getByRole("textbox", { name: "Lead에게 메시지" }).isDisabled(), true);
      const bounds = await page.locator(".builder-composer").boundingBox();
      assert.ok(bounds && bounds.y + bounds.height <= height + 1, "Composer must remain inside the viewport.");
      for (const label of ["설계 시각화", "조직도", "설계 문서", "미결정사항", "시스템", "Lead 대화"]) {
        await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: label, exact: true }).click();
        await page.getByRole("heading", { level: 1, name: label === 'Lead 대화' ? 'Lead와 대화' : label, exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      }
      await page.goto(`${origin}?fixture=graph`);
      await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "설계 시각화", exact: true }).click();
      const detail = page.getByRole('complementary', { name: '선택한 설계 노드 정보', exact: true });
      assert.equal(await page.getByRole('complementary', { name: 'AI 작업 기록', exact: true }).count(), 0);
      await detail.getByRole('heading', { name: 'Fixture Feature', exact: true }).waitFor();
      await detail.getByText('Fixture CTO', { exact: true }).waitFor();
      await detail.getByText('실행 중', { exact: true }).waitFor();
      await detail.getByRole('list', { name: '연결된 설계 노드', exact: true }).getByText('Fixture Component', { exact: true }).waitFor();
      const component = page.locator('.react-flow__node[data-id="fixture-component"]');
      await component.focus();
      await component.press('Enter');
      await detail.getByRole('heading', { name: 'Fixture Component', exact: true }).waitFor();
      await detail.getByText('차단', { exact: true }).waitFor();
      await detail.getByText('담당자 없음', { exact: true }).waitFor();
      const openOwner = detail.getByRole('button', { name: '담당 Actor 세션 열기 · 읽기 전용', exact: true });
      assert.equal(await openOwner.isDisabled(), true);
      await page.getByRole('button', { name: 'Fit View', exact: true }).click();
      await page.locator('.react-flow__node[data-id="fixture-isolated"]').click();
      await detail.getByRole('heading', { name: 'Fixture Isolated', exact: true }).waitFor();
      await detail.getByText('연결된 관계 없음', { exact: true }).waitFor();
      assert.equal(await detail.getByRole('list', { name: '연결된 설계 노드', exact: true }).count(), 0);
      await page.locator('.react-flow__node[data-id="fixture-feature"]').click();
      await detail.getByRole('heading', { name: 'Fixture Feature', exact: true }).waitFor();
      assert.equal(await openOwner.isDisabled(), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (name === 'desktop') assert.ok((await page.locator('.builder-graph-card').boundingBox()).width >= 600, 'The graph must use the available architecture view, not a duplicated activity rail or shrink-wrapped page.');
      await page.screenshot({ path: path.resolve(`artifacts/screenshots/builder-graph-${name}.png`), fullPage: true });
      if (name === 'mobile') {
        await openOwner.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.resolve('artifacts/screenshots/builder-graph-mobile-details.png') });
      }
      await openOwner.click();
      await page.getByText('Fixture CTO read-only record', { exact: true }).waitFor();
      await page.getByText('이 세션은 조회 전용입니다. 사용자 메시지는 보낼 수 없습니다.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('textbox', { name: 'Lead에게 메시지', exact: true }).count(), 0);
      await page.goto(`${origin}?fixture=decisions`);
      await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "미결정사항", exact: true }).click();
      await page.getByRole("heading", { level: 2, name: "Regression question", exact: true }).waitFor();
      await page.getByText("Selected question details remain visible.", { exact: true }).waitFor();
      await page.getByText("Lead decision with unrelated run ID", { exact: true }).waitFor();
      assert.equal(await page.getByText("SUBORDINATE RECORD MUST NOT APPEAR", { exact: true }).count(), 0);
      await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "설계 문서", exact: true }).click();
      await page.getByRole("heading", { level: 1, name: "설계 문서", exact: true }).waitFor();
      await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "미결정사항", exact: true }).click();
      await page.getByText("Lead decision with unrelated run ID", { exact: true }).waitFor();
      assert.equal(await page.getByText("SUBORDINATE RECORD MUST NOT APPEAR", { exact: true }).count(), 0);
      await page.goto(`${origin}?fixture=decisions-no-question`);
      await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "미결정사항", exact: true }).click();
      await page.getByText("미결정사항이 없습니다", { exact: true }).waitFor();
      await page.getByText("Lead decision with unrelated run ID", { exact: true }).waitFor();
      assert.equal(await page.getByText("SUBORDINATE RECORD MUST NOT APPEAR", { exact: true }).count(), 0);
      await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "Lead 대화", exact: true }).click();
      await page.getByRole("heading", { level: 1, name: "Lead와 대화", exact: true }).waitFor();
      await page.getByRole("button", { name: "상담 텍스트 가져오기", exact: true }).click();
      await page.getByRole("textbox", { name: "상담 텍스트", exact: true }).fill("브라우저 검증용 상담 원문");
      await page.getByRole("button", { name: "저장된 입력으로 전달", exact: true }).click();
      await page.getByText("브라우저 검증용 상담 원문", { exact: true }).waitFor();
      const importBox = page.getByRole("textbox", { name: "상담 텍스트", exact: true });
      await importBox.fill("붙여넣은 기존 입력 유지");
      const fileInput = page.getByLabel("상담 .txt 파일");
      await fileInput.setInputFiles({ name: "bad-utf8.txt", mimeType: "text/plain", buffer: Buffer.from([0xc3, 0x28]) });
      await page.getByRole("status").filter({ hasText: "UTF-8 텍스트로 읽을 수 없습니다" }).waitFor();
      assert.equal(await importBox.inputValue(), "붙여넣은 기존 입력 유지");
      await fileInput.setInputFiles({ name: "utf16.txt", mimeType: "text/plain", buffer: Buffer.from([0xff, 0xfe, 0x61, 0x00]) });
      await page.getByRole("status").filter({ hasText: "UTF-16" }).waitFor();
      assert.equal(await importBox.inputValue(), "붙여넣은 기존 입력 유지");
      await fileInput.setInputFiles({ name: "binary.txt", mimeType: "text/plain", buffer: Buffer.from([0x61, 0x00, 0x62]) });
      await page.getByRole("status").filter({ hasText: "바이너리" }).waitFor();
      await fileInput.setInputFiles({ name: "empty.txt", mimeType: "text/plain", buffer: Buffer.from(" \r\n\t", "utf8") });
      await page.getByRole("status").filter({ hasText: "파일이 비어 있습니다" }).waitFor();
      await fileInput.setInputFiles({ name: "large.txt", mimeType: "text/plain", buffer: Buffer.alloc(48 * 1024 + 1, 0x61) });
      await page.getByRole("status").filter({ hasText: "파일이 48 KiB를 넘습니다" }).waitFor();
      assert.equal(await importBox.inputValue(), "붙여넣은 기존 입력 유지");
      const savedBeforePreview = await page.locator(".builder-transcript").innerText();
      await fileInput.setInputFiles({ name: "selected-consultation.txt", mimeType: "text/plain", buffer: Buffer.from("파일에서 읽은 상담 원문", "utf8") });
      await page.getByText("파일 내용을 미리보기로 불러왔습니다", { exact: false }).waitFor();
      assert.equal(await importBox.inputValue(), "파일에서 읽은 상담 원문");
      assert.equal(await page.locator(".builder-transcript").innerText(), savedBeforePreview, "Selecting a file must not save it.");
      await page.getByRole("button", { name: "저장된 입력으로 전달", exact: true }).click();
      await page.getByText("파일에서 읽은 상담 원문", { exact: true }).waitFor();
      await page.getByText("상담 입력이 Builder에 저장되었습니다.", { exact: true }).waitFor();

      await fileInput.setInputFiles({ name: "pending-edit.txt", mimeType: "text/plain", buffer: Buffer.from("늦게 도착한 파일") });
      await page.waitForFunction(() => window.__builderFileReadTest.pending.has("pending-edit.txt"));
      assert.equal(await page.getByRole("button", { name: "파일 읽는 중" }).isDisabled(), true);
      await importBox.fill("읽는 동안 사용자가 편집한 최신 입력");
      await page.evaluate(() => window.__builderFileReadTest.release("pending-edit.txt"));
      assert.equal(await importBox.inputValue(), "읽는 동안 사용자가 편집한 최신 입력");

      await fileInput.setInputFiles({ name: "pending-old.txt", mimeType: "text/plain", buffer: Buffer.from("오래된 파일") });
      await page.waitForFunction(() => window.__builderFileReadTest.pending.has("pending-old.txt"));
      await fileInput.setInputFiles({ name: "new-current.txt", mimeType: "text/plain", buffer: Buffer.from("나중에 고른 파일") });
      await page.getByText("파일 내용을 미리보기로 불러왔습니다", { exact: false }).waitFor();
      await page.evaluate(() => window.__builderFileReadTest.release("pending-old.txt"));
      assert.equal(await importBox.inputValue(), "나중에 고른 파일");
      await page.getByText("미리보기: new-current.txt", { exact: true }).waitFor();

      await fileInput.setInputFiles({ name: "pending-unmount.txt", mimeType: "text/plain", buffer: Buffer.from("분리된 입력") });
      await page.waitForFunction(() => window.__builderFileReadTest.pending.has("pending-unmount.txt"));
      await page.getByRole("button", { name: "상담 텍스트 가져오기", exact: true }).click();
      await page.evaluate(() => window.__builderFileReadTest.release("pending-unmount.txt"));
      await page.getByRole("button", { name: "상담 텍스트 가져오기", exact: true }).click();
      assert.equal(await page.getByRole("textbox", { name: "상담 텍스트", exact: true }).inputValue(), "");
      assert.equal(await page.locator(".builder-import [role=status]").count(), 0, "An unmounted read must not restore status on remount.");

      await page.getByRole("button", { name: "상담 텍스트 가져오기", exact: true }).click();
      await page.getByRole("button", { name: "작업 기록 열기", exact: true }).click();
      if (name === "mobile") {
        await page.getByRole("complementary", { name: "AI 작업 기록", exact:true }).waitFor({ state: "visible" });
        await page.getByRole("button", { name: "작업 기록 닫기", exact: true }).last().click();
      } else {
        await page.getByRole("button", { name: "사이드바 접기", exact: true }).click();
        await page.getByRole("button", { name: "사이드바 펼치기", exact: true }).click();
        await page.getByRole("button", { name: "작업 기록 열기", exact: true }).click();
        await page.locator(".builder-shell").evaluate(element => { element.style.width = "900px"; });
        const embedded = await page.locator(".builder-message-main").boundingBox();
        assert.ok(embedded && embedded.width >= 600, "Embedded Builder must retain a readable main column.");
        assert.equal(await page.getByRole("complementary", { name: "AI 작업 기록", exact:true }).isVisible(), false);
        await page.getByRole("button", { name: "작업 기록 열기", exact: true }).click();
        await page.getByRole("complementary", { name: "AI 작업 기록", exact:true }).waitFor({ state: "visible" });
        await page.getByRole("button", { name: "작업 기록 닫기", exact: true }).last().click();
        await page.locator(".builder-shell").evaluate(element => { element.style.width = ""; });
      }
      await page.screenshot({ path: path.resolve(`artifacts/screenshots/builder-${name}.png`) });
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ builderUi: name, views: 6, pastedTextImport: true, localTxtPreview: true, explicitFileSave: true,
        selectedGraphDetails: true, graphKeyboardSelection: true, graphMissingOwnerAndRelations: true, graphOwnerReadOnly: true,
        decisionsHistoryIgnoresRunId: true, decisionsHistoryExcludesSubordinateActors: true, decisionsHistorySurvivesMissingQuestion: true,
        fileFailurePreservesInput: true, fileSelectionDoesNotSave: true, delayedReadCannotOverwriteEdit: true,
        newerFileWins: true, unmountedReadIgnored: true,
        composerVisible: true, noOverflow: true, coreHostTested: false, realAi: false }));
    } catch (error) {
      await page.screenshot({ path: path.resolve(`artifacts/screenshots/builder-failure-${name}.png`), fullPage: true }).catch(() => {});
      throw error;
    } finally { await page.close(); }
  }
} finally {
  process.removeListener("SIGINT", closeOnSignal);
  process.removeListener("SIGTERM", closeOnSignal);
  await browser?.close();
}
