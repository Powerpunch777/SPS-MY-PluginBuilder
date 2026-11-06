import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverBuilderTests, runBuilderTests } from "../scripts/test.mjs";

test("default discovery includes nested assurance, coverage and Reuse tests", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const found = (await discoverBuilderTests(path.join(root, "test"))).map(file => path.relative(root, file).replaceAll(path.sep, "/"));
  for (const required of ["test/spec-assurance/evaluator.test.ts", "test/spec-assurance/review-first-design.test.ts",
    "test/spec-coverage/evaluator.test.ts"]) assert.ok(found.includes(required), required);
  assert.ok(found.every(file => /\.test\.(ts|mjs)$/u.test(file)));
});

test("runner returns a nested failure exit status and ignores non-test files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "builder-test-discovery-"));
  try {
    const directory = path.join(root, "test", "nested");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "failure.test.mjs"),
      'import test from "node:test"; test("expected fixture failure", () => { throw new Error("TEST_FIXTURE_ONLY"); });\n');
    await writeFile(path.join(directory, "helper.mjs"), 'throw new Error("Must not be selected");\n');
    assert.equal((await discoverBuilderTests(path.join(root, "test"))).length, 1);
    assert.equal(await runBuilderTests(root, ["--test-reporter=dot"], { stdio: "ignore" }), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
