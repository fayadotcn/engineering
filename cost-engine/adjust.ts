import Decimal from "decimal.js";
import { D, lineTotal, round2, round3, sum } from "./money";
import type { BoqItemDTO } from "@shared/types";

/**
 * 总价反算: hit an exact target total by scaling one field.
 * field="price"（默认/合规）：按比例下浮/上浮综合单价（总价控制的正规手段，
 *   工程量是图纸事实不动）；残差分分钱由量×0.01 粒度最细的项吸收。
 * field="quantity"：仅缩放工程量（单价不动）——会改变图纸口径的工程量，
 *   仅限招标人本意是「工程量按同一比例缩放」的特殊场景，工具层需明示。
 * Quantities keep 3 decimals; prices keep 2 decimals.
 */
export function adjustToTarget(
  items: BoqItemDTO[],
  opts: {
    targetTotal: Decimal.Value;
    taxRate?: Decimal.Value; // e.g. 0.09 — target is treated as 含税
    allowedItemIds?: string[]; // undefined = all priced leaf items
    maxIters?: number;
    field?: "price" | "quantity"; // default "price"（单价下浮是合规的总价控制手段）
  }
): {
  ok: boolean;
  field: "price" | "quantity";
  adjustments: { itemId: string; before: Decimal; after: Decimal }[];
  beforeTotal: Decimal;
  afterTotal: Decimal;
  residual: Decimal;
  reason?: string;
} {
  const field = opts.field ?? "price";
  const quantum = field === "quantity" ? new Decimal(0.001) : new Decimal(0.01);
  const round = field === "quantity" ? round3 : round2;
  const read = (i: BoqItemDTO) => D(field === "quantity" ? i.quantity : i.unitPrice);

  const tax = D(opts.taxRate ?? 0);
  const targetExcl = round2(D(opts.targetTotal).div(D(1).plus(tax)));
  const leaf = items.filter((i) => !i.isHeader && i.name.trim());
  const allowed = new Set(
    (opts.allowedItemIds?.length
      ? leaf.filter((i) => opts.allowedItemIds!.includes(i.id))
      : leaf.filter((i) => !D(i.unitPrice).isZero() && !D(i.quantity).isZero())
    ).map((i) => i.id)
  );
  if (!allowed.size)
    return {
      ok: false, field, adjustments: [],
      beforeTotal: new Decimal(0), afterTotal: new Decimal(0),
      residual: new Decimal(0), reason: "没有可调整的清单项",
    };

  const lineOf = (i: BoqItemDTO, val?: Decimal) =>
    field === "quantity"
      ? lineTotal(val ?? D(i.quantity), D(i.unitPrice))
      : lineTotal(D(i.quantity), val ?? D(i.unitPrice));

  const beforeTotal = sum(leaf.map((i) => lineOf(i)));
  const fixedTotal = sum(leaf.filter((i) => !allowed.has(i.id)).map((i) => lineOf(i)));
  const varItems = leaf.filter((i) => allowed.has(i.id));
  const varTotal = sum(varItems.map((i) => lineOf(i)));
  const needed = targetExcl.minus(fixedTotal);
  if (varTotal.isZero())
    return {
      ok: false, field, adjustments: [],
      beforeTotal, afterTotal: beforeTotal,
      residual: needed, reason: "可调项合计为 0，无法反算",
    };

  const scale = needed.div(varTotal);
  const valMap = new Map<string, Decimal>();
  for (const i of varItems) valMap.set(i.id, round(read(i).mul(scale)));

  // residual absorption: iterate to cent-level
  // money quantum = quantum × 另一因子（量×0.01价 或 价×0.001量）
  const maxIters = opts.maxIters ?? 10;
  for (let iter = 0; iter < maxIters; iter++) {
    const cur = sum(
      leaf.map((i) => lineOf(i, allowed.has(i.id) ? valMap.get(i.id)! : undefined))
    );
    const residual = targetExcl.minus(cur);
    if (residual.abs().lte(new Decimal(0.005))) break;

    let best: { item: BoqItemDTO; k: Decimal; err: Decimal } | null = null;
    for (const i of varItems) {
      const other = D(field === "quantity" ? i.unitPrice : i.quantity);
      if (other.isZero()) continue;
      const step = other.mul(quantum); // money per quantum step
      const k = residual.div(step).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
      if (k.isZero()) continue;
      const err = residual.minus(step.mul(k)).abs();
      const newVal = valMap.get(i.id)!.plus(k.mul(quantum));
      if (newVal.isNegative()) continue;
      if (!best || err.lt(best.err)) best = { item: i, k, err };
    }
    if (!best) break;
    valMap.set(best.item.id, valMap.get(best.item.id)!.plus(best.k.mul(quantum)));
  }

  const afterTotal = sum(
    leaf.map((i) => lineOf(i, allowed.has(i.id) ? valMap.get(i.id)! : undefined))
  );
  const adjustments = varItems
    .filter((i) => !valMap.get(i.id)!.eq(read(i)))
    .map((i) => ({
      itemId: i.id,
      before: read(i),
      after: valMap.get(i.id)!,
    }));
  return {
    ok: afterTotal.minus(targetExcl).abs().lte(new Decimal(0.01)),
    field,
    adjustments,
    beforeTotal,
    afterTotal,
    residual: targetExcl.minus(afterTotal),
  };
}

/** @deprecated 兼容旧名：quantity 模式。新代码用 adjustToTarget。 */
export function adjustQuantitiesToTarget(
  items: BoqItemDTO[],
  opts: Parameters<typeof adjustToTarget>[1]
) {
  return adjustToTarget(items, { ...opts, field: "quantity" });
}
