// 聚合 extract-gcfx-quota.ts 产出的 usage.jsonl → 清单→定额 经验频次表
//
// 要点：
//   1) 清单编码不可靠（自编/错填常见）→ 主键 = 归一化名称+单位，规格尺寸另记
//   2) 套用有对有错 → 可信度按"多少个不同项目这么套"排序；
//      孤例（仅1个项目）且桶内已有共识 → 标 suspect
//
// 产物:
//   agg-by-name.json   按名称模式聚合（主表，含每个定额的 projects/flag/规格档）
//   agg-by-code.json   按清单9位编码聚合（编码规范的条目，作辅助索引）
//   summary.md         汇总报告
// 用法: npx tsx scripts/aggregate-gcfx-usage.ts [corpusDir=storage/gcfx-corpus]
import fs from "node:fs";
import path from "node:path";
import {
  normUsageName as normName,
  usageSpecName as specName,
  usageSpecTags as specTags,
  USAGE_AUDIT_LABEL as AUDIT_LABEL,
} from "../cost-engine/usageKey";

const DIR = process.argv[2] ?? "storage/gcfx-corpus";

interface QuotaUse {
  applied: string; code: string; name: string; unit: string;
  conv: boolean; convNote: string; qty: number | null; nums: number[];
  materials: { name: string; unit: string; code: string }[];
}
interface QdItem {
  file: string; code: string; code9: string; name: string; unit: string; spec: string;
  nums: number[]; section: string; stream: string;
  quotas: QuotaUse[]; pai: string[];
}

type QuotaAgg = {
  code: string; names: Map<string, number>; count: number; conv: number;
  files: Set<string>; specTags: Map<string, number>; mats: Map<string, number>;
};
type Bucket = {
  key: string; names: Map<string, number>; units: Map<string, number>;
  code9s: Map<string, number>; sections: Map<string, number>; pais: Map<string, number>;
  count: number; files: Set<string>; quotas: Map<string, QuotaAgg>;
};

const byName = new Map<string, Bucket>();
const byCode = new Map<string, Bucket>();

function bucket(map: Map<string, Bucket>, key: string): Bucket {
  let b = map.get(key);
  if (!b) b = { key, names: new Map(), units: new Map(), code9s: new Map(), sections: new Map(), pais: new Map(), count: 0, files: new Set(), quotas: new Map() };
  return map.set(key, b), b;
}
const bump = (m: Map<string, number>, k: string) => k && m.set(k, (m.get(k) ?? 0) + 1);

function feed(it: QdItem, b: Bucket) {
  b.count++;
  b.files.add(it.file);
  bump(b.names, it.name?.slice(0, 60));
  bump(b.units, it.unit);
  if (/^\d{9}$/.test(it.code9 ?? "")) bump(b.code9s, it.code9);
  bump(b.sections, it.section);
  for (const p of it.pai ?? []) bump(b.pais, p.slice(0, 30));
  const tags = specTags(it.name ?? "", it.spec ?? "");
  for (const q of it.quotas) {
    if (!q.code) continue;
    let qa = b.quotas.get(q.code);
    if (!qa) qa = b.quotas.set(q.code, { code: q.code, names: new Map(), count: 0, conv: 0, files: new Set(), specTags: new Map(), mats: new Map() }).get(q.code)!;
    qa.count++; qa.files.add(it.file);
    if (q.conv) qa.conv++;
    bump(qa.names, q.name?.slice(0, 60));
    for (const t of tags) bump(qa.specTags, t);
    for (const m of q.materials ?? []) bump(qa.mats, `${m.name}${m.unit ? "|" + m.unit : ""}`);
  }
}

const items: QdItem[] = fs.readFileSync(path.join(DIR, "usage.jsonl"), "utf8")
  .trim().split("\n").map((l) => JSON.parse(l));

for (const it of items) {
  // 有效名称：名称字段是操作标签时，用特征里的"1.名称："真名
  const eff = AUDIT_LABEL.test(it.name?.trim() ?? "") ? specName(it.spec ?? "") : (it.name || "");
  const nk = normName(eff);
  if (nk.replace(/[^一-龥A-Za-z]/g, "").length >= 2)
    feed({ ...it, name: eff || it.name }, bucket(byName, `${nk}|${it.unit || "-"}`));
  if (/^\d{9}$/.test(it.code9 ?? "")) feed(it, bucket(byCode, it.code9));
}

const top = <T,>(m: Map<string, number>, n = 8) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

function quotaFlag(q: QuotaAgg, b: Bucket): string {
  const maxFiles = Math.max(...[...b.quotas.values()].map((x) => x.files.size));
  if (q.files.size >= 2 || (maxFiles === 1 && q.count >= 2)) return "common";
  if (q.files.size === 1 && maxFiles >= 3) return "suspect"; // 孤例，且已有共识
  return "rare";
}

function dump(b: Bucket) {
  const quotas = [...b.quotas.values()].sort((a, z) => z.files.size - a.files.size || z.count - a.count);
  return {
    key: b.key,
    items: b.count, projects: b.files.size,
    names: top(b.names, 6).map(([n, c]) => ({ n, c })),
    code9s: top(b.code9s, 5).map(([c, n]) => ({ c, n })),
    units: top(b.units, 4).map(([u, c]) => ({ u, c })),
    pais: top(b.pais, 5).map(([p, c]) => ({ p, c })),
    quotas: quotas.slice(0, 30).map((q) => ({
      code: q.code, flag: quotaFlag(q, b),
      uses: q.count, projects: q.files.size, conv: q.conv,
      name: top(q.names, 2).map(([n]) => n).join(" ‖ "),
      specs: top(q.specTags, 6).map(([t, c]) => ({ t, c })),
      mats: top(q.mats, 5).map(([m, c]) => ({ m, c })),
    })),
  };
}

const aggName = [...byName.values()].sort((a, b) => b.count - a.count).map(dump);
const aggCode = [...byCode.values()].sort((a, b) => b.count - a.count).map(dump);
fs.writeFileSync(path.join(DIR, "agg-by-name.json"), JSON.stringify(aggName, null, 1));
fs.writeFileSync(path.join(DIR, "agg-by-code.json"), JSON.stringify(aggCode, null, 1));

const totalQuota = items.reduce((s, i) => s + i.quotas.length, 0);
const withQ = items.filter((i) => i.quotas.length).length;
const convN = items.reduce((s, i) => s + i.quotas.filter((q) => q.conv).length, 0);
const files = new Set(items.map((i) => i.file));
const suspectN = aggName.reduce((s, b) => s + b.quotas.filter((q) => q.flag === "suspect").length, 0);

const md: string[] = [
  `# 宏业工程文件定额套用经验库`, ``,
  `- 工程文件: ${files.size} 个（去重后）`,
  `- 清单项: ${items.length} 条；有定额组价 ${withQ} 条（${(withQ / items.length * 100).toFixed(1)}%）`,
  `- 定额行: ${totalQuota} 条；换算定额 ${convN} 条`,
  `- 名称模式桶: ${byName.size} 个；清单9位编码桶: ${byCode.size} 个`,
  `- 存疑套用（孤例且有共识替代）: ${suspectN} 个`,
  ``,
  `flag 说明: common=多项目共识 | rare=低频 | suspect=孤例(可能错套)`, ``,
  `## 高频清单模式 → 定额套用`, ``,
];
for (const b of aggName.slice(0, 60)) {
  md.push(`### ${b.key}（${b.items} 次 / ${b.projects} 项目）${b.names[0]?.n ?? ""}`);
  for (const q of b.quotas.slice(0, 8))
    md.push(`- \`${q.code}\` ${q.name}　×${q.uses} / ${q.projects}项目 ${q.flag}${q.conv ? ` 换算×${q.conv}` : ""}${q.specs.length ? " 档:" + q.specs.slice(0, 4).map((s) => s.t).join(",") : ""}`);
  md.push(``);
}
fs.writeFileSync(path.join(DIR, "summary.md"), md.join("\n"));

console.log(`items=${items.length} withQuota=${withQ} quotaRows=${totalQuota} conv=${convN} suspect=${suspectN}`);
console.log(`nameBuckets=${byName.size} codeBuckets=${byCode.size}`);
