import { describe, expect, it } from "vitest";
import { adjustToTarget } from "@cost-engine/adjust";
import { D, lineTotal, sum } from "@cost-engine/money";
import type { BoqItemDTO } from "@shared/types";

const item = (patch: Partial<BoqItemDTO>): BoqItemDTO => ({
  id: "item", projectId: "p", fileId: null, sheetName: "清单", rowIndex: 1, code: "", name: "安装",
  rawFeature: "", unit: "m", quantity: "10", unitPrice: "100", mainMaterialPrice: "0", pricingPlan: [],
  totalPrice: "1000", feeType: "分部分项", sectionPath: "", isHeader: false, sortOrder: 0, discipline: "OTHER", features: {}, ...patch,
});
const items = [item({}), item({ id: "fee", quantity: "0", unitPrice: "0", feeType: "总价措施", totalPrice: "200" }), item({ id: "other", quantity: "1", unitPrice: "50", totalPrice: "300", feeType: "其他项目" })];

describe("总价控制保留固定费用", () => {
  it.each(["price", "quantity"] as const)("%s 模式：固定措施和其他项目计入目标，实际写回可复核", field => {
    const r = adjustToTarget(items, { targetTotal: "1308", taxRate: ".09", field });
    expect(r.ok).toBe(true);
    expect(r.beforeTotal.toString()).toBe("1500");
    expect(r.afterTotal.toString()).toBe("1200");
    expect(r.adjustments.map(a => a.itemId)).toEqual(["item"]);
    const applied = items.map(i => {
      const adjustment = r.adjustments.find(a => a.itemId === i.id);
      return adjustment ? lineTotal(field === "quantity" ? adjustment.after : i.quantity, field === "price" ? adjustment.after : i.unitPrice) : D(i.totalPrice);
    });
    expect(sum(applied).eq(r.afterTotal)).toBe(true);
  });

  it("指定范围仍不能调整总额计价行，空范围不会默认调整全部", () => {
    for (const allowedItemIds of [[], ["fee", "other"]]) {
      const r = adjustToTarget(items, { targetTotal: "1200", allowedItemIds });
      expect(r.ok).toBe(false); expect(r.adjustments).toEqual([]);
      expect(r.beforeTotal.toString()).toBe("1500");
    }
  });

  it("目标低于固定费用时拒绝产生负单价", () => {
    const r = adjustToTarget(items, { targetTotal: "400" });
    expect(r.ok).toBe(false); expect(r.adjustments).toEqual([]);
    expect(r.reason).toContain("低于不可调整项");
  });
});
