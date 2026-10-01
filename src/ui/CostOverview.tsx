"use client";
import { ArrowRight } from "lucide-react";
import { useStore } from "./store";

const money = (value: string) => Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function CostOverview({ onUpload }: { onUpload?: () => void }) {
  const s = useStore();
  const r = s.summary;
  const unpriced = r?.fees.unpricedCount ?? 0;
  const missing = r?.missingSettings ?? [];
  const pending = s.blocks.filter(b => b.type === "confirm" && !b.decided).length;
  const busy = s.running || s.agentRunning || s.importRunning || s.saving || s.mappingDirty || s.settingsDirty || s.boqDirty;
  const upload = onUpload ?? (() => s.setActiveView("view:files"));
  const next = pending
    ? { title: "有文件需要你核对", text: "按上方提示核对表格，再点击确认导入。", action: "查看文件", click: () => s.setActiveView("view:files") }
    : !r?.itemCount
      ? { title: s.files.length ? "还需要导入工程清单" : "先上传工程清单", text: "上传 Excel 或 PDF，系统帮你整理成清单。", action: "上传清单", click: upload }
      : missing.length
        ? { title: "补充几项报价设置", text: `还缺：${missing.join("、")}。`, action: "去填写", click: () => s.setActiveView("view:facts") }
        : unpriced
          ? { title: `还有 ${unpriced} 项未报价`, text: "让助手查材料价、匹配定额并测算。修改清单前会请你确认。", action: "自动测算", click: () => void s.send("帮我给工程清单报价：查材料价、匹配定额并计算，先展示结果，需要修改清单时请求我的确认。") }
          : { title: "可以整理结果了", text: "检查清单后，导出 Excel。", action: "导出 Excel", click: () => void s.send("全面检查清单并导出修改后的清单 Excel") };

  return <div className="cost-overview cost-simple-overview">
    <div className="cost-next-step"><div><small>现在做这一步</small><h3>{next.title}</h3><p>{next.text}</p></div><button className="cost-btn primary" disabled={busy} onClick={next.click}>{next.action}<ArrowRight size={14} /></button></div>
    <div className="cost-metrics">
      <div><span>当前总价（暂计）</span><strong>{money(r?.fees.grandTotal ?? "0")}<small>元</small></strong><p>{missing.includes("税率") ? "未填税率，暂不计税" : `${r?.itemCount ?? 0} 项清单 · ${s.files.length} 份文件`}</p></div>
      <button disabled={!unpriced} className={unpriced ? "warn" : ""} onClick={() => { useStore.setState({ boqOnlyUnpriced: true }); s.setActiveView("view:boq"); }}><span>还没报单价</span><strong>{unpriced}<small>项</small></strong><p>{unpriced ? "点击查看这些项目 →" : "当前没有未报价项"}</p></button>
    </div>
    <details className="cost-fact-details"><summary>查看费用明细</summary><div className="xl-sheet"><table className="xl-table"><thead><tr><th>专业</th><th className="text-right">金额（元）</th></tr></thead><tbody>{r?.disciplines.map(d => <tr key={d.key}><td>{d.label}</td><td className="mono text-right">{money(d.amount)}</td></tr>)}</tbody></table>{!r?.disciplines.length && <p className="cost-file-hint">上传清单后显示费用明细。</p>}</div><p className="cost-file-hint">税前金额：{money(r?.fees.preTax ?? "0")} 元</p></details>
    <details className="cost-fact-details"><summary>查看操作记录</summary>{s.receipts.slice(0, 5).map(receipt => <div className="cost-recent-row" key={receipt.id}><div><p>{receipt.summary}</p><small>{new Date(receipt.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</small></div></div>)}{!s.receipts.length && <p className="cost-file-hint">还没有操作记录。</p>}<button className="cost-btn" onClick={() => s.setActiveView("view:receipts")}>全部记录</button></details>
  </div>;
}
