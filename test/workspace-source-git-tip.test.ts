import assert from "node:assert/strict";
import test from "node:test";
import { readWorkspaceSourceGitTipProof } from "../src/workspace-source-git-tip.ts";

const current = { status: "current", sourceId: "source-1", folderKey: "workspace", branch: "main",
  commitSha: "a".repeat(40), treeSha: "b".repeat(40), observedAt: "2026-11-07T00:00:00.000Z" };

test("current Host Git proof retains its exact branch and object pins", () => {
  assert.deepEqual(readWorkspaceSourceGitTipProof(current), current);
});

test("Host denial and uncertainty remain distinct without exposing raw diagnostic text", () => {
  for (const status of ["denied", "unknown"]) {
    assert.deepEqual(readWorkspaceSourceGitTipProof({ status, reason: "HOST_PRIVATE_DIAGNOSTIC" }), { status });
  }
});

test("non-current responses cannot carry apparently successful Source pins", () => {
  for (const status of ["denied", "unknown"]) {
    assert.throws(() => readWorkspaceSourceGitTipProof({ ...current, status, reason: "source_unavailable" }));
    assert.throws(() => readWorkspaceSourceGitTipProof({ status }));
    assert.throws(() => readWorkspaceSourceGitTipProof({ status, reason: "" }));
  }
});

test("malformed current proofs do not become unavailable or current evidence", () => {
  for (const key of Object.keys(current)) {
    const missing = { ...current } as Record<string, unknown>;
    delete missing[key];
    assert.throws(() => readWorkspaceSourceGitTipProof(missing));
  }
  assert.throws(() => readWorkspaceSourceGitTipProof({ ...current, reason: "unexpected" }));
  assert.throws(() => readWorkspaceSourceGitTipProof({ ...current, observedAt: null }));
  assert.throws(() => readWorkspaceSourceGitTipProof({ status: "passed", reason: "not a Git proof" }));
});

test("Host response accessors, extra fields and custom prototypes are rejected", () => {
  assert.throws(() => readWorkspaceSourceGitTipProof({ ...current, extra: true }));
  assert.throws(() => readWorkspaceSourceGitTipProof(Object.assign(Object.create({}), current)));
  assert.throws(() => readWorkspaceSourceGitTipProof(Object.defineProperty({ ...current }, "status",
    { enumerable: true, get() { throw new Error("must not execute"); } })), /Invalid Builder tool field/u);
});
