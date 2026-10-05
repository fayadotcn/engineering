"use client";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useStore } from "../store";
import { isBusy, isDirty } from "../busy";
import type { ConvBlock } from "../runEvents";

type Confirm = Extract<ConvBlock, { type: "confirm" }>;

/** 导入待核对的文件：工作区里给出核对入口；在映射页上直接确认。其余确认只在对话里处理。
    卡片是「等你确认」的警示态，统一用 Alert(warning)；import-confirm 保留给版面（结果区外边距/打印隐藏）。 */
export function PendingImports() {
  const s = useStore();
  const pending = s.blocks.filter((b): b is Confirm => b.type === "confirm" && !b.decided && !!b.fileId);
  const blocked = isBusy(s) || isDirty(s);
  return <>{pending.map((block) => {
    const mapping = s.views.find((v) => v.kind === "columnMapping" && v.fileId === block.fileId);
    const closed = s.closedViewIds.find((id) => id === `view:mapping:${block.fileId}`);
    const mappingId = mapping?.id ?? closed;
    const review = () => {
      if (!mappingId) { s.setActiveView("view:files"); return; }
      s.setActiveView(mappingId);
      if (!mapping && s.projectId) void s.init(s.projectId, true);
    };
    if (s.activeViewId !== mappingId)
      return <Alert key={block.confirmId} variant="warning" role="status" className="import-confirm text-xs">
        <AlertTriangle size={15} aria-hidden="true" />
        <div className="col-start-2 flex min-w-0 flex-1 flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <strong>有资料需要核对</strong>
            <p>{block.description}</p>
          </div>
          <Button variant="outline" size="sm" onClick={review}>核对并导入<ArrowRight size={14} /></Button>
        </div>
      </Alert>;
    return <Alert key={block.confirmId} variant="warning" role="status" className="import-confirm text-xs">
      <AlertTriangle size={15} aria-hidden="true" />
      <div className="col-start-2 flex min-w-0 flex-1 flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <strong>请核对表格，再导入</strong>
          <p>{s.mappingDirty ? "你改了识别结果，请先保存，再确认导入。" : block.description}</p>
        </div>
        <div className="cost-actions">
          <Button variant="outline" size="sm" disabled={blocked} onClick={() => void s.confirmImport(block.runId, false)}>取消导入</Button>
          <Button size="sm" disabled={blocked} onClick={() => void s.confirmImport(block.runId, true)}>确认导入</Button>
        </div>
      </div>
    </Alert>;
  })}</>;
}
