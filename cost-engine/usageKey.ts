// 历史定额套用经验库的归一化键（宏业 GCFX 语料 → UsageStat/UsageCombo）
// 纯函数，cost-engine 无外部依赖。解析脚本、导入脚本与运行时查询共用同一套键规则，
// 否则线上查不到线下沉淀的桶。

/** 名称归一化：去掉规格数值（DN/Φ/厚度/截面/长度），保留语义骨架 */
export function normUsageName(s: string): string {
  return s
    .replace(/\s+/g, "")
    .replace(/DN\s*[≤<≥>]?\s*\d+/gi, "DNφ")
    .replace(/De\s*\d+/gi, "Deφ")
    .replace(/Φ\s*\d+(\.\d+)?/gi, "Φφ")
    .replace(/\d+(\.\d+)?\s*[x×*]\s*\d+(\.\d+)?(\s*[x×*]\s*\d+(\.\d+)?)?/g, "S")
    .replace(/\d+(\.\d+)?\s*(mm|cm|dm|m|km|m2|m3|㎡|m²|m³|MPa|kPa|kV|KV|V|A|mA|W|kW|KW|kg|t|L|ml|mm2|寸)/gi, "")
    .replace(/\b\d{1,3}(\.\d+)?\b/g, "")
    .replace(/[（(][^)）]{0,30}[)）]/g, "")
    .replace(/[、,，.。;；:：\-—_/\\|]+$/, "")
    .slice(0, 24);
}

/** 审核文件常见操作标签：占住名称位的不是真名，真名在项目特征「1.名称：」里 */
export const USAGE_AUDIT_LABEL =
  /^(替换材料|修改材料耗量|换算|删除|恢复|新增|补充|调整|锁定|解锁|修改|勾选|取消勾选|补充主材|补充设备)$/;

/** 项目特征 "1.名称：消声器" 里抠名称 */
export function usageSpecName(spec: string): string {
  const m = spec.match(/名称[、\s]*[（(]?[^:：\r\n]*[)）]?\s*[:：]\s*([^\r\n,，;；]{1,40})/);
  return m ? m[1].trim() : "";
}

/** 有效名称：操作标签时用特征里的真名，否则用原名称 */
export function usageEffectiveName(name: string, spec: string): string {
  return USAGE_AUDIT_LABEL.test(name.trim()) ? usageSpecName(spec) : name;
}

/** 清单项的经验库桶键；返回空串表示该名称不具检索意义 */
export function usageItemKey(name: string, unit: string, spec = ""): string {
  const eff = usageEffectiveName(name ?? "", spec ?? "");
  const nk = normUsageName(eff);
  if (nk.replace(/[^一-龥A-Za-z]/g, "").length < 2) return "";
  return `${nk}|${unit || "-"}`;
}

/** 从名称/特征文本里抽规格标签（DN350 / Φ12 / 50mm / 2×1.5 等） */
export function usageSpecTags(name: string, spec: string): string[] {
  const src = `${name} ${spec}`;
  const tags = new Set<string>();
  for (const m of src.matchAll(/DN\s*[≤<≥>]?\s*\d+/gi)) tags.add(m[0].replace(/\s+/g, "").toUpperCase());
  for (const m of src.matchAll(/De\s*\d+/gi)) tags.add(m[0].replace(/\s+/g, ""));
  for (const m of src.matchAll(/Φ\s*\d+(\.\d+)?/gi)) tags.add(m[0].replace(/\s+/g, ""));
  for (const m of src.matchAll(/规格[:：]\s*[^,，\r\n;；]{1,20}/g)) tags.add(m[0].replace(/^规格[:：]\s*/, "").trim());
  for (const m of src.matchAll(/\d+(\.\d+)?\s*(mm2|mm|cm|m|m2|m3|㎡|MPa|kV|V|A|W|kW)/gi)) tags.add(m[0].replace(/\s+/g, ""));
  return [...tags].slice(0, 6);
}
