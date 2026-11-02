import { parseLeadMemoryRevision, type LeadMemoryRevision } from "./lead-memory.ts";
import type { BuilderSnapshot } from "./model.ts";

export function projectLeadMemory(snapshot: BuilderSnapshot, value: unknown): BuilderSnapshot {
  if (value === null) return snapshot;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Invalid Lead memory view.");
  const keys = ["workspaceId", "projectId", "sequence", "createdAt", "memory"];
  if (Reflect.ownKeys(value).length !== keys.length) throw new TypeError("Invalid memory view fields.");
  const row: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new TypeError("Invalid memory view field.");
    row[key] = descriptor.value;
  }
  if (row.workspaceId !== snapshot.workspaceId || row.projectId !== snapshot.workspaceId
    || !Number.isSafeInteger(row.sequence) || (row.sequence as number) < 1
    || typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt))
    || new Date(row.createdAt).toISOString() !== row.createdAt) throw new TypeError("Invalid or cross-scope Lead memory view.");
  const memory: LeadMemoryRevision = parseLeadMemoryRevision(row.memory, snapshot.workspaceId);
  return { ...snapshot, documents: [...snapshot.documents, { id: `lead-memory:${memory.revisionId}`,
    title: "Lead 공유 기억 · 해석 기록", revisionId: memory.revisionId, createdAt: row.createdAt,
    text: JSON.stringify({ notice: "세 Lead 세션의 해석 기록입니다. 실행 권한이나 고객 승인을 뜻하지 않습니다.", ...memory }, null, 2) }] };
}
