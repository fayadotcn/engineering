"use client";
import { EmptyState } from "@/components/ui/empty-state";
import type { WorkspaceView } from "@shared/types";
import { FileText } from "lucide-react";


/* ---------------- PDF 文档 ---------------- */

export function DocumentView({ view }: { view: Extract<WorkspaceView, { kind: "document" }> }) {
  return (
    <div className="view-content space-y-4">
      {view.pages.map((p, i) => (
        <div key={i} className="rounded-xl border border-border bg-[var(--card)] p-5 shadow-[var(--shadow-sm)]">
          <div className="mb-2 text-2xs text-muted-foreground">第 {i + 1} 页</div>
          <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-foreground">{p}</pre>
        </div>
      ))}
      {!view.pages.length && <EmptyState icon={<FileText size={22} />} title="无文本内容" hint="这份 PDF 可能是扫描件，文本层为空。" />}
    </div>
  );
}
