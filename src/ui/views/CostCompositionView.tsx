"use client";
import type { CostCompositionRow, WorkspaceView } from "@shared/types";
import { EmptyState } from "../primitives";
import { fmtMoney, PALETTE } from "./shared";

/* ---------------- 人材机成本构成 ---------------- */

const COST_SOURCE_LABEL: Record<CostCompositionRow["source"], string> = {
  quotaPlan: "定额组价",
  imported: "源表分解",
  partial: "仅主材价",
  none: "无数据",
};

export function CostCompositionView({ view }: { view: Extract<WorkspaceView, { kind: "costComposition" }> }) {
  const t = view.totals;
  const c = view.coverage;
  const rev = Number(t.revenue) || 1;
  const buckets = [
    { label: "人工费", amount: t.labor, color: PALETTE[0] },
    { label: "材料费", amount: t.material, color: PALETTE[5] },
    { label: "机械费", amount: t.machine, color: PALETTE[7] },
    { label: "管利及未分解", amount: t.other, color: PALETTE[4] },
  ];
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="chip">可计价 {view.rows.length} 项，合价 {fmtMoney(t.revenue)} 元</span>
        {c.plan > 0 && <span className="chip">定额组价 {c.plan} 项</span>}
        {c.imported > 0 && <span className="chip">源表分解列 {c.imported} 项</span>}
        {c.partial > 0 && <span className="chip">仅主材价 {c.partial} 项</span>}
        {c.none > 0 && (
          <span className="chip warn" title="这些项没有定额组价也没有分解列，合价全部计入「管利及未分解」">
            {c.none} 项无成本数据
          </span>
        )}
        {c.inverted > 0 && <span className="chip danger">{c.inverted} 项成本倒挂（人材机高于合价）</span>}
      </div>

      <div className="mb-4">
        <div className="flex h-3 w-full overflow-hidden rounded">
          {buckets.map((b) => (
            <div key={b.label} style={{ width: `${(Number(b.amount) / rev) * 100}%`, background: b.color }} />
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[12px]">
          {buckets.map((b) => (
            <span key={b.label} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm" style={{ background: b.color }} />
              {b.label}
              <span className="mono text-neutral-500">{fmtMoney(b.amount)}</span>
              <span className="mono text-neutral-400">{((Number(b.amount) / rev) * 100).toFixed(1)}%</span>
            </span>
          ))}
          {t.marginRate !== null && (
            <span className="ml-auto text-neutral-500">
              可算口径毛利 <span className="mono font-medium">{fmtMoney(t.margin)}</span> 元
              （{t.marginRate}%，覆盖 {fmtMoney(t.marginRevenue)} 元）
            </span>
          )}
        </div>
      </div>

      <div className="xl-sheet overflow-auto rounded-lg">
        <table className="xl-table">
          <thead>
            <tr>
              <th className="xl-rn"></th>
              <th className="w-28">编码</th>
              <th>名称</th>
              <th className="w-16 text-right">工程量</th>
              <th className="w-28 text-right">合价</th>
              <th className="w-24 text-right">人工费</th>
              <th className="w-24 text-right">材料费</th>
              <th className="w-24 text-right">机械费</th>
              <th className="w-24 text-right">管利及其他</th>
              <th className="w-20 text-right">毛利率</th>
              <th className="w-20">来源</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r, i) => (
              <tr key={r.itemId} style={r.inverted ? { background: "var(--danger-soft-bg)" } : undefined}>
                <td className="xl-rn">{i + 1}</td>
                <td className="mono text-neutral-500">{r.code || "—"}</td>
                <td className="max-w-56 truncate" title={r.name}>{r.name}</td>
                <td className="mono text-right">{r.quantity}<span className="text-neutral-400"> {r.unit}</span></td>
                <td className="mono text-right">{fmtMoney(r.revenue)}</td>
                <td className="mono text-right">{r.labor === null ? <span className="text-neutral-300">—</span> : fmtMoney(r.labor)}</td>
                <td className="mono text-right">{r.material === null ? <span className="text-neutral-300">—</span> : fmtMoney(r.material)}</td>
                <td className="mono text-right">{r.machine === null ? <span className="text-neutral-300">—</span> : fmtMoney(r.machine)}</td>
                <td className="mono text-right">{fmtMoney(r.other)}</td>
                <td className="mono text-right" style={r.inverted ? { color: "var(--danger-soft-fg)", fontWeight: 600 } : undefined}>
                  {r.marginRate === null ? <span className="text-neutral-300">—</span> : `${r.marginRate}%`}
                </td>
                <td><span className="chip">{COST_SOURCE_LABEL[r.source]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!view.rows.length && <EmptyState title="没有可计价的清单项" />}
    </div>
  );
}
