import { D, round2 } from "@cost-engine/money";
import { QUOTA_LIBRARY, type QuotaEntry } from "./library";
import type { BoqItemDTO } from "@shared/types";

// 定额匹配 + 组价。全部确定性计算。
// 综合单价 = (人工费+辅材费+机械费)/定额倍数 + 主材价×耗量 + (人工+机械)/倍数×(管理费率+利润率)

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toRe = (v: unknown) =>
  typeof v === "string" && v ? new RegExp(escapeRe(v), "i") : undefined;

/** 内置参考库 + 后台上传的定额数据集，合并成匹配库 */
export async function getQuotaLibrary(): Promise<QuotaEntry[]> {
  try {
    const { prisma } = await import("@database/client");
    const rows = await prisma.quotaRow.findMany({
      where: { OR: [{ datasetId: null }, { dataset: { active: true } }] },
    });
    const db: QuotaEntry[] = rows.map((r) => {
      const mk = JSON.parse(r.matchKeys || "{}") as Record<string, string>;
      return {
        code: r.code,
        name: r.name,
        unit: r.unit,
        unitScale: r.unitScale || 1,
        labor: Number(r.labor),
        material: Number(r.material),
        machine: Number(r.machine),
        mainQtyPerUnit: r.mainQtyPerUnit || 1,
        match: {
          category: mk.category,
          system: mk.system,
          material: toRe(mk.material),
          diameter: toRe(mk.diameter),
          spec: toRe(mk.spec),
          // DB 特征值常带后缀（"沟槽连接" vs 清单特征 "沟槽"），剥掉使匹配方向一致
          connection: toRe(mk.connection?.replace(/(连接|方式|敷设|安装)$/, "")),
          keywords: toRe(mk.keywords),
          codes: mk.xmbh ? new Set(mk.xmbh.split(",")) : undefined,
        },
      };
    });
    return [...QUOTA_LIBRARY, ...db];
  } catch {
    return QUOTA_LIBRARY;
  }
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
  // 清单编码前9位命中定额映射表 → 计价软件级确定性，直接强信号
  if (m.codes?.size && item.code && m.codes.has(item.code.slice(0, 9))) s += 60;
  if (m.category) s += f.category === m.category ? 40 : 0;
  if (m.material) s += m.material.test(f.material ?? text) ? 25 : 0;
  if (m.diameter) s += m.diameter.test(f.diameter ?? f.specification ?? "") ? 20 : 0;
  if (m.spec) s += m.spec.test(f.specification ?? "") ? 15 : 0;
  if (m.connection) s += m.connection.test(f.connectionMethod ?? "") ? 10 : 0;
  if (m.system) s += f.system === m.system ? 5 : 0;
  if (m.keywords) s += m.keywords.test(text) ? 10 : 0;
  return s;
}

export function matchQuota(
  item: BoqItemDTO,
  threshold = 50,
  lib: QuotaEntry[] = QUOTA_LIBRARY
): QuotaMatch {
  let best: QuotaMatch = { item, quota: null, score: 0 };
  for (const q of lib) {
    const s = scoreQuota(item, q);
    if (s > best.score) best = { item, quota: q, score: s };
  }
  if (best.score < threshold) return { item, quota: null, score: best.score };
  return best;
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
    const m = matchQuota(item, opts.threshold ?? 50, lib);
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
