import Decimal from "decimal.js";
import { D, lineTotal, round2, round3, sum } from "./money";
import type { BoqItemDTO } from "@shared/types";

/**
 * 工程量反算: hit an exact target total by scaling quantities only.
 * Prices are never touched. Quantities keep 3 decimals.
 * Residual cents are absorbed by the item whose price gives the finest
 * 0.001-quantum granularity (smallest |price * 0.001 - residual| error).
 */
export function adjustQuantitiesToTarget(
  items: BoqItemDTO[],
  opts: {
    targetTotal: Decimal.Value;
    taxRate?: Decimal.Value; // e.g. 0.09 — target is treated as 含税
    allowedItemIds?: string[]; // undefined = all priced leaf items
    maxIters?: number;
  }
): {
  ok: boolean;
  adjustments: { itemId: string; beforeQty: Decimal; afterQty: Decimal }[];
  beforeTotal: Decimal;
  afterTotal: Decimal;
  residual: Decimal;
  reason?: string;
} {
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
      ok: false,
      adjustments: [],
      beforeTotal: new Decimal(0),
      afterTotal: new Decimal(0),
      residual: new Decimal(0),
      reason: "没有可调整的清单项",
    };

  const lineOf = (i: BoqItemDTO, qty?: Decimal) =>
    lineTotal(qty ?? D(i.quantity), D(i.unitPrice));

  const beforeTotal = sum(leaf.map((i) => lineOf(i)));
  const fixedTotal = sum(leaf.filter((i) => !allowed.has(i.id)).map((i) => lineOf(i)));
  const varItems = leaf.filter((i) => allowed.has(i.id));
  const varTotal = sum(varItems.map((i) => lineOf(i)));
  const needed = targetExcl.minus(fixedTotal);
  if (varTotal.isZero())
    return {
      ok: false,
      adjustments: [],
      beforeTotal,
      afterTotal: beforeTotal,
      residual: needed,
      reason: "可调项合计为 0，无法反算",
    };

  const scale = needed.div(varTotal);
  const qtyMap = new Map<string, Decimal>();
  for (const i of varItems) qtyMap.set(i.id, round3(D(i.quantity).mul(scale)));

  // residual absorption: iterate to cent-level
  const maxIters = opts.maxIters ?? 10;
  for (let iter = 0; iter < maxIters; iter++) {
    const cur = sum(
      leaf.map((i) => lineOf(i, allowed.has(i.id) ? qtyMap.get(i.id)! : undefined))
    );
    const residual = targetExcl.minus(cur);
    if (residual.abs().lte(new Decimal(0.005))) break;

    let best: { item: BoqItemDTO; k: Decimal; err: Decimal } | null = null;
    for (const i of varItems) {
      const p = D(i.unitPrice);
      if (p.isZero()) continue;
      // qty step quantum = 0.001 -> money quantum = 0.001 * price
      const k = residual.div(p.mul(0.001)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
      if (k.isZero()) continue;
      const err = residual.minus(p.mul(0.001).mul(k)).abs();
      const newQty = qtyMap.get(i.id)!.plus(k.mul(0.001));
      if (newQty.isNegative()) continue;
      if (!best || err.lt(best.err)) best = { item: i, k, err };
    }
    if (!best) break;
    qtyMap.set(best.item.id, qtyMap.get(best.item.id)!.plus(best.k.mul(0.001)));
  }

  const afterTotal = sum(
    leaf.map((i) => lineOf(i, allowed.has(i.id) ? qtyMap.get(i.id)! : undefined))
  );
  const adjustments = varItems
    .filter((i) => !qtyMap.get(i.id)!.eq(D(i.quantity)))
    .map((i) => ({
      itemId: i.id,
      beforeQty: D(i.quantity),
      afterQty: qtyMap.get(i.id)!,
    }));
  return {
    ok: afterTotal.minus(targetExcl).abs().lte(new Decimal(0.01)),
    adjustments,
    beforeTotal,
    afterTotal,
    residual: targetExcl.minus(afterTotal),
  };
}
