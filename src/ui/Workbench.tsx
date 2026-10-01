"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ClipboardList, Download, FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { useStore, type ConvBlock } from "./store";
import { AnomalyTable, BoqTable, Breakdown, DiffView, DocumentView, ExportResult, SpecResultView, FeeSummaryView, FileCompareView, FileList, MeasureFeeView, QuotaResult, QuotationMatch, ReceiptsView } from "./views";
import { ColumnMappingView } from "./views/ColumnMappingView";
import { PricingSettings } from "./PricingSettings";
import { CostOverview } from "./CostOverview";
import { ConfirmDialog, toast } from "./primitives";
import type { WorkspaceView } from "@shared/types";

const NAV = [
  { id: "boq", label: "清单", viewId: "view:boq" },
  { id: "files", label: "资料", viewId: "view:files" },
  { id: "results", label: "成果", viewId: "empty:results" },
] as const;
const INFO = [
  { id: "overview", label: "工程概况", viewId: "view:overview" },
  { id: "settings", label: "计价设置", viewId: "view:facts" },
  { id: "history", label: "操作记录", viewId: "view:receipts" },
] as const;
const PAGES = [...NAV, ...INFO];

type ObjectId = (typeof PAGES)[number]["id"];

/** 每个视图归属的对象；对象是唯一的顶级层级，视图只是它下面的结果。 */
const OWNER: Record<WorkspaceView["kind"], ObjectId> = {
  overview: "overview",
  receipts: "history",
  factList: "settings",
  boqTable: "boq",
  quotaResult: "results",
  quotationMatch: "results",
  specResult: "results",
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
  results: "生成费用汇总表，说明计价条件缺项",
};

function Result({ view, onUpload }: { view: WorkspaceView; onUpload: () => void }) {
  switch (view.kind) {
    case "boqTable": return <BoqTable view={view} />;
    case "overview": return <CostOverview onUpload={onUpload} />;
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
  const busy = s.running || s.agentRunning || s.importRunning || s.saving || s.boqDirty || s.settingsDirty || s.mappingDirty;
  const mapping = s.views.find(v => v.kind === "columnMapping" && (v.fileId === block.fileId || block.description.includes(v.filename)));
  const closedMapping = s.closedViewIds.find(id => id === `view:mapping:${block.fileId}` || s.files.some(f => id === `view:mapping:${f.id}` && block.description.includes(f.filename)));
  const mappingId = mapping?.id ?? closedMapping;
  const review = () => { if (!mappingId) return; s.setActiveView(mappingId); if (!mapping && s.projectId) void s.init(s.projectId, true); };
  if (s.activeViewId !== mappingId) return <div className="import-confirm" role="status"><div><strong>有资料需要核对</strong><p>{block.description}</p></div><button className="cost-btn" onClick={mappingId ? review : () => s.setActiveView("view:files")}>核对并导入<ArrowRight size={14} /></button></div>;
  return <div className="import-confirm" role="status"><div><strong>请核对表格，再导入</strong><p>{s.mappingDirty ? "你改了识别结果，请先保存，再确认导入。" : block.description}</p></div><div className="cost-actions"><button className="cost-btn" disabled={busy} onClick={() => void s.confirmImport(block.runId, false)}>取消导入</button>{mappingId && <button className="cost-btn" onClick={review}>核对表格</button>}<button className="cost-btn primary" disabled={busy || s.mappingDirty} onClick={() => void s.confirmImport(block.runId, true)}>确认导入</button></div></div>;
}

export function Workbench({ projectId }: { projectId: string }) {
  const s = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const infoRef = useRef<HTMLDetailsElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const selectedViews = useRef<Partial<Record<ObjectId, string>>>({});

  useEffect(() => {
    const origin = new URLSearchParams(location.search).get("harnessOrigin");
    if (origin) sessionStorage.setItem("installation:harnessOrigin", origin);
    void s.init(projectId);
    selectedViews.current = {};
    const timer = setInterval(() => {
      const state = useStore.getState();
      if (document.visibilityState === "visible" && !state.running && !state.importRunning && !state.saving && !state.boqDirty) void state.init(projectId, true);
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
      if (event.data.type === "installation:importState") {
        useStore.setState({ importRunning: !!event.data.running });
        return;
      }
      if (event.data.type === "installation:focus") {
        const store = useStore.getState();
        if (typeof event.data.viewId === "string") {
          store.setActiveView(event.data.viewId);
          if (!store.views.some(v => v.id === event.data.viewId)) void store.init(projectId, true);
        }
        if (typeof event.data.boqQuery === "string" && event.data.boqQuery) store.gotoBoqItem(event.data.boqQuery);
        return;
      }
      if (event.data.type === "installation:refresh" && !useStore.getState().running) void useStore.getState().init(projectId, true);
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

  const activityStamp = `${s.lastViewEvent}:${s.receipts[0]?.id}:${s.files.map(f => `${f.id}:${f.status}`).join(",")}:${s.blocks.filter(b => b.type === "confirm").map(b => b.type === "confirm" ? `${b.confirmId}:${b.decided}` : "").join(",")}`;
  useEffect(() => {
    if (!s.ready || s.projectId !== projectId) return;
    const origin = sessionStorage.getItem("installation:harnessOrigin");
    if (origin && window.parent !== window) window.parent.postMessage({ type: "installation:activityChanged", projectId }, origin);
  }, [activityStamp, s.ready, s.projectId, projectId]);

  // 页内切换保留编辑决策，刷新或关闭页面时使用浏览器原生未保存提示。
  useEffect(() => {
    if (!s.mappingDirty && !s.settingsDirty && !s.boqDirty && !s.saving) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [s.mappingDirty, s.settingsDirty, s.boqDirty, s.saving]);
  const active = s.views.find(v => v.id === s.activeViewId);
  const object: ObjectId = active ? OWNER[active.kind] : (PAGES.find(n => `empty:${n.id}` === s.activeViewId)?.id ?? "boq");
  const owned = s.views.filter(v => OWNER[v.kind] === object);
  if (active) selectedViews.current[object] = active.id;
  const busy = s.running || s.agentRunning || s.importRunning || s.saving || uploading || !s.ready;
  const actionsBlocked = busy || s.mappingDirty || s.settingsDirty || s.boqDirty || !!s.loadingError;

  const open = (id: ObjectId) => {
    const current = s.views.find(v => v.id === s.activeViewId);
    if (current && OWNER[current.kind] === id) return;
    const remembered = selectedViews.current[id];
    const target = s.views.find(v => v.id === remembered && OWNER[v.kind] === id)
      ?? (id === "results" ? [...s.views].reverse().find(v => OWNER[v.kind] === id) : undefined);
    s.setActiveView(target?.id ?? PAGES.find(n => n.id === id)!.viewId);
  };

  const upload = async (files: File[]) => {
    if (actionsBlocked) { toast.info("请先完成当前任务，保存或取消编辑后再导入"); return; }
    setUploading(true);
    try { for (const file of files) await useStore.getState().upload(file); }
    finally { setUploading(false); }
  };

  const pending = s.blocks.filter((b): b is Extract<ConvBlock, { type: "confirm" }> => b.type === "confirm" && !b.decided);

  const lastRunBlock = [...s.blocks].reverse().find(b => "runId" in b && b.runId);
  const latestRunId = lastRunBlock && "runId" in lastRunBlock ? lastRunBlock.runId : undefined;
  const errors = s.blocks.filter((b): b is Extract<ConvBlock, { type: "error" }> => b.type === "error" && (!b.runId || b.runId === latestRunId)).slice(-1);
  const title = active?.title ?? PAGES.find(n => n.id === object)?.label ?? "清单";
  useEffect(() => {
    const origin = sessionStorage.getItem("installation:harnessOrigin");
    if (s.ready && origin && window.parent !== window) window.parent.postMessage({ type: "installation:workspaceState", projectId, title, busy: actionsBlocked }, origin);
  }, [s.ready, projectId, title, actionsBlocked]);
  const ownedTitle = PAGES.find(n => n.id === object)?.label ?? "清单";
  const emptyTask = EMPTY_TASK[object];
  const nav = PAGES.find(n => n.id === object)!;

  return <main className={`cost-workbench ${dragging ? "drop-armed" : ""}`} onDragOver={e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }} onDrop={e => { e.preventDefault(); setDragging(false); void upload([...e.dataTransfer.files]); }}>
    <ConfirmDialog open={!!s.pendingViewId} busy={s.saving} title="放弃未保存的修改？" description="当前页面有未保存的调整。返回后保存，或放弃修改并切换页面。" confirmText="放弃并切换" onCancel={() => useStore.setState({ pendingViewId: null })} onConfirm={() => { const id = useStore.getState().pendingViewId; useStore.setState({ mappingDirty: false, settingsDirty: false, boqDirty: false, pendingViewId: null }); if (id) useStore.getState().setActiveView(id); }} />
    <input ref={fileRef} type="file" accept=".xls,.xlsx,.csv,.pdf" multiple className="hidden" onChange={e => { void upload([...(e.target.files ?? [])]); e.target.value = ""; }} />
    <div className="cost-workspace-top"><a className="cost-back" href="/" aria-label="返回工程项目"><ArrowLeft size={14} />工程项目</a><span title={s.projectName}>{s.projectName || "造价工作区"}</span></div>
    <nav className="cost-project-nav" aria-label="工程工作区">{NAV.map(n => <button key={n.id} onClick={() => open(n.id)} aria-current={object === n.id ? "page" : undefined} className={object === n.id ? "active" : ""}>{n.label}{n.id === "files" && pending.length > 0 && <small>{pending.length} 待核对</small>}</button>)}<details ref={infoRef} className="cost-project-info" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false; }} onKeyDown={e => { if (e.key === "Escape") { e.currentTarget.open = false; e.currentTarget.querySelector("summary")?.focus(); } }}><summary className={INFO.some(n => n.id === object) ? "active" : ""}>工程信息</summary><div>{INFO.map(n => <button key={n.id} aria-current={object === n.id ? "page" : undefined} onClick={() => { open(n.id); if (infoRef.current) infoRef.current.open = false; }}>{n.label}</button>)}</div></details></nav>
    <section className="cost-content">
      <div className="cost-content-heading"><h2>{PAGES.some(n => n.viewId === active?.id) ? nav.label : title}</h2><div className="cost-actions">
        {object === "files" && <button className="cost-btn primary" disabled={actionsBlocked} onClick={() => fileRef.current?.click()}><Upload size={14} />上传文件</button>}
        {object === "boq" && s.items.length > 0 && <button className="cost-btn" disabled={actionsBlocked} onClick={() => void s.send("帮我给工程清单报价：查材料价、匹配定额并计算，先展示结果，需要修改清单时请求我的确认。")}>让助手测算</button>}
        {object === "results" && s.items.length > 0 && <button className="cost-btn primary" disabled={actionsBlocked} onClick={() => void s.send("导出修改后的清单 Excel")}><Download size={13} />导出 Excel</button>}
      </div></div>
      {owned.length > 1 && <div className="cost-view-switch"><label className="cost-view-picker">{ownedTitle === "成果" ? "查看成果" : `切换${ownedTitle}`}<select aria-label={`切换${ownedTitle}页面`} value={active?.id ?? ""} onChange={e => s.setActiveView(e.target.value)}>{[...owned].reverse().map(v => <option key={v.id} value={v.id}>{v.title}</option>)}</select></label>{object === "files" && active?.id !== "view:files" && <button className="cost-btn" onClick={() => s.setActiveView("view:files")}>全部资料</button>}{object === "boq" && active?.id !== "view:boq" && <button className="cost-btn" onClick={() => s.setActiveView("view:boq")}>完整清单</button>}</div>}
      {active && ["quotaResult", "quotationMatch", "feeSummary", "measureFee", "anomalyTable", "fileCompare", "breakdown"].includes(active.kind) && <p className="cost-file-hint">此结果保留生成时的数据。清单或计价设置变化后，可让助手重新生成。</p>}
      {pending.map(block => <ImportConfirmation key={block.confirmId} block={block} />)}
      {busy && s.ready && <div className="cost-status" role="status"><Loader2 size={14} className="spin" />{s.saving ? "正在保存…" : s.agentRunning ? "助手正在处理…" : uploading || s.importRunning ? "正在整理文件…" : "正在处理…"}</div>}
      {s.loadingError && <div className="cost-error" role="alert">{s.loadingError}<button className="cost-btn" disabled={s.saving || s.running || s.agentRunning || s.importRunning} onClick={() => void s.init(projectId, true)}>重试</button></div>}
      {errors.map((e, i) => <div className="cost-error" key={i} role="alert">{e.text}</div>)}
      <div className="cost-result-body">{!s.ready ? <div className="cost-empty"><Loader2 size={22} className="spin" /><p>正在读取项目资料</p></div> : s.loadingError && !s.projectName ? null : object === "boq" && !s.items.length ? <div className="cost-empty"><ClipboardList size={30} /><h3>还没有工程清单</h3><p>上传清单后，系统会帮你整理。</p><button className="cost-btn primary" disabled={actionsBlocked} onClick={() => fileRef.current?.click()}><Upload size={14} />上传清单</button></div> : active ? <Result key={active.kind === "boqTable" ? `${active.id}:${s.boqFocusVersion}` : active.id} view={active} onUpload={() => fileRef.current?.click()} /> : <div className="cost-empty"><FileSpreadsheet size={30} /><h3>尚未生成成果</h3><p>{s.items.length ? "在对话里提出测算、检查或汇总任务，完成后会在这里显示。" : "先上传清单，再查看成果。"}</p>{s.items.length && emptyTask ? <button className="cost-btn primary" disabled={actionsBlocked} onClick={() => void s.send(emptyTask)}>让助手汇总费用<ArrowRight size={14} /></button> : <button className="cost-btn" onClick={() => open("files")}>查看项目资料<ArrowRight size={14} /></button>}</div>}</div>
    </section>{dragging && <div className="drop-overlay">松开文件，导入清单或项目资料</div>}
  </main>;
}
