"use client";
import type { WorkspaceView } from "@shared/types";
import { EmptyState } from "../primitives";

/* ---------------- 定额说明条文 ---------------- */

export function SpecResultView({ view }: { view: Extract<WorkspaceView, { kind: "specResult" }> }) {
  return (
    <div className="h-full space-y-4 overflow-auto p-6">
      <div className="text-[11px] text-neutral-400">
        检索词「{view.query}」· {view.hits.length} 条相关条文 · 来源：《四川省2020建设工程工程量清单计价定额》说明及计算规则
      </div>
      {!view.hits.length && <EmptyState title="没有找到相关条文" hint="换用材料名称、施工工艺或定额编号，再检索一次。" />}
      {view.hits.map((h, i) => (
        <div key={i} className="rounded-xl border border-neutral-200 bg-[var(--surface)] shadow-[var(--shadow-sm)]">
          <div className="flex items-center gap-2 border-b border-neutral-100 px-5 py-3">
            <span className="chip brand">{h.book}</span>
            <span className="text-[13px] font-semibold text-neutral-800">{h.title}</span>
          </div>
          <pre className="whitespace-pre-wrap px-5 py-4 font-sans text-[12px] leading-relaxed text-neutral-700">
            {h.excerpt}
          </pre>
        </div>
      ))}
    </div>
  );
}
