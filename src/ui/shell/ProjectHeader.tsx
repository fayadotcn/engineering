"use client";
import { BarChart3, ClipboardList, Database, FileSpreadsheet, Layers3, LayoutDashboard, LayoutGrid, Settings2, Upload } from "lucide-react";
import { isPricableItem } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemeToggle } from "../ThemeToggle";
import { useStore } from "../store";
import { isBusy, isDirty } from "../busy";
import { cn } from "../views/shared";
import { resultKey, SECTIONS, sectionOf, type SectionId } from "../sections";
import { ProjectSwitch, type ProjectEntry } from "./ProjectSwitch";

const ICON: Record<SectionId, typeof ClipboardList> = {
  overview: LayoutDashboard,
  boq: ClipboardList,
  files: FileSpreadsheet,
  results: BarChart3,
  settings: Settings2,
};

/** 顶栏：品牌 + 工程切换 + 面板入口（开浮层）+ 内联统计 + 全局动作。
    对话是主界面，这里只做安静的入口与状态，不再占第二行导航。 */
export function ProjectHeader({ section, sheetOpen, onOpen, onUpload, projects }: {
  section: SectionId;
  sheetOpen: boolean;
  onOpen: (id: SectionId) => void;
  onUpload: () => void;
  projects: ProjectEntry[];
}) {
  const s = useStore();
  const blocked = isBusy(s) || isDirty(s) || !s.ready;
  const unpriced = s.items.reduce((n, i) => n + (isPricableItem(i) && Number(i.unitPrice) === 0 ? 1 : 0), 0);
  const pendingFiles = s.blocks.filter((b) => b.type === "confirm" && !b.decided && b.fileId).length;
  const results = new Set(s.views.filter((v) => sectionOf(v.kind) === "results").map(resultKey)).size;
  const badge: Partial<Record<SectionId, React.ReactNode>> = {
    boq: unpriced > 0 && <small className="warn">{unpriced}</small>,
    files: pendingFiles > 0 && <small className="warn">{pendingFiles}</small>,
    results: results > 0 && <small className="count">{results}</small>,
  };

  const summary = s.summary;
  const money = (v: string) => Number(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const busyState = s.saving || isDirty(s) || s.agentRunning || s.importRunning;

  return <header className="wb-top">
    <a href="/" className="wb-brand" aria-label="安装造价 · 返回工程列表">
      <span className="brand-tile"><Layers3 size={14} /></span>
      <span className="wb-brand-name">安装造价</span>
    </a>
    <ProjectSwitch projects={projects} />
    {/* 面板入口：点击浮出对应视图，不是整页切换 */}
    <nav className="wb-views max-[760px]:hidden" aria-label="工作区面板">
      {SECTIONS.map((n) => {
        const Icon = ICON[n.id];
        return <Button variant="ghost" size="sm" key={n.id} onClick={() => onOpen(n.id)} aria-current={sheetOpen && section === n.id ? "page" : undefined} className={sheetOpen && section === n.id ? "active" : ""}>
          <Icon size={14} />{n.label}{badge[n.id]}
        </Button>;
      })}
    </nav>
    <div className="wb-stats max-[1000px]:hidden" aria-label="工程摘要">
      {(summary?.itemCount ?? 0) > 0 && <>
        <span>清单 <b className="mono">{summary!.itemCount}</b> 项</span>
        <span>{summary!.missingSettings.includes("税率") ? "暂计总价" : "含税造价"} <b className="mono">{money(summary!.fees.grandTotal)}</b> 元</span>
      </>}
      {unpriced > 0 && <button className="wb-stats-warn" onClick={() => { useStore.setState({ boqOnlyUnpriced: true }); onOpen("boq"); }}>{unpriced} 项未定价</button>}
      <span className={cn("wb-state", busyState ? "busy" : "ok")} role="status">
        {s.saving ? "保存中" : isDirty(s) ? "未保存" : s.agentRunning ? "处理中" : s.importRunning ? "导入中" : "已同步"}
      </span>
    </div>
    <div className="cost-actions">
      {/* ≤760px 收成菜单腾出宽度 */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="min-[761px]:hidden" aria-label="打开工作区面板"><LayoutGrid size={16} /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44 text-xs">
          {SECTIONS.map((n) => {
            const Icon = ICON[n.id];
            return <DropdownMenuItem key={n.id} onSelect={() => onOpen(n.id)}><Icon />{n.label}{badge[n.id] ? <span className="ml-auto">{badge[n.id]}</span> : null}</DropdownMenuItem>;
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild><a href="/admin"><Database />材料与定额库</a></DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ThemeToggle className="max-[760px]:hidden" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" asChild className="max-[760px]:hidden">
            <a href="/admin" aria-label="材料与定额库"><Database size={15} /></a>
          </Button>
        </TooltipTrigger>
        <TooltipContent>材料与定额库</TooltipContent>
      </Tooltip>
      <Button size="sm" disabled={blocked} onClick={onUpload}><Upload size={13} />上传资料</Button>
    </div>
  </header>;
}
