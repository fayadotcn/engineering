"use client";
import { useState } from "react";
import type { WorkspaceView } from "@shared/types";
import { cn, fmtMoney } from "./shared";

/* ---------------- 清单对审 ---------------- */

const CMP_LABEL: Record<string, string> = {
  SAME: "一致", PRICE_DIFF: "价差", QTY_DIFF: "量差",
  BOTH_DIFF: "量价均差", ONLY_A: "仅A有", ONLY_B: "仅B有",
};
const CMP_STYLE: Record<string, string> = {
  SAME: "opacity-60", PRICE_DIFF: "warn",
  QTY_DIFF: "info", BOTH_DIFF: "danger",
  ONLY_A: "", ONLY_B: "ok",
};

export function FileCompareView({ view }: { view: Extract<WorkspaceView, { kind: "fileCompare" }> }) {
  const [filter, setFilter] = useState<string>("DIFF");
  const rows = view.rows.filter((r) =>
    filter === "ALL" ? true
    : filter === "DIFF" ? r.status !== "SAME"
    : r.status === filter
  );
  const s = view.summary;
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-[var(--surface)] px-4 py-2 text-[12px]">
        <span className="text-neutral-500">
          差额合计 <b className="mono text-neutral-800">{fmtMoney(s.totalDelta)}</b> 元
        </span>
        {(s as { qtyOver15?: number }).qtyOver15 ? (
          <span className="chip danger" title="GB50500：工程量偏差超15%应重新组价/调整综合单价">
            {(s as { qtyOver15?: number }).qtyOver15} 项量差&gt;15% 应调价
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {[
            ["DIFF", `差异 ${s.total - s.same}`],
            ["ONLY_A", `仅A ${s.onlyA}`],
            ["ONLY_B", `仅B ${s.onlyB}`],
            ["SAME", `一致 ${s.same}`],
            ["ALL", `全部 ${s.total}`],
          ].map(([k, l]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              aria-pressed={filter === k}
              className={cn(
                "rounded px-2 py-1 text-[11.5px] transition-colors",
                filter === k
                  ? "font-medium text-[var(--bg)]"
                  : "text-neutral-500 hover:bg-[var(--hover)]"
              )}
              style={filter === k ? { background: "var(--ink-1)" } : undefined}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-xs text-neutral-500">
        <span className="break-words">A：{view.labelA}
          {(view.stageA || view.periodA) && <em className="chip info ml-1 !text-[10.5px] not-italic">{[view.stageA, view.periodA].filter(Boolean).join(" · ")}</em>}
        </span>
        <span className="text-neutral-300">↔</span>
        <span className="break-words">B：{view.labelB}
          {(view.stageB || view.periodB) && <em className="chip warn ml-1 !text-[10.5px] not-italic">{[view.stageB, view.periodB].filter(Boolean).join(" · ")}</em>}
        </span>
      </div>
      {!!view.declared?.labels.length && (
        <details className="mx-4 mb-2 rounded-lg border border-neutral-200 bg-[var(--surface)]" open={view.declared.labels.some(l => l.label === "合计" && Math.abs(l.diff) > 0)}>
          <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-neutral-700">申报口径对比（源表汇总真值）</summary>
          <table className="xl-table text-[12px]">
            <thead><tr><th>口径</th><th className="w-28 text-right">A 申报</th><th className="w-28 text-right">B 申报</th><th className="w-28 text-right">差（B−A）</th></tr></thead>
            <tbody>
              {view.declared.labels.map(l => (
                <tr key={l.label}>
                  <td>{l.label}</td>
                  <td className="mono text-right">{fmtMoney(l.a)}</td>
                  <td className="mono text-right">{fmtMoney(l.b)}</td>
                  <td className={cn("mono text-right", l.diff !== 0 && "font-medium text-amber-700")}>{l.diff > 0 ? "+" : ""}{fmtMoney(l.diff)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!!view.declared.units.filter(u => u.side !== "both" || u.diff !== 0).length && (
            <div className="border-t border-neutral-100 px-3 py-2">
              <p className="mb-1 text-[11px] text-neutral-400">变动集中在这些单位工程：</p>
              <div className="flex flex-wrap gap-1.5">
                {view.declared.units.filter(u => u.side !== "both" || u.diff !== 0).map(u => (
                  <span key={u.name} className="chip" title={`A ${fmtMoney(u.a)} → B ${fmtMoney(u.b)}`}>
                    {u.name} {u.side === "a" ? "（仅A）" : u.side === "b" ? "（仅B）" : `${u.diff > 0 ? "+" : ""}${fmtMoney(u.diff)}`}
                  </span>
                ))}
              </div>
            </div>
          )}
        </details>
      )}
      <div className="flex-1 overflow-auto">
        <table className="xl-table xl-pin-last text-[12px]">
          <thead>
            <tr>
              <th className="xl-rn"></th>
              <th className="w-24">编码</th>
              <th>名称</th>
              <th className="w-16">状态</th>
              <th className="w-16 text-right" title={view.labelA}>A量</th>
              <th className="w-16 text-right" title={view.labelB}>B量</th>
              <th className="w-20 text-right">A单价</th>
              <th className="w-20 text-right">B单价</th>
              <th className="w-24 text-right">差额</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={r.key}>
                <td className="xl-rn">{ri + 1}</td>
                <td className="mono text-neutral-500">{r.code || "—"}</td>
                <td className="max-w-44 truncate" title={r.name}>{r.name}</td>
                <td>
                  <span className={cn("chip !text-[10.5px]", CMP_STYLE[r.status])}>
                    {CMP_LABEL[r.status]}
                  </span>
                  {r.qtyOver15 && (
                    <span className="chip danger ml-1 !py-px !text-[9.5px]" title="量差超15%，应重新组价">
                      &gt;15%
                    </span>
                  )}
                </td>
                <td className="mono text-right">{r.aQty ?? "—"}</td>
                <td className={cn("mono text-right", r.qtyDelta && "font-medium text-blue-700")}>{r.bQty ?? "—"}</td>
                <td className="mono text-right">{r.aPrice ?? "—"}</td>
                <td className={cn("mono text-right", r.priceDelta && "font-medium text-amber-700")}>{r.bPrice ?? "—"}</td>
                <td className={cn("mono text-right", Number(r.totalDelta) !== 0 && "font-medium")}>
                  {r.totalDelta ? fmtMoney(r.totalDelta) : "—"}
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={9} className="py-8 text-center text-neutral-500">{filter === "DIFF" ? "两版清单没有差异" : "该类别没有清单项"}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
