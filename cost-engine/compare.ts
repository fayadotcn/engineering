import Decimal from "decimal.js";
import { D, decStr, maxD, median, minD } from "./money";
import { featureCompatible, groupKey } from "./semantic";
import type { AnomalyRow, BoqItemDTO } from "@shared/types";

// Candidate Grouping -> Feature Comparison -> Price Comparison.
// Never plain string matching.

export interface CompareOptions {
  /** items with quantity 0 are ignored (per spec: 工程量为0的不用管) */
  skipZeroQuantity?: boolean;
  /** price deviation ratio vs median to flag anomaly, default 0.15 */
  anomalyRatio?: number;
  onlyPriced?: boolean;
}

const eligible = (it: BoqItemDTO, opts: CompareOptions) =>
  !it.isHeader &&
  it.name.trim().length > 0 &&
  !(opts.skipZeroQuantity !== false && D(it.quantity).isZero()) &&
  !(opts.onlyPriced !== false && D(it.unitPrice).isZero());

function toRowItem(it: BoqItemDTO) {
  return {
    id: it.id,
    code: it.code,
    name: it.name,
    feature: it.rawFeature,
    unit: it.unit,
    quantity: it.quantity,
    unitPrice: it.unitPrice,
    sectionPath: it.sectionPath,
  };
}

function label(it: BoqItemDTO): string {
  const f = it.features;
  const bits = [
    f.category,
    f.material,
    f.diameter ?? f.specification,
    f.connectionMethod,
    f.system,
  ].filter(Boolean);
  return bits.length ? bits.join(" · ") : it.name;
}

export function groupCandidates(
  items: BoqItemDTO[],
  opts: CompareOptions = {}
): Map<string, BoqItemDTO[]> {
  const groups = new Map<string, BoqItemDTO[]>();
  for (const it of items) {
    if (!eligible(it, opts)) continue;
    const key = groupKey(it.name, it.unit, it.features);
    const arr = groups.get(key) ?? [];
    arr.push(it);
    groups.set(key, arr);
  }
  return groups;
}

/** 相同项不同单价: same semantic item priced differently. */
export function findSameItemDifferentPrice(
  items: BoqItemDTO[],
  opts: CompareOptions = {}
): AnomalyRow[] {
  const rows: AnomalyRow[] = [];
  for (const [key, group] of groupCandidates(items, opts)) {
    if (group.length < 2) continue;
    const prices = [...new Set(group.map((g) => decStr(D(g.unitPrice))))];
    if (prices.length < 2) continue;

    // Feature comparison: drop pairs that genuinely differ in features
    const conflicts = new Set<string>();
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) {
        const c = featureCompatible(group[i].features, group[j].features);
        c.conflicts.forEach((x) => conflicts.add(x));
      }
    const priceDs = group.map((g) => D(g.unitPrice));
    const spread = maxD(priceDs).minus(minD(priceDs));
    rows.push({
      groupKey: key,
      label: label(group[0]),
      items: group.map(toRowItem),
      prices,
      spread: spread.toString(),
      reason:
        conflicts.size > 0
          ? `特征存在差异但仍疑似同项: ${[...conflicts].join("；")}`
          : "语义特征一致，综合单价不一致",
    });
  }
  return rows.sort((a, b) => D(b.spread ?? 0).cmp(D(a.spread ?? 0)));
}

/** 综合单价异常: within same-semantic group, price deviates from median > ratio. */
export function findPriceAnomalies(
  items: BoqItemDTO[],
  opts: CompareOptions = {}
): AnomalyRow[] {
  const ratio = D(opts.anomalyRatio ?? 0.15);
  const rows: AnomalyRow[] = [];
  for (const [key, group] of groupCandidates(items, opts)) {
    if (group.length < 3) continue; // need a meaningful baseline
    const med = median(group.map((g) => D(g.unitPrice)));
    if (med.isZero()) continue;
    const bad = group.filter((g) =>
      D(g.unitPrice).minus(med).abs().div(med).gt(ratio)
    );
    if (!bad.length) continue;
    rows.push({
      groupKey: key,
      label: label(group[0]),
      items: group.map(toRowItem),
      prices: [...new Set(group.map((g) => decStr(D(g.unitPrice))))],
      reason: `组内中位价 ${med.toFixed(2)}，偏离超过 ${ratio.mul(100).toFixed(0)}%`,
    });
  }
  return rows;
}

/** 相同编码/名称 但项目特征语义不一致。 */
export function findFeatureMismatch(items: BoqItemDTO[]): AnomalyRow[] {
  const byCodeName = new Map<string, BoqItemDTO[]>();
  for (const it of items) {
    if (it.isHeader || !it.name.trim()) continue;
    const key = it.code
      ? `C:${it.code.trim()}`
      : `N:${it.name.trim()}|${it.unit}`;
    const arr = byCodeName.get(key) ?? [];
    arr.push(it);
    byCodeName.set(key, arr);
  }
  const rows: AnomalyRow[] = [];
  for (const [key, group] of byCodeName) {
    if (group.length < 2) continue;
    const conflicts = new Set<string>();
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) {
        const c = featureCompatible(group[i].features, group[j].features);
        c.conflicts.forEach((x) => conflicts.add(x));
      }
    if (!conflicts.size) continue;
    rows.push({
      groupKey: key,
      label: group[0].name,
      items: group.map(toRowItem),
      prices: [...new Set(group.map((g) => decStr(D(g.unitPrice))))],
      reason: `编码/名称相同但项目特征不一致: ${[...conflicts].join("；")}`,
    });
  }
  return rows;
}

/** 重复项: code+name+unit identical AND semantic features identical. */
export function findDuplicateItems(items: BoqItemDTO[]): AnomalyRow[] {
  const rows: AnomalyRow[] = [];
  for (const [key, group] of groupCandidates(items, { onlyPriced: false, skipZeroQuantity: false })) {
    const exact = new Map<string, BoqItemDTO[]>();
    for (const it of group) {
      if (!it.code) continue;
      const k = `${it.code}|${key}`;
      const arr = exact.get(k) ?? [];
      arr.push(it);
      exact.set(k, arr);
    }
    for (const [k, g] of exact) {
      if (g.length < 2) continue;
      rows.push({
        groupKey: k,
        label: g[0].name,
        items: g.map(toRowItem),
        prices: [...new Set(g.map((x) => decStr(D(x.unitPrice))))],
        reason: "相同编码且语义特征一致，疑似重复清单项",
      });
    }
  }
  return rows;
}
