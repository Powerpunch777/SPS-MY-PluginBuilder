import type { BuilderActor, BuilderMessage, BuilderSnapshot, LeadChannel } from "./model.ts";

export function selectActiveActors(snapshot: BuilderSnapshot): readonly Readonly<BuilderActor>[] {
  return Object.freeze(snapshot.actors
    .filter(actor => actor.role !== "lead" && (actor.status === "running" || actor.status === "waiting"))
    .map(actor => Object.freeze({ ...actor })));
}

export function selectSessionTranscript(snapshot: BuilderSnapshot, sessionId: string): readonly Readonly<BuilderMessage>[] {
  const leadMatches = (Object.entries(snapshot.leadSessions) as [LeadChannel, string | null][])
    .filter(([, value]) => value === sessionId);
  if (leadMatches.length === 1) {
    const [channel] = leadMatches[0]!;
    const leadActorIds = new Set(snapshot.actors
      .filter(actor => actor.role === "lead" && actor.sessionId === sessionId)
      .map(actor => actor.id));
    return readonlyTranscript(snapshot.messages.filter(message => message.channel === channel
      && (message.actorId === null || leadActorIds.has(message.actorId))));
  }
  if (leadMatches.length > 1) return Object.freeze([]);

  const actorMatches = snapshot.actors.filter(actor => actor.sessionId === sessionId && actor.role !== "lead");
  if (actorMatches.length !== 1) return Object.freeze([]);
  const actorId = actorMatches[0]!.id;
  return readonlyTranscript(snapshot.messages.filter(message => message.actorId === actorId));
}

function readonlyTranscript(messages: readonly BuilderMessage[]): readonly Readonly<BuilderMessage>[] {
  return Object.freeze(messages
    .filter(message => message.role === "user" || message.role === "assistant")
    .map(message => Object.freeze({ ...message })));
}
