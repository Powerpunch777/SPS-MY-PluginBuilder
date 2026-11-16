import type { TaskPacket } from "./domain/task-packets.ts";

const writePaths = (packet: TaskPacket) => packet.kind === "qa"
  ? packet.sourceAccess?.qaWritePaths ?? [] : packet.sourceAccess?.writePaths ?? [];
const pathKey = (value: string) => value.toLowerCase();
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

export function taskWriteOverlap(left: TaskPacket, right: TaskPacket): boolean {
  if (!left.sourceAccess || left.sourceAccess.sourceId !== right.sourceAccess?.sourceId) return false;
  // File tools operate on the Source root; distinct branch names alone do not
  // prove distinct working directories.
  const rightPaths = writePaths(right).map(pathKey);
  return writePaths(left).some(path => rightPaths.some(other => overlaps(pathKey(path), other)));
}

export function taskDependsOn(task: TaskPacket, taskId: string, packets: ReadonlyMap<string, TaskPacket>): boolean {
  const pending = [...task.dependencies];
  const seen = new Set<string>();
  while (pending.length) {
    const next = pending.pop()!;
    if (next === taskId) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    const dependency = packets.get(next);
    if (dependency) pending.push(...dependency.dependencies);
  }
  return false;
}

const intentKey = (task: TaskPacket) => JSON.stringify([task.goal.trim().replace(/\s+/gu, " ").toLowerCase(),
  [...task.scopeNodeIds].sort(), [...task.requirementIds].sort()]);

export function unorderedTaskWriterIds(task: TaskPacket, packets: ReadonlyMap<string, TaskPacket>): string[] {
  return [...packets.values()].filter(other => other.taskId !== task.taskId && taskWriteOverlap(task, other)
    && !taskDependsOn(task, other.taskId, packets) && !taskDependsOn(other, task.taskId, packets)).map(other => other.taskId);
}

/** Only declared facts are checked; matching intent is a review hint, not a verdict. */
export function reviewTaskParallelPlan(packets: readonly TaskPacket[]) {
  const byId = new Map(packets.map(packet => [packet.taskId, packet]));
  const affected = packets.map(packet => {
    const unorderedWriterIds = unorderedTaskWriterIds(packet, byId), similarGoalIds: string[] = [];
    const intent = packet.kind === "development" ? intentKey(packet) : null;
    for (const other of packets) {
      if (other.taskId === packet.taskId) continue;
      if (intent !== null && other.kind === "development" && intent === intentKey(other)) similarGoalIds.push(other.taskId);
    }
    return { taskId: packet.taskId, unorderedWriterIds: unorderedWriterIds.slice(0, 4), similarGoalIds: similarGoalIds.slice(0, 4),
      truncated: unorderedWriterIds.length > 4 || similarGoalIds.length > 4 };
  }).filter(item => item.unorderedWriterIds.length || item.similarGoalIds.length);
  return { tasks: affected.slice(0, 16), truncated: affected.length > 16 || affected.some(item => item.truncated) };
}
