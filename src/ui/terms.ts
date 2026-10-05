// UI 术语单源（口径统一出口）。
//
// 为什么有这份文件：价格类型 / 表格类型 / 计价表分层的标签原先各组件各抄一份，
// 同一枚举在不同文件里叫法不同（SUPPLY 有「供应商价」「供应价」两种、LABOR 有「人工价」
// 「人工费」两种）。这里只定义一次，组件一律 import。
//
// 口径红线（勿改）：SUPPLY 一律「供应价」、LABOR 一律「人工费」——与 dataset/priceParse.ts
// 的 normalizePriceType 四类一一对应。
//
// 仍有本地副本的文件（本次不改，后续接入本文件）：
//   file/inspection.ts(SHEET_TYPE_LABEL —— 服务端模块，刻意保留)
import type { FeeType } from "@shared/types";

/* ---------------- 价格类型：INFO | MARKET | SUPPLY | LABOR ---------------- */

/** 价格类型：信息价 / 市场价 / 供应价 / 人工费（dataset/priceParse.normalizePriceType 的产物）。 */
export type PriceType = "INFO" | "MARKET" | "SUPPLY" | "LABOR";

/** 下拉选项顺序：信息价 → 市场价 → 供应价 → 人工费。 */
export const PRICE_TYPES: readonly PriceType[] = ["INFO", "MARKET", "SUPPLY", "LABOR"];

export const PRICE_TYPE_LABEL: Record<PriceType, string> = {
  INFO: "信息价",
  MARKET: "市场价",
  SUPPLY: "供应价",
  LABOR: "人工费",
};

/** 查表兜底：normalizePriceType 对枚举外的短词（≤10 字）原样返回，直接下标会得到 undefined。 */
export function priceTypeLabel(raw: string | null | undefined): string {
  const s = String(raw ?? "");
  return (PRICE_TYPE_LABEL as Record<string, string>)[s] ?? s;
}

/* ---------------- 表格 / 工作表类型（SheetInspection.type，8 类） ---------------- */

/** 与 file/inspection.ts 的 SHEET_TYPE_LABEL 同口径（服务端模块不进客户端，这里复刻一份）。 */
export const FILE_TYPE_LABEL = {
  BOQ: "清单",
  QUOTATION: "询价表",
  GENERIC: "忽略",
  COMPARE: "对比表",
  APPROVAL: "报审资料",
  PENDING_QUOTE: "待报价清单",
  FACTS: "汇总/说明表",
  MATERIAL_PRICE: "材料价格表",
} as const;

export type FileType = keyof typeof FILE_TYPE_LABEL;

/** 类型下拉选项顺序：会导行的类型在前（照搬 ColumnMappingView / DatasetMappingPanel 原顺序）。 */
export const FILE_TYPE_OPTIONS: readonly FileType[] = [
  "BOQ", "PENDING_QUOTE", "QUOTATION", "MATERIAL_PRICE",
  "COMPARE", "APPROVAL", "FACTS", "GENERIC",
];

/* ---------------- 计价表分层（shared/types.FeeType） ---------------- */

/** 分部分项 | 单价措施 | 总价措施 | 其他项目（FeeType 原值即口径词，这里给单源出口）。 */
export const FEE_TYPE_LABEL: Record<FeeType, string> = {
  分部分项: "分部分项",
  单价措施: "单价措施",
  总价措施: "总价措施",
  其他项目: "其他项目",
};

/** 同上，带计价口径说明（新增行 / 下拉选项用，措辞与清单表新增行现有选项一致）。 */
export const FEE_TYPE_HINT: Record<FeeType, string> = {
  分部分项: "分部分项（量×价）",
  单价措施: "单价措施（量×价）",
  总价措施: "总价措施（只填金额）",
  其他项目: "其他项目（只填金额）",
};
