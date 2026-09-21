import Decimal from "decimal.js";
import { D, decStr, sum } from "./money";
import { DISCIPLINE_LABEL, isPricableItem, type BoqItemDTO, type BreakdownSlice, type Discipline } from "@shared/types";

export function aggregateByDiscipline(items: BoqItemDTO[]): {
  slices: BreakdownSlice[];
  total: Decimal;
} {
  const leaf = items.filter((i) => !i.isHeader && i.name.trim());
  const total = sum(leaf.map((i) => D(i.totalPrice)));
  const byDisc = new Map<Discipline, { amount: Decimal; count: number }>();
  for (const it of leaf) {
    const cur = byDisc.get(it.discipline) ?? { amount: new Decimal(0), count: 0 };
    cur.amount = cur.amount.plus(D(it.totalPrice));
    cur.count += 1;
    byDisc.set(it.discipline, cur);
  }
  const slices: BreakdownSlice[] = [...byDisc.entries()]
    .map(([k, v]) => ({
      key: k,
      label: DISCIPLINE_LABEL[k] ?? k,
      amount: v.amount.toFixed(2),
      share: total.isZero() ? 0 : v.amount.div(total).toNumber(),
      count: v.count,
    }))
    .sort((a, b) => D(b.amount).cmp(D(a.amount)));
  return { slices, total };
}

/** 按语义类别聚合材料/分项金额: 电缆、桥架、管道、阀门… */
export function aggregateByCategory(
  items: BoqItemDTO[],
  categories?: string[]
): { slices: BreakdownSlice[]; total: Decimal } {
  const leaf = items.filter((i) => !i.isHeader && i.name.trim());
  const total = sum(leaf.map((i) => D(i.totalPrice)));
  const map = new Map<string, { amount: Decimal; count: number }>();
  const wanted = categories?.length ? new Set(categories) : null;

  for (const it of leaf) {
    const cat = it.features.category ?? "未分类";
    if (wanted && !wanted.has(cat)) continue;
    const cur = map.get(cat) ?? { amount: new Decimal(0), count: 0 };
    cur.amount = cur.amount.plus(D(it.totalPrice));
    cur.count += 1;
    map.set(cat, cur);
  }
  const slices: BreakdownSlice[] = [...map.entries()]
    .map(([k, v]) => ({
      key: k,
      label: k,
      amount: v.amount.toFixed(2),
      share: total.isZero() ? 0 : v.amount.div(total).toNumber(),
      count: v.count,
    }))
    .sort((a, b) => D(b.amount).cmp(D(a.amount)));
  return { slices, total };
}

export function projectTotals(items: BoqItemDTO[]) {
  const leaf = items.filter((i) => !i.isHeader && i.name.trim());
  const pricable = leaf.filter(isPricableItem);
  return {
    itemCount: leaf.length,
    pricedCount: pricable.filter((i) => !D(i.unitPrice).isZero()).length,
    pricableCount: pricable.length,
    totalAmount: decStr(sum(leaf.map((i) => D(i.totalPrice)))),
  };
}
