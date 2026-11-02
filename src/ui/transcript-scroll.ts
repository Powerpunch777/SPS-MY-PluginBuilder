export type TranscriptPosition = Readonly<{ scrollHeight: number; clientHeight: number; scrollTop: number }>;
export type TranscriptPage = Readonly<{ firstId: string | null; lastId: string | null; count: number }>;

export function isNearTranscriptBottom(position: TranscriptPosition): boolean {
  return Number.isFinite(position.scrollHeight) && Number.isFinite(position.clientHeight)
    && Number.isFinite(position.scrollTop) && position.scrollHeight >= 0 && position.clientHeight >= 0
    && position.scrollHeight - position.clientHeight - Math.max(0, position.scrollTop) <= 40;
}

export function transcriptScrollAction(previous: TranscriptPage | null, current: TranscriptPage,
  followLatest: boolean, previouslyFollowedLatest: boolean, sticky: boolean): "bottom" | "start" | "keep" {
  if (!followLatest) return previous?.firstId !== current.firstId ? "start" : "keep";
  if (!previous || !previouslyFollowedLatest || sticky) return "bottom";
  return "keep";
}
