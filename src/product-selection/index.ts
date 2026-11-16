import {
  DELIVERY_TARGETS,
  PRODUCT_TIERS,
  type DeliveryTarget,
  type ProductTier,
} from "../domain/specification-revisions.ts";

export type ProductSelectionRoute = "FAST" | "ASSEMBLY" | "CUSTOM";
export type ProductSelectionStatus = "complete" | "incomplete" | "invalid";

export type ProductCatalogEntry = Readonly<{
  id: string;
  name: string;
  tier: ProductTier;
}>;
export type ProductAddOnEntry = Readonly<{ id: string; name: string }>;

const catalogSource = Object.freeze({
  document: "SPS_Solution_Builder_Integrated_Reuse_First_Design_Tailscale_SSH_2026-10-28.md",
  section: "§1.1.1",
  sha256: "7fd759a1c9f66e8145283ff804f149005eed842b6889d5dec69ee47f56444266",
  verification: "source bytes and official list confirmed by CTO",
} as const);

const productRows: readonly ProductCatalogEntry[] = ([
  { id: "S01", name: "반복 업무 자동화", tier: "S" },
  { id: "S02", name: "개인 AI 비서 구축", tier: "S" },
  { id: "S03", name: "서비스 연동 자동화", tier: "S" },
  { id: "S04", name: "AI Agent 맞춤 제작", tier: "S" },
  { id: "M01", name: "1인 게임 개발", tier: "M" },
  { id: "M02", name: "AI 소프트웨어 개발", tier: "M" },
  { id: "M03", name: "1인 기업 운영", tier: "M" },
  { id: "M04", name: "콘텐츠 제작", tier: "M" },
  { id: "M05", name: "연구·전문업무", tier: "M" },
  { id: "L01", name: "팀 개발", tier: "L" },
  { id: "L02", name: "게임 개발팀", tier: "L" },
  { id: "L03", name: "팀 업무·협업", tier: "L" },
  { id: "L04", name: "AI Agent 협업 워크스테이션", tier: "L" },
  { id: "XL01", name: "기업 통합 업무", tier: "XL" },
  { id: "XL02", name: "기업 AI 운영", tier: "XL" },
  { id: "XL03", name: "산업별 특화 워크스테이션", tier: "XL" },
] satisfies readonly ProductCatalogEntry[]).map(row => Object.freeze(row));

const addOnRows: readonly ProductAddOnEntry[] = [
  { id: "A01", name: "컨설팅" },
  { id: "A02", name: "기능 추가" },
  { id: "A03", name: "외부 프로그램 연동" },
  { id: "A04", name: "이전·업그레이드" },
  { id: "A05", name: "유지보수" },
].map(row => Object.freeze(row));

export const PRODUCT_CATALOG = Object.freeze({
  source: catalogSource,
  products: Object.freeze(productRows),
  addOns: Object.freeze(addOnRows),
});

export type ProductSelectionDraftInput = Readonly<{
  workspaceId: string;
  projectId: string;
  sourceContext: Readonly<{
    sourceIds: readonly string[];
    revisionRefs: readonly string[];
  }>;
  productId?: string;
  productTier?: ProductTier;
  route?: ProductSelectionRoute;
  deliveryTargets?: readonly DeliveryTarget[];
  deliveredProductUsesAI?: boolean;
  addOnIds?: readonly string[];
}>;

/** All claims and references in this draft are reported input, not authenticated evidence. */
export type ProductSelectionDraft = Readonly<{
  status: "draft";
  workspaceId: string;
  projectId: string;
  sourceContext: Readonly<{
    sourceIds: readonly string[];
    revisionRefs: readonly string[];
    verification: "reported-unverified";
  }>;
  productId: string | null;
  productTier: ProductTier | null;
  route: ProductSelectionRoute | null;
  deliveryTargets: readonly DeliveryTarget[] | null;
  deliveredProductUsesAI: boolean | null;
  addOnIds: readonly string[] | null;
  approval: "not-approved";
}>;

export type ProductSelectionParseResult = Readonly<{
  status: ProductSelectionStatus;
  draft: ProductSelectionDraft | null;
  missing: readonly string[];
  errors: readonly string[];
}>;

const tierSet = new Set<string>(PRODUCT_TIERS);
const targetSet = new Set<string>(DELIVERY_TARGETS);
const routeSet = new Set<string>(["FAST", "ASSEMBLY", "CUSTOM"]);
const products = new Map(productRows.map(row => [row.id, row]));
const addOns = new Set(addOnRows.map(row => row.id));
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function plainRecord(value: unknown, allowed: readonly string[], required: readonly string[], label: string,
  errors: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    errors.push(`${label} must be a plain object`);
    return null;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string" || !allowed.includes(key))
    || required.some(key => !keys.includes(key))) {
    errors.push(`${label} has unknown or missing fields`);
    return null;
  }
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      errors.push(`${label}.${key} must be a plain data field`);
      return null;
    }
    out[key] = descriptor.value;
  }
  return out;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value) && value.trim() === value;
}

function parseIds(value: unknown, label: string, errors: string[]): readonly string[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    errors.push(`${label} must be an array`);
    return null;
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) {
    errors.push(`${label} must be dense and have no extra properties`);
    return null;
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      errors.push(`${label}[${index}] must be a plain data value`);
      continue;
    }
    const item: unknown = descriptor.value;
    if (!validId(item)) errors.push(`${label}[${index}] is invalid`);
    else result.push(item);
  }
  if (new Set(result).size !== result.length) errors.push(`${label} contains duplicate IDs`);
  return Object.freeze(result);
}

function invalid(errors: string[]): ProductSelectionParseResult {
  return Object.freeze({ status: "invalid", draft: null, missing: Object.freeze([]), errors: Object.freeze(errors) });
}

/** Parse a draft against trusted caller expectations; the self-asserted IDs do not prove authority. */
function parseProductSelectionDraftInternal(value: unknown, expected: Readonly<{
  workspaceId: string;
  projectId: string;
}>): ProductSelectionParseResult {
  const errors: string[] = [];
  if (!validId(expected?.workspaceId) || !validId(expected?.projectId)) return invalid(["expected workspace/project IDs are invalid"]);
  const row = plainRecord(value,
    ["workspaceId", "projectId", "sourceContext", "productId", "productTier", "route", "deliveryTargets", "deliveredProductUsesAI", "addOnIds"],
    ["workspaceId", "projectId", "sourceContext"], "draft", errors);
  if (!row) return invalid(errors);
  if (!validId(row.workspaceId)) errors.push("draft.workspaceId is invalid");
  else if (row.workspaceId !== expected.workspaceId) errors.push("draft.workspaceId does not match expected workspace");
  if (!validId(row.projectId)) errors.push("draft.projectId is invalid");
  else if (row.projectId !== expected.projectId) errors.push("draft.projectId does not match expected project");

  const source = plainRecord(row.sourceContext, ["sourceIds", "revisionRefs"], ["sourceIds", "revisionRefs"], "draft.sourceContext", errors);
  const sourceIds = source ? parseIds(source.sourceIds, "draft.sourceContext.sourceIds", errors) : null;
  const revisionRefs = source ? parseIds(source.revisionRefs, "draft.sourceContext.revisionRefs", errors) : null;

  let productId: string | null = null;
  if (Object.hasOwn(row, "productId")) {
    if (!validId(row.productId)) errors.push("draft.productId is invalid");
    else if (!products.has(row.productId)) errors.push("draft.productId is unknown or belongs to the add-on axis");
    else productId = row.productId;
  }
  let productTier: ProductTier | null = null;
  if (Object.hasOwn(row, "productTier")) {
    if (typeof row.productTier !== "string" || !tierSet.has(row.productTier)) errors.push("draft.productTier is invalid");
    else productTier = row.productTier as ProductTier;
  }
  if (productId && productTier && products.get(productId)!.tier !== productTier) errors.push("draft.productId tier does not match selected productTier");

  let route: ProductSelectionRoute | null = null;
  if (Object.hasOwn(row, "route")) {
    if (typeof row.route !== "string" || !routeSet.has(row.route)) errors.push("draft.route is invalid");
    else route = row.route as ProductSelectionRoute;
  }
  let deliveryTargets: readonly DeliveryTarget[] | null = null;
  if (Object.hasOwn(row, "deliveryTargets")) {
    const parsed = parseIds(row.deliveryTargets, "draft.deliveryTargets", errors);
    if (parsed) {
      for (const target of parsed) if (!targetSet.has(target)) errors.push(`draft.deliveryTargets includes unsupported target: ${target}`);
      if (new Set(parsed).size !== parsed.length) errors.push("draft.deliveryTargets contains duplicates");
      deliveryTargets = Object.freeze(parsed as DeliveryTarget[]);
    }
  }
  let deliveredProductUsesAI: boolean | null = null;
  if (Object.hasOwn(row, "deliveredProductUsesAI")) {
    if (typeof row.deliveredProductUsesAI !== "boolean") errors.push("draft.deliveredProductUsesAI must be a boolean");
    else deliveredProductUsesAI = row.deliveredProductUsesAI;
  }
  let addOnIds: readonly string[] | null = null;
  if (Object.hasOwn(row, "addOnIds")) {
    const parsed = parseIds(row.addOnIds, "draft.addOnIds", errors);
    if (parsed) {
      for (const id of parsed) if (!addOns.has(id)) errors.push(`draft.addOnIds includes unknown or product-axis ID: ${id}`);
      addOnIds = parsed;
    }
  }
  if (errors.length) return invalid(errors);

  const missing = [
    ...(productId ? [] : ["productId"]), ...(productTier ? [] : ["productTier"]), ...(route ? [] : ["route"]),
    ...(deliveryTargets?.length ? [] : ["deliveryTargets"]),
    ...(deliveredProductUsesAI === null ? ["deliveredProductUsesAI"] : []),
  ];
  const draft: ProductSelectionDraft = Object.freeze({ status: "draft", workspaceId: row.workspaceId as string,
    projectId: row.projectId as string,
    sourceContext: Object.freeze({ sourceIds: sourceIds!, revisionRefs: revisionRefs!, verification: "reported-unverified" }),
    productId, productTier, route, deliveryTargets, deliveredProductUsesAI, addOnIds, approval: "not-approved" });
  return Object.freeze({ status: missing.length ? "incomplete" : "complete", draft,
    missing: Object.freeze(missing), errors: Object.freeze([]) });
}

/** Malformed or uninspectable caller values are invalid inputs, never parser exceptions. */
export function parseProductSelectionDraft(value: unknown, expected: Readonly<{
  workspaceId: string;
  projectId: string;
}>): ProductSelectionParseResult {
  try {
    return parseProductSelectionDraftInternal(value, expected);
  } catch {
    return invalid(["draft or expected workspace/project could not be inspected safely"]);
  }
}

/** Only a complete, structurally valid draft can be projected; projection is not approval. */
export function projectSelectionForApprovedSpecConsumer(value: unknown): Readonly<{
  productTier: ProductTier;
  targets: readonly DeliveryTarget[];
}> | null {
  const parsed = parseStoredProductSelectionDraft(value);
  if (parsed?.status !== "complete" || !parsed.draft) return null;
  return Object.freeze({ productTier: parsed.draft.productTier!, targets: Object.freeze([...parsed.draft.deliveryTargets!]) });
}

export function parseStoredProductSelectionDraft(value: unknown, expected?: { workspaceId: string; projectId: string }) {
  try {
    const draft = plainRecord(value,
      ["status", "workspaceId", "projectId", "sourceContext", "productId", "productTier", "route", "deliveryTargets", "deliveredProductUsesAI", "addOnIds", "approval"],
      ["status", "workspaceId", "projectId", "sourceContext", "productId", "productTier", "route", "deliveryTargets", "deliveredProductUsesAI", "addOnIds", "approval"],
      "draft", []);
    if (!draft || draft.status !== "draft" || draft.approval !== "not-approved") return null;

    const source = plainRecord(draft.sourceContext, ["sourceIds", "revisionRefs", "verification"],
      ["sourceIds", "revisionRefs", "verification"], "draft.sourceContext", []);
    if (!source || source.verification !== "reported-unverified") return null;

    const parsed = parseProductSelectionDraft({
      workspaceId: draft.workspaceId,
      projectId: draft.projectId,
      sourceContext: { sourceIds: source.sourceIds, revisionRefs: source.revisionRefs },
      ...Object.fromEntries(["productId", "productTier", "route", "deliveryTargets", "deliveredProductUsesAI", "addOnIds"]
        .filter(key => draft[key] !== null).map(key => [key, draft[key]])),
    }, expected ?? { workspaceId: draft.workspaceId as string, projectId: draft.projectId as string });
    return parsed.status === "invalid" ? null : parsed;
  } catch {
    return null;
  }
}

/** Persistence is an injected integration boundary; this module does not create a store. */
export type ExistingProductSelectionWriter = Readonly<{
  writeDraft(input: Readonly<{ workspaceId: string; projectId: string; draft: ProductSelectionDraft }>): Promise<unknown>;
}>;

export async function handoffProductSelectionDraft(value: unknown, expected: Readonly<{ workspaceId: string; projectId: string }>,
  writer: ExistingProductSelectionWriter): Promise<Readonly<{ validation: ProductSelectionParseResult; storage: "not-written" | "writer-called" }>> {
  const validation = parseProductSelectionDraft(value, expected);
  if (validation.status === "invalid" || !validation.draft) return Object.freeze({ validation, storage: "not-written" });
  await writer.writeDraft(Object.freeze({ workspaceId: expected.workspaceId, projectId: expected.projectId, draft: validation.draft }));
  return Object.freeze({ validation, storage: "writer-called" });
}
