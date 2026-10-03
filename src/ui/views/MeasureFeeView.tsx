"use client";
import type { WorkspaceView } from "@shared/types";
import { fmtMoney } from "./shared";

/* ---------------- 措施费计取（官方系数） ---------------- */

export function MeasureFeeView({ view }: { view: Extract<WorkspaceView, { kind: "measureFee" }> }) {
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-3 text-[12px] text-neutral-500">
        基数为定额测算的分册定额人工费；费率档按檐口/操作物高度自动选档。计取结果已写入台账「系数措施费」，费用汇总表自动采用。
      </div>
      <div className="xl-sheet overflow-auto rounded-lg">
        <table className="xl-table">
          <thead>
            <tr>
              <th>费用项目</th>
              <th className="w-12 text-center">分册</th>
              <th>档位</th>
              <th>计算基数</th>
              <th className="w-16 text-right">费率</th>
              <th className="w-28 text-right">金额（元）</th>
              <th className="w-40 text-right">其中：人工/材料/机械</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r, i) => (
              <tr key={i}>
                <td>{r.name}</td>
                <td className="text-center"><span className="chip">{r.book}</span></td>
                <td className="text-[11.5px] text-neutral-500">{r.tier}</td>
                <td className="text-[11.5px] text-neutral-500">{r.basis}</td>
                <td className="mono text-right">{r.rate}</td>
                <td className="mono text-right font-medium">{fmtMoney(r.amount)}</td>
                <td className="mono text-right text-[11px] text-neutral-400">
                  {[r.laborPart, r.materialPart, r.machinePart].map((p) => (p ? fmtMoney(p) : "—")).join(" / ")}
                </td>
              </tr>
            ))}
            <tr style={{ background: "color-mix(in srgb, var(--brand-accent) 8%, var(--surface))" }}>
              <td className="font-medium">合计</td>
              <td colSpan={4} />
              <td className="mono text-right font-semibold">{fmtMoney(view.total)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      {view.skipped.length > 0 && (
        <div className="cost-info warn !mb-0 mt-3">
          未计取：{view.skipped.slice(0, 8).map((s) => `${s.name}（${s.reason}）`).join("；")}
          {view.skipped.length > 8 ? ` 等 ${view.skipped.length} 项` : ""}
        </div>
      )}
    </div>
  );
}
