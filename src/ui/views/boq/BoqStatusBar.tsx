"use client";
import { fmtMoney } from "../shared";

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
    <div className="flex flex-wrap items-center gap-3 border-t border-neutral-200 bg-[var(--sidebar)] px-3 py-1.5">
      <span className="text-[11.5px] text-neutral-500">
        合价合计
        <b className="mono ml-1.5 text-[12.5px] font-medium text-neutral-800">
          {fmtMoney(sumShown)}
        </b>
        <span className="ml-1">元</span>
        {filtering && <span className="ml-1 text-neutral-400">（筛选口径）</span>}
      </span>
      {unpriced > 0 && <span className="chip warn">{unpriced} 项未定价</span>}
      {selCount > 1 && (
        <span className="chip brand" title="所选行的合价加总">
          已选 {selCount} 行 · 合计 <b className="mono font-medium">{fmtMoney(selTotal)}</b> 元
        </span>
      )}
      <span className="ml-auto text-[11px] text-neutral-400">
        {dataShown === dataTotal ? `${dataTotal} 行` : `${dataShown} / ${dataTotal} 行`}
      </span>
    </div>
  );
}
