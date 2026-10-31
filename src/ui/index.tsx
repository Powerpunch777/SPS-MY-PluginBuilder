import { useMemo, useRef } from "react";
import { useHostContext, usePluginAction, usePluginData } from "@sonparkserver/plugin-sdk/ui/bridge";
import { BuilderShell } from "./BuilderShell.tsx";
import { createEmptyBuilderSnapshot, parseBuilderSnapshot } from "../domain/snapshot.ts";

export function BuilderPage() {
  const context = useHostContext();
  const state = usePluginData<unknown>("builder.snapshot");
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
  if (!current || !context.companyId) return <section role="status">Select an SPS Workspace to open Builder.</section>;
  const workspaceId = context.companyId;
  return <BuilderShell key={workspaceId} snapshot={current.snapshot} workspaceLabel={context.companyPrefix ?? "Workspace"}
    loading={state.loading} error={current.error ?? (state.error ? "Builder data is unavailable. Refresh to try again." : null)}
    onRefresh={state.refresh} onImportConsultation={async text => {
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
