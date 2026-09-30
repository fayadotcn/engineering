"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ClipboardList, Download, FileSpreadsheet, FolderOpen, LayoutDashboard, Loader2, Settings2, Upload, X } from "lucide-react";
import { useStore, type ConvBlock } from "./store";
import { AnomalyTable, BoqTable, Breakdown, DiffView, DocumentView, ExportResult, SpecResultView, FeeSummaryView, FileCompareView, FileList, MeasureFeeView, QuotaResult, QuotationMatch, ReceiptsView } from "./views";
import { ColumnMappingView } from "./views/ColumnMappingView";
import { PricingSettings } from "./PricingSettings";
import { CostOverview } from "./CostOverview";
import { toast } from "./primitives";
import type { WorkspaceView } from "@shared/types";

/**
 * 项目级对象：导航只说"在操作什么"。
 * 组价、审核、费用汇总不再各占一个顶级入口——它们都是清单和成果上的动作与视图。
 */
const NAV = [
  { id: "overview", label: "总览", icon: LayoutDashboard, viewId: "view:overview", hint: "查看当前测算与待办，按顺序推进造价工作。" },
  { id: "boq", label: "工程清单", icon: ClipboardList, viewId: "view:boq", hint: "核对工程量和综合单价，预览主材匹配与定额测算。" },
  { id: "files", label: "项目资料", icon: FolderOpen, viewId: "view:files", hint: "导入清单、询价表与 PDF，核对识别结果。" },
  { id: "settings", label: "计价条件", icon: Settings2, viewId: "view:facts", hint: "确认价格依据、管理费、利润与税率。" },
  { id: "results", label: "成果", icon: FileSpreadsheet, viewId: "empty:results", hint: "查看费用汇总、审核结果与导出文件。" },
] as const;

type ObjectId = (typeof NAV)[number]["id"];

/** 每个视图归属的对象；对象是唯一的顶级层级，视图只是它下面的结果。 */
const OWNER: Record<WorkspaceView["kind"], ObjectId> = {
  overview: "overview",
  receipts: "overview",
  factList: "settings",
  boqTable: "boq",
  quotaResult: "boq",
  quotationMatch: "boq",
  specResult: "boq",
  anomalyTable: "results",
  fileCompare: "results",
  diff: "results",
  fileList: "files",
  columnMapping: "files",
  document: "files",
  feeSummary: "results",
  measureFee: "results",
  breakdown: "results",
  exportResult: "results",
};

/** 对象为空时的唯一动作入口；与在对话里直接说这句话等价。 */
const EMPTY_TASK: Partial<Record<ObjectId, string>> = {
  boq: "匹配定额并测算综合单价，展示组价明细和缺价项",
  results: "生成费用汇总表，说明计价条件缺项",
};

function Result({ view }: { view: WorkspaceView }) {
  switch (view.kind) {
    case "boqTable": return <BoqTable />;
    case "overview": return <CostOverview />;
    case "receipts": return <ReceiptsView />;
    case "anomalyTable": return <AnomalyTable view={view} />;
    case "quotationMatch": return <QuotationMatch view={view} />;
    case "breakdown": return <Breakdown view={view} />;
    case "quotaResult": return <QuotaResult view={view} />;
    case "feeSummary": return <FeeSummaryView view={view} />;
    case "measureFee": return <MeasureFeeView view={view} />;
    case "fileCompare": return <FileCompareView view={view} />;
    case "document": return <DocumentView view={view} />;
    case "specResult": return <SpecResultView view={view} />;
    case "diff": return <DiffView view={view} />;
    case "factList": return <PricingSettings />;
    case "exportResult": return <ExportResult view={view} />;
    case "fileList": return <FileList />;
    case "columnMapping": return <ColumnMappingView view={view} />;
  }
}

function ImportConfirmation({ block }: { block: Extract<ConvBlock, { type: "confirm" }> }) {
  const s = useStore();
  const mapping = s.views.find(v => v.kind === "columnMapping" && block.description.includes(v.filename));
  return <div className="import-confirm" role="status"><div><strong>待核对 · 导入映射</strong><p>{block.description}</p></div><div className="cost-actions"><button className="cost-btn" disabled={s.running} onClick={() => void s.confirmImport(block.runId, false)}>取消导入</button>{mapping && <button className="cost-btn" onClick={() => s.setActiveView(mapping.id)}>核对映射</button>}<button className="cost-btn primary" disabled={s.running} onClick={() => void s.confirmImport(block.runId, true)}>确认导入</button></div></div>;
}

export function Workbench({ projectId }: { projectId: string }) {
  const s = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const selectedViews = useRef<Partial<Record<ObjectId, string>>>({});

  useEffect(() => {
    const origin = new URLSearchParams(location.search).get("harnessOrigin");
    if (origin) sessionStorage.setItem("installation:harnessOrigin", origin);
    void s.init(projectId);
    selectedViews.current = {};
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !useStore.getState().running) void useStore.getState().init(projectId, true);
    }, 8000);
    return () => clearInterval(timer);
  }, [projectId]);

  // 与对话侧的握手：接受"定位到某个结果视图/某一行"和"立刻重载"。
  // 定位是用户点了卡片才发生的，不是系统替用户决定看什么。
  useEffect(() => {
    const parentOrigin = new URLSearchParams(location.search).get("harnessOrigin") ?? sessionStorage.getItem("installation:harnessOrigin");
    if (!parentOrigin || window.parent === window) return;
    const receive = (event: MessageEvent) => {
      if (event.origin !== parentOrigin || event.source !== window.parent) return;
      if (event.data?.projectId !== projectId) return;
      if (event.data.type === "installation:taskState") {
        useStore.setState({ agentRunning: !!event.data.running });
        return;
      }
      if (event.data.type === "installation:focus") {
        const store = useStore.getState();
        if (typeof event.data.viewId === "string") store.setActiveView(event.data.viewId);
        if (typeof event.data.boqQuery === "string" && event.data.boqQuery) store.gotoBoqItem(event.data.boqQuery);
        return;
      }
      if (event.data.type === "installation:refresh") void useStore.getState().init(projectId, true);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [projectId]);

  // 视图重放完成才通知对话侧：在那之前"定位到某个结果"没有落点。
  useEffect(() => {
    if (!s.ready || s.loadingError || s.projectId !== projectId) return;
    const parentOrigin = new URLSearchParams(location.search).get("harnessOrigin") ?? sessionStorage.getItem("installation:harnessOrigin");
    if (parentOrigin && window.parent !== window) window.parent.postMessage({ type: "installation:ready", projectId }, parentOrigin);
  }, [s.ready, s.loadingError, s.projectId, projectId]);

  /** 面板只承载当前工程的数据，不再有自己的工程 header 与返回入口。 */
  const active = s.views.find(v => v.id === s.activeViewId);
  const object: ObjectId = active ? OWNER[active.kind] : (NAV.find(n => `empty:${n.id}` === s.activeViewId)?.id ?? "overview");
  const owned = s.views.filter(v => OWNER[v.kind] === object);
  if (active) selectedViews.current[object] = active.id;
  const busy = s.running || s.agentRunning || uploading;

  const open = (id: ObjectId) => {
    const current = s.views.find(v => v.id === s.activeViewId);
    if (current && OWNER[current.kind] === id) return;
    const remembered = selectedViews.current[id];
    const target = s.views.find(v => v.id === remembered && OWNER[v.kind] === id);
    s.setActiveView(target?.id ?? NAV.find(n => n.id === id)!.viewId);
  };

  const upload = async (files: File[]) => {
    if (busy) { toast.info("请先完成当前任务"); return; }
    setUploading(true);
    try { for (const file of files) await useStore.getState().upload(file); }
    finally { setUploading(false); }
  };

  const pending = s.blocks.filter((b): b is Extract<ConvBlock, { type: "confirm" }> => b.type === "confirm" && !b.decided);

  const lastRunBlock = [...s.blocks].reverse().find(b => "runId" in b && b.runId);
  const latestRunId = lastRunBlock && "runId" in lastRunBlock ? lastRunBlock.runId : undefined;
  const errors = s.blocks.filter((b): b is Extract<ConvBlock, { type: "error" }> => b.type === "error" && (!b.runId || b.runId === latestRunId)).slice(-1);
  const title = active?.title ?? NAV.find(n => n.id === object)?.label ?? "总览";
  const ownedTitle = NAV.find(n => n.id === object)?.label ?? "总览";
  const emptyTask = EMPTY_TASK[object];
  const nav = NAV.find(n => n.id === object)!;
  const close = (id: string) => {
    const next = owned.find(v => v.id !== id);
    s.closeView(id);
    if (s.activeViewId === id) s.setActiveView(next?.id ?? nav.viewId);
  };

  return <main className={`cost-workbench ${dragging ? "drop-armed" : ""}`} onDragOver={e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }} onDrop={e => { e.preventDefault(); setDragging(false); void upload([...e.dataTransfer.files]); }}>
    <input ref={fileRef} type="file" accept=".xls,.xlsx,.csv,.pdf" multiple className="hidden" onChange={e => { void upload([...(e.target.files ?? [])]); e.target.value = ""; }} />
    <div className="cost-workspace-top"><span title={s.projectName}>{s.projectName || "造价工作区"}</span><button className="cost-btn" disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={13} />导入资料</button></div>
    <nav className="cost-project-nav" aria-label="工程工作区">{NAV.map(n => { const Icon = n.icon; return <button key={n.id} onClick={() => open(n.id)} aria-current={object === n.id ? "page" : undefined} className={object === n.id ? "active" : ""}><Icon size={14} /><span>{n.label}</span>{n.id === "files" && pending.length > 0 && <small>{pending.length} 待确认</small>}</button>; })}</nav>
    <section className="cost-content">
      <div className="cost-content-heading"><div><h2>{title}</h2><p>{nav.hint}</p></div></div>
      {pending.map(block => <ImportConfirmation key={block.confirmId} block={block} />)}
      {busy && <div className="cost-status" role="status"><Loader2 size={14} className="spin" />{s.agentRunning ? "造价助手正在处理，完成后更新结果。" : "正在导入资料；需要核对时会暂停等待确认。"}</div>}
      {s.loadingError && <div className="cost-error" role="alert">{s.loadingError}<button className="cost-btn" onClick={() => void s.init(projectId)}>重新加载</button></div>}
      {errors.map((e, i) => <div className="cost-error" key={i} role="alert">{e.text}</div>)}
      {object === "boq" && s.items.length > 0 && <div className="cost-taskbar" aria-label="清单操作"><button className="cost-btn" disabled={busy} onClick={() => void s.send("预览材料库对缺主材价项的匹配结果，不写回")}>预览主材匹配</button><button className="cost-btn" disabled={busy} onClick={() => void s.send("匹配定额并测算综合单价，展示组价明细和缺价项，不写回")}>测算综合单价</button><span>写回修改需在对话中确认</span></div>}
      {object === "results" && <div className="cost-taskbar" aria-label="成果操作"><button className="cost-btn" disabled={busy || !s.items.length} onClick={() => void s.send("生成费用汇总表，说明计价条件缺项")}>费用汇总</button><button className="cost-btn" disabled={busy || !s.items.length} onClick={() => void s.send("全面检查清单")}>检查异常</button><button className="cost-btn" disabled={busy || !s.items.length} onClick={() => void s.send("导出修改后的清单 Excel")}><Download size={13} />导出 Excel</button></div>}
      {owned.length > 1 && <div className="cost-result-tabs" aria-label={`${ownedTitle}结果`}>{owned.map(v => <div key={v.id} className={v.id === active?.id ? "active" : ""}><button aria-pressed={v.id === active?.id} onClick={() => s.setActiveView(v.id)}>{v.title}</button>{!NAV.some(n => n.viewId === v.id) && v.id !== "view:receipts" && <button aria-label={`关闭${v.title}`} onClick={() => close(v.id)}><X size={12} /></button>}</div>)}</div>}
      <div className="cost-result-body">{!s.ready ? <div className="cost-empty"><Loader2 size={22} className="spin" /><p>正在读取项目资料</p></div> : s.loadingError ? null : object === "boq" && !s.items.length ? <div className="cost-empty"><ClipboardList size={30} /><h3>还没有工程清单</h3><p>先导入清单 Excel 或带文本层的 PDF，再核对工程量与综合单价。</p><button className="cost-btn primary" disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={14} />导入清单</button></div> : active ? <Result key={active.id} view={active} /> : <div className="cost-empty"><FileSpreadsheet size={30} /><h3>尚未生成成果</h3><p>{s.items.length ? "生成费用汇总，核对异常后导出清单。结果会保留在此处，随时可以重新查看。" : "导入清单并确认计价条件后，在这里汇总费用、检查异常和导出成果。"}</p>{s.items.length && emptyTask ? <button className="cost-btn primary" disabled={busy} onClick={() => void s.send(emptyTask)}>生成费用汇总<ArrowRight size={14} /></button> : <button className="cost-btn" onClick={() => open("files")}>查看项目资料<ArrowRight size={14} /></button>}</div>}</div>
    </section>{dragging && <div className="drop-overlay">松开文件，导入清单或项目资料</div>}
  </main>;
}
