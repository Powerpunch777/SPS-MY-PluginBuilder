import assert from "node:assert/strict";
import test from "node:test";
import {
  assertConsultationRequestSize, consultationRequestBytes, decodeConsultationFile,
  MAX_CONSULTATION_REQUEST_BYTES,
} from "../src/domain/consultation-file.ts";

test("decodes UTF-8 and strips exactly one leading BOM", () => {
  const bytes = new TextEncoder().encode("\uFEFF상담 내용");
  assert.equal(decodeConsultationFile(bytes), "상담 내용");
  assert.throws(() => decodeConsultationFile(new TextEncoder().encode("\uFEFF\uFEFF상담 내용")), /BOM은 하나만/);
});

test("rejects empty and whitespace-only consultation files", () => {
  assert.throws(() => decodeConsultationFile(new Uint8Array()), /비어 있습니다/);
  assert.throws(() => decodeConsultationFile(new TextEncoder().encode(" \r\n\t")), /비어 있습니다/);
});

test("rejects malformed UTF-8, UTF-16 BOMs, and binary control data", () => {
  assert.throws(() => decodeConsultationFile(new Uint8Array([0xc3, 0x28])), /UTF-8/);
  assert.throws(() => decodeConsultationFile(new Uint8Array([0xff, 0xfe, 0x61, 0x00])), /UTF-16/);
  assert.throws(() => decodeConsultationFile(new Uint8Array([0x61, 0x00, 0x62])), /바이너리/);
});

test("measures the actual UTF-8 JSON request and rejects oversized file or request", () => {
  assert.equal(consultationRequestBytes("상담"), new TextEncoder().encode(JSON.stringify({
    requestId: "00000000-0000-4000-8000-000000000000", text: "상담",
  })).byteLength);
  assert.throws(() => assertConsultationRequestSize("x".repeat(MAX_CONSULTATION_REQUEST_BYTES)), /48 KiB/);
  assert.throws(() => decodeConsultationFile(new Uint8Array(MAX_CONSULTATION_REQUEST_BYTES + 1)), /48 KiB/);
});
