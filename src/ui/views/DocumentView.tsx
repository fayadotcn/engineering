"use client";
import type { WorkspaceView } from "@shared/types";
import { FileText } from "lucide-react";
import { EmptyState } from "../primitives";

/* ---------------- PDF 文档 ---------------- */

export function DocumentView({ view }: { view: Extract<WorkspaceView, { kind: "document" }> }) {
  return (
    <div className="h-full space-y-4 overflow-auto p-6">
      {view.pages.map((p, i) => (
        <div key={i} className="rounded-xl border border-neutral-200 bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
          <div className="mb-2 text-[10.5px] text-neutral-300">第 {i + 1} 页</div>
          <pre className="whitespace-pre-wrap font-sans text-[12px] leading-relaxed text-neutral-700">{p}</pre>
        </div>
      ))}
      {!view.pages.length && <EmptyState icon={<FileText size={22} />} title="无文本内容" hint="这份 PDF 可能是扫描件，文本层为空。" />}
    </div>
  );
}
