"use client";
import { EmptyState } from "@/components/ui/empty-state";
import { useEffect, useRef, useState } from "react";
import { ClipboardList, Download, Loader2, Upload, X } from "lucide-react";
import { useStore, CLOSE_VIEW_ID, takePendingStart } from "./store";
import { api, type WorkbenchInit } from "./api";
import { isBusy, isDirty } from "./busy";
import { Conversation, FOCUS_COMPOSER } from "./Conversation";
import { ConfirmDialog, Modal, toast } from "./primitives";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CircleAlert as AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { SECTIONS, sectionOf, type SectionId } from "./sections";
import { ProjectHeader } from "./shell/ProjectHeader";
import type { ProjectEntry } from "./shell/ProjectSwitch";
import { ResultsPanel } from "./shell/ResultsPanel";
import { SubTabs } from "./shell/SubTabs";
import { PendingImports } from "./shell/PendingImports";
import { ViewRenderer } from "./shell/ViewRenderer";

const SHORTCUTS: [string, string][] = [
  ["Ctrl + K", "聚焦对话输入框"],
  ["Esc", "关闭面板 / 取消编辑"],
  ["/", "清单内查找"],
  ["↑ / ↓", "清单内移动选中行"],
  ["Enter", "编辑选中单元格"],
  ["Tab", "编辑中移到下一格"],
  ["Ctrl + A", "全选清单行"],
  ["Ctrl + C / V", "复制所选行到 Excel / 粘回更新"],
  ["Shift / Ctrl + 点击", "连选 / 加选多行批量调价"],
  ["Delete", "删除选中行"],
  ["Ctrl + Z", "撤销最近一笔修改"],
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
function useShortcuts(setHelpOpen: (open: boolean) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const inField = !!(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable));
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !inField) { e.preventDefault(); setHelpOpen(true); return; }
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        window.dispatchEvent(new Event(FOCUS_COMPOSER));
        return;
      }
      if (key !== "z" || e.shiftKey) return;
      // 焦点在输入框里时放行原生撤销（撤销的是框内文字，不是清单数据）
      if (inField) return;
      e.preventDefault();
      void useStore.getState().undoLast();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setHelpOpen]);
}

export function Workbench({ projectId, projects = [], initial }: { projectId: string; projects?: ProjectEntry[]; initial?: WorkbenchInit }) {
  const s = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    // 服务端预载只在 id 对得上时采用（防串项目）；重复 init 复用同一份是幂等的，
    // 之后的 digest 轮询/手动刷新仍走 API 拉新数据
    void s.init(projectId, false, initial?.p.id === projectId ? initial : undefined);
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

  useShortcuts(setHelpOpen);

  // 首页「一句话+附件」直达：工程就绪后消费交接袋——先补传文件（各自触发导入 run），
  // 全部落定后再发出第一句话。startedRef 按 projectId 记，防 StrictMode 双跑重复发起。
  const startedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!s.ready || s.projectId !== projectId || startedRef.current === projectId) return;
    const start = takePendingStart(projectId);
    if (!start) { startedRef.current = projectId; return; }
    startedRef.current = projectId;
    void (async () => {
      for (const f of start.files) await useStore.getState().upload(f);
      if (start.message.trim()) await useStore.getState().send(start.message.trim());
    })();
  }, [s.ready, s.projectId, projectId]);

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

  // 浮层打开时遮罩盖住拖放区：吞掉 window 级 dragover/drop，
  // 否则浏览器默认行为会直接把文件导航打开、丢掉工作台状态
  useEffect(() => {
    if (!s.viewOpen) return;
    const stop = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => { window.removeEventListener("dragover", stop); window.removeEventListener("drop", stop); };
  }, [s.viewOpen]);

  const active = s.views.find((v) => v.id === s.activeViewId);
  const section: SectionId = active ? sectionOf(active.kind) : s.activeViewId === "empty:results" ? "results" : "overview";
  const blocked = isBusy(s) || isDirty(s) || !!s.loadingError || !s.ready;

  /** 分区入口：浮层定位到该分区的家视图；成果区落最近一份结果。 */
  const open = (id: SectionId) => {
    if (id === "results") {
      const latest = [...s.views].reverse().find((v) => sectionOf(v.kind) === "results");
      s.setActiveView(latest?.id ?? "empty:results");
      return;
    }
    s.setActiveView(SECTIONS.find((n) => n.id === id)!.home);
  };

  const upload = async (files: File[]) => {
    if (blocked) { toast.info("请先完成当前任务，保存或取消编辑后再导入"); return; }
    for (const file of files) await useStore.getState().upload(file);
  };
  const pickFile = () => fileRef.current?.click();

  const sectionViews = s.views.filter((v) => sectionOf(v.kind) === section);
  const sheetView = active ?? sectionViews[0];
  const sheetLabel = SECTIONS.find((n) => n.id === section)!.label;

  return <main
    className={`wb ${dragging ? "drop-armed" : ""}`}
    onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
    onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
    onDrop={(e) => { e.preventDefault(); setDragging(false); void upload([...e.dataTransfer.files]); }}
  >
    <ConfirmDialog open={!!s.pendingViewId} busy={s.saving} title="放弃未保存的修改？" description="当前页面有未保存的调整。返回后保存，或放弃修改。" confirmText="放弃修改"
      onCancel={() => useStore.setState({ pendingViewId: null })}
      onConfirm={() => {
        const id = useStore.getState().pendingViewId;
        useStore.setState({ mappingDirty: false, settingsDirty: false, boqDirty: false, pendingViewId: null });
        if (id === CLOSE_VIEW_ID) useStore.setState({ viewOpen: false });
        else if (id) useStore.getState().setActiveView(id);
      }} />
    <input ref={fileRef} type="file" accept=".xls,.xlsx,.csv,.pdf" multiple hidden onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; void upload(fs); }} />
    <div className="gov-strip">安装造价工作台 · <b>对话即造价</b></div>
    <ProjectHeader section={section} sheetOpen={s.viewOpen} onOpen={open} onUpload={pickFile} projects={projects} />
    <section id="main-content" aria-label="造价助手对话" className="wb-conv-col">
      <PendingImports />
      {s.loadingError && <Alert variant="destructive" className="wb-error">
        <AlertCircle />
        <AlertTitle>读取工程资料失败</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>{s.loadingError}</span>
          <Button variant="outline" size="sm" disabled={isBusy(s)} onClick={() => void s.init(projectId, true)}>重试</Button>
        </AlertDescription>
      </Alert>}
      {!s.ready
        ? <div className="cost-empty"><Loader2 size={22} className="spin" /><p>正在读取项目资料</p></div>
        : <Conversation />}
    </section>
    {/* 视图浮层：清单/资料/成果/设置按需浮出，对话始终在底层 */}
    <Dialog open={s.viewOpen && s.ready} onOpenChange={(o) => { if (!o) s.closeOverlay(); }}>
      <DialogContent
        showCloseButton={false}
        className="wb-sheet fixed left-3 right-3 top-3 bottom-3 sm:left-6 sm:right-6 sm:top-5 sm:bottom-5 translate-x-0 translate-y-0 flex w-auto max-w-none flex-col gap-0 overflow-hidden rounded-xl p-0 sm:max-w-none max-sm:left-0 max-sm:right-0 max-sm:top-0 max-sm:bottom-0 max-sm:rounded-none"
      >
        <DialogTitle className="sr-only">{sheetView?.title ?? sheetLabel}</DialogTitle>
        <DialogDescription className="sr-only">{`${sheetLabel}面板，Esc 或右上角关闭返回对话`}</DialogDescription>
        <header className="wb-sheet-head">
          <div className="wb-sheet-tabs">
            {section !== "results" && sectionViews.length > 1
              ? <SubTabs views={sectionViews} active={sheetView} label={`${sheetLabel}视图切换`} />
              : <small className="wb-sheet-kind">{sheetLabel}</small>}
          </div>
          <div className="cost-actions">
            {section === "boq" && s.items.length > 0 && (
              <Button variant="ghost" size="sm" asChild>
                <a href={`/api/projects/${projectId}/export`} download><Download size={13} />导出 Excel</a>
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" onClick={() => s.closeOverlay()} aria-label="关闭面板，返回对话"><X size={16} /></Button>
          </div>
        </header>
        <div className={`wb-sheet-body is-${section}`}>
          {section === "files" && <PendingImports />}
          {section === "results" ? <ResultsPanel projectId={projectId} onUpload={pickFile} />
            : section === "boq" && !s.items.length ? <EmptyState
              size="lg"
              icon={<ClipboardList size={22} />}
              title="还没有工程清单"
              hint="上传招标清单、投标报价或结算清单（Excel / PDF），系统会自动识别表格结构。"
              action={<Button disabled={blocked} onClick={pickFile}><Upload size={14} />上传清单</Button>}
            />
            : sheetView ? <ViewRenderer view={sheetView} onUpload={pickFile} /> : null}
        </div>
      </DialogContent>
    </Dialog>
    {dragging && <div className="drop-overlay">松开文件，导入清单或项目资料</div>}
    <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
  </main>;
}
