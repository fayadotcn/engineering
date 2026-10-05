"use client";
import { useEffect, useRef, useState } from "react";
import { ClipboardList, Loader2, Upload } from "lucide-react";
import { useStore, OPEN_CONV_EVENT } from "./store";
import { api, type WorkbenchInit } from "./api";
import { isBusy, isDirty } from "./busy";
import { Conversation, FOCUS_COMPOSER } from "./Conversation";
import { ConfirmDialog, EmptyState, Modal, toast } from "./primitives";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CircleAlert as AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SECTIONS, sectionOf, type SectionId } from "./sections";
import { ProjectHeader, StatusBar } from "./shell/ProjectHeader";
import type { ProjectEntry } from "./shell/ProjectSwitch";
import { ResultsPanel } from "./shell/ResultsPanel";
import { SubTabs } from "./shell/SubTabs";
import { PendingImports } from "./shell/PendingImports";
import { ViewRenderer } from "./shell/ViewRenderer";

const SHORTCUTS: [string, string][] = [
  ["Ctrl + K", "聚焦对话输入框"],
  ["/", "清单内查找"],
  ["↑ / ↓", "清单内移动选中行"],
  ["Enter", "编辑选中单元格"],
  ["Tab", "编辑中移到下一格"],
  ["Ctrl + A", "全选清单行"],
  ["Ctrl + C / V", "复制所选行到 Excel / 粘回更新"],
  ["Shift / Ctrl + 点击", "连选 / 加选多行批量调价"],
  ["Delete", "删除选中行"],
  ["Ctrl + Z", "撤销最近一笔修改"],
  ["Esc", "取消编辑 / 关闭"],
  ["?", "打开本快捷键帮助"],
];

/** 快捷键速查卡（? 呼出） */
function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} label="快捷键" width={400} onClose={onClose}>
      <div className="dlg-title">快捷键</div>
      <p className="dlg-desc">工作台支持键盘操作，效率操作不必伸手摸鼠标。</p>
      <div className="mt-4 divide-y divide-border">
        {SHORTCUTS.map(([k, d]) => (
          <div key={k} className="flex items-center justify-between gap-4 py-2 text-xs">
            <span className="text-muted-foreground">{d}</span>
            <kbd className="kbd h-[19px] min-w-0 px-1.5">{k}</kbd>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** 工作台全局快捷键：Ctrl+Z 撤销最近一笔清单修改，Ctrl+K 聚焦对话输入，? 打开帮助。 */
function useShortcuts(setConvOpen: (open: boolean) => void, setHelpOpen: (open: boolean) => void) {
  useEffect(() => {
    const openConv = () => setConvOpen(true);
    window.addEventListener(OPEN_CONV_EVENT, openConv);
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const inField = !!(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable));
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !inField) { e.preventDefault(); setHelpOpen(true); return; }
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        setConvOpen(true);
        requestAnimationFrame(() => window.dispatchEvent(new Event(FOCUS_COMPOSER)));
        return;
      }
      if (key !== "z" || e.shiftKey) return;
      // 焦点在输入框里时放行原生撤销（撤销的是框内文字，不是清单数据）
      if (inField) return;
      e.preventDefault();
      void useStore.getState().undoLast();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_CONV_EVENT, openConv);
    };
  }, [setConvOpen, setHelpOpen]);
}

const CONV_W_KEY = "cost-conv-w";
const CONV_W_MIN = 300;
const CONV_W_MAX = 560;

export function Workbench({ projectId, projects = [], initial }: { projectId: string; projects?: ProjectEntry[]; initial?: WorkbenchInit }) {
  const s = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [convOpen, setConvOpen] = useState(true);
  const [convW, setConvW] = useState(() => {
    if (typeof localStorage === "undefined") return 380;
    const v = Number(localStorage.getItem(CONV_W_KEY));
    return Number.isFinite(v) && v > 0 ? Math.min(CONV_W_MAX, Math.max(CONV_W_MIN, v)) : 380;
  });
  const [resizing, setResizing] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  /** 每个分区上次停留的视图：切回分区时回到原处 */
  const remembered = useRef<Partial<Record<SectionId, string>>>({});

  // 对话栏拖宽：指针捕获拖动，键盘也可用 ←/→ 微调
  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizing(true);
  };
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    setConvW(Math.min(CONV_W_MAX, Math.max(CONV_W_MIN, e.clientX)));
  };
  const onResizeEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setResizing(false);
    localStorage.setItem(CONV_W_KEY, String(convW));
  };
  const onResizeKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = Math.min(CONV_W_MAX, Math.max(CONV_W_MIN, convW + (e.key === "ArrowRight" ? 24 : -24)));
    setConvW(next);
    localStorage.setItem(CONV_W_KEY, String(next));
  };

  useEffect(() => {
    // 服务端预载只在 id 对得上时采用（防串项目）；重复 init 复用同一份是幂等的，
    // 之后的 digest 轮询/手动刷新仍走 API 拉新数据
    void s.init(projectId, false, initial?.p.id === projectId ? initial : undefined);
    remembered.current = {};
    // 空闲轮询只打轻量 digest 探针（KB 级），指纹变化才全量刷新——
    // 之前每 10s 直接 init 会拉 boq+runs+summary ~2MB，页面常驻抖动。
    let lastDigest = "";
    const timer = setInterval(() => {
      const st = useStore.getState();
      if (document.visibilityState !== "visible" || isBusy(st) || isDirty(st)) return;
      void api.digest(projectId).then((d) => {
        const sig = JSON.stringify(d);
        if (lastDigest && sig !== lastDigest) void st.init(projectId, true);
        lastDigest = sig;
      }).catch(() => {});
    }, 10000);
    return () => clearInterval(timer);
  }, [projectId]);

  useShortcuts(setConvOpen, setHelpOpen);

  useEffect(() => {
    document.title = s.projectName ? `${s.projectName} · 安装造价` : "安装造价工作台";
  }, [s.projectName]);

  // 页内切换已有放弃确认；刷新或关闭页面时使用浏览器原生未保存提示
  const unsaved = isDirty(s) || s.saving;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  const active = s.views.find((v) => v.id === s.activeViewId);
  const section: SectionId = active ? sectionOf(active.kind) : s.activeViewId === "empty:results" ? "results" : "overview";
  if (active) remembered.current[section] = active.id;
  const blocked = isBusy(s) || isDirty(s) || !!s.loadingError || !s.ready;

  const open = (id: SectionId) => {
    if (section === id) return;
    const back = s.views.find((v) => v.id === remembered.current[id] && sectionOf(v.kind) === id);
    s.setActiveView(back?.id ?? SECTIONS.find((n) => n.id === id)!.home);
  };

  const upload = async (files: File[]) => {
    if (blocked) { toast.info("请先完成当前任务，保存或取消编辑后再导入"); return; }
    for (const file of files) await useStore.getState().upload(file);
  };
  const pickFile = () => fileRef.current?.click();

  const sectionViews = s.views.filter((v) => sectionOf(v.kind) === section);
  const body = (() => {
    if (!s.ready) return <div className="cost-empty"><Loader2 size={22} className="spin" /><p>正在读取项目资料</p></div>;
    if (s.loadingError && !s.projectName) return null;
    if (section === "results") return <ResultsPanel projectId={projectId} onUpload={pickFile} />;
    if (section === "boq" && !s.items.length) return <EmptyState
      size="lg"
      icon={<ClipboardList size={22} />}
      title="还没有工程清单"
      hint="上传招标清单、投标报价或结算清单（Excel / PDF），系统会自动识别表格结构。"
      action={<Button disabled={blocked} onClick={pickFile}><Upload size={14} />上传清单</Button>}
    />;
    const view = active ?? sectionViews[0];
    return view ? <>
      <SubTabs views={sectionViews} active={view} label={`${SECTIONS.find((n) => n.id === section)!.label}视图切换`} />
      <ViewRenderer view={view} onUpload={pickFile} />
    </> : null;
  })();

  return <main
    className={`wb ${convOpen ? "conv-open" : "conv-closed"} ${dragging ? "drop-armed" : ""} ${resizing ? "wb-resizing" : ""}`}
    style={{ "--conv-w": `${convW}px` } as React.CSSProperties}
    onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
    onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
    onDrop={(e) => { e.preventDefault(); setDragging(false); void upload([...e.dataTransfer.files]); }}
  >
    <ConfirmDialog open={!!s.pendingViewId} busy={s.saving} title="放弃未保存的修改？" description="当前页面有未保存的调整。返回后保存，或放弃修改并切换页面。" confirmText="放弃并切换"
      onCancel={() => useStore.setState({ pendingViewId: null })}
      onConfirm={() => {
        const id = useStore.getState().pendingViewId;
        useStore.setState({ mappingDirty: false, settingsDirty: false, boqDirty: false, pendingViewId: null });
        if (id) useStore.getState().setActiveView(id);
      }} />
    <input ref={fileRef} type="file" accept=".xls,.xlsx,.csv,.pdf" multiple hidden onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; void upload(fs); }} />
    {convOpen && (
      <aside className="wb-conv" aria-label="造价助手对话">
        <Conversation onCollapse={() => setConvOpen(false)} />
        <div
          className="wb-conv-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整对话栏宽度"
          title="拖动调整对话栏宽度，双击复位"
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          onDoubleClick={() => { setConvW(380); localStorage.setItem(CONV_W_KEY, "380"); }}
          tabIndex={0}
          onKeyDown={onResizeKey}
        />
      </aside>
    )}
    <div className="wb-main">
      <ProjectHeader section={section} onOpen={open} onUpload={pickFile} convOpen={convOpen} onOpenConv={() => setConvOpen(true)} projects={projects} />
      <section className={`wb-body ${section === "results" ? "is-results" : ""}`}>
        <PendingImports />
        {s.loadingError && <Alert variant="destructive" className="mb-4">
          <AlertCircle />
          <AlertTitle>读取工程资料失败</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{s.loadingError}</span>
            <Button variant="outline" size="sm" disabled={isBusy(s)} onClick={() => void s.init(projectId, true)}>重试</Button>
          </AlertDescription>
        </Alert>}
        {body}
      </section>
      {s.ready && <StatusBar />}
    </div>
    {dragging && <div className="drop-overlay">松开文件，导入清单或项目资料</div>}
    <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
  </main>;
}
