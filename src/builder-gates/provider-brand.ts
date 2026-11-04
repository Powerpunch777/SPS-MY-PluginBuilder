/** Internal provenance marker for the code-owned SDK Host registry factory. */
const hostRegistries = new WeakSet<object>();

export function markHostBoundRegistry<T extends object>(registry: T): T {
  hostRegistries.add(registry);
  return registry;
}

export function isHostBoundRegistry(value: unknown): value is object {
  return Boolean(value && typeof value === "object" && hostRegistries.has(value));
}
