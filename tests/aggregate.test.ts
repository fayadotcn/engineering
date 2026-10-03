import { describe, expect, it } from "vitest";
import { aggregateByUnitProject } from "@cost-engine/aggregate";
import type { BoqItemDTO } from "@shared/types";

let n = 0;
const row = (name: string, total: string, unitProject = ""): BoqItemDTO => ({
  id: `i${++n}`, projectId: "p", fileId: null, sheetName: "s", rowIndex: n,
  code: "", name, rawFeature: "", unit: "m", quantity: "1", unitPrice: total,
  mainMaterialPrice: "0", laborUnitPrice: "0", machineUnitPrice: "0", pricingPlan: [],
  feeType: "分部分项", totalPrice: total, sectionPath: "", isHeader: false,
  sortOrder: n, discipline: "OTHER", features: {}, unitProject,
});

describe("aggregateByUnitProject 单位工程费用汇总", () => {
  it("按单位工程分组求和并算占比，未注明的归入兜底组", () => {
    const { slices, total } = aggregateByUnitProject([
      row("A", "100", "一号楼"),
      row("B", "300", "一号楼"),
      row("C", "600", "二号楼"),
      row("D", "0"), // 未注明
    ]);
    expect(total.toString()).toBe("1000");
    expect(slices[0].key).toBe("二号楼");
    expect(slices[0].share).toBeCloseTo(0.6);
    const untagged = slices.find((s) => s.key === "未注明单位工程");
    expect(untagged?.count).toBe(1);
  });

  it("分部标题行不计入", () => {
    const h = row("电气分部", "0", "一号楼");
    h.isHeader = true;
    const { slices } = aggregateByUnitProject([h, row("A", "100", "一号楼")]);
    expect(slices).toHaveLength(1);
    expect(slices[0].amount).toBe("100.00");
  });
});
