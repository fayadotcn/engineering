import { describe, expect, it } from "vitest";
import { findFeatureMismatch, findSameItemDifferentPrice } from "@cost-engine/compare";
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
