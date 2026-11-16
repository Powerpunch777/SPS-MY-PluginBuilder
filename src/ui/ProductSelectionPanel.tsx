import { useRef, useState } from "react";
import { Save } from "lucide-react";
import { DELIVERY_TARGETS, PRODUCT_TIERS, type DeliveryTarget, type ProductTier } from "../domain/specification-revisions.ts";
import { PRODUCT_CATALOG, parseStoredProductSelectionDraft, type ProductSelectionDraft, type ProductSelectionDraftInput, type ProductSelectionRoute } from "../product-selection/index.ts";

type Selection = Omit<ProductSelectionDraftInput, "workspaceId" | "projectId">;
export type ProductSelectionSave = { requestId: string; expectedRevisionId: string | null; selection: Selection };
type RecordView = { revisionId: string; draft: ProductSelectionDraft };
const targetNames: Record<DeliveryTarget, string> = {
  "sps-plugin": "SPS 플러그인", desktop: "데스크톱", "web-api": "웹·API",
  "cli-automation": "CLI·자동화", "agent-workflow": "Agent 워크플로", hybrid: "복합",
};

function readRecord(value: unknown, workspaceId: string): RecordView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.workspaceId !== workspaceId || record.projectId !== workspaceId
    || typeof record.revisionId !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(record.revisionId)
    || !Number.isSafeInteger(record.sequence) || (record.sequence as number) < 1) return null;
  const parsed = parseStoredProductSelectionDraft(record.draft, { workspaceId, projectId: workspaceId });
  return parsed?.draft && parsed.status === record.status ? { revisionId: record.revisionId, draft: parsed.draft } : null;
}

function ProductSelectionForm({ record, save }: { record: RecordView | null; save(input: ProductSelectionSave): Promise<unknown> }) {
  const draft = record?.draft;
  const [tier, setTier] = useState<ProductTier | "">(draft?.productTier ?? "");
  const [product, setProduct] = useState(draft?.productId ?? "");
  const [route, setRoute] = useState<ProductSelectionRoute | "">(draft?.route ?? "");
  const [targets, setTargets] = useState<readonly DeliveryTarget[]>(draft?.deliveryTargets ?? []);
  const [ai, setAi] = useState(draft?.deliveredProductUsesAI == null ? "" : String(draft.deliveredProductUsesAI));
  const [addOns, setAddOns] = useState<readonly string[]>(draft?.addOnIds ?? []);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [failed, setFailed] = useState(false);
  const pending = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const products = tier ? PRODUCT_CATALOG.products.filter(row => row.tier === tier) : PRODUCT_CATALOG.products;
  const chosen = PRODUCT_CATALOG.products.find(row => row.id === product);
  const toggle = <T extends string,>(items: readonly T[], item: T) => items.includes(item)
    ? items.filter(value => value !== item) : [...items, item];

  return <form className="builder-product-selection" onSubmit={async event => {
    event.preventDefault();
    if (busy) return;
    const expectedRevisionId = record?.revisionId ?? null;
    const selection: Selection = {
      sourceContext: { sourceIds: draft?.sourceContext.sourceIds ?? [], revisionRefs: draft?.sourceContext.revisionRefs ?? [] },
      ...(tier ? { productTier: tier } : {}), ...(product ? { productId: product } : {}),
      ...(route ? { route } : {}), deliveryTargets: targets,
      ...(ai ? { deliveredProductUsesAI: ai === "true" } : {}), addOnIds: addOns,
    };
    const fingerprint = JSON.stringify([expectedRevisionId, selection]);
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, requestId: crypto.randomUUID() };
    setBusy(true); setNotice(""); setFailed(false);
    try {
      const result = await save({ requestId: pending.current.requestId, expectedRevisionId, selection });
      if (!result || typeof result !== "object" || !("status" in result)) throw new Error("Invalid selection receipt.");
      if (result.status === "conflict") {
        setFailed(true); setNotice("다른 곳에서 초안이 변경됐습니다. 새로고침 후 다시 선택해 주세요.");
      } else if (result.status === "saved") {
        pending.current = null; setNotice("상품 선택 초안을 저장했습니다.");
      } else throw new Error("Selection was not saved.");
    } catch {
      setFailed(true); setNotice("저장을 확인하지 못했습니다. 기존 초안은 유지됩니다.");
    } finally { setBusy(false); }
  }}>
    <fieldset disabled={busy}>
      <legend>선택 초안</legend>
      <div className="builder-product-fields">
        <label>상품 규모<select aria-label="상품 규모" value={tier} onChange={event => {
          const next = event.currentTarget.value as ProductTier | "";
          setTier(next); if (chosen && chosen.tier !== next) setProduct("");
        }}><option value="">미정</option>{PRODUCT_TIERS.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>상품<select aria-label="상품" value={product} onChange={event => {
          const id = event.currentTarget.value;
          setProduct(id);
          const entry = PRODUCT_CATALOG.products.find(row => row.id === id);
          if (entry) setTier(entry.tier);
        }}><option value="">미정</option>{products.map(row => <option key={row.id} value={row.id}>{row.id} · {row.name}</option>)}</select></label>
        <label>개발 방식<select aria-label="개발 방식" value={route} onChange={event => setRoute(event.currentTarget.value as ProductSelectionRoute | "")}>
          <option value="">미정</option><option>FAST</option><option>ASSEMBLY</option><option>CUSTOM</option>
        </select></label>
        <label>납품 제품의 AI 사용<select aria-label="납품 제품의 AI 사용" value={ai} onChange={event => setAi(event.currentTarget.value)}>
          <option value="">미정</option><option value="true">사용</option><option value="false">사용 안 함</option>
        </select></label>
      </div>
    </fieldset>
    <fieldset disabled={busy}><legend>납품 대상</legend><div className="builder-product-options">
      {DELIVERY_TARGETS.map(target => <label key={target}><input type="checkbox" checked={targets.includes(target)}
        onChange={() => setTargets(toggle(targets, target))} />{targetNames[target]}</label>)}
    </div></fieldset>
    <fieldset disabled={busy}><legend>부가 서비스</legend><div className="builder-product-options">
      {PRODUCT_CATALOG.addOns.map(item => <label key={item.id}><input type="checkbox" checked={addOns.includes(item.id)}
        onChange={() => setAddOns(toggle(addOns, item.id))} />{item.name}</label>)}
    </div></fieldset>
    <div className="builder-product-actions">
      <button type="submit" className="builder-quiet-button" disabled={busy}><Save aria-hidden="true" />{busy ? "저장 중" : "초안 저장"}</button>
      {notice && <span role={failed ? "alert" : "status"}>{notice}</span>}
    </div>
  </form>;
}

export function ProductSelectionPanel({ workspaceId, value, loading, unavailable, save }: {
  workspaceId: string; value: unknown; loading: boolean; unavailable: boolean; save(input: ProductSelectionSave): Promise<unknown>;
}) {
  const record = readRecord(value, workspaceId);
  if (unavailable || (!loading && value != null && !record)) return <p className="builder-product-selection" role="alert">상품 선택 초안을 불러오지 못했습니다.</p>;
  if (loading && !record) return <p className="builder-product-selection" role="status">상품 선택 초안을 불러오는 중입니다.</p>;
  return <ProductSelectionForm key={record?.revisionId ?? "initial"} record={record} save={save} />;
}
