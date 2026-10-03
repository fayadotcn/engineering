"use client";
import { useStore } from "../../store";
import type { BoqItemDTO, PricingPlanLine } from "@shared/types";
import { cn, fmtMoney } from "../shared";

/** 清单行展开：综合单价的定额组价构成，人材机管利+主材逐项可复核到分。 */
export function PriceComposition({ item }: { item: BoqItemDTO }) {
  const { send } = useStore();
  const plan = item.pricingPlan ?? [];
  const lines = plan.filter((l) => !l.suggested);
  const suggested = plan.filter((l) => l.suggested);
  if (!lines.length && !suggested.length) return null;
  const unit = item.unit || "单位";
  const money = (v: string | null | undefined) => (v == null || v === "" ? "—" : fmtMoney(v));
  const sumSub = lines.reduce((a, l) => a + (Number(l.subtotal) || 0), 0);
  const diff = Number(item.unitPrice) - sumSub;
  const line = (l: PricingPlanLine, i: number, dim = false) => (
    <tr key={i} className={cn(dim && "opacity-55")}>
      <td className="max-w-72 py-1 pr-3 align-top">
        <span className="mono mr-1.5 text-[10.5px] text-neutral-400">{l.quotaCode}</span>
        <span className="text-neutral-700">{l.quotaName}</span>
        {l.manual && <span className="chip ml-1 !py-0 !text-[10px]">指定</span>}
        {dim && <span className="chip ml-1 !py-0 !text-[10px]">建议</span>}
        {l.scope && <div className="mt-0.5 text-[10.5px] leading-snug text-neutral-400">{l.scope}</div>}
      </td>
      <td className="mono py-1 align-top text-right">{money(l.labor)}</td>
      <td className="mono py-1 align-top text-right">{money(l.materialAux)}</td>
      <td className="mono py-1 align-top text-right">{money(l.machine)}</td>
      <td className="mono py-1 align-top text-right">{money(l.fee)}</td>
      <td className="max-w-56 py-1 align-top text-right text-neutral-500">
        {l.mainMaterialName ? (
          <span title={`主材费 = 耗量 × 主材价 = ${money(l.mainQty)} × ${money(l.mainPrice)} 元`}>
            <span className="text-neutral-600">{l.mainMaterialName}</span>{" "}
            <span className="mono">{money(l.mainQty)}×{money(l.mainPrice)}</span>
          </span>
        ) : "—"}
      </td>
      <td className="mono py-1 align-top text-right font-medium text-neutral-700">{money(l.subtotal)}</td>
    </tr>
  );
  return (
    <div className="border-l-2 px-4 py-2.5" style={{ borderColor: "var(--brand-ink)", background: "color-mix(in srgb, var(--brand-soft) 16%, var(--surface))" }}>
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[11.5px] font-medium text-neutral-700">综合单价构成</span>
        <span className="text-[11px] text-neutral-400">
          {item.name} · <b className="mono font-medium text-neutral-600">{fmtMoney(item.unitPrice)}</b> 元/{unit} · 由 {lines.length} 条定额子目组成
        </span>
        <button
          type="button"
          className="ml-auto shrink-0 text-[11px] text-[var(--brand-ink)] hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            void send?.(`帮我核对清单项「${item.name}」的综合单价构成：定额子目是否齐全、人材机与主材价取费是否合理`);
          }}
        >
          让助手核对组价 →
        </button>
      </div>
      <table className="w-full text-[11.5px]">
        <thead>
          <tr className="text-left text-[10.5px] text-neutral-400">
            <th className="pb-1 font-normal">定额子目</th>
            <th className="pb-1 text-right font-normal">人工费</th>
            <th className="pb-1 text-right font-normal">辅材</th>
            <th className="pb-1 text-right font-normal">机械</th>
            <th className="pb-1 text-right font-normal">管利</th>
            <th className="pb-1 text-right font-normal">主材（耗量×价）</th>
            <th className="pb-1 text-right font-normal">小计（元）</th>
          </tr>
        </thead>
        <tbody className="text-neutral-600">
          {lines.map((l, i) => line(l, i))}
          {suggested.length > 0 && (
            <tr>
              <td colSpan={7} className="pt-1.5 text-[10.5px] text-neutral-400">
                — 建议增列的子目（未计入单价，可由助手确认后追加） —
              </td>
            </tr>
          )}
          {suggested.map((l, i) => line(l, i, true))}
        </tbody>
      </table>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-neutral-200/70 pt-1.5 text-[11px] text-neutral-500">
        <span>
          子目小计合计 <b className="mono">{fmtMoney(sumSub)}</b> 元/{unit}
        </span>
        {lines.length > 0 && (Math.abs(diff) <= 0.01 ? (
          <span className="text-neutral-400">· 与综合单价一致</span>
        ) : (
          <span style={{ color: "var(--warning-soft-fg)" }}>
            · 与综合单价差 {fmtMoney(diff)}，可能有未计入的调整
          </span>
        ))}
        <span className="ml-auto text-neutral-400">金额均为每{unit}口径</span>
      </div>
    </div>
  );
}
