import { D } from "./money";
import { groupKey } from "./semantic";
import type { BoqItemDTO } from "@shared/types";

// 两版清单对审（招标 vs 中标 / 中标 vs 结算）：
// 优先按编码对齐，无编码按语义组键对齐。

export interface FileCompareRow {
  key: string;
  code: string;
  name: string;
  status: "SAME" | "PRICE_DIFF" | "QTY_DIFF" | "BOTH_DIFF" | "ONLY_A" | "ONLY_B";
  aId?: string;
  bId?: string;
  aQty?: string;
  bQty?: string;
  aPrice?: string;
  bPrice?: string;
  aTotal?: string;
  bTotal?: string;
  qtyDelta?: string;
  priceDelta?: string;
  totalDelta?: string;
  /** 量差绝对值超基准量 15%（GB50500：工程量偏差超15%应重新组价/调整综合单价） */
  qtyOver15?: boolean;
}

function alignKey(it: BoqItemDTO): string {
  if (it.code.trim()) return `C:${it.code.trim()}`;
  return `S:${groupKey(it.name, it.unit, it.features)}`;
}

export function compareBoqSets(a: BoqItemDTO[], b: BoqItemDTO[]): FileCompareRow[] {
  const leaf = (xs: BoqItemDTO[]) => xs.filter((i) => !i.isHeader && i.name.trim());
  const mapA = new Map<string, BoqItemDTO>();
  const mapB = new Map<string, BoqItemDTO>();
  for (const it of leaf(a)) mapA.set(alignKey(it), it);
  for (const it of leaf(b)) mapB.set(alignKey(it), it);

  const keys = new Set([...mapA.keys(), ...mapB.keys()]);
  const rows: FileCompareRow[] = [];
  for (const key of keys) {
    const ia = mapA.get(key);
    const ib = mapB.get(key);
    const name = ia?.name ?? ib?.name ?? "";
    const code = ia?.code ?? ib?.code ?? "";
    if (ia && ib) {
      const qtyDiff = !D(ia.quantity).eq(D(ib.quantity));
      const priceDiff = !D(ia.unitPrice).eq(D(ib.unitPrice));
      const status = qtyDiff && priceDiff ? "BOTH_DIFF" : qtyDiff ? "QTY_DIFF" : priceDiff ? "PRICE_DIFF" : "SAME";
      // GB50500：量差超基准量 15% 是调价触发线（应重新组价，不能沿用原综合单价）
      const qtyOver15 =
        qtyDiff && !D(ia.quantity).isZero() &&
        D(ib.quantity).minus(ia.quantity).abs().div(D(ia.quantity).abs()).gt(0.15);
      rows.push({
        key, code, name, status,
        aId: ia.id, bId: ib.id,
        aQty: ia.quantity, bQty: ib.quantity,
        aPrice: ia.unitPrice, bPrice: ib.unitPrice,
        aTotal: ia.totalPrice, bTotal: ib.totalPrice,
        qtyDelta: qtyDiff ? D(ib.quantity).minus(ia.quantity).toString() : undefined,
        priceDelta: priceDiff ? D(ib.unitPrice).minus(ia.unitPrice).toString() : undefined,
        totalDelta: D(ib.totalPrice).minus(ia.totalPrice).toString(),
        qtyOver15: qtyOver15 || undefined,
      });
    } else {
      const it = ia ?? ib!;
      rows.push({
        key, code, name,
        status: ia ? "ONLY_A" : "ONLY_B",
        aId: ia?.id, bId: ib?.id,
        aQty: ia?.quantity, bQty: ib?.quantity,
        aPrice: ia?.unitPrice, bPrice: ib?.unitPrice,
        aTotal: ia?.totalPrice, bTotal: ib?.totalPrice,
        totalDelta: ia ? D(ia.totalPrice).neg().toString() : D(ib!.totalPrice).toString(),
      });
    }
  }
  const order = { ONLY_B: 0, ONLY_A: 1, BOTH_DIFF: 2, PRICE_DIFF: 3, QTY_DIFF: 4, SAME: 5 };
  return rows.sort((x, y) => order[x.status] - order[y.status]);
}

export function compareSummary(rows: FileCompareRow[]) {
  const count = (s: FileCompareRow["status"]) => rows.filter((r) => r.status === s).length;
  const deltaSum = rows.reduce((a, r) => a.plus(D(r.totalDelta ?? 0)), D(0));
  return {
    total: rows.length,
    same: count("SAME"),
    priceDiff: count("PRICE_DIFF") + count("BOTH_DIFF"),
    qtyDiff: count("QTY_DIFF") + count("BOTH_DIFF"),
    qtyOver15: rows.filter((r) => r.qtyOver15).length,
    onlyA: count("ONLY_A"),
    onlyB: count("ONLY_B"),
    totalDelta: deltaSum.toFixed(2),
  };
}
