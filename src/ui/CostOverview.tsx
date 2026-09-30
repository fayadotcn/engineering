"use client";
import { ArrowRight, Check, FileSpreadsheet, Flag, FolderOpen, Settings2 } from "lucide-react";
import { useStore } from "./store";
import type { WorkspaceView } from "@shared/types";

const money = (value: string) => Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function CostOverview() {
  const s = useStore();
  const open = (kind: "fileList" | "boqTable" | "factList", title: string) => {
    const view = { kind, id: `view:${kind}`, title } as WorkspaceView;
    s.replaceView(view); s.setActiveView(view.id);
  };
  const r = s.summary;
  const unpriced = r?.fees.unpricedCount ?? 0;
  const missing = r?.missingSettings ?? [];
  return <div className="cost-overview"><div className="cost-overview-intro"><span className="cost-overview-caption">当前计价概况</span><span className="cost-stage">{!r?.itemCount ? "待导入清单" : unpriced ? "待完善组价" : missing.length ? "待确认计价口径" : "可进入审核"}</span></div>
    <div className="cost-metrics"><div><span>当前税前测算</span><strong>{money(r?.fees.preTax ?? "0")}<small>元</small></strong><p>{r?.itemCount ? "包含已计入的项目费用" : "导入清单后自动汇总"}</p></div><div><span>暂计含税造价</span><strong>{money(r?.fees.grandTotal ?? "0")}<small>元</small></strong><p>{missing.includes("税率") ? "税率未确认，暂不计税" : `税率 ${s.facts.find(f => f.key === "税率")?.value ?? "未确认"}`}</p></div><div><span>有效清单项</span><strong>{r?.itemCount ?? 0}<small>项</small></strong><p>已定综合单价 {r?.pricedCount ?? 0} 项</p></div><button onClick={() => void s.send("预览材料库对未定价项的匹配结果")} disabled={s.running || !unpriced} className={unpriced ? "warn" : ""}><span>待补综合单价</span><strong>{unpriced}<small>项</small></strong><p>{unpriced ? "查看主材价匹配结果 →" : "当前无未定价项"}</p></button></div>
    <div className="cost-workflow">{[{ n: "01", label: "整理资料", done: s.files.length > 0, text: `${s.files.length} 份项目文件`, onClick: () => open("fileList", "项目资料") }, { n: "02", label: "确认口径", done: !missing.length, text: missing.length ? `待确认：${missing.join("、")}` : "基础口径已填写", onClick: () => open("factList", "计价设置") }, { n: "03", label: "定额组价", done: s.items.some(i => i.pricingPlan.length), text: "主材价 → 定额 → 综合单价", onClick: () => void s.send("匹配定额并测算综合单价") }, { n: "04", label: "审核输出", done: false, text: "检查异常，生成造价成果", onClick: () => void s.send("全面检查清单") }].map(step => <button key={step.n} onClick={step.onClick} disabled={s.running}><span className={step.done ? "done" : ""}>{step.done ? <Check size={13} /> : step.n}</span><div><strong>{step.label}</strong><p>{step.text}</p></div><ArrowRight size={13} /></button>)}</div>
    {(missing.length > 0 || unpriced > 0) && <div className="cost-attention"><Flag size={17} /><div><strong>正式输出前需要完善</strong><p>{unpriced ? `${unpriced} 项尚无综合单价。` : ""}{missing.length ? `${missing.join("、")}尚未确认。` : ""}当前金额用于测算，缺项会在费用汇总中标注。</p></div><button className="cost-btn" onClick={() => open("factList", "计价设置")}><Settings2 size={13} />确认口径</button></div>}
    <div className="cost-overview-grid"><section className="cost-overview-section"><div className="section-heading"><h3>专业费用构成</h3><small>按当前清单金额</small></div>{r?.disciplines.length ? r.disciplines.map((d, index) => <div className="discipline-row" key={d.key}><span className="discipline-dot" style={{ background: ["#315acb", "#448b84", "#d19d4b", "#8c78b7", "#8a9cb4"][index % 5] }} /><span>{d.label}</span><div className="discipline-bar"><i style={{ width: `${Math.max(0, Math.min(100, d.share * 100))}%` }} /></div><strong>{money(d.amount)}</strong><small>{(d.share * 100).toFixed(1)}%</small></div>) : <div className="cost-section-empty"><FileSpreadsheet size={25} /><p>导入清单后，展示各专业费用</p><button className="cost-btn" onClick={() => open("fileList", "项目资料")}>查看项目资料</button></div>}</section><section className="cost-overview-section"><div className="section-heading"><h3>最近操作</h3><button onClick={() => { s.replaceView({ kind: "receipts", id: "view:receipts", title: "变更记录" }); s.setActiveView("view:receipts"); }}>查看全部 <ArrowRight size={12} /></button></div>{s.receipts.slice(0, 5).map(r => <div className="cost-recent-row" key={r.id}><span className="status-dot" /><div><p>{r.summary}</p><small>{new Date(r.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} · {r.createdBy === "user" ? "人工操作" : "造价助手"}</small></div></div>)}{!s.receipts.length && <div className="cost-section-empty"><FolderOpen size={25} /><p>导入和修改都会留下记录</p></div>}</section></div>
  </div>;
}
