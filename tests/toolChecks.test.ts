import { describe, expect, it, vi } from "vitest";
import type { BoqItemDTO } from "@shared/types";

// 检查类工具（boq.find*）工具级冒烟：一个刻意污染的清单夹具触发全部
// 检查维度，验证 listBoq → 引擎 → anomalyView 的接线没断。

const db = vi.hoisted(() => ({ items: [] as BoqItemDTO[] }));

vi.mock("@boq/service", () => ({
  listBoq: vi.fn(async () => db.items),
  updateBoqItems: vi.fn(async (_p: string, patches: { id: string; patch: Record<string, unknown> }[]) => {
    const before = db.items.filter((i) => patches.some((p) => p.id === i.id));
    const after = before.map((b) => ({ ...b, ...patches.find((p) => p.id === b.id)!.patch }));
    return { before, after };
  }),
}));
vi.mock("@project/facts", () => ({
  getFacts: vi.fn(async () => []),
  getFact: vi.fn(async () => null),
  setFact: vi.fn(),
  loadFeeParams: vi.fn(async () => ({
    set: {}, coeffMeasureFee: { isZero: () => true, gt: () => false },
    regLaborBase: null,
  })),
  parseRateValue: (v: string) => { const m = String(v).match(/[\d.]+/); return m ? Number(m[0]) / (String(v).includes("%") ? 100 : 1) : null; },
  parseAmountValue: () => null,
  parseAreaValue: () => null,
}));
vi.mock("@project/service", () => ({
  createProject: vi.fn(async (name: string) => ({ id: "newp", name })),
}));
const quoteRows = vi.hoisted(() => ({ rows: [] as { materialName: string; spec: string; price: string; file: { filename: string; createdAt: Date }; createdAt: Date }[] }));
vi.mock("@database/client", () => ({
  prisma: {
    quotationItem: { findMany: vi.fn(async () => quoteRows.rows) },
    materialPrice: { findMany: vi.fn(async () => []) },
  },
}));

import "../agent/tools/boqTools";
import "../agent/tools/costTools";
import "../agent/tools/materialTools";
import "../agent/tools/projectTools";
import { getTool } from "../agent/tools/registry";

const ctx = { projectId: "p", runId: "r1", userId: "u", emit: vi.fn() };
const item = (over: Partial<BoqItemDTO> = {}): BoqItemDTO => ({
  id: Math.random().toString(36).slice(2, 8),
  projectId: "p",
  fileId: "f",
  sheetName: "s",
  rowIndex: 1,
  code: "",
  name: "项",
  rawFeature: "",
  unit: "m",
  quantity: "10",
  unitPrice: "100.00",
  mainMaterialPrice: "0.00",
  laborUnitPrice: "0.00",
  machineUnitPrice: "0.00",
  totalPrice: "1000.00",
  isHeader: false,
  feeType: "分部分项",
  discipline: "电气",
  unitProject: "",
  sectionPath: "",
  sortOrder: 0,
  features: {},
  rawCells: "{}",
  quantityExpr: "",
  pricingPlan: [],
  ...over,
} as BoqItemDTO);

// 污染清单：同组不同价 + 中位偏离 + 同码异名 + 缺码 + 非标码 + 算术错 + 单位不一致 + 负价
const FIXTURE: BoqItemDTO[] = [
  // 同语义组（同 category/spec/unit），价格离散 → sameItemDiffPrice + priceAnomaly
  item({ id: "a1", code: "030404017001", name: "配电箱", unit: "台", quantity: "2", unitPrice: "1500", totalPrice: "3000.00", features: { category: "配电箱" } }),
  item({ id: "a2", code: "030404017001", name: "配电箱", unit: "台", quantity: "3", unitPrice: "1800", totalPrice: "5400.00", features: { category: "配电箱" } }),
  item({ id: "a3", code: "030404017002", name: "配电箱", unit: "台", quantity: "1", unitPrice: "5000", totalPrice: "5000.00", features: { category: "配电箱" } }),
  // 同编码不同名 → codeNameMismatch
  item({ id: "b1", code: "030404017001", name: "照明配电箱", unit: "台", quantity: "1", unitPrice: "1600", totalPrice: "1600.00" }),
  // 缺编码 → missingCodes
  item({ id: "c1", name: "电缆敷设", unit: "m", quantity: "10", unitPrice: "50", totalPrice: "500.00" }),
  // 非标编码 → invalidCodes
  item({ id: "d1", code: "ABC-1", name: "阀门", unit: "个", quantity: "2", unitPrice: "80", totalPrice: "160.00" }),
  // 量×价≠合价 → arithmetic
  item({ id: "e1", code: "030411004001", name: "配管", unit: "m", quantity: "10", unitPrice: "100", totalPrice: "9999.00" }),
  // 同语义不同单位 → unitInconsistency（m vs km 量纲错位）
  item({ id: "f1", code: "030411003001", name: "桥架", unit: "m", quantity: "5", unitPrice: "50", totalPrice: "250.00", features: { category: "桥架" } }),
  item({ id: "f2", code: "030411003002", name: "桥架", unit: "km", quantity: "5", unitPrice: "50", totalPrice: "250.00", features: { category: "桥架" } }),
  // 负综合单价 → dataIssues
  item({ id: "g1", code: "030411003003", name: "支架", unit: "kg", quantity: "2", unitPrice: "-5", totalPrice: "-10.00" }),
];

type ToolResult = { observation: { count?: number; groups?: unknown[] }; views?: { kind: string; anomalyType?: string }[]; message?: string };
const run = (name: string, args: Record<string, unknown> = {}) =>
  getTool(name)!.handler!(ctx as never, args as never) as Promise<ToolResult>;

describe("检查类工具接线（boq.find*）", () => {
  it("findSameItemDifferentPrice 命中同组不同价", async () => {
    db.items = FIXTURE;
    const r = await run("boq.findSameItemDifferentPrice");
    expect(r.observation.count).toBeGreaterThan(0);
    expect(r.views?.[0].anomalyType).toBe("SAME_ITEM_DIFF_PRICE");
  });

  it("findPriceAnomalies 命中中位价离群", async () => {
    db.items = FIXTURE;
    const r = await run("boq.findPriceAnomalies");
    expect(r.observation.count).toBeGreaterThan(0);
    expect(r.views?.[0].anomalyType).toBe("PRICE_ANOMALY");
  });

  it("findCodeNameMismatch 命中一码多名", async () => {
    db.items = FIXTURE;
    const r = await run("boq.findCodeNameMismatch");
    expect(r.observation.count).toBeGreaterThan(0);
    expect(r.views?.[0].anomalyType).toBe("CODE_MISMATCH");
  });

  it("findMissingCodes 命中缺编码", async () => {
    db.items = FIXTURE;
    const r = await run("boq.findMissingCodes");
    expect(r.observation.count).toBeGreaterThan(0);
    expect(r.views?.[0].anomalyType).toBe("MISSING_CODE");
  });

  it("findInvalidCodes 命中非标编码", async () => {
    db.items = FIXTURE;
    const r = await run("boq.findInvalidCodes");
    expect(r.observation.count).toBeGreaterThan(0);
    expect(r.views?.[0].anomalyType).toBe("INVALID_CODE");
  });

  it("findArithmeticMismatches 命中合价算术错", async () => {
    db.items = FIXTURE;
    const r = await run("boq.findArithmeticMismatches");
    expect(r.observation.count).toBeGreaterThan(0);
    expect(r.views?.[0].anomalyType).toBe("ARITHMETIC");
  });

  it("findUnitInconsistencies 命中量纲不一致", async () => {
    db.items = FIXTURE;
    const r = await run("boq.findUnitInconsistencies");
    expect(r.observation.count).toBeGreaterThan(0);
    expect(r.views?.[0].anomalyType).toBe("UNIT_INCONSISTENT");
  });

  it("findDuplicateItems 命中同码同语义重复项", async () => {
    db.items = FIXTURE;
    const r = await run("boq.findDuplicateItems");
    expect(r.observation.count).toBeGreaterThan(0);
    expect(r.views?.[0].anomalyType).toBe("DUPLICATE");
  });

  it("findDataIssues 命中负综合单价", async () => {
    db.items = FIXTURE;
    const r = await run("boq.findDataIssues");
    expect(r.observation.count).toBeGreaterThan(0);
    expect(r.views?.[0].anomalyType).toBe("DATA_QUALITY");
  });

  it("findFeatureMismatch 命中同码异特征", async () => {
    db.items = [
      item({ id: "fm1", code: "030404017001", name: "配电箱", unit: "台", quantity: "1", unitPrice: "1500", totalPrice: "1500.00", features: { category: "配电箱", specification: "AL-1" } }),
      item({ id: "fm2", code: "030404017001", name: "配电箱", unit: "台", quantity: "1", unitPrice: "1500", totalPrice: "1500.00", features: { category: "配电箱", specification: "AL-9" } }),
    ];
    const r = await run("boq.findFeatureMismatch");
    expect(r.observation.count).toBeGreaterThan(0);
    expect(r.views?.[0].anomalyType).toBe("FEATURE_MISMATCH");
  });

  it("干净清单各检查均 0 命中且视图行空", async () => {
    db.items = [
      item({ id: "ok1", code: "030404017001", name: "配电箱", unit: "台", quantity: "2", unitPrice: "1500", totalPrice: "3000.00", features: { category: "配电箱" } }),
    ];
    for (const t of [
      "boq.findSameItemDifferentPrice", "boq.findPriceAnomalies", "boq.findCodeNameMismatch",
      "boq.findMissingCodes", "boq.findInvalidCodes", "boq.findArithmeticMismatches",
      "boq.findUnitInconsistencies", "boq.findDuplicateItems", "boq.findDataIssues",
    ]) {
      const r = await run(t);
      expect(r.observation.count, t).toBe(0);
    }
  });
});

describe("cost.* 聚合工具接线", () => {
  it("cost.aggregate 返回分部分项合计", async () => {
    db.items = FIXTURE;
    const r = await run("cost.aggregate");
    expect(Number(r.observation.total)).toBeGreaterThan(0);
  });

  it("cost.professionalBreakdown 出 breakdown 视图", async () => {
    db.items = FIXTURE;
    const r = await run("cost.professionalBreakdown") as ToolResult & { views: { kind: string }[] };
    expect(r.views[0].kind).toBe("breakdown");
  });

  it("cost.unitSummary 按单位工程分块", async () => {
    db.items = [
      item({ id: "u1", unitProject: "A栋", totalPrice: "100.00" }),
      item({ id: "u2", unitProject: "B栋", totalPrice: "200.00" }),
    ];
    const r = await run("cost.unitSummary") as ToolResult & { observation: { slices: { key: string }[] } };
    expect(r.observation.slices.map((s) => s.key).sort()).toEqual(["A栋", "B栋"]);
  });

  it("cost.materialBreakdown categories 过滤生效", async () => {
    db.items = FIXTURE;
    const r = await run("cost.materialBreakdown", { categories: ["配电箱"] }) as ToolResult & { observation: { slices: { label: string }[] } };
    expect(r.observation.slices.every((s) => s.label === "配电箱")).toBe(true);
  });

  it("cost.composition 出人材机构成视图", async () => {
    db.items = FIXTURE;
    const r = await run("cost.composition") as ToolResult & { views: { kind: string }[]; observation: { totals: { revenue: string } } };
    expect(r.views[0].kind).toBe("costComposition");
    expect(Number(r.observation.totals.revenue)).toBeGreaterThan(0);
  });
});

describe("quantity.calculate / quantity.adjust 守卫", () => {
  it("quantity.calculate 求值并支持 x 乘号记号", async () => {
    const r = await run("quantity.calculate", { expression: "3x12+5" });
    expect(r.observation.result ?? (r.observation as Record<string, unknown>).result).toBeTruthy();
    expect(r.message).toContain("41");
  });

  it("quantity.calculate 无效式返回错误观测而不是抛", async () => {
    const r = await run("quantity.calculate", { expression: "3米2米" });
    expect(String(r.observation.error)).toContain("计算式无效");
  });

  it("quantity.adjust 负目标总价被工具层拦截", async () => {
    db.items = FIXTURE;
    const r = await run("quantity.adjust", { targetTotal: -100, apply: true });
    expect(String((r.observation as { reason?: string }).reason)).toContain("非负");
  });
});

describe("project.* 工具接线", () => {
  it("project.summary 汇总行数与合价", async () => {
    db.items = FIXTURE;
    const r = await run("project.summary");
    expect(String(r.message)).toContain("清单");
  });

  it("project.create 走领域服务（名称校验+回执在 createProject 内）", async () => {
    const { createProject } = await import("@project/service");
    const r = await run("project.create", { name: "新工程" });
    expect(createProject).toHaveBeenCalledWith("新工程");
    expect((r.observation as { projectId: string }).projectId).toBe("newp");
  });
});

describe("material.getPriceHistory 接线", () => {
  it("同材料不同规格写法（4×35≡4x35）归并为一条价格轨迹", async () => {
    quoteRows.rows = [
      { materialName: "电力电缆", spec: "YJV-4x35", price: "120.00", file: { filename: "询价1.xlsx", createdAt: new Date("2024-01-01") }, createdAt: new Date("2024-01-01") },
      { materialName: "电力电缆", spec: "YJV-4×35", price: "125.00", file: { filename: "询价2.xlsx", createdAt: new Date("2024-03-01") }, createdAt: new Date("2024-03-01") },
    ];
    const r = await run("material.getPriceHistory", {}) as ToolResult & {
      observation: { materials: number; detail: { spec: string; points: unknown[] }[] };
    };
    expect(r.observation.materials).toBe(1);
    expect(r.observation.detail[0].points.length).toBe(2);
  });
});
