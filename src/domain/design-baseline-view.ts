import { parseDesignBaseline, type DesignBaseline } from "./design-baseline.ts";
import type { BuilderSnapshot } from "./model.ts";

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("Invalid design baseline view.");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError("Invalid design baseline view fields.");
  }
  const row: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("Invalid design baseline view field.");
    }
    row[key] = descriptor.value;
  }
  return row;
}

export function projectDesignBaseline(snapshot: BuilderSnapshot, value: unknown): BuilderSnapshot {
  if (value === null) return snapshot;
  const row = exactRecord(value, ["workspaceId", "projectId", "sequence", "baseline"]);
  if (row.workspaceId !== snapshot.workspaceId || row.projectId !== snapshot.workspaceId
    || typeof row.sequence !== "number" || !Number.isSafeInteger(row.sequence) || row.sequence < 1) {
    throw new TypeError("Invalid or cross-scope design baseline view.");
  }

  const baseline: DesignBaseline = parseDesignBaseline(row.baseline, snapshot.workspaceId);
  return {
    ...snapshot,
    documents: [...snapshot.documents, {
      id: `design-baseline:${baseline.revisionId}`,
      title: "설계 기준 · Lead 해석 기록",
      revisionId: baseline.revisionId,
      createdAt: baseline.createdAt,
      text: JSON.stringify({
        notice: "사용자 입력에 대한 Lead의 설계 해석입니다. 외부 계약 체결이나 코드 실행 권한이 아닙니다.",
        ...baseline,
      }, null, 2),
    }],
  };
}
