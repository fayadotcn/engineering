// Shared列映射辅助。零运行时依赖——客户端（ColumnMappingView）与服务端
//（excel.ts applyTypeHint / PATCH /mapping）共用同一套规则。

/**
 * 类型与单价角色对齐：清单里裸「单价」= 综合单价；询价表里单价 = price。
 * 分项成本价（材料/主材/人工/机械/询价/报价 表头）不动。不改入参对象。
 */
export function reconcilePriceRole(
  type: "BOQ" | "QUOTATION" | "GENERIC",
  columns: Record<string, number>,
  headerCells: string[]
): {
  columns: Record<string, number>;
  moved: "price→unitPrice" | "unitPrice→price" | null;
} {
  const next = { ...columns };
  const hd = (i: number) => (headerCells[i] ?? "").replace(/\s+/g, "");
  if (type === "BOQ") {
    if (
      next.price !== undefined &&
      next.unitPrice === undefined &&
      !/材料|主材|人工|机械|询价|报价/.test(hd(next.price))
    ) {
      next.unitPrice = next.price;
      delete next.price;
      return { columns: next, moved: "price→unitPrice" };
    }
  } else if (type === "QUOTATION") {
    if (next.unitPrice !== undefined && next.price === undefined) {
      next.price = next.unitPrice;
      delete next.unitPrice;
      return { columns: next, moved: "unitPrice→price" };
    }
  }
  return { columns: next, moved: null };
}
