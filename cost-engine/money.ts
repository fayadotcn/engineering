import Decimal from "decimal.js";

// Deterministic money math. All amounts flow through here — never raw floats.

export const D = (v: Decimal.Value | null | undefined): Decimal =>
  new Decimal(v ?? 0);

export const round2 = (v: Decimal.Value): Decimal => D(v).toDecimalPlaces(2);
export const round3 = (v: Decimal.Value): Decimal => D(v).toDecimalPlaces(3);

/** 金额 = 工程量 × 综合单价，保留两位 */
export const lineTotal = (qty: Decimal.Value, price: Decimal.Value): Decimal =>
  round2(D(qty).mul(D(price)));

export const sum = (values: Decimal.Value[]): Decimal =>
  values.reduce<Decimal>((acc, v) => acc.plus(D(v)), new Decimal(0));

/** 含税 = 不含税 × (1 + 税率) */
export const withTax = (amount: Decimal.Value, taxRate: Decimal.Value): Decimal =>
  round2(D(amount).mul(D(1).plus(D(taxRate))));

export const fmt = (v: Decimal.Value, places = 2): string =>
  D(v).toFixed(places);

/** 对外展示用：千分位 + 两位小数（工具消息/视图摘要里的金额） */
export const fmtMoney = (v: Decimal.Value): string =>
  Number(round2(v).toFixed(2)).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const decStr = (v: Decimal.Value): string => D(v).toString();

export const maxD = (vs: Decimal.Value[]): Decimal =>
  vs.reduce<Decimal>((a, b) => Decimal.max(a, D(b)), new Decimal(0));

// 空数组返回 0 而非 Infinity——调用方拿它做减法会算出 -Infinity 金额
export const minD = (vs: Decimal.Value[]): Decimal =>
  vs.length === 0
    ? new Decimal(0)
    : vs.reduce<Decimal>((a, b) => Decimal.min(a, D(b)), D(vs[0]));

export const median = (vs: Decimal.Value[]): Decimal => {
  if (vs.length === 0) return new Decimal(0);
  const sorted = [...vs].map(D).sort((a, b) => a.cmp(b));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : sorted[mid - 1].plus(sorted[mid]).div(2);
};
