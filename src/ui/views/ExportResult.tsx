"use client";
import type { WorkspaceView } from "@shared/types";
import { Download, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";

/* ---------------- 导出结果 / 文件列表 ---------------- */

export function ExportResult({ view }: { view: Extract<WorkspaceView, { kind: "exportResult" }> }) {
  return (
    <div className="flex flex-1 items-center justify-center py-8">
      <div className="w-full max-w-80 rounded-xl border border-border bg-card p-6 break-words">
        <span className="export-file-icon"><FileSpreadsheet size={24} /></span>
        <p className="mt-5 text-2xs text-muted-foreground">成果文件已生成</p>
        <div className="mt-3 text-sm font-medium">{view.filename}</div>
        <div className="mt-1 text-xs text-muted-foreground">{view.summary}</div>
        <Button asChild className="mt-4 w-full">
          <a
            href={`/api/artifacts/${view.artifactId}/download`}
            download={view.filename}
            aria-label={`下载${view.filename}`}
          >
            <Download size={14} /> 下载 Excel
          </a>
        </Button>
      </div>
    </div>
  );
}
