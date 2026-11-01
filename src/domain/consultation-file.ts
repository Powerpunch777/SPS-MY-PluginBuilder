export const MAX_CONSULTATION_REQUEST_BYTES = 48 * 1024;

const REQUEST_ID_FOR_SIZE_CHECK = "00000000-0000-4000-8000-000000000000";

export function consultationRequestBytes(text: string): number {
  const request = JSON.stringify({ requestId: REQUEST_ID_FOR_SIZE_CHECK, text });
  return new TextEncoder().encode(request).byteLength;
}

export function assertConsultationRequestSize(text: string): void {
  if (consultationRequestBytes(text) > MAX_CONSULTATION_REQUEST_BYTES) {
    throw new Error("상담 입력이 저장 요청 한도(48 KiB)를 넘습니다. 내용을 줄여 주세요.");
  }
}

export function decodeConsultationFile(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_CONSULTATION_REQUEST_BYTES) {
    throw new Error("파일이 48 KiB를 넘습니다. 더 작은 UTF-8 .txt 파일을 선택해 주세요.");
  }
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new Error("UTF-16 파일은 지원하지 않습니다. UTF-8 .txt 파일을 선택해 주세요.");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("UTF-8 텍스트로 읽을 수 없습니다. 바이너리 파일이 아닌 UTF-8 .txt 파일을 선택해 주세요.");
  }

  if (text.includes("\0") || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new Error("파일에 바이너리 데이터가 있습니다. UTF-8 .txt 파일을 선택해 주세요.");
  }

  if (text.startsWith("\uFEFF\uFEFF")) {
    throw new Error("파일 시작 부분의 BOM은 하나만 허용됩니다. UTF-8 .txt 파일을 확인해 주세요.");
  }
  const withoutOneBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
  if (!withoutOneBom.trim()) {
    throw new Error("파일이 비어 있습니다. 상담 텍스트가 있는 UTF-8 .txt 파일을 선택해 주세요.");
  }
  assertConsultationRequestSize(withoutOneBom);
  return withoutOneBom;
}
