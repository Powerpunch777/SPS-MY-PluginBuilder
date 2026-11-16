import assert from "node:assert/strict";
import test from "node:test";
import { isNearTranscriptBottom, transcriptScrollAction } from "../src/ui/transcript-scroll.ts";

test("transcript bottom tracking tolerates fractional offsets without treating a scrolled-up reader as sticky", () => {
  assert.equal(isNearTranscriptBottom({ scrollHeight: 900, clientHeight: 300, scrollTop: 599.5 }), true);
  assert.equal(isNearTranscriptBottom({ scrollHeight: 900, clientHeight: 300, scrollTop: 200 }), false);
  assert.equal(isNearTranscriptBottom({ scrollHeight: 200, clientHeight: 300, scrollTop: 0 }), true);
  assert.equal(isNearTranscriptBottom({ scrollHeight: 900, clientHeight: 300, scrollTop: -10 }), false);
  assert.equal(isNearTranscriptBottom({ scrollHeight: Infinity, clientHeight: 300, scrollTop: 0 }), false);
});

test("new answers follow only a sticky reader while initial/latest navigation reaches the end", () => {
  const old = { firstId: "a", lastId: "b", count: 2 };
  const current = { firstId: "a", lastId: "c", count: 3 };
  assert.equal(transcriptScrollAction(null, current, true, true, false), "bottom");
  assert.equal(transcriptScrollAction(old, current, true, true, true), "bottom");
  assert.equal(transcriptScrollAction(old, current, true, true, false), "keep");
  assert.equal(transcriptScrollAction(old, current, true, false, false), "bottom");
});

test("explicit older-page navigation never jumps to the newest edge", () => {
  const current = { firstId: "old-a", lastId: "old-b", count: 2 };
  assert.equal(transcriptScrollAction(null, current, false, true, true), "start");
  assert.equal(transcriptScrollAction({ firstId: "a", lastId: "b", count: 2 }, current, false, true, true), "start");
  assert.equal(transcriptScrollAction(current, current, false, false, true), "keep");
});
