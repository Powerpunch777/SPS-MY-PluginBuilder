import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createSolutionRevisionStore, type RevisionState } from "../solution-revision-store.ts";
import type { SolutionRevision } from "../domain/graph-revisions.ts";
import { createSolutionRevisionPinReader } from "./revision-pins.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "project-1";
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const revision = (graphRevisionId: string): SolutionRevision => Object.freeze({ approvedSpecRevisionId: `spec-${graphRevisionId}`,
  graphRevisionId, entities: Object.freeze([]), relations: Object.freeze([]), viewLayoutRef: `layout-${graphRevisionId}` });

function host() {
  const values = new Map<string, JsonValue>();
  const state: RevisionState = {
    async get(key) { const value = values.get(key.stateKey); return value === undefined ? null : structuredClone(value); },
    async compareAndSet(key: SpsStateKey, expected, value) {
      const current = values.get(key.stateKey);
      const matches = expected.exists ? current !== undefined && JSON.stringify(current) === JSON.stringify(expected.value) : current === undefined;
      if (!matches) return { swapped: false };
      values.set(key.stateKey, structuredClone(value));
      return { swapped: true };
    },
  };
  return { state, values };
}

test("reads only revisions published in the existing CAS journal and returns stable content pins", async () => {
  const fake = host();
  const journal = createSolutionRevisionStore(workspaceId, projectId, fake.state);
  assert.equal((await journal.publish({ expectedBaseRevisionId: null, revision: revision("graph-r1") })).status, "published");
  assert.equal((await journal.publish({ expectedBaseRevisionId: "graph-r1", revision: revision("graph-r2") })).status, "published");

  const reader = createSolutionRevisionPinReader({ workspaceId, projectId, sourceId: "solution-graph", state: fake.state });
  const old = await reader.published("graph-r1");
  const current = await reader.current();
  assert.equal(old.status, "found");
  assert.equal(current.status, "found");
  if (old.status === "found") {
    assert.equal(old.sequence, 1);
    assert.deepEqual(old.pin, { sourceId: "solution-graph", revisionId: "graph-r1",
      sourceSha256: digest(JSON.stringify(revision("graph-r1"))) });
  }
  if (current.status === "found") {
    assert.equal(current.sequence, 2);
    assert.equal(current.pin.revisionId, "graph-r2");
  }
  assert.equal((await reader.published("never-published")).status, "missing");
});

test("corrupt journal evidence becomes unavailable, never a source pin", async () => {
  const fake = host();
  const journal = createSolutionRevisionStore(workspaceId, projectId, fake.state);
  await journal.publish({ expectedBaseRevisionId: null, revision: revision("graph-r1") });
  const entryKey = [...fake.values.keys()].find(key => key.startsWith("solution-revision.v1."));
  assert(entryKey);
  const entry = structuredClone(fake.values.get(entryKey)) as Record<string, unknown>;
  entry.digest = "0".repeat(64);
  fake.values.set(entryKey, entry as JsonValue);
  const reader = createSolutionRevisionPinReader({ workspaceId, projectId, sourceId: "solution-graph", state: fake.state });
  assert.equal((await reader.current()).status, "unavailable");
  assert.equal((await reader.published("graph-r1")).status, "unavailable");
});

test("Host read failure is unavailable and a later read recovers", async () => {
  const fake = host();
  const journal = createSolutionRevisionStore(workspaceId, projectId, fake.state);
  await journal.publish({ expectedBaseRevisionId: null, revision: revision("graph-r1") });
  let fail = true;
  const intermittent: RevisionState = { get: async key => {
    if (fail) { fail = false; throw new Error("Host read unavailable"); }
    return fake.state.get(key);
  }, compareAndSet: fake.state.compareAndSet };
  const reader = createSolutionRevisionPinReader({ workspaceId, projectId, sourceId: "solution-graph", state: intermittent });
  assert.equal((await reader.current()).status, "unavailable");
  assert.equal((await reader.current()).status, "found");
});
