import { DELIVERY_TARGETS, type DeliveryTarget } from "./specification-revisions.ts";

export type DeliveryPreparation = Readonly<{
  packageVersion: string;
  targets: readonly Readonly<{ target: DeliveryTarget; environments: readonly string[]; dependencies: readonly string[];
    entryPaths: readonly string[]; supplementaryPaths: readonly string[] }>[];
  limitationStatement: string;
  limitations: readonly string[];
  changeNotes: readonly string[];
}>;

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Invalid delivery preparation record.");
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key)
    || !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key]!, "value"))) throw new TypeError("Invalid delivery preparation fields.");
  return Object.fromEntries(fields.map(key => [key, descriptors[key]!.value]));
}
function text(value: unknown, max = 2048): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\p{Cc}\p{Cf}\ufffd]/u.test(value)) throw new TypeError("Invalid delivery preparation text.");
  return value;
}
function list<T>(value: unknown, parse: (item: unknown) => T, min: number, max: number): readonly T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max
    || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError("Invalid delivery preparation list.");
  const values = Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Invalid delivery preparation list value.");
    return parse(descriptor.value);
  });
  if (new Set(values.map(item => JSON.stringify(item))).size !== values.length) throw new TypeError("Duplicate delivery preparation entry.");
  return Object.freeze(values);
}
function path(value: unknown) {
  const result = text(value, 200);
  if (/[\\<>:"|?*]/u.test(result) || result.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git"
    || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu.test(part))) throw new TypeError("Invalid delivery preparation path.");
  return result;
}

/** Main-authored delivery declarations, never a QA verdict or execution grant. */
export function parseDeliveryPreparation(value: unknown): DeliveryPreparation {
  const row = record(value, ["packageVersion", "targets", "limitationStatement", "limitations", "changeNotes"]);
  const targets = list(row.targets, value => {
    const target = record(value, ["target", "environments", "dependencies", "entryPaths", "supplementaryPaths"]);
    if (typeof target.target !== "string" || !(DELIVERY_TARGETS as readonly string[]).includes(target.target)) throw new TypeError("Invalid delivery target.");
    const entryPaths = list(target.entryPaths, path, 1, 32), supplementaryPaths = list(target.supplementaryPaths, path, 0, 32);
    const paths = [...entryPaths, ...supplementaryPaths].map(value => value.toLocaleLowerCase("en-US"));
    if (new Set(paths).size !== paths.length) throw new TypeError("Colliding delivery preparation paths.");
    return Object.freeze({ target: target.target as DeliveryTarget, environments: list(target.environments, text, 1, 16),
      dependencies: list(target.dependencies, text, 0, 32), entryPaths, supplementaryPaths });
  }, 1, DELIVERY_TARGETS.length);
  if (new Set(targets.map(item => item.target)).size !== targets.length) throw new TypeError("Duplicate delivery target.");
  return Object.freeze({ packageVersion: text(row.packageVersion, 80), targets,
    limitationStatement: text(row.limitationStatement), limitations: list(row.limitations, text, 0, 32),
    changeNotes: list(row.changeNotes, text, 1, 32) });
}
