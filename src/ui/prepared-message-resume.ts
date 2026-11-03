export async function performConversationControlAction(
  action: (() => Promise<void>) | undefined,
  busy: boolean,
  setBusy: (busy: boolean) => void,
  setFeedback: (feedback: string) => void,
): Promise<void> {
  if (!action || busy) return;
  setBusy(true);
  setFeedback("");
  try {
    await action();
  } catch {
    setFeedback("결과를 확인하지 못했습니다. 같은 실행의 상태를 다시 확인해 주세요.");
  } finally {
    setBusy(false);
  }
}

export async function resumePreparedMessageInScope<T extends { saved: boolean; requestId: string }>(options: {
  requestId: string;
  scopeToken: object;
  currentScopeToken(): object | null;
  resume(): Promise<T>;
  refreshCurrentScope: readonly (() => void)[];
}): Promise<void> {
  try {
    let result: T;
    try {
      result = await options.resume();
    } catch (error) {
      if (options.currentScopeToken() !== options.scopeToken) return;
      throw error;
    }
    if (options.currentScopeToken() !== options.scopeToken) return;
    if (result.saved !== true || result.requestId !== options.requestId) throw new Error("Unexpected prepared message result.");
  } finally {
    if (options.currentScopeToken() === options.scopeToken) for (const refresh of options.refreshCurrentScope) refresh();
  }
}
