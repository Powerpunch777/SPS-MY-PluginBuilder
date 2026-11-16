import assert from "node:assert/strict";
import test from "node:test";
import { setupVerifiedWorkstreamPlatform } from "./fixtures/verified-workstream-platform.ts";

test("registered verify-workstream reads current approved sources and emits one guarded verification wake", async () => {
  const f = await setupVerifiedWorkstreamPlatform();
  const result = await f.verify();
  assert.equal(result.data.status, "published", JSON.stringify(result.data));
  assert.match(result.data.eventId, /^builder-verified-v1:/u);
  assert.equal(f.atomicWakeCalls, 1);
  assert.equal(f.wakes.length, 1);
  assert.equal((f.wakes[0] as any).name, "builder.workstream.verified");
  assert.equal((f.wakes[0] as any).jobKey, "builder.integrate-verified-workstream");
  assert.equal((await f.reportStore().current())!.revision.verdict, "passed");
  assert.equal(result.data.snapshot?.verificationStatus, undefined, "the tool returns a publication receipt, not integration completion");
});
