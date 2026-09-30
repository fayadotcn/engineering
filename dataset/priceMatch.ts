import { periodKey } from "./priceParse";

// 价格库候选行打分：名称/规格是基础分（沿用既有阈值 60/80），
// 品牌偏好 / 地区 / 期次新旧 / 价格类型 在候选间做加减分裁决。
// 纯函数——候选集由调用方（dataset/service）从 DB 取出。

export interface PriceCandidate {
  id?: string;
  name: string;
  spec: string;
  unit: string;
  brand: string;
  price: number;
  priceType: string;
  region: string;
  period: string;
  source?: string;
  createdAt?: string;
}

export interface PricePrefs {
  /** 品牌偏好：appliesTo 为空 = 全局指定（如「品牌=上上」）；否则只作用于名称/材质含该词的条目（「电缆品牌=上上」→电缆类） */
  brands?: { appliesTo: string; value: string }[];
  /** 地区偏好（项目所在地区），候选 region 命中优先 */
  region?: string;
  /** 指定期次 YYYY-MM：按「截至该期最新价」取（信息价口径），超出该期的候选降权 */
  period?: string;
  /** 价格类型偏好 INFO|MARKET|SUPPLY|LABOR */
  priceType?: string;
}

const norm = (s: string | null | undefined): string =>
  String(s ?? "").replace(/\s/g, "").replace(/X/gi, "x").toUpperCase();

/** 名称/规格命中检查用的弱同义（去品牌前缀差异） */
const nameHit = (row: string, item: string): boolean => {
  const a = norm(row), b = norm(item);
  return a === b || a.includes(b) || b.includes(a);
};

/**
 * 规格里的型号词根：「WDZB1-YJY-0.6/1kV 3*10」→ {WDZB1, YJY, 1KV}。
 * 纯数字不进（3/10 太泛）；型号式价格行（报价单无材料名列）靠它对上清单规格。
 */
export const specTokens = (s: string | null | undefined): Set<string> =>
  new Set(
    (String(s ?? "").toUpperCase().match(/[A-Z]+\d*|\d+[A-Z]+\d*/g) ?? []).filter(
      (t) => t.length >= 2
    )
  );

/** 共有型号词根数：strong=长度≥3（YJY/WDZB1 这类才足以定位型号系列） */
const sharedSpecTokens = (a: string, b: string) => {
  const sa = specTokens(a), sb = specTokens(b);
  let any = 0, strong = 0;
  for (const t of sa)
    if (sb.has(t)) {
      any++;
      if (t.length >= 3) strong++;
    }
  return { any, strong };
};

/** 当前条目适用的品牌偏好值列表 */
export function applicableBrands(prefs: PricePrefs | undefined, text: string): string[] {
  if (!prefs?.brands?.length) return [];
  const t = norm(text);
  return prefs.brands
    .filter((b) => !b.appliesTo || t.includes(norm(b.appliesTo)))
    .map((b) => b.value)
    .filter(Boolean);
}

export interface PricePick {
  row: PriceCandidate;
  score: number;
  /** 需要向用户说明的偏差（如品牌非指定、期次早于指定） */
  notes: string[];
}

/**
 * 候选集里挑最优价。baseline 与既有 matchLibraryForItem 一致：
 *   名称命中 +40 / 规格精确 +50 包含 +30 无规格 +20 / 单位一致 +10。
 * 新维度：品牌偏好命中 +30（无品牌 +8，异品牌 -15）、地区命中 +15（空 +5）、
 *   期次默认取候选中最新一期 +12；指定期次时取「≤该期」中最新（+14，最早扣分），
 *   价格类型偏好命中 +10。
 */
export function pickBestPriceRow(
  candidates: PriceCandidate[],
  item: { name: string; spec?: string; unit?: string; material?: string },
  prefs?: PricePrefs
): PricePick | null {
  if (!candidates.length) return null;
  const spec = norm(item.spec ?? "");
  const brands = applicableBrands(prefs, `${item.name} ${item.material ?? ""}`);
  const prefPk = periodKey(prefs?.period);
  const maxPk = Math.max(0, ...candidates.map((c) => periodKey(c.period)));
  const eligiblePk = prefPk
    ? Math.max(0, ...candidates.map((c) => {
        const k = periodKey(c.period);
        return k > 0 && k <= prefPk ? k : 0;
      }))
    : 0;
  // 期次全空时退到入库时间——「最新」对无期次表也该生效
  const maxCreated =
    maxPk === 0
      ? Math.max(0, ...candidates.map((c) => Date.parse(c.createdAt ?? "") || 0))
      : 0;

  let best: PricePick | null = null;
  for (const r of candidates) {
    const rs = norm(r.spec);
    const specExact = !!(spec && rs && rs === spec);
    const specContain = !!(
      spec && rs && (rs.includes(spec) || spec.includes(rs))
    );
    const shared = spec && rs && !specExact && !specContain
      ? sharedSpecTokens(spec, rs)
      : { any: 0, strong: 0 };
    const nameOk =
      nameHit(r.name, item.name) ||
      !!(item.material && r.name.includes(item.material));
    // 型号式价格行（名称为型号）无名称命中——规格词根重合度够也保留参选
    if (!nameOk && !specExact && !specContain && !shared.strong && shared.any < 2)
      continue;
    let s = 40;
    const notes: string[] = [];
    if (specExact) s += 50;
    else if (specContain) s += 30;
    else if (shared.strong >= 1) s += 22;
    else if (shared.any >= 2) s += 12;
    else if (!spec) s += 20;
    // 词根命中后的截面/尺寸精排（4*25+1*16 ≠ 3*35+1*16 ≠ 3*10）：
    // 全命中加分，全不命中罚分，部分命中不加不罚
    if (!specExact && !specContain && spec && rs) {
      const dReq = spec.match(/\d+(?:[*x×]\d+)+/g) ?? [];
      const dRow = new Set(rs.match(/\d+(?:[*x×]\d+)+/g) ?? []);
      if (dReq.length && dReq.every((d) => dRow.has(d))) s += 8;
      else if (dReq.length && !dReq.some((d) => dRow.has(d))) {
        s -= 20;
        notes.push("截面/尺寸档不同");
      }
    }
    if (!nameOk) notes.push("名称未直接命中（按型号规格匹配）");
    if (r.unit && item.unit && r.unit === item.unit) s += 10;

    // 品牌：指定品牌命中 > 无品牌候选 > 异品牌候选（异品牌仍可兜底但要留痕）
    if (brands.length) {
      const rb = norm(r.brand);
      if (rb && brands.some((b) => rb === norm(b) || rb.includes(norm(b)) || norm(b).includes(rb)))
        s += 30;
      else if (!rb) s += 8;
      else {
        s -= 15;
        notes.push(`品牌「${r.brand}」非指定（${brands.join("/")}）`);
      }
    }
    // 地区
    if (prefs?.region) {
      const rr = norm(r.region), pr = norm(prefs.region);
      if (rr && (rr.includes(pr) || pr.includes(rr))) s += 15;
      else if (!rr) s += 5;
      else notes.push(`地区「${r.region}」非「${prefs.region}」`);
    }
    // 期次：默认偏好候选里最新一期；指定期次按「截至该期」取
    const pk = periodKey(r.period);
    if (prefPk) {
      if (pk > 0 && pk <= prefPk) {
        s += 12;
        if (pk === eligiblePk) s += 2;
      } else if (pk > prefPk) {
        s += 0;
        notes.push(`期次「${r.period}」晚于指定「${prefs!.period}」`);
      }
    } else if (pk > 0 && pk === maxPk) s += 12;
    else if (maxPk === 0 && maxCreated > 0 && (Date.parse(r.createdAt ?? "") || 0) === maxCreated)
      s += 12;
    // 价格类型偏好
    if (prefs?.priceType && r.priceType === prefs.priceType) s += 10;

    if (!best || s > best.score) best = { row: r, score: s, notes };
  }
  return best;
}
