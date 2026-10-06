"use client";
import { useEffect, useRef, useState } from "react";
import { Info, Save } from "lucide-react";
import { PRICING_FIELDS } from "@shared/settings";
import { useStore } from "./store";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PRICE_TYPES, PRICE_TYPE_LABEL } from "./terms";
import { toast } from "./primitives";
import { FactList } from "./views";

/** Radix Select 的 item value 不能是空串，「未指定」用哨兵值承载 */
const PRICE_TYPE_NONE = "__none__";

export function PricingSettings() {
  const { projectId, facts, refreshMeta, reloadBoq, running, agentRunning, importRunning } = useStore();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    useStore.setState({ settingsDirty: dirty });
    return () => { useStore.setState({ settingsDirty: false }); };
  }, [dirty]);
  useEffect(() => {
    if (!dirty) setValues(Object.fromEntries(PRICING_FIELDS.map(f => [f.key, facts.find(x => x.key === f.key)?.value ?? ""])));
  }, [facts, dirty]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); if (!projectId || lock.current || running || agentRunning || importRunning) return;
    lock.current = true; setBusy(true); useStore.setState({ saving: true });
    let saved = false;
    try {
      const res = await fetch(`/api/projects/${projectId}/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "保存失败");
      saved = true;
      if (useStore.getState().projectId !== projectId) return;
      await Promise.all([refreshMeta(), reloadBoq()]); setDirty(false); toast.success("计价条件已保存，费用汇总已更新");
    } catch (error) {
      if (useStore.getState().projectId !== projectId) return;
      if (saved) { setDirty(false); useStore.setState({ loadingError: "计价条件已保存，刷新失败。请重新加载以查看最新数据。" }); }
      toast.error(saved ? "计价条件已保存，数据刷新失败，请重新加载" : error instanceof Error ? error.message : "保存失败");
    }
    finally { lock.current = false; setBusy(false); if (useStore.getState().projectId === projectId) useStore.setState({ saving: false }); }
  };
  const basic = new Set(["地区", "价格期", "品牌", "管理费率", "利润率", "税率"]);
  /* <Label> 自带 items-center/font-medium/leading-none：抹平回 .cost-settings label 的
     竖向拉伸、400 字重（否则输入框里的值也会跟着变粗）与正常行高；列向与 8px 间距由 CSS 负责。 */
  const field = (f: typeof PRICING_FIELDS[number]) => <Label key={f.key} className="items-stretch font-normal leading-normal"><span>{f.label}</span>{f.key === "价格类型"
    ? <Select value={values[f.key] || PRICE_TYPE_NONE} onValueChange={v => { setDirty(true); setValues({ ...values, [f.key]: v === PRICE_TYPE_NONE ? "" : v }); }}>
        <SelectTrigger size="sm" className="w-full"><SelectValue>{values[f.key] ? (PRICE_TYPE_LABEL[values[f.key] as keyof typeof PRICE_TYPE_LABEL] ?? values[f.key]) : "未指定"}</SelectValue></SelectTrigger>
        <SelectContent>
          <SelectItem value={PRICE_TYPE_NONE}>未指定</SelectItem>
          {PRICE_TYPES.map(t => <SelectItem key={t} value={t}>{PRICE_TYPE_LABEL[t]}</SelectItem>)}
        </SelectContent>
      </Select>
    : <Input value={values[f.key] ?? ""} onChange={e => { setDirty(true); setValues({ ...values, [f.key]: e.target.value }); }} type={f.key === "价格期" ? "month" : "text"} />}<small>{f.hint}</small></Label>;
  return <form onSubmit={save} className="cost-settings"><header className="view-heading"><div><span className="page-eyebrow">报价的计算依据</span><h2>计价条件</h2><p>先填常用条件，其他费用按工程需要补充。</p></div></header><Alert className="mb-6"><Info /><AlertDescription>品牌可以留空；不计取的费率请填 0%。</AlertDescription></Alert>
    <fieldset disabled={busy || running || agentRunning || importRunning} className="min-w-0" aria-busy={busy}><div className="cost-settings-grid">{PRICING_FIELDS.filter(f => basic.has(f.key)).map(field)}</div><details className="cost-fact-details"><summary>更多费用和工程条件</summary><div className="cost-settings-grid">{PRICING_FIELDS.filter(f => !basic.has(f.key)).map(field)}</div></details></fieldset>
    <footer><p role="status">{dirty ? "有未保存的计价条件" : "计价条件已与当前测算同步"}</p><div className="cost-actions"><Button variant="outline" size="sm" disabled={busy || !dirty} type="button" onClick={() => setDirty(false)}>取消修改</Button><Button size="sm" disabled={busy || running || agentRunning || importRunning || !dirty} type="submit"><Save size={14} />{busy ? "正在保存…" : "保存计价条件"}</Button></div></footer>
    <details className="cost-fact-details"><summary>查看所有已保存信息</summary><FactList /></details>
  </form>;
}
