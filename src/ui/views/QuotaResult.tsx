"use client";
import { Fragment, useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import type { WorkspaceView } from "@shared/types";
import { ChevronDown } from "lucide-react";
import { EmptyState } from "../primitives";
import { cn, fmtMoney, Tip, TipEl } from "./shared";

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
        <Badge variant="secondary" >{view.rows.length} 项中，{matched} 项找到定额</Badge>
        {needMain > 0 && <Badge variant="warning" >{needMain} 项还缺材料价</Badge>}
        {ambiguous > 0 && (
          <TipEl tip="存在得分相近且基价不同的备选子目，点击行可查看备选，或查定额说明核实">
            <Badge variant="warning">
              {ambiguous} 项需要核对定额
            </Badge>
          </TipEl>
        )}
        {deviant > 0 && <Badge variant="danger" >{deviant} 项偏差 &gt;20%</Badge>}
      </div>
      <details className="cost-simple-more mb-3">
        <summary>查看费用构成和计算方法</summary>
        <div className="cost-more-body">
          <Label className="text-xs">
            <Checkbox checked={details} onCheckedChange={(v) => setDetails(v === true)} />
            显示人工、材料、机械和取费
          </Label>
          <p className="w-full text-xs text-muted-foreground">综合单价 = 人工+辅材+机械 + 主材价×耗量 + (人工+机械)×(管理费{(view.mgmtRate * 100).toFixed(0)}%+利润{(view.profitRate * 100).toFixed(0)}%)</p>
        </div>
      </details>
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
            <TipEl tip={hasDetail ? "点击查看定额工作内容" : undefined}>
            <tr
              className={cn(hasDetail && "cursor-pointer")}
              onClick={() => hasDetail && setOpen(expanded ? null : r.itemId)}
            >
              <td className="xl-rn">{ri + 1}</td>
              <td className="max-w-40 truncate"><Tip tip={r.name}>{r.name}</Tip></td>
              <td className="text-muted-foreground">
                {r.quotaCode ? (
                  <button disabled={!hasDetail} aria-label={`查看${r.name}的定额工作内容`} aria-expanded={expanded} onClick={e => { e.stopPropagation(); if (hasDetail) setOpen(expanded ? null : r.itemId); }} className="mono inline-flex items-center gap-1 text-2xs">
                    {hasDetail && <ChevronDown className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")} />}
                    {details ? r.quotaCode : "查看明细"}
                    {r.needsMainPrice && (
                      <TipEl tip={r.missingMaterials?.length ? `缺价：${r.missingMaterials.join("、")}` : "缺主材暂估价"}>
                        <Badge size="xs" variant="warning" className="font-sans">缺材料价</Badge>
                      </TipEl>
                    )}
                    {r.ambiguous && (
                      <TipEl tip={r.altQuota ? `备选：${r.altQuota}` : "存在得分相近的备选子目"}>
                        <Badge size="xs" variant="warning" className="font-sans">
                          存疑
                        </Badge>
                      </TipEl>
                    )}
                  </button>
                ) : (
                  <TipEl tip={r.unmatchedReason ?? "定额库无合适子目"}>
                    <span>未找到定额{r.unmatchedReason ? <span className="text-muted-foreground">（{r.unmatchedReason}）</span> : null}</span>
                  </TipEl>
                )}
              </td>
              {details && <><td className="mono text-right">{r.labor ?? "—"}</td>
              <td className="mono text-right">{r.materialAux ?? "—"}</td>
              <td className="mono text-right">{r.machine ?? "—"}</td>
              <td className="mono text-right">
                {r.needsMainPrice ? <span className="text-[var(--warning-soft-fg)]">缺主材价</span> : r.mainMaterial ?? "—"}
              </td>
              <td className="mono text-right">{r.fee ?? "—"}</td></>}
              <td className="mono text-right font-medium">{r.calcPrice ?? "—"}{r.needsMainPrice && <div className="text-2xs font-sans font-normal text-[var(--warning-soft-fg)]">未含缺失材料价</div>}</td>
              <td className="mono text-right text-muted-foreground">{fmtMoney(r.listPrice)}</td>
              <td className={cn(
                "mono text-right",
                r.deviation !== null && Math.abs(Number(r.deviation)) > 20 && "font-medium text-[var(--destructive-soft-fg)]"
              )}>
                {r.deviation !== null ? `${Number(r.deviation) > 0 ? "+" : ""}${r.deviation}%` : "—"}
              </td>
            </tr>
            </TipEl>
            {expanded && (
              <tr>
                <td className="xl-rn"></td>
                <td colSpan={details ? 10 : 5} className="whitespace-normal" style={{ background: "var(--muted)" }}>
                  <div className="space-y-1 py-1.5 text-2xs leading-relaxed">
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                      <span className="font-medium text-foreground">{r.quotaCode} {r.quotaName}</span>
                      {r.quotaFb && <span className="text-muted-foreground">分册：{r.quotaFb}</span>}
                      {r.quotaChapter && <span className="text-muted-foreground">章节：{r.quotaChapter}</span>}
                      {r.quotaBase && <span className="text-muted-foreground">基价：<span className="mono">{r.quotaBase}</span> 元/{r.quotaCode ? "定额单位" : ""}</span>}
                      {r.quotaMainName && <span className="text-muted-foreground">主材：{r.quotaMainName}</span>}
                      {r.ambiguous && r.altQuota && (
                        <span className="text-[var(--warning-soft-fg)]">备选子目：{r.altQuota}（基价不同，请结合定额说明核实）</span>
                      )}
                    </div>
                    {r.quotaGcnr && <div className="text-muted-foreground">工作内容：{r.quotaGcnr}</div>}
                    {(r.plan?.length ?? 0) > 1 && (
                      <div className="mt-1">
                        <Separator className="mb-1" />
                        <div className="mb-0.5 font-medium text-muted-foreground">组价方案（{r.plan!.filter((l) => !l.suggested).length} 条已计）</div>
                        {r.plan!.map((l, li) => (
                          <div key={li} className="text-muted-foreground">
                            <div className="flex items-baseline gap-2">
                              <span className="mono">{l.quotaCode || "—"}</span>
                              <span className="truncate">{l.quotaName}</span>
                              {l.suggested ? (
                                <TipEl tip={l.scope}>
                                  <Badge size="xs" variant="warning">建议增列</Badge>
                                </TipEl>
                              ) : l.manual ? (
                                <Badge size="xs" variant="secondary">人工指定</Badge>
                              ) : null}
                              <span className="ml-auto mono">{l.subtotal}</span>
                            </div>
                            {(l.materials?.length ?? 0) > 0 && (
                              <div className="pl-2 text-2xs text-muted-foreground/90">
                                含量：{l.materials!.map((m) => `${m.name} ${m.qty}${m.unit || ""}${m.price == null ? "（缺价）" : `×${m.price}`}`).join("、")}
                              </div>
                            )}
                            {l.suggested && l.scope && <div className="pl-2 text-2xs">{l.scope}</div>}
                          </div>
                        ))}
                        {r.missingMaterials?.length ? (
                          <div className="text-2xs text-[var(--warning-soft-fg)]">缺价材料：{r.missingMaterials.join("、")} —— 询价后测算才完整</div>
                        ) : null}
                        <div className="text-2xs text-muted-foreground">
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
