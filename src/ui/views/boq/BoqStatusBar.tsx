"use client";
import { fmtMoney } from "../shared";
import { Badge, type BadgeVariant } from "@/components/ui/badge";

/** 清单底部状态栏：合价合计随筛选联动、未定价计数、多选合计（Excel 状态栏口径） */
export function BoqStatusBar({ sumShown, filtering, unpriced, selCount, selTotal, dataShown, dataTotal }: {
  sumShown: string | number;
  filtering: boolean;
  unpriced: number;
  selCount: number;
  selTotal: number;
  dataShown: number;
  dataTotal: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border bg-[var(--muted)] px-3 py-1.5">
      <span className="text-2xs text-muted-foreground">
        合价合计
        <b className="mono ml-1.5 text-xs font-medium text-foreground">
          {fmtMoney(sumShown)}
        </b>
        <span className="ml-1">元</span>
        {filtering && <span className="ml-1 text-muted-foreground">（筛选口径）</span>}
      </span>
      {unpriced > 0 && <Badge variant="warning" >{unpriced} 项未定价</Badge>}
      {selCount > 1 && (
        <Badge variant="secondary"  title="所选行的合价加总">
          已选 {selCount} 行 · 合计 <b className="mono font-medium">{fmtMoney(selTotal)}</b> 元
        </Badge>
      )}
      <span className="ml-auto text-2xs text-muted-foreground">
        {dataShown === dataTotal ? `${dataTotal} 行` : `${dataShown} / ${dataTotal} 行`}
      </span>
    </div>
  );
}
