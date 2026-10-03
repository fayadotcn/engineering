"use client";
import { useStore } from "../store";
import type { BreakdownSlice, WorkspaceView } from "@shared/types";
import { DISCIPLINE_COLOR } from "../colors";
import { fmtMoney, PALETTE } from "./shared";

/* ---------------- 占比图 ---------------- */

export function Breakdown({ view }: { view: Extract<WorkspaceView, { kind: "breakdown" }> }) {
  const { send } = useStore();
  const total = Number(view.total);
  let acc = 0;
  const R = 52;
  const C = 2 * Math.PI * R;
  // 专业占比沿用专业语义色（和总览 mix bar 一致），材料类别走色板
  const colorOf = (s: BreakdownSlice, i: number) =>
    view.mode === "discipline" ? DISCIPLINE_COLOR[s.key] ?? DISCIPLINE_COLOR.OTHER : PALETTE[i % PALETTE.length];
  return (
    <div className="flex h-full flex-wrap items-start gap-8 overflow-auto p-8 max-[420px]:gap-5 max-[420px]:p-4">
      <svg width="150" height="150" viewBox="0 0 140 140" className="mt-1 shrink-0 -rotate-90">
        <circle cx="70" cy="70" r={R} fill="none" strokeWidth="20" style={{ stroke: "var(--chart-track)" }} />
        {view.slices.map((s: BreakdownSlice, i) => {
          const dash = s.share * C;
          const off = -acc * C;
          acc += s.share;
          return (
            <circle
              key={s.key}
              cx="70" cy="70" r={R} fill="none"
              style={{ stroke: colorOf(s, i) }}
              strokeWidth="20"
              strokeDasharray={`${dash} ${C - dash}`}
              strokeDashoffset={off}
            />
          );
        })}
      </svg>
      <div className="min-w-0 flex-1 basis-80">
        <div className="mono mb-4 text-xl font-medium">{fmtMoney(total)} <span className="text-xs font-normal text-neutral-400">元</span></div>
        {view.slices.map((s, i) => (
          <div key={s.key} className="flex items-center gap-3 border-b border-neutral-100 py-1.5 text-[12.5px] max-[420px]:flex-wrap max-[420px]:gap-x-2.5 max-[420px]:gap-y-0.5">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: colorOf(s, i) }} />
            <span className="w-24 shrink-0 truncate max-[420px]:w-auto max-[420px]:min-w-0 max-[420px]:flex-1" title={s.label}>{s.label}</span>
            <div className="h-1.5 min-w-8 flex-1 rounded max-[420px]:min-w-6" style={{ background: "var(--chart-track)" }}>
              <div className="h-1.5 rounded" style={{ width: `${s.share * 100}%`, background: colorOf(s, i) }} />
            </div>
            <span className="mono w-28 shrink-0 text-right max-[420px]:w-auto">{fmtMoney(s.amount)}</span>
            <span className="hidden max-[420px]:block max-[420px]:basis-full" aria-hidden="true" />
            <span className="mono w-12 shrink-0 text-right text-neutral-500 max-[420px]:w-auto max-[420px]:text-left">{(s.share * 100).toFixed(1)}%</span>
            <span className="w-14 shrink-0 whitespace-nowrap text-right text-[11px] text-neutral-400 max-[420px]:ml-auto max-[420px]:w-auto">{s.count} 项</span>
          </div>
        ))}
        {(() => {
          const uncat = view.mode === "material" ? view.slices.find((s) => s.key === "未分类") : undefined;
          return uncat && uncat.count > 0 ? (
            <div className="cost-info warn !mb-0 mt-3 flex items-center justify-between gap-3">
              <span>还有 {uncat.count} 项没归到材料类别（占 {(uncat.share * 100).toFixed(1)}%），归好类占比才准。</span>
              <button
                className="shrink-0 font-medium hover:underline"
                onClick={() => void send?.("帮我把清单里还没分类的项目按材料类别归一下类，再统计一次材料类别金额占比")}
              >
                让助手归类 →
              </button>
            </div>
          ) : null;
        })()}
      </div>
    </div>
  );
}
