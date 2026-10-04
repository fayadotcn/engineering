"use client";
import type { WorkspaceView } from "@shared/types";
import { Download, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";

/* ---------------- 导出结果 / 文件列表 ---------------- */

export function ExportResult({ view }: { view: Extract<WorkspaceView, { kind: "exportResult" }> }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-80 rounded-xl border border-border bg-[var(--card)] p-5 break-words">
        <FileSpreadsheet size={20} className="text-muted-foreground" />
        <div className="mt-3 text-[13px] font-medium">{view.filename}</div>
        <div className="mt-1 text-xs text-muted-foreground">{view.summary}</div>
        <Button asChild className="mt-4 w-full">
          <a
            href={`/api/artifacts/${view.artifactId}/download`}
            download={view.filename}
            aria-label={`下载${view.filename}`}
          >
            <Download size={13} /> 下载
          </a>
        </Button>
      </div>
    </div>
  );
}
