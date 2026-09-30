"use client";
import { useEffect, useState } from "react";
import { Save, Settings2 } from "lucide-react";
import { PRICING_FIELDS } from "@shared/settings";
import { useStore } from "./store";
import { toast } from "./primitives";

export function PricingSettings() {
  const { projectId, facts, refreshMeta, reloadBoq } = useStore();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setValues(Object.fromEntries(PRICING_FIELDS.map(f => [f.key, facts.find(x => x.key === f.key)?.value ?? ""])));
  }, [facts, dirty]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "保存失败");
      await Promise.all([refreshMeta(), reloadBoq()]); setDirty(false); toast.success("计价条件已保存，费用汇总已更新");
    } catch (error) { toast.error(error instanceof Error ? error.message : "保存失败"); }
    finally { setBusy(false); }
  };
  return <form onSubmit={save} className="cost-settings"><div className="cost-info"><Settings2 size={17} /><p>计价条件由你确认。未填税率暂不计税；未填费率暂按零估算。正式成果前请核实项目适用口径，缺价清单不会被当作完整组价写入。</p></div>
    {["价格依据", "组价与取费", "工程条件"].map(group => <section key={group}><h3>{group}</h3><div className="cost-settings-grid">{PRICING_FIELDS.filter(f => f.group === group).map(f => <label key={f.key}><span>{f.label}</span>{f.key === "价格类型" ? <select value={values[f.key] ?? ""} onChange={e => { setDirty(true); setValues({ ...values, [f.key]: e.target.value }); }}><option value="">未指定</option><option value="INFO">信息价</option><option value="MARKET">市场价</option><option value="SUPPLY">供应价</option><option value="LABOR">人工价</option></select> : <input value={values[f.key] ?? ""} onChange={e => { setDirty(true); setValues({ ...values, [f.key]: e.target.value }); }} placeholder={f.hint} type={f.key === "价格期" ? "month" : "text"} />}<small>{f.hint}</small></label>)}</div></section>)}
    <footer><p>模型配置在左侧「设置 → 模型」中管理。</p><button className="cost-btn primary" disabled={busy || !dirty} type="submit"><Save size={14} />{busy ? "正在保存…" : "保存计价条件"}</button></footer>
  </form>;
}
