"use client";
import { useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import type { WorkspaceView } from "@shared/types";
import { cn, fmtMoney } from "./shared";

/* ---------------- 清单对审 ---------------- */

const CMP_LABEL: Record<string, string> = {
  SAME: "一致", PRICE_DIFF: "价差", QTY_DIFF: "量差",
  BOTH_DIFF: "量价均差", ONLY_A: "仅A有", ONLY_B: "仅B有",
};
const CMP_STYLE: Record<string, BadgeVariant> = {
  SAME: "secondary", PRICE_DIFF: "warning",
  QTY_DIFF: "info", BOTH_DIFF: "danger",
  ONLY_A: "secondary", ONLY_B: "success",
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
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-[var(--card)] px-4 py-2 text-[12px]">
        <span className="text-muted-foreground">
          差额合计 <b className="mono text-foreground">{fmtMoney(s.totalDelta)}</b> 元
        </span>
        {(s as { qtyOver15?: number }).qtyOver15 ? (
          <Badge variant="danger"  title="GB50500：工程量偏差超15%应重新组价/调整综合单价">
            {(s as { qtyOver15?: number }).qtyOver15} 项量差&gt;15% 应调价
          </Badge>
        ) : null}
        {(s as { compliance?: number }).compliance ? (
          <Badge variant="warning"  title="能对齐的两版清单行中，名称/单位/项目特征不响应招标口径的条数（五统一符合性）">
            {(s as { compliance?: number }).compliance} 项五统一不符
          </Badge>
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
                  ? "font-medium text-[var(--background)]"
                  : "text-muted-foreground hover:bg-[var(--accent)]"
              )}
              style={filter === k ? { background: "var(--foreground)" } : undefined}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-xs text-muted-foreground">
        <span className="break-words">A：{view.labelA}
          {(view.stageA || view.periodA) && <Badge variant="info" className="ml-1 !text-[10.5px] not-italic" >{[view.stageA, view.periodA].filter(Boolean).join(" · ")}</Badge>}
        </span>
        <span className="text-muted-foreground">↔</span>
        <span className="break-words">B：{view.labelB}
          {(view.stageB || view.periodB) && <Badge variant="warning" className="ml-1 !text-[10.5px] not-italic" >{[view.stageB, view.periodB].filter(Boolean).join(" · ")}</Badge>}
        </span>
      </div>
      {!!view.declared?.labels.length && (
        <details className="mx-4 mb-2 rounded-lg border border-border bg-[var(--card)]" open={view.declared.labels.some(l => l.label === "合计" && Math.abs(l.diff) > 0)}>
          <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-foreground">申报口径对比（源表汇总真值）</summary>
          <table className="xl-table text-[12px]">
            <thead><tr><th>口径</th><th className="w-28 text-right">A 申报</th><th className="w-28 text-right">B 申报</th><th className="w-28 text-right">差（B−A）</th></tr></thead>
            <tbody>
              {view.declared.labels.map(l => (
                <tr key={l.label}>
                  <td>{l.label}</td>
                  <td className="mono text-right">{fmtMoney(l.a)}</td>
                  <td className="mono text-right">{fmtMoney(l.b)}</td>
                  <td className={cn("mono text-right", l.diff !== 0 && "font-medium text-[var(--warning-soft-fg)]")}>{l.diff > 0 ? "+" : ""}{fmtMoney(l.diff)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!!view.declared.units.filter(u => u.side !== "both" || u.diff !== 0).length && (
            <div className="border-t border-border px-3 py-2">
              <p className="mb-1 text-[11px] text-muted-foreground">变动集中在这些单位工程：</p>
              <div className="flex flex-wrap gap-1.5">
                {view.declared.units.filter(u => u.side !== "both" || u.diff !== 0).map(u => (
                  <Badge variant="secondary" key={u.name}  title={`A ${fmtMoney(u.a)} → B ${fmtMoney(u.b)}`}>
                    {u.name} {u.side === "a" ? "（仅A）" : u.side === "b" ? "（仅B）" : `${u.diff > 0 ? "+" : ""}${fmtMoney(u.diff)}`}
                  </Badge>
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
                <td className="mono text-muted-foreground">{r.code || "—"}</td>
                <td className="max-w-44 truncate" title={r.name}>{r.name}</td>
                <td>
                  <Badge variant={CMP_STYLE[r.status] ?? "secondary"} className={cn("!text-[10.5px]", r.status === "SAME" && "opacity-60")}>
                    {CMP_LABEL[r.status]}
                  </Badge>
                  {r.qtyOver15 && (
                    <Badge variant="danger" className="ml-1 !py-px !text-[9.5px]"  title="量差超15%，应重新组价">
                      &gt;15%
                    </Badge>
                  )}
                  {r.nameMismatch && (
                    <Badge variant="warning" className="ml-1 !py-px !text-[9.5px]"  title="两版名称原文不一致（五统一）">名称异</Badge>
                  )}
                  {r.unitMismatch && (
                    <Badge variant="danger" className="ml-1 !py-px !text-[9.5px]"  title="两版单位量纲不一致（五统一）">单位异</Badge>
                  )}
                  {r.featureConflict?.length ? (
                    <Badge variant="warning" className="ml-1 !py-px !text-[9.5px]"  title={r.featureConflict.join("；")}>特征异</Badge>
                  ) : null}
                </td>
                <td className="mono text-right">{r.aQty ?? "—"}</td>
                <td className={cn("mono text-right", r.qtyDelta && "font-medium text-[var(--info-soft-fg)]")}>{r.bQty ?? "—"}</td>
                <td className="mono text-right">{r.aPrice ?? "—"}</td>
                <td className={cn("mono text-right", r.priceDelta && "font-medium text-[var(--warning-soft-fg)]")}>{r.bPrice ?? "—"}</td>
                <td className={cn("mono text-right", Number(r.totalDelta) !== 0 && "font-medium")}>
                  {r.totalDelta ? fmtMoney(r.totalDelta) : "—"}
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={9} className="py-8 text-center text-muted-foreground">{filter === "DIFF" ? "两版清单没有差异" : "该类别没有清单项"}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
