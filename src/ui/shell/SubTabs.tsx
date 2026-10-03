"use client";
import { X } from "lucide-react";
import type { WorkspaceView } from "@shared/types";
import { FIXED_VIEWS } from "../sections";
import { useStore } from "../store";

/** 分区内的二级切换（资料：文件/价格库/打开的表格；设置：计价/记录）。常驻页不可关闭。 */
export function SubTabs({ views, active, label }: { views: WorkspaceView[]; active?: WorkspaceView; label: string }) {
  const s = useStore();
  if (views.length < 2) return null;
  return <div className="subtabs" role="tablist" aria-label={label}>
    {views.map((v, i) => {
      const current = v.id === active?.id;
      return <div key={v.id} className={current ? "active" : ""}>
        <button role="tab" aria-selected={current} title={v.title} onClick={() => s.setActiveView(v.id)}>{v.title}</button>
        {!FIXED_VIEWS.has(v.id) && <button aria-label={`关闭${v.title}`} title="关闭" onClick={() => s.closeView(v.id, current ? views[i - 1]?.id ?? views[0]?.id : undefined)}><X size={11} /></button>}
      </div>;
    })}
  </div>;
}
