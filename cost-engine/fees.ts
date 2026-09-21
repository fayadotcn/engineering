import Decimal from "decimal.js";
import { D, sum } from "./money";
import type { BoqItemDTO } from "@shared/types";

// 费用汇总（取费）：分部分项 → 措施 → 其他项目 → 规费 → 税前 → 税金 → 含税造价。
// 纯函数、确定性。
// 专业口径：
//  - 分部分项/措施/其他项目按清单费用口径分层；导入了措施表/其他项目表就用真值，
//    没导入才用费率估算并注明。
//  - 规费基数是「定额人工费」（四川安装口径），不是分部分项费——
//    定额测算后台账里有 定额人工费 时才用真基数，否则退回简化口径并显著标注。
//  - 费率全部来自项目事实台账，未设置的计 0 并在行内注明，绝不静默套默认值。

export interface FeeParams {
  /** 措施项目费率（基数：分部分项工程费），如 0.03 */
  measureRate: Decimal;
  /** 规费费率（基数：定额人工费），如 0.28 */
  regulationRate: Decimal;
  /** 暂列金额率（基数：分部分项工程费），如 0.05 */
  provisionalRate: Decimal;
  /** 暂列金额固定值（>0 时优先于暂列金额率） */
  provisionalAmount: Decimal;
  /** 增值税率，默认 0.09 */
  taxRate: Decimal;
  /** 定额人工费合计（定额测算写入台账）；null = 未测算，规费退回简化口径 */
  laborBase: Decimal | null;
  /** 官方系数措施费合计（cost.measureFees 计取写入台账）：脚手架/超高/高层增加费等 */
  coeffMeasureFee: Decimal;
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
  const byType = (t: string) => leaf.filter((i) => (i.feeType ?? "分部分项") === t);
  const priced = byType("分部分项").concat(byType("单价措施"));
  const unpricedCount = priced.filter((i) => D(i.unitPrice).isZero()).length;

  const boqTotal = sum(byType("分部分项").map((i) => i.totalPrice));
  const measureItems = byType("单价措施").concat(byType("总价措施"));
  const otherItems = byType("其他项目");
  const importedMeasure = sum(measureItems.map((i) => i.totalPrice));
  const importedOther = sum(otherItems.map((i) => i.totalPrice));

  // 措施费构成：导入的措施清单真值 + 官方系数计取（脚手架/超高/高层，cost.measureFees 写台账）；
  // 两者皆无才退费率估算并注明
  const coeffFee = params.coeffMeasureFee;
  const measure = importedMeasure.plus(coeffFee).gt(0)
    ? importedMeasure.plus(coeffFee)
    : boqTotal.mul(params.measureRate);
  // 其他项目费：导入了其他项目表用真值；否则暂列金额估算
  const other = importedOther.gt(0)
    ? importedOther
    : params.provisionalAmount.gt(0)
      ? params.provisionalAmount
      : boqTotal.mul(params.provisionalRate);
  // 规费：定额人工费为真实基数（测算后可用）；否则退回简化口径并标注
  const laborBase = params.laborBase;
  const regulation = laborBase !== null && laborBase.gt(0)
    ? laborBase.mul(params.regulationRate)
    : boqTotal.mul(params.regulationRate);
  const preTax = boqTotal.plus(measure).plus(other).plus(regulation);
  const tax = preTax.mul(params.taxRate);
  const grandTotal = preTax.plus(tax);

  const unset = (flag: boolean, hint: string) => (flag ? undefined : `未设置，按 0 计（可用「${hint}」写入台账）`);
  const rows: FeeRow[] = [
    {
      seq: "一", name: "分部分项工程费", basis: `Σ 分部分项合价（${byType("分部分项").length} 项）`,
      rate: null, amount: boqTotal.toFixed(2), level: "leaf",
      note: unpricedCount ? `含 ${unpricedCount} 项未定价` : undefined,
    },
    {
      seq: "二", name: "措施项目费",
      basis: [
        importedMeasure.gt(0) ? `Σ 措施清单合价（${measureItems.length} 项）` : "",
        coeffFee.gt(0) ? `系数措施费 ${coeffFee.toFixed(2)}（脚手架/超高/高层等，川标费率）` : "",
      ].filter(Boolean).join(" + ") || "分部分项工程费 × 费率（估算）",
      rate: importedMeasure.plus(coeffFee).gt(0) ? null : pct(params.measureRate),
      amount: measure.toFixed(2), level: "leaf",
      note: importedMeasure.plus(coeffFee).gt(0)
        ? [
            importedMeasure.gt(0) ? "按导入的措施项目清单计价表" : "",
            coeffFee.gt(0) ? "含「措施费计取」结果" : "",
          ].filter(Boolean).join("；") || undefined
        : unset(params.set.measure, "措施费率设为x% 或先做「措施费计取」") ?? "费率估算口径",
    },
    {
      seq: "三", name: "其他项目费",
      basis: importedOther.gt(0)
        ? `Σ 其他项目清单合价（${otherItems.length} 项）`
        : params.provisionalAmount.gt(0) ? "暂列金额（固定值）" : "分部分项工程费 × 暂列金额率（估算）",
      rate: importedOther.gt(0) ? null : params.provisionalAmount.gt(0) ? null : pct(params.provisionalRate),
      amount: other.toFixed(2), level: "leaf",
      note: importedOther.gt(0)
        ? "按导入的其他项目清单计价表（暂列金额/暂估价/计日工/总承包服务费）"
        : unset(params.set.provisional, "暂列金额率设为x% 或 暂列金额设为x元"),
    },
    {
      seq: "四", name: "规费",
      basis: laborBase !== null && laborBase.gt(0)
        ? `定额人工费 ${laborBase.toFixed(2)} × 费率`
        : "分部分项工程费 × 费率（简化基数）",
      rate: pct(params.regulationRate), amount: regulation.toFixed(2), level: "leaf",
      note: laborBase !== null && laborBase.gt(0)
        ? "基数为定额测算汇总的定额人工费（四川安装口径）"
        : params.set.regulation
          ? "简化口径：以分部分项费为基数；运行「定额测算」后自动改用定额人工费"
          : unset(false, "规费费率设为x%"),
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
