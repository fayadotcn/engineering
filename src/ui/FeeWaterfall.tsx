"use client";
import { useMemo } from "react";
import { cn, fmtMoney, PALETTE } from "./views/shared";

/* ---------------- 费用瀑布（费用汇总视图与概况页仪表盘共用） ---------------- */

export interface FeeRowLike {
  name: string;
  amount: string;
  level: "leaf" | "subtotal" | "total";
  basis?: string;
}

// 大额缩写：构成图的窄列里放得下
const fmtCompact = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (a >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return v.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
};

// 费用瀑布：分项费用叠在累计水位上，税前/含税是落地柱 —— 一眼看清「钱是怎么一步步加出来的」
const FEE_STEP_COLORS = [PALETTE[0], PALETTE[1], PALETTE[7], PALETTE[5], PALETTE[9]];

export function FeeWaterfall({
  rows,
  grandTotal,
  onFix,
}: {
  rows: FeeRowLike[];
  grandTotal: string;
  /** 存在未计取费用行时的补救入口；不传则只提示不引导 */
  onFix?: () => void;
}) {
  const steps = useMemo(() => {
    let cum = 0;
    let leaf = 0;
    return (rows ?? []).map((r) => {
      const amount = Number(r.amount) || 0;
      const name = r.name.replace(/工程造价|工程费|项目费/g, "");
      if (r.level === "leaf") {
        const s = { name, basis: r.basis, amount, base: cum, top: cum + amount, solid: false, color: FEE_STEP_COLORS[leaf++ % FEE_STEP_COLORS.length] };
        cum += amount;
        return s;
      }
      cum = amount;
      return { name, basis: r.basis, amount, base: 0, top: amount, solid: true, color: r.level === "total" ? "var(--chart-total)" : PALETTE[3] };
    });
  }, [rows]);
  if (!steps.length) return null;
  const max = Math.max(...steps.map((s) => s.top), 1);
  const grand = Number(grandTotal) || 0;
  const missing = steps.filter((s) => !s.solid && s.amount === 0).map((s) => s.name);
  return (
    <div aria-hidden="true">
      <div className="flex items-end gap-1.5" style={{ height: 112 }}>
        {steps.map((s, i) => (
          <div key={i} className="relative h-full min-w-0 flex-1" title={`${s.name}　${fmtMoney(s.amount)} 元${s.basis ? `（${s.basis}）` : ""}`}>
            <div
              className="absolute rounded-[3px]"
              style={{
                left: "18%",
                right: "18%",
                bottom: `${(s.base / max) * 100}%`,
                height: `${Math.max((s.amount / max) * 100, s.amount > 0 ? 1.2 : 0)}%`,
                background: s.color,
              }}
            />
            {i < steps.length - 1 && (
              <div
                className="absolute border-t border-dashed"
                style={{ left: "82%", width: "calc(36% + 6px)", bottom: `${(s.top / max) * 100}%`, borderColor: "var(--chart-line)" }}
              />
            )}
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1.5 border-t border-neutral-100 pt-1.5">
        {steps.map((s, i) => (
          <div key={i} className="min-w-0 flex-1 text-center leading-tight">
            <div className={cn("truncate text-[11px]", s.solid ? "font-medium text-neutral-700" : "text-neutral-500")}>{s.name}</div>
            <div className={cn("mono truncate text-[11px]", s.solid ? "text-neutral-700" : "text-neutral-500")}>{fmtCompact(s.amount)}</div>
            <div className="text-[10px] text-neutral-400">
              {s.solid ? "\u00a0" : s.amount > 0 && grand > 0
                ? `${((s.amount / grand) * 100).toFixed(1)}%`
                : <span style={{ color: "var(--warning-soft-fg)" }}>未计</span>}
            </div>
          </div>
        ))}
      </div>
      {missing.length > 0 && (
        <div className="mt-2 flex items-center justify-between gap-3 border-t border-neutral-100 pt-2 text-[11.5px]">
          <span className="text-neutral-500">{missing.join("、")}还没计取，总价不完整。</span>
          {onFix && (
            <button className="shrink-0 text-[var(--brand-ink)] hover:underline" onClick={onFix}>
              让助手补齐 →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
