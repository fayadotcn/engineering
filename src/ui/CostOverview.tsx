"use client";
import { ArrowRight, Check, FileSpreadsheet, FolderOpen } from "lucide-react";
import { useStore } from "./store";
import type { WorkspaceView } from "@shared/types";

const money = (value: string) => Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** 常驻视图的固定 id：与 store 初始视图一致，避免同一对象出现两个重复标签。 */
const VIEW_IDS = { fileList: "view:files", boqTable: "view:boq", factList: "view:facts" } as const;
export function CostOverview() {
  const s = useStore();
  const open = (kind: keyof typeof VIEW_IDS, title: string) => {
    const view = { kind, id: VIEW_IDS[kind], title } as WorkspaceView;
    s.replaceView(view); s.setActiveView(view.id);
  };
  const r = s.summary;
  const unpriced = r?.fees.unpricedCount ?? 0;
  const missing = r?.missingSettings ?? [];
  const busy = s.running || s.agentRunning;
  const pending = s.blocks.filter(b => b.type === "confirm" && !b.decided).length;
  const next = !s.files.length ? { title: "先导入工程资料", text: "上传清单、询价表或 PDF，识别完成后核对需要确认的列。", action: "查看项目资料", click: () => open("fileList", "项目资料") } : pending ? { title: `${pending} 项导入等待确认`, text: "打开项目资料，核对列映射后确认导入。", action: "核对导入", click: () => open("fileList", "项目资料") } : missing.length ? { title: "确认本工程的计价条件", text: `待确认：${missing.join("、")}。保存后，当前费用测算会自动更新。`, action: "填写计价条件", click: () => open("factList", "计价条件") } : unpriced ? { title: `${unpriced} 项需要完善综合单价`, text: "先核对主材价，再测算定额组价；批准后才写回综合单价。", action: "查看工程清单", click: () => open("boqTable", "工程清单") } : { title: "核对清单并整理成果", text: "检查异常、汇总费用，再导出本工程的清单成果。", action: "生成费用汇总", click: () => void s.send("生成费用汇总表，说明计价条件缺项") };
  return <div className="cost-overview"><div className="cost-overview-intro"><span className="cost-overview-caption">当前计价概况</span><span className="cost-stage">{!r?.itemCount ? "待导入清单" : unpriced ? "待完善组价" : missing.length ? "待确认计价口径" : "可进入审核"}</span></div>
    <div className="cost-next-step"><div><small>下一步</small><h3>{next.title}</h3><p>{next.text}</p></div><button className="cost-btn primary" disabled={busy} onClick={next.click}>{next.action}<ArrowRight size={13} /></button></div>
    <div className="cost-metrics"><div><span>当前税前测算</span><strong>{money(r?.fees.preTax ?? "0")}<small>元</small></strong><p>{r?.itemCount ? "包含已计入的项目费用" : "导入清单后自动汇总"}</p></div><div><span>暂计含税造价</span><strong>{money(r?.fees.grandTotal ?? "0")}<small>元</small></strong><p>{missing.includes("税率") ? "税率未确认，暂不计税" : `税率 ${s.facts.find(f => f.key === "税率")?.value ?? "未确认"}`}</p></div><div><span>有效清单项</span><strong>{r?.itemCount ?? 0}<small>项</small></strong><p>已定综合单价 {r?.pricedCount ?? 0} 项</p></div><button onClick={() => open("boqTable", "工程清单")} disabled={!unpriced} className={unpriced ? "warn" : ""}><span>待补综合单价</span><strong>{unpriced}<small>项</small></strong><p>{unpriced ? "查看清单并完善组价 →" : "当前无未定价项"}</p></button></div>
    <div className="cost-workflow">{[{ n: "01", label: "整理资料", done: s.files.some(f => f.status === "PARSED"), text: `${s.files.length} 份项目资料`, onClick: () => open("fileList", "项目资料") }, { n: "02", label: "确认口径", done: !!r && !missing.length, text: missing.length ? `${missing.length} 项条件待确认` : "查看价格依据与取费", onClick: () => open("factList", "计价条件") }, { n: "03", label: "定额组价", done: !!r?.pricableCount && !unpriced, text: "主材价 → 定额 → 综合单价", onClick: () => open("boqTable", "工程清单") }, { n: "04", label: "审核输出", done: s.views.some(v => v.kind === "exportResult"), text: "汇总、审核与导出", onClick: () => s.setActiveView(s.views.find(v => v.kind === "feeSummary")?.id ?? "empty:results") }].map(step => <button key={step.n} onClick={step.onClick}><span className={step.done ? "done" : ""}>{step.done ? <Check size={13} /> : step.n}</span><div><strong>{step.label}</strong><p>{step.text}</p></div><ArrowRight size={13} /></button>)}</div>
    <div className="cost-overview-grid"><section className="cost-overview-section"><div className="section-heading"><h3>专业费用构成</h3><small>按当前清单金额</small></div>{r?.disciplines.length ? r.disciplines.map((d, index) => <div className="discipline-row" key={d.key}><span className="discipline-dot" style={{ background: ["#315acb", "#448b84", "#d19d4b", "#8c78b7", "#8a9cb4"][index % 5] }} /><span>{d.label}</span><div className="discipline-bar"><i style={{ width: `${Math.max(0, Math.min(100, d.share * 100))}%` }} /></div><strong>{money(d.amount)}</strong><small>{(d.share * 100).toFixed(1)}%</small></div>) : <div className="cost-section-empty"><FileSpreadsheet size={25} /><p>导入清单后，展示各专业费用</p><button className="cost-btn" onClick={() => open("fileList", "项目资料")}>查看项目资料</button></div>}</section><section className="cost-overview-section"><div className="section-heading"><h3>最近操作</h3><button onClick={() => { s.replaceView({ kind: "receipts", id: "view:receipts", title: "变更记录" }); s.setActiveView("view:receipts"); }}>查看全部 <ArrowRight size={12} /></button></div>{s.receipts.slice(0, 5).map(r => <div className="cost-recent-row" key={r.id}><span className="status-dot" /><div><p>{r.summary}</p><small>{new Date(r.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} · {r.createdBy === "user" ? "人工操作" : "造价助手"}</small></div></div>)}{!s.receipts.length && <div className="cost-section-empty"><FolderOpen size={25} /><p>导入和修改都会留下记录</p></div>}</section></div>
  </div>;
}
