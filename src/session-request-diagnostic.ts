import { exactToolRecord } from "./lead-tool-authority.ts";

type SessionRequestReader = Readonly<{
  getRequest(sessionId: string, companyId: string, requestId: string,
    options?: { includeDiagnostic: true }): Promise<unknown>;
}>;

/** A skipped/no-Run diagnostic is an observation, never permission to resend a request. */
export async function hasConfirmedNotStartedSessionRequest(input: Readonly<{
  sessions: SessionRequestReader;
  sessionId: string;
  workspaceId: string;
  requestId: string;
  assertCurrent(): Promise<void>;
}>): Promise<boolean> {
  await input.assertCurrent();
  let confirmed = false;
  try {
    const receipt = exactToolRecord(await input.sessions.getRequest(input.sessionId, input.workspaceId, input.requestId,
      { includeDiagnostic: true }), ["requestId", "state", "runId"], ["diagnostic"]);
    if (receipt.requestId === input.requestId && ["pending", "uncertain"].includes(receipt.state as string)
      && receipt.runId === null && Object.hasOwn(receipt, "diagnostic")) {
      const diagnostic = exactToolRecord(receipt.diagnostic, ["kind", "wakeupStatus"]);
      confirmed = diagnostic.kind === "not_started" && diagnostic.wakeupStatus === "skipped";
    }
  } catch { /* Older Hosts and failed lookups do not establish non-execution. */ }
  await input.assertCurrent();
  return confirmed;
}
