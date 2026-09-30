"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Calculator, CheckCheck, ClipboardList, Download, FileSpreadsheet, FolderOpen, LayoutDashboard, Loader2, RefreshCw, Settings2, Upload, X } from "lucide-react";
import { useStore, type ConvBlock } from "./store";
import { AnomalyTable, BoqTable, Breakdown, DiffView, DocumentView, ExportResult, SpecResultView, FeeSummaryView, FileCompareView, FileList, MeasureFeeView, QuotaResult, QuotationMatch, ReceiptsView } from "./views";
import { ColumnMappingView } from "./views/ColumnMappingView";
import { PricingSettings } from "./PricingSettings";
import { CostOverview } from "./CostOverview";
import { toast } from "./primitives";
import type { WorkspaceView } from "@shared/types";

const NAV = [
  { id: "overview", label: "项目总览", icon: LayoutDashboard },
  { id: "files", label: "项目资料", icon: FolderOpen },
  { id: "boq", label: "工程量清单", icon: ClipboardList },
  { id: "pricing", label: "定额组价", icon: Calculator },
  { id: "fees", label: "费用汇总", icon: FileSpreadsheet },
  { id: "audit", label: "清单审核", icon: CheckCheck },
  { id: "exports", label: "成果导出", icon: Download },
  { id: "settings", label: "计价设置", icon: Settings2 },
] as const;

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
  const [busy, setBusy] = useState(false);
  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/runs/${block.runId}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approve }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "确认失败");
    } catch (error) { toast.error(error instanceof Error ? error.message : "确认失败"); }
    finally { setBusy(false); }
  };
  return <div className="import-confirm" role="status"><div><strong>请核对导入映射</strong><p>{block.description}</p></div><div className="flex shrink-0 gap-2"><button className="cost-btn" disabled={busy} onClick={() => decide(false)}>取消导入</button><button className="cost-btn primary" disabled={busy} onClick={() => decide(true)}>确认导入</button></div></div>;
}

export function Workbench({ projectId }: { projectId: string }) {
  const s = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [tab, setTab] = useState("overview");
  useEffect(() => {
    const origin = new URLSearchParams(location.search).get("harnessOrigin");
    if (origin) sessionStorage.setItem("installation:harnessOrigin", origin);
    const parentOrigin = origin ?? sessionStorage.getItem("installation:harnessOrigin");
    if (parentOrigin && window.parent !== window) window.parent.postMessage({ type: "installation:location", projectId }, parentOrigin);
    void s.init(projectId);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !useStore.getState().running) void useStore.getState().init(projectId, true);
    }, 8000);
    return () => clearInterval(timer);
  }, [projectId]);
  const open = (id: string) => {
    setTab(id);
    const staticKinds: Record<string, WorkspaceView["kind"]> = { overview: "overview", files: "fileList", boq: "boqTable", settings: "factList", receipts: "receipts" };
    const kind = staticKinds[id];
    if (kind) {
      const view = { kind, id: `view:${id}`, title: NAV.find(n => n.id === id)?.label ?? "变更记录" } as WorkspaceView;
      s.replaceView(view); s.setActiveView(view.id);
    } else {
      const kinds: Record<string, string[]> = { pricing: ["quotaResult", "quotationMatch", "specResult"], fees: ["feeSummary", "measureFee"], audit: ["anomalyTable", "fileCompare"], exports: ["exportResult"] };
      const view = [...s.views].reverse().find(v => kinds[id]?.includes(v.kind));
      s.setActiveView(view?.id ?? `empty:${id}`);
    }
  };
  const upload = async (files: File[]) => {
    if (s.running) { toast.info("请先完成当前导入或确认"); return; }
    for (const file of files) await useStore.getState().upload(file);
  };
  const active = s.views.find(v => v.id === s.activeViewId);
  useEffect(() => {
    if (!active) return;
    const category: Record<string, string> = { overview: "overview", fileList: "files", columnMapping: "files", document: "files", boqTable: "boq", factList: "settings", receipts: "receipts", quotaResult: "pricing", quotationMatch: "pricing", specResult: "pricing", feeSummary: "fees", measureFee: "fees", anomalyTable: "audit", fileCompare: "audit", exportResult: "exports" };
    if (category[active.kind]) setTab(category[active.kind]);
  }, [active?.kind, active?.id]);
  const resultKinds: Record<string, string[]> = { files: ["columnMapping", "document"], pricing: ["quotaResult", "quotationMatch", "specResult"], fees: ["feeSummary", "measureFee", "breakdown"], audit: ["anomalyTable", "fileCompare", "diff"], exports: ["exportResult"] };
  const results = s.views.filter(v => resultKinds[tab]?.includes(v.kind));
  const pending = s.blocks.filter((b): b is Extract<ConvBlock, { type: "confirm" }> => b.type === "confirm" && !b.decided);
  const pendingId = pending.at(-1)?.confirmId;
  useEffect(() => {
    const origin = sessionStorage.getItem("installation:harnessOrigin");
    if (pendingId && origin && window.parent !== window) window.parent.postMessage({ type: "installation:showData", projectId }, origin);
  }, [projectId, pendingId]);
  const lastRunBlock = [...s.blocks].reverse().find(b => "runId" in b && b.runId);
  const latestRunId = lastRunBlock && "runId" in lastRunBlock ? lastRunBlock.runId : undefined;
  const errors = s.blocks.filter((b): b is Extract<ConvBlock, { type: "error" }> => b.type === "error" && (!b.runId || b.runId === latestRunId)).slice(-1);
  const title = active?.title ?? NAV.find(n => n.id === tab)?.label ?? "项目总览";
  const task = tab === "pricing" ? "匹配定额并测算综合单价，展示组价明细和缺价项" : tab === "fees" ? "生成费用汇总表，说明计价条件缺项" : tab === "audit" ? "全面检查清单的单价、特征和重复项" : "导出造价分析报告 Excel";
  return <main className={`cost-workbench ${dragging ? "drop-armed" : ""}`} onDragOver={e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }} onDrop={e => { e.preventDefault(); setDragging(false); void upload([...e.dataTransfer.files]); }}>
    <header className="cost-project-header"><a href="/" className="cost-back icon-btn h-8 w-8" aria-label="返回项目列表"><ArrowLeft size={17} /></a><div className="min-w-0"><h1 className="truncate">{s.projectName || "正在加载项目…"}</h1><p className="cost-project-subtitle">项目资料与计价结果</p></div><button className="cost-btn ml-auto" onClick={() => void s.init(projectId, true)} aria-label="刷新项目"><RefreshCw size={14} /></button><button className="cost-btn primary" disabled={s.running} onClick={() => fileRef.current?.click()}><Upload size={14} />导入资料</button></header>
    <input ref={fileRef} type="file" accept=".xls,.xlsx,.csv,.pdf" multiple className="hidden" onChange={e => { void upload([...(e.target.files ?? [])]); e.target.value = ""; }} />
    <div className="cost-workspace-body"><nav className="cost-project-nav" aria-label="项目导航">{NAV.map(n => <button key={n.id} onClick={() => open(n.id)} aria-current={tab === n.id ? "page" : undefined} className={tab === n.id ? "active" : ""}><span>{n.label}</span></button>)}<button className={tab === "receipts" ? "active" : ""} onClick={() => open("receipts")}><span>变更记录</span></button></nav>
    <section className="cost-content"><div className="cost-content-heading"><div><h2>{title}</h2>{tab === "settings" && <p>按项目实际情况确认计价条件，留空表示尚未确定。</p>}</div><button className="cost-btn" disabled={s.running || !s.items.length} onClick={() => void s.send("导出修改后的清单 Excel")}><Download size={14} />导出清单</button></div>
      {pending.map(block => <ImportConfirmation key={block.confirmId} block={block} />)}
      {s.running && <div className="cost-status"><Loader2 size={14} className="spin" />正在处理任务；需要核对时会在这里停下。</div>}
      {s.loadingError && <div className="cost-error" role="alert">{s.loadingError}<button className="cost-btn" onClick={() => void s.init(projectId)}>重新加载</button></div>}
      {errors.map((e, i) => <div className="cost-error" key={i} role="alert">{e.text}</div>)}
      {results.length > 0 && <div className="cost-result-tabs" aria-label="任务结果">{results.map(v => <button key={v.id} className={v.id === active?.id ? "active" : ""} onClick={() => s.setActiveView(v.id)}>{v.title}<span onClick={e => { e.stopPropagation(); s.closeView(v.id); }}><X size={11} /></span></button>)}</div>}
      <div className="cost-result-body">{!s.ready ? <div className="cost-empty"><Loader2 size={22} className="spin" /><p>正在读取项目资料</p></div> : active ? <Result key={active.id} view={active} /> : <div className="cost-empty"><Calculator size={32} /><h3>{title}</h3><p>{tab === "exports" ? "从当前清单生成 Excel 成果，并保留导出记录。" : "发起测算后，明细将显示在这里。可同时在对话中核对依据。"}</p><button className="cost-btn primary" disabled={s.running || !s.items.length} onClick={() => void s.send(task)}>{tab === "pricing" ? "开始定额测算" : tab === "fees" ? "生成费用汇总" : tab === "audit" ? "开始清单审核" : "生成成果"}<ArrowRight size={14} /></button></div>}</div>
    </section></div>{dragging && <div className="drop-overlay">松开文件，导入清单或项目资料</div>}
  </main>;
}
