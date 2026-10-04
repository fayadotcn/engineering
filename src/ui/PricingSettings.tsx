"use client";
import { useEffect, useRef, useState } from "react";
import { Save, Settings2 } from "lucide-react";
import { PRICING_FIELDS } from "@shared/settings";
import { useStore } from "./store";
import { Button } from "@/components/ui/button";
import { toast } from "./primitives";
import { FactList } from "./views";

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
  const field = (f: typeof PRICING_FIELDS[number]) => <label key={f.key}><span>{f.label}</span>{f.key === "价格类型" ? <select value={values[f.key] ?? ""} onChange={e => { setDirty(true); setValues({ ...values, [f.key]: e.target.value }); }}><option value="">未指定</option><option value="INFO">信息价</option><option value="MARKET">市场价</option><option value="SUPPLY">供应价</option><option value="LABOR">人工价</option></select> : <input value={values[f.key] ?? ""} onChange={e => { setDirty(true); setValues({ ...values, [f.key]: e.target.value }); }} type={f.key === "价格期" ? "month" : "text"} />}<small>{f.hint}</small></label>;
  return <form onSubmit={save} className="cost-settings"><div className="cost-info"><Settings2 size={17} /><p>先填写常用设置。品牌可以留空；不计取的费率请填 0%。</p></div>
    <fieldset disabled={busy || running || agentRunning || importRunning} className="min-w-0" aria-busy={busy}><div className="cost-settings-grid">{PRICING_FIELDS.filter(f => basic.has(f.key)).map(field)}</div><details className="cost-fact-details"><summary>更多费用和工程条件</summary><div className="cost-settings-grid">{PRICING_FIELDS.filter(f => !basic.has(f.key)).map(field)}</div></details></fieldset>
    <footer><p role="status">{dirty ? "有未保存的计价条件" : "计价条件已与当前测算同步"}</p><div className="cost-actions"><Button variant="outline" size="sm" disabled={busy || !dirty} type="button" onClick={() => setDirty(false)}>取消修改</Button><Button size="sm" disabled={busy || running || agentRunning || importRunning || !dirty} type="submit"><Save size={14} />{busy ? "正在保存…" : "保存计价条件"}</Button></div></footer>
    <details className="cost-fact-details"><summary>查看所有已保存信息</summary><FactList /></details>
  </form>;
}
