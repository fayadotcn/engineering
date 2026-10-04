"use client";
import { ArrowRight, Check, FolderOpen, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStore } from "./store";
import { DISCIPLINE_COLOR } from "./colors";
import { DisciplineDonut, ProgressRing } from "./dashboard";
import { FeeWaterfall } from "./FeeWaterfall";
import type { Discipline } from "@shared/types";

const money = (value: string) => Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** 大额用「万」说话：941.9 万元 比 9,418,648.28 元 一眼可读；小金额保留到分。 */
const wan = (value: string) => { const n = Number(value); return n >= 1e8 ? `${(n / 1e8).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 亿元` : n >= 10000 ? `${(n / 10000).toLocaleString("zh-CN", { maximumFractionDigits: n >= 1000000 ? 0 : 1 })} 万元` : `${money(value)} 元`; };
const wanNum = (value: string) => { const n = Number(value); return n >= 1e8 ? `${(n / 1e8).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}亿` : n >= 10000 ? `${(n / 10000).toLocaleString("zh-CN", { maximumFractionDigits: n >= 1000000 ? 0 : 1 })}万` : money(value); };

export function CostOverview({ onUpload }: { onUpload?: () => void }) {
  const s = useStore();
  const r = s.summary;
  const unpriced = r?.fees.unpricedCount ?? 0;
  const missing = r?.missingSettings ?? [];
  const pending = s.blocks.filter(b => b.type === "confirm" && !b.decided).length;
  const busy = s.running || s.agentRunning || s.importRunning || s.saving || s.mappingDirty || s.settingsDirty || s.boqDirty;
  const upload = onUpload ?? (() => s.setActiveView("view:files"));
  const next = pending
    ? { title: "有文件需要你核对", text: "按上方提示核对表格，再点击确认导入。", action: "查看文件", icon: <FolderOpen size={14} />, click: () => s.setActiveView("view:files") }
    : !r?.itemCount
      ? { title: s.files.length ? "还需要导入工程清单" : "先上传工程清单", text: "上传 Excel 或 PDF，系统帮你整理成清单。", action: "上传清单", icon: <FolderOpen size={14} />, click: upload }
      : missing.length
        ? { title: "补充几项报价设置", text: `还缺：${missing.join("、")}。`, action: "去填写", icon: <ArrowRight size={14} />, click: () => s.setActiveView("view:facts") }
        : unpriced
          ? { title: `还有 ${unpriced} 项未报价`, text: "自动补主材价、匹配定额测算、汇总费用，写回清单前会请你确认。", action: "一键报价", icon: <Zap size={14} />, click: () => void s.send("一键智能报价", { autopilot: true }) }
          : { title: "可以整理结果了", text: "检查清单后，导出 Excel。", action: "导出 Excel", icon: <ArrowRight size={14} />, click: () => void s.send("全面检查清单并导出修改后的清单 Excel") };

  const pricable = r?.pricableCount ?? 0;
  const priced = r?.pricedCount ?? 0;
  const coverage = pricable > 0 ? Math.round((priced / pricable) * 100) : 0;
  const mix = (r?.disciplines ?? []).filter(d => Number(d.amount) > 0);
  // 申报核对按文件配对：每份源表的汇总口径只跟自己的清单行比，差>1%的项按差异额降序
  const driftFiles = (r?.declaredCheck ?? [])
    .map(d => ({ file: d.file, checks: d.checks.filter(c => Math.abs(c.pct) > 0.01).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)) }))
    .filter(d => d.checks.length);
  const driftCount = driftFiles.reduce((n, d) => n + d.checks.length, 0);
  const driftMax = driftFiles.flatMap(d => d.checks).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))[0];
  const hasResults = s.views.some(v => v.id.startsWith("view:") && !["view:boq", "view:files", "view:overview", "view:facts", "view:receipts", "view:prices"].includes(v.id));

  /** 点专业跳到这个专业对应的清单行——数字能追问。 */
  const drillDiscipline = (key: string) => {
    useStore.setState(st => ({
      boqOnlyUnpriced: false,
      views: st.views.map(v => v.id === "view:boq" && v.kind === "boqTable" ? { ...v, filter: { ...v.filter, discipline: key as Discipline } } : v),
    }));
    s.setActiveView("view:boq");
  };

  const steps = [
    { label: "传清单", done: !!r?.itemCount, click: () => s.setActiveView("view:files") },
    { label: "补计价设置", done: !!r?.itemCount && !missing.length, click: () => s.setActiveView("view:facts") },
    { label: "填价格", done: pricable > 0 && !unpriced, click: () => s.setActiveView("view:boq") },
    { label: "出成果", done: hasResults, click: () => s.setActiveView("empty:results") },
  ];
  const currentStep = steps.findIndex(st => !st.done);
  const hasBoq = !!r?.itemCount;

  return <div className="cost-overview cost-simple-overview">
    <ol className="cost-steps">{steps.map((st, i) => <li key={st.label} className={`${st.done ? "done" : ""} ${i === currentStep ? "current" : ""}`}><button onClick={st.click}><i>{st.done ? <Check size={11} /> : i + 1}</i>{st.label}</button></li>)}</ol>

    <div className="dash-hero">
      <div className="cost-next-step"><div><small>现在做这一步</small><h3>{next.title}</h3><p>{next.text}</p></div><Button disabled={busy} onClick={next.click}>{next.icon}{next.action}<ArrowRight size={14} /></Button></div>
      {hasBoq && <div className="dash-kpis">
        <div className="dash-kpi">
          <span>当前总价（暂计）</span>
          <strong>{wanNum(r!.fees.grandTotal)}<small>元</small></strong>
          <p>{missing.includes("税率") ? "未填税率，暂不计税" : `${r!.itemCount} 项清单 · ${s.files.length} 份文件`}</p>
        </div>
        {pricable > 0 && <div className="dash-kpi">
          <span>定价进度</span>
          <div className="dash-kpi-ring"><ProgressRing pct={coverage} done={coverage >= 100} /></div>
          <p>{priced} / {pricable} 项已报价</p>
        </div>}
        <button className={`dash-kpi ${unpriced ? "warn" : ""}`} disabled={!unpriced} onClick={() => { useStore.setState({ boqOnlyUnpriced: true }); s.setActiveView("view:boq"); }}>
          <span>还没报单价</span>
          <strong>{unpriced}<small>项</small></strong>
          <p>{unpriced ? "点击查看这些项目 →" : "当前没有未报价项"}</p>
        </button>
      </div>}
    </div>
    {hasBoq && <p className="cost-conclusion">这个工程目前合计约 <strong>{wan(r!.fees.grandTotal)}</strong>{missing.includes("税率") ? "（税金还没算进去）" : ""}，{unpriced ? <>还有 <strong>{unpriced}</strong> 项没填单价。</> : "清单里的项目都填了价。"}</p>}

    {hasBoq && (mix.length > 0 || Number(r!.fees.grandTotal) > 0) && <div className="dash-charts">
      {mix.length > 0 && <section className="dash-card">
        <div className="dash-card-head"><span>钱都花在哪</span><small>按专业分 · 点图下钻清单</small></div>
        <div className="dash-card-body donut-wrap">
          <DisciplineDonut slices={mix} center={wanNum(r!.fees.grandTotal)} sub="含税总价" onSelect={drillDiscipline} />
          <ul className="cost-mix-legend">{mix.map(d => { const pct = d.share > 0 && d.share < 0.005 ? "<1%" : `${Math.round(d.share * 100)}%`; return <li key={d.key}><button onClick={() => drillDiscipline(d.key)} title={`只看${d.label}的清单`}><i style={{ background: DISCIPLINE_COLOR[d.key] ?? DISCIPLINE_COLOR.OTHER }} />{d.label}<em>{wan(d.amount)} · {pct}</em></button></li>; })}</ul>
        </div>
      </section>}
      {Number(r!.fees.grandTotal) > 0 && <section className="dash-card">
        <div className="dash-card-head"><span>费用怎么加出来的</span><small>分部分项 → 措施 → 规费 → 税金</small></div>
        <div className="dash-card-body">
          <FeeWaterfall rows={r!.fees.rows} grandTotal={r!.fees.grandTotal}
            onFix={missing.length ? () => s.setActiveView("view:facts") : undefined} />
        </div>
      </section>}
    </div>}

    {!!driftFiles.length ? null : (r?.declaredChecked ?? 0) > 0 && (
      <p className="cost-file-hint" style={{ color: "var(--success-soft-fg)" }}>✓ 已与 {r!.declaredChecked} 份源表的申报汇总口径核对，无差异。</p>
    )}
    {!!driftFiles.length && <details className="cost-fact-details cost-drift"><summary>⚠ 与源表申报口径有 {driftCount} 处差异，最大 {wan(String(Math.abs(driftMax.diff)))}（{driftMax.label}）</summary><div className="xl-sheet">{driftFiles.map(d => <div key={d.file}>{driftFiles.length > 1 && <p className="cost-file-hint cost-drift-file">按「{d.file}」口径</p>}<table className="xl-table"><thead><tr><th>口径</th><th className="text-right">源表申报（元）</th><th className="text-right">本次计算（元）</th><th className="text-right">差异</th></tr></thead><tbody>{d.checks.map(c => <tr key={c.label}><td>{c.label}</td><td className="mono text-right">{money(String(c.declared))}</td><td className="mono text-right">{money(String(c.computed))}</td><td className={`mono text-right ${Math.abs(c.pct) > 0.05 ? "warn" : ""}`} title={c.note}>{c.diff > 0 ? "+" : ""}{money(String(c.diff))}（{(c.pct * 100).toFixed(1)}%）{c.note && <small className="block text-[10px] text-muted-foreground">{c.note}</small>}</td></tr>)}</tbody></table></div>)}<p className="cost-file-hint">源表申报来自上传文件里的单位工程汇总表；差异常见于规费未取费、暂列金额口径或合价四舍五入。可在台账补录「规费费率」等设置后重新汇总。</p></div></details>}
    <details className="cost-fact-details"><summary>查看费用明细</summary><div className="xl-sheet"><table className="xl-table"><thead><tr><th>专业</th><th className="text-right">金额（元）</th></tr></thead><tbody>{r?.disciplines.map(d => <tr key={d.key}><td>{d.label}</td><td className="mono text-right">{money(d.amount)}</td></tr>)}</tbody></table>{!r?.disciplines.length && <p className="cost-file-hint">上传清单后显示费用明细。</p>}</div><p className="cost-file-hint">税前金额：{money(r?.fees.preTax ?? "0")} 元</p></details>
    <details className="cost-fact-details"><summary>查看操作记录</summary>{s.receipts.slice(0, 5).map(receipt => <div className="cost-recent-row" key={receipt.id}><div><p>{receipt.summary}</p><small>{new Date(receipt.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</small></div></div>)}{!s.receipts.length && <p className="cost-file-hint">还没有操作记录。</p>}<Button variant="outline" size="sm" onClick={() => s.setActiveView("view:receipts")}>全部记录</Button></details>
  </div>;
}
