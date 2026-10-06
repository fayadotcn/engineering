"use client";
import { X } from "lucide-react";
import type { WorkspaceView } from "@shared/types";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FIXED_VIEWS } from "../sections";
import { useStore } from "../store";

/** 分区内的二级切换（资料：文件/价格库/打开的表格；设置：计价/记录）。常驻页不可关闭。
    外观沿用 .subtabs 的「胶囊容器 + 浮起选中块」：容器交给项目类，选中块由 data-state=active 驱动；
    左右方向键（Home/End）切页由 Radix 的 roving focus 提供。 */
export function SubTabs({ views, active, label }: { views: WorkspaceView[]; active?: WorkspaceView; label: string }) {
  const s = useStore();
  if (views.length < 2) return null;
  return <Tabs
    value={active?.id ?? views[0].id}
    onValueChange={(id) => s.setActiveView(id)}
    className="shrink-0"
  >
    <TabsList className="subtabs" aria-label={label}>
      {views.map((v, i) => {
        const current = v.id === active?.id;
        return <div key={v.id} className={current ? "active" : ""}>
          {/* Tooltip 挂在触发器内部：Radix 会把 data-state 写在被包裹的元素上，
              套在 TabsTrigger 外会盖掉 tab 自己的 active/inactive 状态，选中块就浮不起来了 */}
          <TabsTrigger
            value={v.id}
            className="px-3 py-[5px] text-xs text-muted-foreground data-[state=active]:text-foreground"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <span>{v.title}</span>
              </TooltipTrigger>
              <TooltipContent side="bottom">{v.title}</TooltipContent>
            </Tooltip>
          </TabsTrigger>
          {!FIXED_VIEWS.has(v.id) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-xs"
                  aria-label={`关闭${v.title}`}
                  onClick={() => s.closeView(v.id, current ? views[i - 1]?.id ?? views[0]?.id : undefined)}
                >
                  <X size={11} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">关闭</TooltipContent>
            </Tooltip>
          )}
        </div>;
      })}
    </TabsList>
  </Tabs>;
}
