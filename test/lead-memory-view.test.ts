import assert from "node:assert/strict";
import test from "node:test";
import { projectLeadMemory } from "../src/domain/lead-memory-view.ts";
import { createEmptyBuilderSnapshot } from "../src/domain/snapshot.ts";

const workspace = "11111111-1111-4111-8111-111111111111";
const view = () => ({ workspaceId: workspace, projectId: workspace, sequence: 1,
  createdAt: "2026-11-02T00:00:00.000Z", memory: { projectId: workspace, revisionId: "memory-1", entries: [
    { id: "goal-1", kind: "goal", text: "Keep customer notes local", sourceIds: ["consultation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] },
  ] } });

test("memory is a read-only interpreted document, not snapshot mutation or approval", () => {
  const snapshot = createEmptyBuilderSnapshot(workspace);
  const before = structuredClone(snapshot);
  const shown = projectLeadMemory(snapshot, view());
  assert.deepEqual(snapshot, before);
  assert.equal(shown.documents.length, 1);
  assert.match(shown.documents[0]!.title, /공유 기억/);
  assert.match(shown.documents[0]!.text, /실행 권한이나 고객 승인을 뜻하지 않습니다/);
  assert.deepEqual(shown.graph, snapshot.graph);
  assert.deepEqual(shown.messages, snapshot.messages);
  assert.equal(projectLeadMemory(snapshot, null), snapshot);
});

test("memory view rejects cross-scope, altered schema and accessor fields", () => {
  const snapshot = createEmptyBuilderSnapshot(workspace);
  assert.throws(() => projectLeadMemory(snapshot, { ...view(), workspaceId: "22222222-2222-4222-8222-222222222222" }));
  assert.throws(() => projectLeadMemory(snapshot, { ...view(), projectId: "other" }));
  assert.throws(() => projectLeadMemory(snapshot, { ...view(), sequence: 0 }));
  assert.throws(() => projectLeadMemory(snapshot, { ...view(), approved: true }));
  let invoked = false;
  const getter = view();
  Object.defineProperty(getter, "memory", { enumerable: true, get() { invoked = true; return null; } });
  assert.throws(() => projectLeadMemory(snapshot, getter));
  assert.equal(invoked, false);
});
