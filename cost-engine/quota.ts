import Decimal from "decimal.js";
import { D, round2 } from "@cost-engine/money";
import { QUOTA_LIBRARY, type QuotaEntry } from "@quota/library";
import type { BoqItemDTO, PricingPlanLine } from "@shared/types";

// 定额匹配 + 组价。全部确定性计算。
// 综合单价 = (人工费+辅材费+机械费)/定额倍数 + 主材价×耗量 + (人工+机械)/倍数×(管理费率+利润率)

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
  /** 组价方案：第 1 行是主项定额（计入测算价），suggested 行是工作内容缺口的建议增列 */
  plan?: PricingPlanLine[];
}

/** 定额人工费：规费总基数及各分册措施费基数，均按工程量计算。 */
export function quotaLaborTotals(rows: QuotaCalcRow[]) {
  let total = D(0);
  const books: Record<string, Decimal> = {};
  for (const row of rows.filter(r => r.quotaCode)) {
    const amount = D(row.labor ?? 0).mul(D(row.quantity));
    const book = row.quotaCode!.match(/^(5[A-Z])/)?.[1] ?? "通用";
    total = total.plus(amount);
    books[book] = (books[book] ?? D(0)).plus(amount);
  }
  return { total: total.toFixed(2), byBook: Object.fromEntries(Object.entries(books).map(([book, amount]) => [book, amount.toFixed(2)])) };
}

/** 单条定额 → 组价方案行（每清单单位口径：定额单位倍数已折算） */
export function lineFromQuota(
  item: BoqItemDTO,
  q: QuotaEntry,
  opts: { mgmtRate: Decimal.Value; profitRate: Decimal.Value; mainPrice?: number; suggested?: boolean; manual?: boolean; scope?: string }
): PricingPlanLine {
  const mgmt = D(opts.mgmtRate), profit = D(opts.profitRate);
  const perUnit = (v: number) => D(v).div(q.unitScale || 1);
  const labor = perUnit(q.labor);
  const aux = perUnit(q.material);
  const mach = perUnit(q.machine);
  const fee = labor.plus(mach).mul(mgmt.plus(profit));
  const main = opts.mainPrice === undefined ? null : D(opts.mainPrice).mul(q.mainQtyPerUnit);
  const subtotal = labor.plus(aux).plus(mach).plus(fee).plus(main ?? 0);
  return {
    quotaCode: q.code,
    quotaName: q.name,
    labor: round2(labor).toString(),
    materialAux: round2(aux).toString(),
    machine: round2(mach).toString(),
    fee: round2(fee).toString(),
    mainMaterialName: q.detail?.mainMaterial ?? null,
    mainQty: main !== null ? String(q.mainQtyPerUnit) : null,
    mainPrice: main !== null ? round2(D(opts.mainPrice!)).toString() : null,
    subtotal: round2(subtotal).toString(),
    suggested: opts.suggested || undefined,
    manual: opts.manual || undefined,
    scope: opts.scope ?? q.detail?.gcnr ?? undefined,
  };
}

/** 组价方案合计 → 每清单单位综合单价（只计已确认行，suggested 不计入） */
export function planPrice(plan: PricingPlanLine[]): Decimal {
  return plan.filter((l) => !l.suggested).reduce((a, l) => a.plus(D(l.subtotal)), D(0));
}

// 工作内容缺口分析：主定额 gcnr 没写到的工序 → 在同册找配套子目建议增列。
// 这是真实组价：给水管道 = 管道安装 + 消毒冲洗 + 支吊架；沟槽/法兰连接的管件另计。
const SCOPE_NEEDS: {
  key: string; covered: RegExp; find: RegExp; reason: string;
  applies?: (item: BoqItemDTO) => boolean;
}[] = [
  {
    key: "管道消毒冲洗", covered: /冲洗|消毒/, find: /消毒.*冲洗|冲洗.*消毒|管道消毒|管道冲洗/,
    reason: "主定额工作内容未含冲洗消毒，给水/消防管道规范要求另套",
    applies: (i) => /给水|饮用|消防|喷淋|消火栓|供水/.test(`${i.name}${i.rawFeature}`),
  },
  {
    key: "支吊架", covered: /支吊架|支架|吊架|托钩/, find: /支吊架|管道支架|支架制作.*安装/,
    reason: "主定额工作内容未含支吊架制作安装",
  },
  {
    key: "水压试验", covered: /水压|试压|压力试验|严密性/, find: /水压试验|压力试验|管道试压/,
    reason: "主定额工作内容未含水压试验",
  },
  {
    key: "管件", covered: /管件|零件|接头|上零件/, find: /管件.*连接|管件/,
    reason: "沟槽/法兰/卡压连接的管件为独立主材，定额通常未含",
    applies: (i) => /沟槽|法兰|卡压/.test(i.features?.connectionMethod ?? ""),
  },
];

const i0 = (i: BoqItemDTO) => `${i.name} ${i.rawFeature}`;

function suggestSupplementary(
  item: BoqItemDTO,
  q: QuotaEntry,
  lib: QuotaEntry[],
  mgmt: Decimal.Value,
  profit: Decimal.Value
): PricingPlanLine[] {
  const pipeish =
    item.features?.category === "管道" ||
    /管|给水|排水|喷淋|消火栓|采暖|冷凝水|雨水|污水|风管/.test(i0(item));
  if (!pipeish) return [];
  const coveredText = `${q.name} ${q.detail?.gcnr ?? ""}`;
  const bookPrefix = q.code.slice(0, 2); // SC2020 编号前两位=分册
  // 直径档归一化：DN100/公称直径100mm以内 → 数字 "100"，只在直径语境里匹配
  // （不能裸匹配数字——"混凝土基础400×400"不是 DN400）
  const diaNum = (item.features?.diameter ?? "").replace(/\D/g, "");
  const diaHit = (name: string) =>
    !!diaNum && new RegExp(`(直径|DN|Φ|DE|de)\\s*${diaNum}(?![\\d])|${diaNum}\\s*mm`, "i").test(name);
  const out: PricingPlanLine[] = [];
  for (const need of SCOPE_NEEDS) {
    if (out.length >= 3) break;
    if (need.covered.test(coveredText)) continue; // 主定额已含该工序
    if (need.applies && !need.applies(item)) continue;
    // 候选：同册优先 → 名称命中 → 规格档相符优先
    const cands = lib
      .filter((c) => c.code !== q.code && need.find.test(c.name))
      .sort((a, b) => {
        const sa = (a.code.startsWith(bookPrefix) ? 2 : 0) + (diaHit(a.name) ? 3 : 0);
        const sb = (b.code.startsWith(bookPrefix) ? 2 : 0) + (diaHit(b.name) ? 3 : 0);
        return sb - sa;
      });
    const c = cands[0];
    if (!c) continue;
    // 有规格档的定额若明确不覆盖该项直径，跳过（避免推荐错档子目误导）
    if (diaNum && /直径\s*\d+/.test(c.name) && !diaHit(c.name)) continue;
    out.push(lineFromQuota(item, c, { mgmtRate: mgmt, profitRate: profit, suggested: true, scope: need.reason }));
  }
  return out;
}

export function calcQuota(
  items: BoqItemDTO[],
  opts: {
    mainPrices?: Record<string, number>; // category/material -> 主材单价
    mgmtRate?: number; // 未确认时按零测算
    profitRate?: number; // 未确认时按零测算
    threshold?: number;
    lib?: QuotaEntry[];
  } = {}
): QuotaCalcRow[] {
  const mgmt = D(opts.mgmtRate ?? 0);
  const profit = D(opts.profitRate ?? 0);
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
    const perUnit = (v: number) => D(v).div(q.unitScale || 1);
    const labor = perUnit(q.labor);
    const aux = perUnit(q.material);
    const mach = perUnit(q.machine);
    const fee = labor.plus(mach).mul(mgmt.plus(profit));

    // 主材价优先级：清单项已确认的主材暂估价 > 询价/材料库匹配价。
    // 缺主材价时测算价不含主材费，是不完整单价——绝不能与清单综合单价比偏差。
    const ownMain = D(item.mainMaterialPrice ?? 0);
    const mainKey = `${f2m(item)}`;
    const mainPrice = ownMain.gt(0) ? Number(ownMain) : opts.mainPrices?.[mainKey];
    const needsMain = mainPrice === undefined;
    const main = needsMain ? D(0) : D(mainPrice!).mul(q.mainQtyPerUnit);

    const calc = labor.plus(aux).plus(mach).plus(main).plus(fee);
    // 缺主材的测算价缺了造价大头（阀体/管材/设备），与清单综合单价比偏差必然失真——不出偏差数
    const dev = needsMain || D(item.unitPrice).isZero()
      ? null
      : calc.minus(D(item.unitPrice)).div(D(item.unitPrice)).mul(100);

    // 组价方案：主项行 + 工作内容缺口的建议增列行（建议行不计入测算价）
    const primaryLine = lineFromQuota(item, q, {
      mgmtRate: mgmt, profitRate: profit, mainPrice,
    });
    const plan = [primaryLine, ...suggestSupplementary(item, q, lib, mgmt, profit)];

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
      plan,
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
