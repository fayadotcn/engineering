import { D, round2 } from "@cost-engine/money";
import { QUOTA_LIBRARY, type QuotaEntry } from "./library";
import type { BoqItemDTO } from "@shared/types";

// 定额匹配 + 组价。全部确定性计算。
// 综合单价 = (人工费+辅材费+机械费)/定额倍数 + 主材价×耗量 + (人工+机械)/倍数×(管理费率+利润率)

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toRe = (v: unknown) =>
  typeof v === "string" && v ? new RegExp(escapeRe(v), "i") : undefined;
/** 直径/规格这类离散值要整词匹配：DN15 不应命中 DN150 */
const toExactRe = (v: unknown) =>
  typeof v === "string" && v ? new RegExp(`^${escapeRe(v)}$`, "i") : undefined;

/** 内置参考库 + 后台上传的定额数据集，合并成匹配库 */
export async function getQuotaLibrary(): Promise<QuotaEntry[]> {
  try {
    const { prisma } = await import("@database/client");
    const rows = await prisma.quotaRow.findMany({
      where: { OR: [{ datasetId: null }, { dataset: { active: true } }] },
    });
    const db: QuotaEntry[] = rows.map((r) => {
      const mk = JSON.parse(r.matchKeys || "{}") as Record<string, string>;
      const raw = JSON.parse(r.raw || "{}") as { gcnr?: string; fb?: string; chapter?: string; jj?: number; mainMaterial?: string };
      return {
        code: r.code,
        name: r.name,
        unit: r.unit,
        unitScale: r.unitScale || 1,
        labor: Number(r.labor),
        material: Number(r.material),
        machine: Number(r.machine),
        mainQtyPerUnit: r.mainQtyPerUnit || 1,
        detail: { gcnr: raw.gcnr, fb: raw.fb, chapter: raw.chapter, jj: raw.jj, mainMaterial: raw.mainMaterial },
        match: {
          category: mk.category,
          material: toRe(mk.material),
          diameter: toExactRe(mk.diameter),
          spec: toExactRe(mk.spec),
          // DB 特征值常带后缀（"沟槽连接" vs 清单特征 "沟槽"），剥掉使匹配方向一致
          connection: toRe(mk.connection?.replace(/(连接|方式|敷设|安装)$/, "")),
          keywords: toRe(mk.keywords),
          // xmbh 是软件内部的「册章节树码」(03+册序+章+节)，不是 GB 清单编码，不能拿来比对 item.code。
          // 改用定额编号前缀推断所属系统，给跨册同名子目做系统词 tiebreak。
          system: mk.system ?? BOOK_SYSTEM[r.code.slice(0, 2)],
        },
      };
    });
    return [...QUOTA_LIBRARY, ...db];
  } catch {
    return QUOTA_LIBRARY;
  }
}

// 四川2020安装定额分册 → 所属系统词（用于跨册同名子目的 tiebreak）
const BOOK_SYSTEM: Record<string, string> = {
  "5A": "机械设备", "5B": "电气|配电|照明|电缆|桥架|防雷",
  "5C": "热力|锅炉", "5D": "炉窑|砌筑", "5E": "静置|金属结构|储罐|球罐",
  "5F": "工业管道|工艺管道", "5G": "消防|喷淋|消火栓|火灾报警|气体灭火",
  "5H": "给水|排水|采暖|燃气|卫生器具", "5I": "通风|空调|防排烟|风管",
  "5J": "自动化|仪表|自控", "5K": "刷油|防腐|绝热|保温",
};
const SYSTEM_WORDS = "消防|喷淋|消火栓|给水|排水|采暖|燃气|通风|空调|防排烟|风管|电气|配电|照明|电缆|桥架|防雷|自动化|仪表|热力|锅炉|炉窑|静置|工业管道|刷油|防腐|绝热|保温|卫生器具";
const sysReCache = new Map<string, RegExp>();
function sysRe(s: string): RegExp {
  let r = sysReCache.get(s);
  if (!r) { r = new RegExp(s); sysReCache.set(s, r); }
  return r;
}

export interface QuotaMatch {
  item: BoqItemDTO;
  quota: QuotaEntry | null;
  score: number;
}

export function scoreQuota(item: BoqItemDTO, q: QuotaEntry): number {
  const f = item.features ?? {};
  const m = q.match;
  const text = `${item.name} ${item.rawFeature}`;
  let s = 0;
  if (m.category) s += f.category === m.category ? 40 : 0;
  if (m.material) s += m.material.test(f.material ?? text) ? 25 : 0;
  if (m.diameter) s += m.diameter.test(f.diameter ?? f.specification ?? "") ? 20 : 0;
  if (m.spec) s += m.spec.test(f.specification ?? "") ? 15 : 0;
  if (m.connection) s += m.connection.test(f.connectionMethod ?? "") ? 10 : 0;
  if (m.keywords) s += m.keywords.test(text) ? 10 : 0;
  // 系统归属：清单项的分部路径/名称出现系统词时，所属分册一致的定额加分。
  // 解决「镀锌钢管DN100」在消防册(5G)与给排水册(5H)同分的跨册歧义。
  if (m.system) {
    const scope = `${item.sectionPath ?? ""} ${text} ${f.system ?? ""}`;
    s += sysRe(m.system).test(scope) ? 12 : 0;
  }
  return s;
}

export function matchQuota(
  item: BoqItemDTO,
  threshold = 50,
  lib: QuotaEntry[] = QUOTA_LIBRARY
): QuotaMatch {
  const { best } = top2Quota(item, lib);
  if (best.s < threshold) return { item, quota: null, score: best.s };
  return { item, quota: best.q, score: best.s };
}

/** top2 候选 + 存疑判定：分差≤10 且基价差>5% 才算「拿不准」（跨册同名同价不算歧义） */
export function top2Quota(item: BoqItemDTO, lib: QuotaEntry[]) {
  let best: { q: QuotaEntry | null; s: number } = { q: null, s: 0 };
  let alt: { q: QuotaEntry | null; s: number } = { q: null, s: 0 };
  for (const q of lib) {
    const s = scoreQuota(item, q);
    if (s > best.s) { alt = best; best = { q, s }; }
    else if (s > alt.s) alt = { q, s };
  }
  const price = (q: QuotaEntry) => q.labor + q.material + q.machine;
  const ambiguous = !!(best.q && alt.q && best.s - alt.s <= 10 &&
    Math.abs(price(best.q) - price(alt.q)) / Math.max(1, price(best.q)) > 0.05);
  return { best, alt, ambiguous };
}

export interface QuotaCalcRow {
  itemId: string;
  code: string;
  name: string;
  quantity: string;
  listPrice: string; // 清单现有单价
  quotaCode: string | null;
  quotaName: string | null;
  labor: string | null;
  materialAux: string | null;
  machine: string | null;
  mainMaterial: string | null; // 主材费 = 主材价 × 耗量
  fee: string | null; // 管理费+利润
  calcPrice: string | null; // 测算综合单价
  deviation: string | null; // vs 清单单价 %
  needsMainPrice: boolean;
  /** 定额解释详情：工程内容/分册/章节路径/基价/主材名 */
  quotaGcnr?: string | null;
  quotaFb?: string | null;
  quotaChapter?: string | null;
  quotaBase?: string | null;
  quotaMainName?: string | null;
  /** 存在得分相近且基价不同的备选子目 */
  ambiguous?: boolean;
  altQuota?: string | null; // 备选子目 "code name"
}

export function calcQuota(
  items: BoqItemDTO[],
  opts: {
    mainPrices?: Record<string, number>; // category/material -> 主材单价
    mgmtRate?: number; // 默认 0.16
    profitRate?: number; // 默认 0.09
    threshold?: number;
    lib?: QuotaEntry[];
  } = {}
): QuotaCalcRow[] {
  const mgmt = D(opts.mgmtRate ?? 0.16);
  const profit = D(opts.profitRate ?? 0.09);
  const lib = opts.lib ?? QUOTA_LIBRARY;
  return items.map((item) => {
    const t = top2Quota(item, lib);
    const m: QuotaMatch =
      t.best.q && t.best.s >= (opts.threshold ?? 50)
        ? { item, quota: t.best.q, score: t.best.s }
        : { item, quota: null, score: t.best.s };
    const base: QuotaCalcRow = {
      itemId: item.id,
      code: item.code,
      name: item.name,
      quantity: item.quantity,
      listPrice: item.unitPrice,
      quotaCode: null, quotaName: null,
      labor: null, materialAux: null, machine: null,
      mainMaterial: null, fee: null, calcPrice: null,
      deviation: null, needsMainPrice: false,
    };
    if (!m.quota) return base;
    const q = m.quota;
    const perUnit = (v: number) => D(v).div(q.unitScale);
    const labor = perUnit(q.labor);
    const aux = perUnit(q.material);
    const mach = perUnit(q.machine);
    const fee = labor.plus(mach).mul(mgmt.plus(profit));

    // 主材价: quotation map → 用户清单单价兜底反推不可用 → 标记
    const mainKey = `${f2m(item)}`;
    const mainPrice = opts.mainPrices?.[mainKey];
    const needsMain = mainPrice === undefined;
    const main = needsMain ? D(0) : D(mainPrice!).mul(q.mainQtyPerUnit);

    const calc = labor.plus(aux).plus(mach).plus(main).plus(fee);
    const dev = D(item.unitPrice).isZero()
      ? null
      : calc.minus(D(item.unitPrice)).div(D(item.unitPrice)).mul(100);

    return {
      ...base,
      quotaCode: q.code,
      quotaName: q.name,
      labor: round2(labor).toString(),
      materialAux: round2(aux).toString(),
      machine: round2(mach).toString(),
      mainMaterial: needsMain ? null : round2(main).toString(),
      fee: round2(fee).toString(),
      calcPrice: round2(calc).toString(),
      deviation: dev === null ? null : dev.toFixed(1),
      needsMainPrice: needsMain,
      ambiguous: t.ambiguous,
      altQuota: t.ambiguous && t.alt.q ? `${t.alt.q.code} ${t.alt.q.name}` : null,
      quotaGcnr: q.detail?.gcnr ?? null,
      quotaFb: q.detail?.fb ?? null,
      quotaChapter: q.detail?.chapter ?? null,
      quotaBase: q.detail?.jj != null ? String(q.detail.jj) : null,
      quotaMainName: q.detail?.mainMaterial ?? null,
    };
  });
}

// main-material price lookup key: material+spec of the item
function f2m(item: BoqItemDTO): string {
  const f = item.features ?? {};
  return [f.material ?? item.name, f.diameter ?? f.specification ?? ""]
    .filter(Boolean)
    .join("|");
}

export { f2m as mainPriceKey };
