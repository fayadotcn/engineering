import { describe, expect, it } from "vitest";
import { findDataIssues, findDuplicateItems, findFeatureMismatch, findSameItemDifferentPrice } from "@cost-engine/compare";
import { parseSemanticFeature, inferDiscipline } from "@cost-engine/semantic";
import type { BoqItemDTO } from "@shared/types";

let n = 0;
const item = (
  name: string,
  feature: string,
  unit: string,
  qty: string,
  price: string,
  code = ""
): BoqItemDTO => ({
  id: `i${++n}`,
  projectId: "p",
  fileId: null,
  sheetName: "s",
  rowIndex: n,
  code,
  name,
  rawFeature: feature,
  unit,
  quantity: qty,
  unitPrice: price,
  mainMaterialPrice: "0", laborUnitPrice: "0", machineUnitPrice: "0",
  pricingPlan: [],
  feeType: "分部分项",
  totalPrice: (parseFloat(qty) * parseFloat(price)).toFixed(2),
  sectionPath: "",
  isHeader: false,
  sortOrder: n,
  discipline: inferDiscipline(name, feature, ""),
  features: parseSemanticFeature(name, feature),
});

describe("findSameItemDifferentPrice", () => {
  it("flags same semantic item with different prices", () => {
    const items = [
      item("镀锌钢管", "DN100 沟槽连接 室内消防", "m", "120", "85.00"),
      item("镀锌钢管", "DN100 沟槽连接 室内消防给水", "m", "80", "92.50"),
      item("镀锌钢管", "DN150 沟槽连接", "m", "60", "120.00"),
    ];
    const rows = findSameItemDifferentPrice(items);
    expect(rows.length).toBe(1);
    expect(rows[0].items.length).toBe(2);
    expect(rows[0].prices.sort()).toEqual(["85", "92.5"].sort());
  });

  it("ignores zero-quantity items", () => {
    const items = [
      item("镀锌钢管", "DN100 沟槽连接", "m", "120", "85.00"),
      item("镀锌钢管", "DN100 沟槽连接", "m", "0", "999.00"),
    ];
    expect(findSameItemDifferentPrice(items).length).toBe(0);
  });

  it("does not merge different specs", () => {
    const items = [
      item("镀锌钢管", "DN100 沟槽连接", "m", "10", "85"),
      item("镀锌钢管", "DN65 沟槽连接", "m", "10", "55"),
    ];
    expect(findSameItemDifferentPrice(items).length).toBe(0);
  });
});

describe("findFeatureMismatch", () => {
  it("flags same code with conflicting features", () => {
    const items = [
      item("镀锌钢管", "DN100 沟槽连接", "m", "10", "85", "031001001001"),
      item("镀锌钢管", "DN100 螺纹连接", "m", "10", "85", "031001001001"),
    ];
    const rows = findFeatureMismatch(items);
    expect(rows.length).toBe(1);
    expect(rows[0].reason).toContain("connectionMethod");
  });
});

describe("findArithmeticMismatches（清标算术校验）", () => {
  it("flags 合价 ≠ 量×价 的可计价行，差额汇总进 spread", async () => {
    const { findArithmeticMismatches } = await import("@cost-engine/compare");
    const a = item("钢管", "DN100", "m", "10", "85");
    a.totalPrice = "999.99"; // 源表合价错误：应 850
    const b = item("阀门", "DN50", "个", "4", "100"); // 400 正确
    const rows = findArithmeticMismatches([a, b]);
    expect(rows).toHaveLength(1);
    expect(rows[0].items.map((x) => x.id)).toEqual([a.id]);
    expect(Number(rows[0].spread)).toBeCloseTo(149.99);
  });

  it("未报价/零量行与总额计价行不算算术错", async () => {
    const { findArithmeticMismatches } = await import("@cost-engine/compare");
    const unpriced = item("钢管", "DN100", "m", "10", "0");
    unpriced.totalPrice = "123"; // 单价 0 的未报价行，合价原值保留不报
    const lump = item("安全文明施工费", "", "项", "0", "0");
    lump.feeType = "总价措施"; lump.totalPrice = "5000";
    expect(findArithmeticMismatches([unpriced, lump])).toHaveLength(0);
  });

  it("分分钱舍入噪声不报（容差 0.02 元或 0.1%）", async () => {
    const { findArithmeticMismatches } = await import("@cost-engine/compare");
    const a = item("电缆", "YJV", "m", "3.333", "10.01");
    a.totalPrice = "33.36"; // 量×价=33.363→33.36 容差内
    const b = item("电缆", "YJV", "m", "10000", "0.33");
    b.totalPrice = "3300.01"; // 差 0.01 < 0.02
    expect(findArithmeticMismatches([a, b])).toHaveLength(0);
  });
});

describe("单位归一化与 findUnitInconsistencies", () => {
  it("米/m 同义归一：相同项跨表写法不一致仍同组比价", () => {
    const items = [
      item("电力电缆", "YJV-4×35+1×16", "m", "100", "120"),
      item("电力电缆", "YJV-4×35+1×16", "米", "50", "150"),
    ];
    const rows = findSameItemDifferentPrice(items);
    expect(rows.length).toBe(1);
  });

  it("m vs km（量纲不同）→ 单位不一致报警", async () => {
    const { findUnitInconsistencies } = await import("@cost-engine/compare");
    const items = [
      item("电力电缆", "YJV-4×35+1×16", "m", "100", "120"),
      item("电力电缆", "YJV-4×35+1×16", "km", "0.1", "120000"),
    ];
    const rows = findUnitInconsistencies(items);
    expect(rows.length).toBe(1);
    expect(rows[0].reason).toContain("m");
    expect(rows[0].reason).toContain("km");
  });

  it("米 vs m 同义 → 不报单位不一致", async () => {
    const { findUnitInconsistencies } = await import("@cost-engine/compare");
    const items = [
      item("电力电缆", "YJV-4×35", "米", "100", "120"),
      item("电力电缆", "YJV-4×35", "m", "50", "120"),
    ];
    expect(findUnitInconsistencies(items).length).toBe(0);
  });

  it("不同特征不合并：DN100钢管m 与 DN200钢管m 不算单位不一致", async () => {
    const { findUnitInconsistencies } = await import("@cost-engine/compare");
    const items = [
      item("镀锌钢管", "DN100", "m", "100", "85"),
      item("镀锌钢管", "DN200", "m", "50", "160"),
    ];
    expect(findUnitInconsistencies(items).length).toBe(0);
  });
});

describe("findCodeNameMismatch（一码多名）", () => {
  it("同编码不同名称 → 编码错用", async () => {
    const { findCodeNameMismatch } = await import("@cost-engine/compare");
    const items = [
      item("镀锌钢管", "DN100", "m", "10", "85", "031001001001"),
      item("闸阀", "DN100", "个", "4", "320", "031001001001"),
    ];
    const rows = findCodeNameMismatch(items);
    expect(rows.length).toBe(1);
    expect(rows[0].items.length).toBe(2);
    expect(rows[0].reason).toContain("唯一");
  });

  it("同编码同名称（清单分行正常）不报", async () => {
    const { findCodeNameMismatch } = await import("@cost-engine/compare");
    const items = [
      item("镀锌钢管", "DN100", "m", "10", "85", "031001001001"),
      item("镀锌钢管", "DN100", "m", "20", "85", "031001001001"),
    ];
    expect(findCodeNameMismatch(items).length).toBe(0);
  });
});

describe("findInvalidCodes（非标编码）", () => {
  it("非 12 位数字编码被标出（自编补码/缺位）", async () => {
    const { findInvalidCodes } = await import("@cost-engine/compare");
    const items = [
      item("镀锌钢管", "DN100", "m", "10", "85", "031001001001"),
      item("临时支吊架", "", "项", "1", "500", "补-001"),
      item("灭火器", "MF/ABC4", "具", "20", "85", "030901"),          // 缺位
      item("配电箱", "", "台", "2", "8500", ""),                     // 空编码不报（手工补录行常见）
    ];
    const rows = findInvalidCodes(items);
    expect(rows.length).toBe(1);
    expect(rows[0].items.length).toBe(2);
    expect(rows[0].reason).toContain("12 位");
  });

  it("全 12 位编码不报", async () => {
    const { findInvalidCodes } = await import("@cost-engine/compare");
    const items = [item("镀锌钢管", "DN100", "m", "10", "85", "031001001001")];
    expect(findInvalidCodes(items).length).toBe(0);
  });
});

describe("findMissingCodes（缺编码）", () => {
  it("分部分项/单价措施无编码被标出，总价措施不报", async () => {
    const { findMissingCodes } = await import("@cost-engine/compare");
    const ok = item("安全文明施工费", "", "项", "1", "12000", "");
    ok.feeType = "总价措施";
    const items = [
      item("镀锌钢管", "DN100", "m", "10", "85", ""),          // 缺编码 → 报
      item("闸阀", "DN100", "个", "4", "320", "031001001001"), // 有编码
      ok,                                                    // 总价措施无编码 → 不报
    ];
    const rows = findMissingCodes(items);
    expect(rows.length).toBe(1);
    expect(rows[0].items.length).toBe(1);
    expect(rows[0].items[0].name).toBe("镀锌钢管");
  });
});

describe("findDataIssues", () => {
  const mk = (over: Partial<BoqItemDTO>): BoqItemDTO => ({
    id: "x", projectId: "p", fileId: "f", sheetName: "s", rowIndex: 1,
    code: "031001001001", name: "钢管", rawFeature: "", unit: "m",
    quantity: "10", quantityExpr: null, unitPrice: "50", mainMaterialPrice: null,
    laborUnitPrice: null, machineUnitPrice: null, pricingPlan: null,
    totalPrice: "500", feeType: "分部分项", sectionPath: "", unitProject: "",
    taxIncluded: false, isHeader: false, sortOrder: 0, discipline: "",
    features: { category: null, material: null, diameter: null, specification: null, power: null, connectionMethod: null, system: null, keywords: [] },
    rawCells: {},
    ...over,
  } as BoqItemDTO);

  it("负单价/负量/缺单位分别成组", () => {
    const rows = findDataIssues([
      mk({ id: "a", unitPrice: "-5", totalPrice: "-50" }),
      mk({ id: "b", quantity: "-3" }),
      mk({ id: "c", unit: "" }),
      mk({ id: "ok" }),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0].items[0].id).toBe("a");
    expect(rows[1].items[0].id).toBe("b");
    expect(rows[2].items[0].id).toBe("c");
  });

  it("总价措施行负单价不算数据问题（无量价结构）", () => {
    const rows = findDataIssues([mk({ feeType: "总价措施", unitPrice: "-100", unit: "" })]);
    expect(rows).toHaveLength(0);
  });
});

describe("findDuplicateItems", () => {
  const code = "030404017001";
  it("同一单位工程内同编码同特征 → 重复项", () => {
    const rows = findDuplicateItems([
      item("配电箱", "AL1", "台", "2", "8500", code),
      item("配电箱", "AL1", "台", "3", "8500", code),
    ]);
    expect(rows).toHaveLength(1);
  });

  it("不同单位工程各列一条同编码 → 不算重复（多栋楼各自列项）", () => {
    const a = item("配电箱", "AL1", "台", "2", "8500", code);
    const b = item("配电箱", "AL1", "台", "3", "8500", code);
    a.unitProject = "1#楼";
    b.unitProject = "2#楼";
    expect(findDuplicateItems([a, b])).toHaveLength(0);
  });
});

describe("findPriceAnomalies", () => {
  it("组内≥3项时偏离中位价>15%的项被标出", async () => {
    const { findPriceAnomalies } = await import("@cost-engine/compare");
    const items = [
      item("镀锌钢管", "DN100 沟槽连接", "m", "10", "100.00"),
      item("镀锌钢管", "DN100 沟槽连接", "m", "20", "105.00"),
      item("镀锌钢管", "DN100 沟槽连接", "m", "30", "98.00"),
      item("镀锌钢管", "DN100 沟槽连接", "m", "40", "150.00"), // +47% 离中位 101.5
    ];
    const rows = findPriceAnomalies(items);
    expect(rows.length).toBe(1);
    expect(rows[0].items.map((i) => i.unitPrice)).toContain("150.00");
  });

  it("偏离≤15%不报；组内<3项不报", async () => {
    const { findPriceAnomalies } = await import("@cost-engine/compare");
    expect(findPriceAnomalies([
      item("镀锌钢管", "DN100 沟槽连接", "m", "10", "100.00"),
      item("镀锌钢管", "DN100 沟槽连接", "m", "20", "110.00"),
      item("镀锌钢管", "DN100 沟槽连接", "m", "30", "95.00"),
    ]).length).toBe(0);
    expect(findPriceAnomalies([
      item("镀锌钢管", "DN100 沟槽连接", "m", "10", "100.00"),
      item("镀锌钢管", "DN100 沟槽连接", "m", "20", "500.00"),
    ]).length).toBe(0);
  });
});
