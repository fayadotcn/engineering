"use client";
import { useState } from "react";
import { useStore } from "../store";
import type { WorkspaceView } from "@shared/types";
import { cn, fmtMoney } from "./shared";
import { FeeWaterfall } from "../FeeWaterfall";

/* ---------------- 费用汇总表（取费） ---------------- */

export function FeeSummaryView({ view }: { view: Extract<WorkspaceView, { kind: "feeSummary" }> }) {
  const { send } = useStore();
  const [details, setDetails] = useState(false);
  return (
    <div className="h-full overflow-auto p-4">
      {view.unpricedCount > 0 && (
        <div className="cost-info warn !mb-3">
          还有 {view.unpricedCount} 项未报价，以下总价尚不完整。请先在清单页点击“自动测算”。
        </div>
      )}
      {view.issues?.filter((i) => i.label !== "清单未定价").map((i) => (
        <div key={i.label} className={cn("cost-info !mb-3", i.level === "error" ? "error" : "warn")}>
          <b>{i.label}</b>：{i.detail}
        </div>
      ))}
      <div className="xl-sheet mb-3 rounded-lg px-4 pb-2.5 pt-3">
        <FeeWaterfall rows={view.rows} grandTotal={view.grandTotal}
          onFix={() => void send?.("帮我完善计价设置，把还没计取的费用（措施费、规费、税金等）算出来，重新汇总费用")} />
      </div>
      <details className="cost-simple-more mb-3"><summary>更多信息</summary><div className="cost-more-body"><label><input type="checkbox" checked={details} onChange={e => setDetails(e.target.checked)} />显示计算基础和费率</label></div></details>
      <div className="xl-sheet overflow-auto rounded-lg">
        <table className="xl-table table-fixed">
          <thead>
            <tr>
              <th className="w-16 text-center">序号</th>
              <th>费用名称</th>
              {details && <><th>计算基础</th><th className="w-20 text-right">费率</th></>}
              <th className="w-32 text-right">金额（元）</th>
              <th className="w-40">备注</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r) => (
              <tr
                key={r.seq}
                style={
                  r.level === "total"
                    ? { background: "color-mix(in srgb, var(--brand-accent) 8%, var(--surface))" }
                    : r.level === "subtotal"
                      ? { background: "var(--sidebar)" }
                      : undefined
                }
              >
                <td className="text-center text-neutral-500">{r.seq}</td>
                <td className={cn("truncate", r.level !== "leaf" && "font-medium")} title={r.name}>{r.name}</td>
                {details && <><td className="truncate text-neutral-500" title={r.basis}>{r.basis}</td><td className="mono text-right">{r.rate ?? "—"}</td></>}
                <td className={cn("mono text-right", r.level === "total" && "text-[13px] font-semibold", r.level === "subtotal" && "font-medium")}>
                  {fmtMoney(r.amount)}
                </td>
                <td className="truncate text-[11.5px] text-neutral-400" title={r.note ?? ""}>{r.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {view.indicators?.length ? (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {view.indicators.map((i) => (
            <span key={i.label} className="chip">{i.label} <b className="mono font-medium">{i.value}</b></span>
          ))}
        </div>
      ) : null}
      <div className="mt-3 flex items-baseline justify-end gap-2 text-[12px] text-neutral-500">
        含税工程造价
        <span className="mono text-xl font-semibold" style={{ color: "var(--ink-1)" }}>
          {fmtMoney(view.grandTotal)}
        </span>
        元
      </div>
    </div>
  );
}
