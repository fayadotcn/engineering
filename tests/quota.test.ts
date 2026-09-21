import { describe, expect, it } from "vitest";
import { calcQuota } from "../quota/service";
import type { QuotaEntry } from "../quota/library";
import type { BoqItemDTO } from "../shared/types";

// 专业语义回归：主材暂估价是组价输入；缺主材价时测算不完整、不算偏差。

const lib: QuotaEntry[] = [
  {
    code: "T-1", name: "镀锌钢管安装 DN100", unit: "10m", unitScale: 10,
    labor: 100, material: 20, machine: 5, mainQtyPerUnit: 1.02,
    match: { category: "管道" },
  },
];

const item = (o: Partial<BoqItemDTO> = {}): BoqItemDTO =>
  ({
    id: "i1", projectId: "p", fileId: null, sheetName: "s", rowIndex: 1,
    code: "", name: "镀锌钢管", rawFeature: "", unit: "m",
    quantity: "10", unitPrice: "50", mainMaterialPrice: "0",
    totalPrice: "500", feeType: "分部分项", sectionPath: "",
    isHeader: false, sortOrder: 0, discipline: "OTHER",
    features: { category: "管道" },
    ...o,
  }) as BoqItemDTO;

describe("calcQuota 组价语义", () => {
  it("清单项上的主材暂估价优先参与组价（询价/材料库之外的第一来源）", () => {
    const [r] = calcQuota([item({ mainMaterialPrice: "30" })], {
      lib, threshold: 0, mgmtRate: 0.16, profitRate: 0.09,
    });
    // 人工10 + 辅材2 + 机械0.5 + 主材30×1.02 + 费(10.5×0.25) = 10+2+0.5+30.6+2.625 = 45.725
    expect(r.needsMainPrice).toBe(false);
    expect(r.mainMaterial).toBe("30.6");
    expect(r.calcPrice).toBe("45.73");
    expect(r.deviation).not.toBeNull();
  });

  it("缺主材价：测算为不完整单价，不算偏差（缺主材的比价必然失真）", () => {
    const [r] = calcQuota([item()], { lib, threshold: 0 });
    expect(r.needsMainPrice).toBe(true);
    expect(r.deviation).toBeNull();
    expect(r.calcPrice).not.toBeNull(); // 人材机管利部分仍可看
  });

  it("主材暂估价优先于询价映射", () => {
    const [r] = calcQuota([item({ mainMaterialPrice: "99" })], {
      lib, threshold: 0, mainPrices: { "镀锌钢管|": 1 },
    });
    expect(r.mainMaterial).toBe("100.98"); // 99×1.02，而非 1×1.02
  });
});
