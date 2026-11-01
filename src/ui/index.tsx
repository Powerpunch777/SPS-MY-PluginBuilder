import { useMemo, useRef } from "react";
import { useHostContext, usePluginAction, usePluginData } from "@sonparkserver/plugin-sdk/ui/bridge";
import { BuilderShell } from "./BuilderShell.tsx";
import { createEmptyBuilderSnapshot, parseBuilderSnapshot } from "../domain/snapshot.ts";
import { parseLeadAgentOptions } from "../domain/lead-agent.ts";

export function BuilderPage() {
  const context = useHostContext();
  const state = usePluginData<unknown>("builder.snapshot");
  const lead = usePluginData<unknown>("builder.lead-agents");
  const selectLead = usePluginAction<{ agentId: string | null; expectedRevision: number }, { saved: boolean; executionStarted: boolean }>("builder.select-lead-agent");
  const importText = usePluginAction<{ requestId: string; text: string }, { saved: boolean; analysisStarted: boolean }>("builder.import-consultation");
  const pending = useRef<{ workspaceId: string; text: string; requestId: string } | null>(null);
  const current = useMemo(() => {
    if (!context.companyId) return null;
    try {
      return { snapshot: state.data === null ? createEmptyBuilderSnapshot(context.companyId)
        : parseBuilderSnapshot(state.data, context.companyId), error: null };
    } catch {
      return { snapshot: createEmptyBuilderSnapshot(context.companyId), error: "Workspace data could not be validated. Refresh to try again." };
    }
  }, [context.companyId, state.data]);
  const leadOptions = useMemo(() => {
    if (!context.companyId || lead.loading || lead.error) return null;
    try { return parseLeadAgentOptions(lead.data, context.companyId); } catch { return null; }
  }, [context.companyId, lead.data, lead.loading, lead.error]);
  if (!current || !context.companyId) return <section role="status">Select an SPS Workspace to open Builder.</section>;
  const workspaceId = context.companyId;
  return <BuilderShell key={workspaceId} snapshot={current.snapshot} workspaceLabel={context.companyPrefix ?? "Workspace"}
    leadAgents={leadOptions} leadAgentsLoading={lead.loading}
    leadAgentsError={!lead.loading && !leadOptions ? "Agent 목록을 불러오지 못했습니다. 새로고침해 주세요." : null}
    onSelectLeadAgent={async (agentId, expectedRevision) => {
      if (!leadOptions || lead.loading || lead.error) throw new Error("Agent settings are not ready.");
      const result = await selectLead({ agentId, expectedRevision });
      if (result.saved !== true || result.executionStarted !== false) throw new Error("Unexpected Lead Agent selection result.");
      lead.refresh();
    }}
    loading={state.loading} error={current.error ?? (state.error ? "Builder data is unavailable. Refresh to try again." : null)}
    onRefresh={() => { state.refresh(); lead.refresh(); }} onImportConsultation={async text => {
      if (state.loading || state.error || current.error) throw new Error("Workspace data is not ready.");
      if (pending.current?.workspaceId !== workspaceId || pending.current.text !== text) {
        pending.current = { workspaceId, text, requestId: crypto.randomUUID() };
      }
      const result = await importText({ requestId: pending.current.requestId, text });
      if (result.saved !== true || result.analysisStarted !== false) throw new Error("Unexpected consultation import result.");
      pending.current = null;
      state.refresh();
    }} />;
}
