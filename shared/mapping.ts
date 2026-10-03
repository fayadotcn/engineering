// Shared列映射辅助。零运行时依赖——客户端（ColumnMappingView）与服务端
//（excel.ts applyTypeHint / PATCH /mapping）共用同一套规则。

/**
 * 类型与单价角色对齐：清单里裸「单价」= 综合单价；询价表里单价 = price。
 * 分项成本价（材料/主材/人工/机械/询价 表头）不动；「报价」不挡——投标报价
 * 就是综合单价口径，询价表里它先升格也会由 unitPrice→price 还原。不改入参对象。
 */
export function reconcilePriceRole(
  type:
    | "BOQ" | "QUOTATION" | "GENERIC"
    | "COMPARE" | "APPROVAL" | "PENDING_QUOTE" | "FACTS" | "MATERIAL_PRICE",
  columns: Record<string, number>,
  headerCells: string[]
): {
  columns: Record<string, number>;
  moved: "price→unitPrice" | "unitPrice→price" | null;
} {
  const next = { ...columns };
  const hd = (i: number) => (headerCells[i] ?? "").replace(/\s+/g, "");
  if (type === "BOQ" || type === "PENDING_QUOTE") {
    if (
      next.price !== undefined &&
      next.unitPrice === undefined &&
      !/材料|主材|人工|机械|询价/.test(hd(next.price))
    ) {
      next.unitPrice = next.price;
      delete next.price;
      return { columns: next, moved: "price→unitPrice" };
    }
  } else if (type === "QUOTATION" || type === "MATERIAL_PRICE") {
    // 反向守卫：询价/价格表里「综合单价」列不是材料价（人材机管利组价结果），
    // 升格成 price 会污染价格库——脱映射落到原文区，由用户重新指认
    if (next.unitPrice !== undefined && /综合单价|综合价/.test(hd(next.unitPrice))) {
      delete next.unitPrice;
      return { columns: next, moved: null };
    }
    if (next.unitPrice !== undefined && next.price === undefined) {
      next.price = next.unitPrice;
      delete next.unitPrice;
      return { columns: next, moved: "unitPrice→price" };
    }
  }
  return { columns: next, moved: null };
}
