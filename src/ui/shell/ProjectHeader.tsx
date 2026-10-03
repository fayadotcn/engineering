"use client";
import { useState } from "react";
import { ArrowLeft, BarChart3, ClipboardList, Database, FileSpreadsheet, LayoutDashboard, MessageCircle, Settings2, Upload } from "lucide-react";
import { isPricableItem } from "@shared/types";
import { ThemeToggle } from "../ThemeToggle";
import { useStore } from "../store";
import { isBusy, isDirty } from "../busy";
import { cn } from "../views/shared";
import { resultKey, SECTIONS, sectionOf, type SectionId } from "../sections";

const ICON: Record<SectionId, typeof ClipboardList> = {
  overview: LayoutDashboard,
  boq: ClipboardList,
  files: FileSpreadsheet,
  results: BarChart3,
  settings: Settings2,
};

/** 工程名点击即可改名：Enter 保存，Esc 放弃。 */
function ProjectName() {
  const s = useStore();
  const [editing, setEditing] = useState<string | null>(null);
  const commit = async () => {
    const name = editing?.trim();
    if (name && name !== s.projectName) await s.renameProject(name);
    setEditing(null);
  };
  if (editing !== null) return <input className="wb-name-input" autoFocus value={editing} maxLength={120} aria-label="工程名称"
    onChange={(e) => setEditing(e.target.value)} onBlur={() => void commit()}
    onKeyDown={(e) => { if (e.key === "Enter") void commit(); if (e.key === "Escape") setEditing(null); }} />;
  return <button className="wb-name" title="点击修改工程名称" onClick={() => setEditing(s.projectName)}>{s.projectName || "工程"}</button>;
}

export function ProjectHeader({ section, onOpen, onUpload, convOpen, onOpenConv }: {
  section: SectionId;
  onOpen: (id: SectionId) => void;
  onUpload: () => void;
  convOpen: boolean;
  onOpenConv: () => void;
}) {
  const s = useStore();
  const blocked = isBusy(s) || isDirty(s) || !s.ready;
  const unpriced = s.items.reduce((n, i) => n + (isPricableItem(i) && Number(i.unitPrice) === 0 ? 1 : 0), 0);
  const pendingFiles = s.blocks.filter((b) => b.type === "confirm" && !b.decided && b.fileId).length;
  const pendingAll = s.blocks.filter((b) => b.type === "confirm" && !b.decided).length;
  const results = new Set(s.views.filter((v) => sectionOf(v.kind) === "results").map(resultKey)).size;
  const badge: Partial<Record<SectionId, React.ReactNode>> = {
    boq: unpriced > 0 && <small className="warn">{unpriced} 未定价</small>,
    files: pendingFiles > 0 && <small className="warn">{pendingFiles} 待核对</small>,
    results: results > 0 && <small className="count">{results}</small>,
  };
  return <header className="wb-header">
    <div className="wb-top">
      {!convOpen && <button className="icon-btn wb-conv-open" onClick={onOpenConv} title="展开造价助手" aria-label="展开造价助手">
        <MessageCircle size={16} />{pendingAll > 0 && <i>{pendingAll}</i>}
      </button>}
      <nav className="wb-crumbs" aria-label="位置">
        <a href="/" className="cost-back"><ArrowLeft size={14} />工程项目</a>
        <span>/</span>
        <span className="wb-avatar" aria-hidden="true">{(s.projectName || "造").trim()[0]?.toUpperCase()}</span>
        <ProjectName />
      </nav>
      <div className="cost-actions">
        <ThemeToggle className="wb-theme" />
        <a className="cost-btn ghost" href="/admin" title="各工程共用的材料价格与定额库"><Database size={13} />材料与定额库</a>
        <button className="cost-btn primary" disabled={blocked} onClick={onUpload}><Upload size={13} />上传资料</button>
      </div>
    </div>
    <nav className="wb-nav" aria-label="工程工作区">
      {SECTIONS.map((n) => {
        const Icon = ICON[n.id];
        return <button key={n.id} onClick={() => onOpen(n.id)} aria-current={section === n.id ? "page" : undefined} className={section === n.id ? "active" : ""}>
          <Icon size={14} />{n.label}{badge[n.id]}
        </button>;
      })}
    </nav>
  </header>;
}

export function StatusBar() {
  const s = useStore();
  const summary = s.summary;
  const unpriced = summary?.fees.unpricedCount ?? 0;
  const money = (v: string) => Number(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return <footer className="wb-status">
    {(summary?.itemCount ?? 0) > 0 && <>
      <span>清单 <b className="mono">{summary!.itemCount}</b> 项</span>
      <span>{summary!.missingSettings.includes("税率") ? "暂计总价" : "含税造价"} <b className="mono">{money(summary!.fees.grandTotal)}</b> 元</span>
    </>}
    {unpriced > 0 && <button className="wb-status-warn" onClick={() => { useStore.setState({ boqOnlyUnpriced: true }); s.setActiveView("view:boq"); }}>{unpriced} 项未定价</button>}
    <span className={cn("wb-status-state", (s.saving || isDirty(s) || s.agentRunning || s.importRunning) ? "busy" : "ok")} role="status">
      {s.saving ? "正在保存…" : isDirty(s) ? "有未保存的修改" : s.agentRunning ? "助手处理中" : s.importRunning ? "正在导入资料" : "已同步"}
    </span>
  </footer>;
}
