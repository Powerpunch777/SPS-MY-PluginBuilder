import { parseProjectCtos } from "./project-ctos.ts";
import type { BuilderSnapshot } from "./model.ts";

/** Adds registered CTO identities for display without inventing execution facts. */
export function projectProjectCtos(snapshot: BuilderSnapshot, raw: unknown): BuilderSnapshot {
  const registry = parseProjectCtos(raw, snapshot.workspaceId, snapshot.workspaceId);
  const actorIds = new Set(snapshot.actors.map(actor => actor.id));
  const sessionIds = new Set([
    ...Object.values(snapshot.leadSessions).filter((id): id is string => id !== null),
    ...snapshot.actors.flatMap(actor => actor.sessionId === null ? [] : [actor.sessionId]),
  ]);

  const actors = registry.ctos.map(cto => {
    if (actorIds.has(cto.ctoId)) throw new TypeError(`Project CTO ${cto.ctoId} collides with a snapshot actor.`);
    if (cto.sessionId !== null && sessionIds.has(cto.sessionId)) {
      throw new TypeError(`Project CTO ${cto.ctoId} session collides with a snapshot session.`);
    }
    return {
      id: cto.ctoId,
      role: "cto" as const,
      label: cto.displayName,
      parentActorId: null,
      agentId: cto.agentId,
      sessionId: cto.sessionId,
      status: cto.status === "RETIRED" ? "archived" as const : "idle" as const,
    };
  });

  return { ...snapshot, actors: [...snapshot.actors, ...actors] };
}
