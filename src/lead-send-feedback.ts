export const PROTECTED_SEND_UNAVAILABLE = "SPS_BUILDER_PROTECTED_SEND_UNAVAILABLE";

export function leadSendFailureMessage(error: unknown): string {
  // The Core UI bridge rejects with a plain DTO, not necessarily an Error.
  const field = error !== null && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "message") : undefined;
  const message = field && Object.hasOwn(field, "value") ? field.value : null;
  return typeof message === "string" && message.length <= 4096 && message.includes(PROTECTED_SEND_UNAVAILABLE)
    ? "보호 실행을 확인하지 못해 전송하지 않았습니다. Core와 선택한 AI의 지원 상태를 확인해 주세요."
    : "전송 결과를 확인하지 못했습니다. 응답 확인으로 기존 실행을 확인해 주세요.";
}
