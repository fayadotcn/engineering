"use client";
import { Fragment, useState } from "react";
import type { WorkspaceView } from "@shared/types";
import { ChevronDown } from "lucide-react";
import { EmptyState } from "../primitives";
import { cn, fmtMoney } from "./shared";

/* ---------------- 定额测算 ---------------- */

export function QuotaResult({ view }: { view: Extract<WorkspaceView, { kind: "quotaResult" }> }) {
  const [open, setOpen] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const matched = view.rows.filter((r) => r.quotaCode).length;
  const needMain = view.rows.filter((r) => r.needsMainPrice).length;
  const ambiguous = view.rows.filter((r) => r.ambiguous).length;
  const deviant = view.rows.filter(
    (r) => r.deviation !== null && Math.abs(Number(r.deviation)) > 20
  ).length;
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="chip">{view.rows.length} 项中，{matched} 项找到定额</span>
        {needMain > 0 && <span className="chip warn">{needMain} 项还缺材料价</span>}
        {ambiguous > 0 && (
          <span className="chip warn" title="存在得分相近且基价不同的备选子目，点击行可查看备选，或查定额说明核实">
            {ambiguous} 项需要核对定额
          </span>
        )}
        {deviant > 0 && <span className="chip danger">{deviant} 项偏差 &gt;20%</span>}
      </div>
      <details className="cost-simple-more mb-3"><summary>查看费用构成和计算方法</summary><div className="cost-more-body"><label><input type="checkbox" checked={details} onChange={e => setDetails(e.target.checked)} />显示人工、材料、机械和取费</label><p className="w-full text-xs text-neutral-500">综合单价 = 人工+辅材+机械 + 主材价×耗量 + (人工+机械)×(管理费{(view.mgmtRate * 100).toFixed(0)}%+利润{(view.profitRate * 100).toFixed(0)}%)</p></div></details>
      <div className="xl-sheet overflow-auto rounded-lg">
      <table className="xl-table xl-pin-last">
        <thead>
          <tr>
            <th className="xl-rn"></th>
            <th>清单项</th>
            <th>状态 / 明细</th>
            {details && <><th className="text-right">人工</th><th className="text-right">辅材</th><th className="text-right">机械</th><th className="text-right">主材</th><th className="text-right">管+利</th></>}
            <th className="text-right">建议单价（元）</th>
            <th className="text-right">原单价（元）</th>
            <th className="text-right">偏差</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((r, ri) => {
            const expanded = open === r.itemId;
            const hasDetail = !!r.quotaCode;
            return (
            <Fragment key={r.itemId}>
            <tr
              key={r.itemId}
              className={cn(hasDetail && "cursor-pointer")}
              onClick={() => hasDetail && setOpen(expanded ? null : r.itemId)}
              title={hasDetail ? "点击查看定额工作内容" : undefined}
            >
              <td className="xl-rn">{ri + 1}</td>
              <td className="max-w-40 truncate" title={r.name}>{r.name}</td>
              <td className="text-neutral-500">
                {r.quotaCode ? (
                  <button disabled={!hasDetail} aria-label={`查看${r.name}的定额工作内容`} aria-expanded={expanded} onClick={e => { e.stopPropagation(); if (hasDetail) setOpen(expanded ? null : r.itemId); }} className="mono inline-flex items-center gap-1 text-[11px]">
                    {hasDetail && <ChevronDown className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")} />}
                    {details ? r.quotaCode : "查看明细"}
                    {r.needsMainPrice && <span className="chip warn !py-px !text-[9.5px] font-sans">缺材料价</span>}
                    {r.ambiguous && (
                      <span className="chip warn !py-px !text-[9.5px] font-sans" title={r.altQuota ? `备选：${r.altQuota}` : "存在得分相近的备选子目"}>
                        存疑
                      </span>
                    )}
                  </button>
                ) : "未找到定额"}
              </td>
              {details && <><td className="mono text-right">{r.labor ?? "—"}</td>
              <td className="mono text-right">{r.materialAux ?? "—"}</td>
              <td className="mono text-right">{r.machine ?? "—"}</td>
              <td className="mono text-right">
                {r.needsMainPrice ? <span className="text-amber-600">缺主材价</span> : r.mainMaterial ?? "—"}
              </td>
              <td className="mono text-right">{r.fee ?? "—"}</td></>}
              <td className="mono text-right font-medium">{r.calcPrice ?? "—"}{r.needsMainPrice && <div className="text-[10px] font-sans font-normal text-amber-600">未含缺失材料价</div>}</td>
              <td className="mono text-right text-neutral-500">{fmtMoney(r.listPrice)}</td>
              <td className={cn(
                "mono text-right",
                r.deviation !== null && Math.abs(Number(r.deviation)) > 20 && "font-medium text-red-600"
              )}>
                {r.deviation !== null ? `${Number(r.deviation) > 0 ? "+" : ""}${r.deviation}%` : "—"}
              </td>
            </tr>
            {expanded && (
              <tr>
                <td className="xl-rn"></td>
                <td colSpan={details ? 10 : 5} className="whitespace-normal!" style={{ background: "var(--sidebar)" }}>
                  <div className="space-y-1 py-1.5 text-[11.5px] leading-relaxed">
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                      <span className="font-medium text-neutral-700">{r.quotaCode} {r.quotaName}</span>
                      {r.quotaFb && <span className="text-neutral-500">分册：{r.quotaFb}</span>}
                      {r.quotaChapter && <span className="text-neutral-500">章节：{r.quotaChapter}</span>}
                      {r.quotaBase && <span className="text-neutral-500">基价：<span className="mono">{r.quotaBase}</span> 元/{r.quotaCode ? "定额单位" : ""}</span>}
                      {r.quotaMainName && <span className="text-neutral-500">主材：{r.quotaMainName}</span>}
                      {r.ambiguous && r.altQuota && (
                        <span className="text-amber-600">备选子目：{r.altQuota}（基价不同，请结合定额说明核实）</span>
                      )}
                    </div>
                    {r.quotaGcnr && <div className="text-neutral-500">工作内容：{r.quotaGcnr}</div>}
                    {(r.plan?.length ?? 0) > 1 && (
                      <div className="mt-1 border-t border-neutral-200 pt-1">
                        <div className="mb-0.5 font-medium text-neutral-600">组价方案（{r.plan!.filter((l) => !l.suggested).length} 条已计）</div>
                        {r.plan!.map((l, li) => (
                          <div key={li} className="flex items-baseline gap-2 text-neutral-500">
                            <span className="mono">{l.quotaCode}</span>
                            <span className="truncate">{l.quotaName}</span>
                            {l.suggested ? (
                              <span className="chip warn !py-px !text-[9.5px]" title={l.scope}>建议增列</span>
                            ) : l.manual ? (
                              <span className="chip !py-px !text-[9.5px]">人工指定</span>
                            ) : null}
                            <span className="ml-auto mono">{l.subtotal}</span>
                          </div>
                        ))}
                        <div className="text-[10.5px] text-neutral-400">
                          建议增列的子目不计入测算价，确认后用「为该项增列定额」写入组价方案
                        </div>
                      </div>
                    )}
                  </div>
                </td>
              </tr>
            )}
            </Fragment>
            );
          })}
        </tbody>
      </table>
      </div>
      {!view.rows.length && <EmptyState title="没有可测算的清单项" />}
    </div>
  );
}
