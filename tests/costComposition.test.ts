import { describe, expect, it } from "vitest";
import { analyzeCostComposition } from "@cost-engine/costComposition";
import type { BoqItemDTO, PricingPlanLine } from "@shared/types";

const item = (patch: Partial<BoqItemDTO> = {}): BoqItemDTO => ({
  id: patch.id ?? "i1",
  projectId: "p1",
  fileId: null,
  sheetName: "s",
  rowIndex: 1,
  code: "",
  name: "镀锌钢管 DN100",
  rawFeature: "",
  unit: "m",
  quantity: "10",
  unitPrice: "100",
  mainMaterialPrice: "0",
  laborUnitPrice: "0",
  machineUnitPrice: "0",
  pricingPlan: [],
  totalPrice: "1000",
  feeType: "分部分项",
  sectionPath: "",
  isHeader: false,
  sortOrder: 0,
  discipline: "PLUMBING",
  features: {},
  ...patch,
});

const planLine = (patch: Partial<PricingPlanLine> = {}): PricingPlanLine => ({
  quotaCode: "5H0001",
  quotaName: "管道安装",
  labor: "10",
  materialAux: "5",
  machine: "2",
  fee: "4",
  mainMaterialName: "镀锌钢管",
  mainQty: "1.02",
  mainPrice: "50",
  subtotal: "72",
  ...patch,
});

describe("analyzeCostComposition", () => {
  it("组价方案项：四分量齐全，毛利=合价-人材机", () => {
    // 每单位: labor10 aux5 machine2 main=1.02*50=51 → direct=68/unit, qty10 → 680
    const r = analyzeCostComposition([item({ pricingPlan: [planLine()] })]);
    const row = r.rows[0];
    expect(row.source).toBe("quotaPlan");
    expect(row.labor).toBe("100.00");
    expect(row.machine).toBe("20.00");
    expect(row.material).toBe("560.00"); // (5 + 51) * 10
    expect(row.directCost).toBe("680.00");
    expect(row.margin).toBe("320.00");
    expect(row.marginRate).toBe("32.0");
    // other = 管利口径残差 = 1000-680 = 320
    expect(row.other).toBe("320.00");
    expect(row.inverted).toBe(false);
    expect(r.totals.marginRate).toBe("32.0");
    expect(r.coverage.plan).toBe(1);
  });

  it("组价方案缺主材价：材料不完整，margin 置空", () => {
    const r = analyzeCostComposition([
      item({ pricingPlan: [planLine({ mainQty: "1.02", mainPrice: null })] }),
    ]);
    const row = r.rows[0];
    expect(row.source).toBe("quotaPlan");
    expect(row.material).toBeNull();
    expect(row.margin).toBeNull();
    expect(row.directCost).toBeNull();
    expect(row.inverted).toBe(false);
  });

  it("建议增列行（suggested）不计入成本", () => {
    const r = analyzeCostComposition([
      item({ pricingPlan: [planLine(), planLine({ labor: "99", suggested: true })] }),
    ]);
    expect(r.rows[0].labor).toBe("100.00"); // 99 的 suggested 行不算
  });

  it("导入分解列：人工/机械已知，有主材价可算毛利", () => {
    // labor 8/unit, machine 3/unit, main 40/unit, qty 10 → direct=(8+40+3)*10=510
    const r = analyzeCostComposition([
      item({ laborUnitPrice: "8", machineUnitPrice: "3", mainMaterialPrice: "40" }),
    ]);
    const row = r.rows[0];
    expect(row.source).toBe("imported");
    expect(row.labor).toBe("80.00");
    expect(row.machine).toBe("30.00");
    expect(row.material).toBe("400.00");
    expect(row.margin).toBe("490.00");
    expect(r.coverage.imported).toBe(1);
  });

  it("导入分解列无主材价：材料未知入 other，不算毛利", () => {
    const r = analyzeCostComposition([
      item({ laborUnitPrice: "8", machineUnitPrice: "3" }),
    ]);
    const row = r.rows[0];
    expect(row.material).toBeNull();
    expect(row.other).toBe("890.00"); // 1000 - 80 - 30
    expect(row.margin).toBeNull();
  });

  it("仅主材暂估价：partial，材料一角已知", () => {
    const r = analyzeCostComposition([item({ mainMaterialPrice: "40" })]);
    const row = r.rows[0];
    expect(row.source).toBe("partial");
    expect(row.material).toBe("400.00");
    expect(row.labor).toBeNull();
    expect(row.other).toBe("600.00");
    expect(r.coverage.partial).toBe(1);
  });

  it("无任何成本数据：全额进 other，计入 none", () => {
    const r = analyzeCostComposition([item()]);
    const row = r.rows[0];
    expect(row.source).toBe("none");
    expect(row.other).toBe("1000.00");
    expect(r.totals.coveredRevenue).toBe("0.00");
    expect(r.coverage.none).toBe(1);
  });

  it("人材机 > 合价 → 成本倒挂", () => {
    const r = analyzeCostComposition([
      item({ laborUnitPrice: "60", machineUnitPrice: "50", unitPrice: "100" }),
    ]);
    const row = r.rows[0];
    // direct=(60+50)*10=1100 > 1000 → 倒挂；材料未知 → margin 空？directCost 需要 material
    expect(row.material).toBeNull();
    expect(row.margin).toBeNull();
    expect(row.inverted).toBe(false);
    // 主材价存在时才能算 directCost
    const r2 = analyzeCostComposition([
      item({ laborUnitPrice: "60", machineUnitPrice: "50", mainMaterialPrice: "5" }),
    ]);
    expect(r2.rows[0].directCost).toBe("1150.00");
    expect(r2.rows[0].margin).toBe("-150.00");
    expect(r2.rows[0].inverted).toBe(true);
    expect(r2.coverage.inverted).toBe(1);
  });

  it("总价措施/其他项目行不参与分解", () => {
    const r = analyzeCostComposition([
      item({ feeType: "总价措施", unitPrice: "0", totalPrice: "5000" }),
      item({ isHeader: true }),
      item({ laborUnitPrice: "8", machineUnitPrice: "3", mainMaterialPrice: "40" }),
    ]);
    expect(r.rows).toHaveLength(1);
    expect(r.totals.revenue).toBe("1000.00");
  });

  it("旧数据兜底：字段为 0 时从 rawCells 表头找回分解列", () => {
    const r = analyzeCostComposition([
      item({
        rawCells: { "项目编码": "0301", "人工费": "8", "机械费(C)": "3", "合价": "1000" },
      }),
    ]);
    const row = r.rows[0];
    expect(row.source).toBe("imported");
    expect(row.labor).toBe("80.00");
    expect(row.machine).toBe("30.00");
    // 显式字段优先于 rawCells
    const r2 = analyzeCostComposition([
      item({
        laborUnitPrice: "9",
        rawCells: { "人工费": "8" },
      }),
    ]);
    expect(r2.rows[0].labor).toBe("90.00");
    // 非数值/无关表头不兜底
    const r3 = analyzeCostComposition([
      item({ rawCells: { "人工费": "暂估", "备注": "人工" } }),
    ]);
    expect(r3.rows[0].source).toBe("none");
  });

  it("汇总口径：四分量加总=合价，毛利率按可算行收入计", () => {
    const r = analyzeCostComposition([
      item({ id: "a", pricingPlan: [planLine()] }), // margin 320 / rev 1000
      item({ id: "b", laborUnitPrice: "8", machineUnitPrice: "3" }), // margin 不可算
      item({ id: "c" }), // none
    ]);
    const t = r.totals;
    // labor100+0+0=100, material560+0+0=560, machine20+0+0=20
    // other: a=320, b=890, c=1000 → 2210；100+560+20+2210=2890=3000? a/b/c revenue 各1000
    expect(t.revenue).toBe("3000.00");
    const sum = ["labor", "material", "machine", "other"]
      .map((k) => Number(t[k as keyof typeof t]))
      .reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(3000, 2);
    expect(t.marginRevenue).toBe("1000.00");
    expect(t.margin).toBe("320.00");
    expect(t.marginRate).toBe("32.0");
  });
});
