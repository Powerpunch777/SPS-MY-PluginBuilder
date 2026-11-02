import assert from "node:assert/strict";
import test from "node:test";
import { leadSendFailureMessage, PROTECTED_SEND_UNAVAILABLE } from "../src/lead-send-feedback.ts";

test("known pre-dispatch rejection explains that nothing was sent without exposing raw errors", () => {
  const message = leadSendFailureMessage(new Error(`Remote action failed: ${PROTECTED_SEND_UNAVAILABLE}`));
  assert.match(message, /전송하지 않았습니다/);
  assert.doesNotMatch(message, /Remote action failed|SPS_BUILDER/);
  assert.equal(leadSendFailureMessage({ code: "WORKER_ERROR", message: PROTECTED_SEND_UNAVAILABLE }), message);
});

test("unknown failures keep admission uncertainty rather than claiming no execution", () => {
  let reads = 0;
  const getter = { get message() { reads += 1; return PROTECTED_SEND_UNAVAILABLE; } };
  for (const error of [new Error("private-token-or-path"), null, { message: "Different message" }, getter]) {
    const message = leadSendFailureMessage(error);
    assert.match(message, /기존 실행을 확인/);
    assert.doesNotMatch(message, /private-token|전송하지 않았습니다/);
  }
  assert.equal(reads, 0);
});
