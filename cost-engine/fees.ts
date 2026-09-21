import Decimal from "decimal.js";
import { D, sum } from "./money";
import type { BoqItemDTO } from "@shared/types";

// 费用汇总（取费）：分部分项 → 措施 → 其他项目(暂列) → 规费 → 税前 → 税金 → 含税造价。
// 纯函数、确定性；费率来自项目事实台账，未设置的费率计 0 并在行内注明。

export interface FeeParams {
  /** 措施项目费率（基数：分部分项工程费），如 0.03 */
  measureRate: Decimal;
  /** 规费费率（基数：分部分项工程费，简化口径——真实规费基数为人工费），如 0.02 */
  regulationRate: Decimal;
  /** 暂列金额率（基数：分部分项工程费），如 0.05 */
  provisionalRate: Decimal;
  /** 暂列金额固定值（>0 时优先于暂列金额率） */
  provisionalAmount: Decimal;
  /** 增值税率，默认 0.09 */
  taxRate: Decimal;
  /** 各费率是否来自台账（false=未设置，行内注明） */
  set: { measure: boolean; regulation: boolean; provisional: boolean; tax: boolean };
}

export interface FeeRow {
  seq: string;
  name: string;
  /** 计算基础/表达式描述 */
  basis: string;
  /** 费率显示文本，无费率行为 null */
  rate: string | null;
  amount: string;
  /** 层级：section(一/二/三) | subtotal(小计) | total(总计) | leaf */
  level: "leaf" | "subtotal" | "total";
  note?: string;
}

export interface FeeSummary {
  rows: FeeRow[];
  /** 含税工程造价（大写行金额） */
  grandTotal: string;
  /** 税前造价 */
  preTax: string;
  unpricedCount: number;
}

const pct = (rate: Decimal): string => `${rate.mul(100).toFixed(rate.mul(100).decimalPlaces() > 2 ? 2 : 0)}%`;

export function feeSummary(items: BoqItemDTO[], params: FeeParams): FeeSummary {
  const leaf = items.filter((i) => !i.isHeader && i.name.trim());
  const unpricedCount = leaf.filter((i) => D(i.unitPrice).isZero()).length;
  const boqTotal = sum(leaf.map((i) => i.totalPrice));

  const measure = boqTotal.mul(params.measureRate);
  const provisional = params.provisionalAmount.gt(0)
    ? params.provisionalAmount
    : boqTotal.mul(params.provisionalRate);
  const regulation = boqTotal.mul(params.regulationRate);
  const preTax = boqTotal.plus(measure).plus(provisional).plus(regulation);
  const tax = preTax.mul(params.taxRate);
  const grandTotal = preTax.plus(tax);

  const unset = (flag: boolean, hint: string) => (flag ? undefined : `未设置，按 0 计（可用「${hint}」写入台账）`);
  const rows: FeeRow[] = [
    {
      seq: "一", name: "分部分项工程费", basis: `Σ 清单合价（${leaf.length} 项）`,
      rate: null, amount: boqTotal.toFixed(2), level: "leaf",
      note: unpricedCount ? `含 ${unpricedCount} 项未定价` : undefined,
    },
    {
      seq: "二", name: "措施项目费", basis: "分部分项工程费 × 费率",
      rate: pct(params.measureRate), amount: measure.toFixed(2), level: "leaf",
      note: unset(params.set.measure, "措施费率设为x%"),
    },
    {
      seq: "三", name: "其他项目费（暂列金额）", basis: params.provisionalAmount.gt(0) ? "固定金额" : "分部分项工程费 × 费率",
      rate: params.provisionalAmount.gt(0) ? null : pct(params.provisionalRate),
      amount: provisional.toFixed(2), level: "leaf",
      note: unset(params.set.provisional, "暂列金额率设为x% 或 暂列金额设为x元"),
    },
    {
      seq: "四", name: "规费", basis: "分部分项工程费 × 费率（简化基数）",
      rate: pct(params.regulationRate), amount: regulation.toFixed(2), level: "leaf",
      note: params.set.regulation ? "简化口径：以分部分项费为基数" : unset(false, "规费费率设为x%"),
    },
    {
      seq: "五", name: "税前工程造价", basis: "一 + 二 + 三 + 四",
      rate: null, amount: preTax.toFixed(2), level: "subtotal",
    },
    {
      seq: "六", name: "增值税", basis: "税前工程造价 × 税率",
      rate: pct(params.taxRate), amount: tax.toFixed(2), level: "leaf",
      note: params.set.tax ? undefined : "未设置，按默认 9% 计",
    },
    {
      seq: "七", name: "含税工程造价", basis: "五 + 六",
      rate: null, amount: grandTotal.toFixed(2), level: "total",
    },
  ];
  return { rows, grandTotal: grandTotal.toFixed(2), preTax: preTax.toFixed(2), unpricedCount };
}
