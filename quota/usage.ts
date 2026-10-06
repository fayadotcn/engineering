// 历史工程定额套用经验库：宏业 GCFX 语料 → UsageStat/UsageCombo → 匹配通道「经验套用」
// 语料是经验证据不是真理——flag 只按跨项目共识分档，自动套用仍走定额库语义匹配。
import { usageItemKey, usageEffectiveName, usageSpecTags, normUsageName } from "@cost-engine/usageKey";
import { fromJson } from "@shared/json";

/** usage.jsonl 行形态（extract-gcfx-quota.ts 产出，字段宽松） */
export interface UsageItemRecord {
  file: string;
  code?: string; code9?: string;
  name?: string; unit?: string; spec?: string;
  section?: string;
  quotas?: {
    applied?: string; code?: string; name?: string; unit?: string;
    conv?: boolean; convNote?: string;
    materials?: { name?: string; unit?: string; code?: string }[];
  }[];
  pai?: string[];
}

export interface UsageStatRow {
  itemKey: string; itemName: string;
  quotaCode: string; applied: string; quotaName: string; unit: string;
  uses: number; projects: number; conv: number; flag: string;
  specs: string[]; mats: string[]; samples: string[];
}
export interface UsageComboLine {
  code: string; applied: string; name: string; unit: string; conv: boolean;
}
export interface UsageComboRow {
  itemKey: string; itemName: string;
  lines: UsageComboLine[];
  uses: number; projects: number; flag: string;
}

type QuotaAgg = {
  code: string; applied: Map<string, number>; names: Map<string, number>; unit: Map<string, number>;
  count: number; conv: number; files: Set<string>;
  specTags: Map<string, number>; mats: Map<string, number>;
};
type ComboAgg = { lines: UsageComboLine[]; count: number; files: Set<string> };
type Bucket = {
  key: string; names: Map<string, number>; count: number; files: Set<string>;
  quotas: Map<string, QuotaAgg>; combos: Map<string, ComboAgg>;
};

/** 语料解码自二进制流，偶含半对代理字符——Prisma/SQLite JSON 校验会拒，入库前清掉 */
const cleanStr = (s: string) =>
  s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

const bump = (m: Map<string, number>, k: string) => k && m.set(cleanStr(k), (m.get(cleanStr(k)) ?? 0) + 1);
const top = <T,>(m: Map<string, number>, n = 8) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** common=多项目共识 | rare=低频 | suspect=孤例且桶内已有共识（可能错套） */
function flagOf(files: Set<string>, count: number, maxFiles: number): string {
  if (files.size >= 2 || (maxFiles === 1 && count >= 2)) return "common";
  if (files.size === 1 && maxFiles >= 3) return "suspect";
  return "rare";
}

/** usage.jsonl → 聚合行（定额级 UsageStat + 组合级 UsageCombo），纯函数可单测 */
export function buildUsageStats(items: UsageItemRecord[]): { stats: UsageStatRow[]; combos: UsageComboRow[]; buckets: number } {
  const byName = new Map<string, Bucket>();
  for (const it of items) {
    const key = usageItemKey(it.name ?? "", it.unit ?? "", it.spec ?? "");
    if (!key) continue;
    let b = byName.get(key);
    if (!b) b = byName.set(key, { key, names: new Map(), count: 0, files: new Set(), quotas: new Map(), combos: new Map() }).get(key)!;
    b.count++;
    b.files.add(it.file);
    bump(b.names, usageEffectiveName(it.name ?? "", it.spec ?? "").slice(0, 60) || (it.name ?? "").slice(0, 60));
    const tags = usageSpecTags(it.name ?? "", it.spec ?? "");
    const quotas = (it.quotas ?? []).filter((q) => q.code);
    for (const q of quotas) {
      const code = q.code!;
      let qa = b.quotas.get(code);
      if (!qa) qa = b.quotas.set(code, { code, applied: new Map(), names: new Map(), unit: new Map(), count: 0, conv: 0, files: new Set(), specTags: new Map(), mats: new Map() }).get(code)!;
      qa.count++;
      qa.files.add(it.file);
      if (q.conv) qa.conv++;
      bump(qa.applied, (q.applied ?? "").slice(0, 20));
      bump(qa.names, (q.name ?? "").slice(0, 80));
      bump(qa.unit, q.unit ?? "");
      for (const t of tags) bump(qa.specTags, t);
      for (const m of q.materials ?? []) bump(qa.mats, `${m.name}${m.unit ? "|" + m.unit : ""}`);
    }
    if (quotas.length) {
      const lines: UsageComboLine[] = quotas.map((q) => ({
        code: cleanStr(q.code!), applied: cleanStr(q.applied ?? ""), name: cleanStr((q.name ?? "").slice(0, 80)),
        unit: cleanStr(q.unit ?? ""), conv: !!q.conv,
      }));
      const sig = lines.map((l) => l.code).join("+");
      let ca = b.combos.get(sig);
      if (!ca) ca = b.combos.set(sig, { lines, count: 0, files: new Set() }).get(sig)!;
      ca.count++;
      ca.files.add(it.file);
    }
  }

  const stats: UsageStatRow[] = [];
  const combos: UsageComboRow[] = [];
  for (const b of byName.values()) {
    const itemName = top(b.names, 1)[0]?.[0] ?? b.key.split("|")[0];
    const maxQ = Math.max(0, ...[...b.quotas.values()].map((x) => x.files.size));
    const maxC = Math.max(0, ...[...b.combos.values()].map((x) => x.files.size));
    const quotas = [...b.quotas.values()].sort((a, z) => z.files.size - a.files.size || z.count - a.count);
    for (const q of quotas.slice(0, 20)) {
      stats.push({
        itemKey: cleanStr(b.key), itemName: cleanStr(itemName),
        quotaCode: cleanStr(q.code), applied: top(q.applied, 1)[0]?.[0] ?? cleanStr(q.code),
        quotaName: top(q.names, 1)[0]?.[0] ?? "", unit: top(q.unit, 1)[0]?.[0] ?? "",
        uses: q.count, projects: q.files.size, conv: q.conv,
        flag: flagOf(q.files, q.count, maxQ),
        specs: top(q.specTags, 6).map(([t]) => t),
        mats: top(q.mats, 5).map(([m]) => m),
        samples: top(new Map([...b.files].map((f) => [baseName(f), 1])), 3).map(([f]) => f),
      });
    }
    const combosS = [...b.combos.values()].sort((a, z) => z.files.size - a.files.size || z.count - a.count);
    for (const c of combosS.slice(0, 10)) {
      combos.push({ itemKey: cleanStr(b.key), itemName: cleanStr(itemName), lines: c.lines, uses: c.count, projects: c.files.size, flag: flagOf(c.files, c.count, maxC) });
    }
  }
  return { stats, combos, buckets: byName.size };
}

const toJson = (v: unknown) => JSON.stringify(v);

/** 语料导入：整表重建（经验库是一次性快照，幂等重导） */
export async function importUsageCorpus(items: UsageItemRecord[]) {
  const { stats, combos, buckets } = buildUsageStats(items);
  const { prisma } = await import("@database/client");
  await prisma.$transaction([prisma.usageCombo.deleteMany(), prisma.usageStat.deleteMany()]);
  for (let i = 0; i < stats.length; i += 500) {
    await prisma.usageStat.createMany({
      data: stats.slice(i, i + 500).map((s) => ({
        itemKey: s.itemKey, itemName: s.itemName,
        quotaCode: s.quotaCode, applied: s.applied, quotaName: s.quotaName, unit: s.unit,
        uses: s.uses, projects: s.projects, conv: s.conv, flag: s.flag,
        specs: toJson(s.specs), mats: toJson(s.mats), samples: toJson(s.samples),
      })),
    });
  }
  for (let i = 0; i < combos.length; i += 500) {
    await prisma.usageCombo.createMany({
      data: combos.slice(i, i + 500).map((c) => ({
        itemKey: c.itemKey, itemName: c.itemName, lines: toJson(c.lines),
        uses: c.uses, projects: c.projects, flag: c.flag,
      })),
    });
  }
  return { stats: stats.length, combos: combos.length, buckets };
}

/* ---------------- 运行时查询 ---------------- */

export interface UsageQuotaHit {
  code: string; applied: string; name: string; unit: string;
  uses: number; projects: number; conv: number; flag: string; specs: string[];
}
export interface UsageComboHit {
  lines: UsageComboLine[]; uses: number; projects: number; flag: string;
}
export interface UsageForItem {
  key: string; fuzzy: boolean;
  quotas: UsageQuotaHit[]; combos: UsageComboHit[];
}

const FLAG_RANK: Record<string, number> = { common: 2, rare: 1, suspect: 0 };

async function hitRows(keys: string[]) {
  const { prisma } = await import("@database/client");
  const [qs, cs] = await Promise.all([
    prisma.usageStat.findMany({ where: { itemKey: { in: keys } } }),
    prisma.usageCombo.findMany({ where: { itemKey: { in: keys } } }),
  ]);
  return { qs, cs };
}

type StatRow = { itemKey: string; itemName: string; quotaCode: string; applied: string; quotaName: string; unit: string; uses: number; projects: number; conv: number; flag: string; specs: string };
type ComboRowT = { itemKey: string; lines: string; uses: number; projects: number; flag: string };

function quotaHits(qs: StatRow[], itemTags: Set<string>): UsageQuotaHit[] {
  return qs
    .map((q) => {
      const specs = fromJson<string[]>(q.specs, []);
      return { q, specs, specHit: specs.some((t) => itemTags.has(t)) ? 1 : 0 };
    })
    .sort((a, z) => (FLAG_RANK[z.q.flag] ?? 0) - (FLAG_RANK[a.q.flag] ?? 0) || z.specHit - a.specHit || z.q.projects - a.q.projects || z.q.uses - a.q.uses)
    .slice(0, 5)
    .map(({ q, specs }) => ({
      code: q.quotaCode, applied: q.applied, name: q.quotaName, unit: q.unit,
      uses: q.uses, projects: q.projects, conv: q.conv, flag: q.flag, specs,
    }));
}

function comboHits(cs: ComboRowT[]): UsageComboHit[] {
  return [...cs]
    .sort((a, z) => (FLAG_RANK[z.flag] ?? 0) - (FLAG_RANK[a.flag] ?? 0) || z.projects - a.projects || z.uses - a.uses)
    .slice(0, 3)
    .map((c) => ({ lines: fromJson<UsageComboLine[]>(c.lines, []), uses: c.uses, projects: c.projects, flag: c.flag }));
}

/** 批量：给一组清单项查经验套用（精确桶），返回 itemKey → 候选 */
export async function usageForKeys(rows: { itemKey: string; specTags?: string[] }[]): Promise<Map<string, { quotas: UsageQuotaHit[]; combos: UsageComboHit[] }>> {
  const keys = [...new Set(rows.map((r) => r.itemKey).filter(Boolean))];
  const out = new Map<string, { quotas: UsageQuotaHit[]; combos: UsageComboHit[] }>();
  if (!keys.length) return out;
  const { qs, cs } = await hitRows(keys);
  for (const r of rows) {
    if (out.has(r.itemKey)) continue;
    const quotas = quotaHits(qs.filter((q) => q.itemKey === r.itemKey), new Set(r.specTags ?? []));
    const combos = comboHits(cs.filter((c) => c.itemKey === r.itemKey));
    if (quotas.length || combos.length) out.set(r.itemKey, { quotas, combos });
  }
  return out;
}

/** 清单项 → 历史套用候选。先精确桶，miss 时退到名称前缀桶（单位异写/局部差异） */
export async function usageForItem(name: string, unit: string, spec = ""): Promise<UsageForItem | null> {
  const exact = usageItemKey(name, unit, spec);
  if (!exact) return null;
  const nk = exact.split("|")[0];
  let fuzzy = false;
  let { qs, cs } = await hitRows([exact]);
  if (!qs.length && !cs.length) {
    // 同名称模式、单位异写（个/台/套）也算命中——桶键里单位是弱信号
    const { prisma } = await import("@database/client");
    const alt = await prisma.usageStat.findMany({ where: { itemKey: { startsWith: `${nk}|` } }, select: { itemKey: true }, distinct: ["itemKey"], take: 5 });
    if (alt.length) {
      fuzzy = true;
      ({ qs, cs } = await hitRows(alt.map((r) => r.itemKey)));
    }
  }
  if (!qs.length && !cs.length) {
    // 模糊兜底：归一化名称相互包含（「镀锌钢管」命中「镀锌钢管DNφ」桶）
    const { prisma } = await import("@database/client");
    const cand = await prisma.usageStat.findMany({
      where: { OR: [{ itemKey: { contains: nk } }, { itemName: { contains: usageEffectiveName(name, spec).slice(0, 12) } }] },
      select: { itemKey: true }, distinct: ["itemKey"], take: 5,
    });
    if (!cand.length) return null;
    fuzzy = true;
    ({ qs, cs } = await hitRows(cand.map((r) => r.itemKey)));
    if (!qs.length && !cs.length) return null;
  }
  return { key: exact, fuzzy, quotas: quotaHits(qs, new Set(usageSpecTags(name, spec))), combos: comboHits(cs) };
}

/** 自由检索：按关键词找名称模式桶（quota.usage 工具） */
export async function searchUsage(query: string, limit = 20) {
  const { prisma } = await import("@database/client");
  const q = query.trim().slice(0, 20);
  const nk = normUsageName(q);
  const keyRows = await prisma.usageStat.findMany({
    where: { OR: [
      { itemKey: { contains: nk } },
      { itemName: { contains: q } },
      { quotaName: { contains: q } },
    ] },
    select: { itemKey: true }, distinct: ["itemKey"], take: limit,
  });
  const keys = keyRows.map((r) => r.itemKey);
  if (!keys.length) return [];
  const { qs, cs } = await hitRows(keys);
  return keys.map((k) => {
    const quotas = quotaHits(qs.filter((x) => x.itemKey === k), new Set());
    const combos = comboHits(cs.filter((x) => x.itemKey === k));
    return {
      key: k,
      itemName: qs.find((x) => x.itemKey === k)?.itemName ?? k.split("|")[0],
      quotas, combos,
    };
  });
}

export async function usageSummary() {
  const { prisma } = await import("@database/client");
  const [stats, combos, buckets, common] = await Promise.all([
    prisma.usageStat.count(),
    prisma.usageCombo.count(),
    prisma.usageStat.findMany({ select: { itemKey: true }, distinct: ["itemKey"] }).then((r) => r.length),
    prisma.usageStat.count({ where: { flag: "common" } }),
  ]);
  return { stats, combos, buckets, common };
}
