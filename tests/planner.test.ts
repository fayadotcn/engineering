import { describe, expect, it, vi } from "vitest";
import { RulePlanner, type PlanStep } from "../agent/planner";
import type { RunContext } from "../agent/context";
import type { ToolResult } from "../agent/tools/registry";
import type { BoqItemDTO } from "../shared/types";

// 比例调价路由：「总价下浮5%」「电缆单价下浮5%」「管道工程量上浮3个点」。
// 动态步需要 listBoq —— mock 出两条可计价行验证范围锁定与目标价换算。

vi.mock("@boq/service", () => ({
  listBoq: vi.fn(async () => [
    {
      id: "i1", name: "电力电缆敷设", rawFeature: "YJV-4x25", unitPrice: "100",
      quantity: "10", totalPrice: "1000.00", isHeader: false, feeType: "分部分项",
      features: { category: "电缆" },
    },
    {
      id: "i2", name: "镀锌钢管", rawFeature: "DN100", unitPrice: "200",
      quantity: "10", totalPrice: "2000.00", isHeader: false, feeType: "分部分项",
      features: { category: "管道" },
    },
    {
      id: "h1", name: "电气工程", rawFeature: "", unitPrice: "0",
      quantity: "0", totalPrice: "0", isHeader: true, feeType: "分部分项",
      features: {},
    },
  ] as BoqItemDTO[]),
}));

const ctx = (facts: { key: string; value: string }[] = []): RunContext => ({
  projectId: "p1",
  projectName: "测试工程",
  files: [],
  facts: facts.map((f) => ({ ...f, source: "USER_PROVIDED" })),
  boq: { itemCount: 2, pricedCount: 2, totalAmount: "3000.00" },
  quotationCount: 0,
  recentChanges: [],
  history: [],
});

const plan = (m: string, facts?: { key: string; value: string }[]) =>
  new RulePlanner().plan(ctx(facts), m);

const resolve = async (
  step: PlanStep | ((r: ToolResult[]) => Promise<PlanStep | null> | PlanStep | null),
  results: ToolResult[] = []
): Promise<PlanStep | null> => (typeof step === "function" ? step(results) : step);

describe("总价按比例调整路由（下浮/上浮 %）", () => {
  it("「总价下浮5%」→ 先取总价再反算（默认调综合单价）", async () => {
    const p = await plan("总价下浮5%");
    expect(p.steps).toHaveLength(2);
    const s0 = await resolve(p.steps[0]);
    expect(s0?.tool).toBe("cost.calculate");
    const s1 = await resolve(p.steps[1], [{ observation: { exclTax: "1000.00", inclTax: null } }]);
    expect(s1?.tool).toBe("quantity.adjust");
    expect(s1?.args.targetTotal).toBe(950);
    expect(s1?.args.apply).toBe(true);
    expect(s1?.args.taxRate).toBe(0);
  });

  it("「含税总价上浮3个点」→ 含税基准 ×1.03，税率走台账", async () => {
    const p = await plan("含税总价上浮3个点", [{ key: "税率", value: "9%" }]);
    const s1 = await resolve(p.steps[1], [{ observation: { exclTax: "1000.00", inclTax: "1090.00" } }]);
    expect(s1?.args.targetTotal).toBeCloseTo(1122.7);
    expect(s1?.args.taxRate).toBeCloseTo(0.09);
  });

  it("含税但台账无税率：inclTax 为空时按 exclTax×(1+9%) 反推基准", async () => {
    const p = await plan("含税总价下浮10%");
    const s1 = await resolve(p.steps[1], [{ observation: { exclTax: "1000.00", inclTax: null } }]);
    // 基准 = 1000 × 1.09 = 1090，下浮 10% → 981
    expect(s1?.args.targetTotal).toBeCloseTo(981);
    expect(s1?.args.taxRate).toBeCloseTo(0.09);
  });
});

describe("范围化比例调整（类别/名称词锁范围）", () => {
  it("「电缆单价下浮5%」→ 只调电缆项，目标价=总合计−电缆合计×5%", async () => {
    const p = await plan("电缆单价下浮5%");
    const s = await resolve(p.steps[0]);
    expect(s?.tool).toBe("quantity.adjust");
    expect(s?.args.allowedItemIds).toEqual(["i1"]);
    expect(s?.args.mode).toBe("price");
    // allTotal 3000 − subtotal 1000×5% = 2950
    expect(s?.args.targetTotal).toBe(2950);
  });

  it("「管道工程量上浮10%」→ mode=quantity，范围=管道类", async () => {
    const p = await plan("管道工程量上浮10%");
    const s = await resolve(p.steps[0]);
    expect(s?.args.mode).toBe("quantity");
    expect(s?.args.allowedItemIds).toEqual(["i2"]);
    expect(s?.args.targetTotal).toBe(3200);
  });

  it("「所有单价下浮5%」→ 全量，不带 allowedItemIds", async () => {
    const p = await plan("所有单价统一下浮5%");
    const s = await resolve(p.steps[0]);
    expect(s?.tool).toBe("quantity.adjust");
    expect(s?.args.allowedItemIds).toBeUndefined();
    expect(s?.args.targetTotal).toBe(2850);
  });

  it("范围词没命中任何清单项 → 不出步骤，提示找不到", async () => {
    const p = await plan("桥架单价下浮5%");
    const s = await resolve(p.steps[0]);
    expect(s).toBeNull();
    expect(p.fallbackMessage).toContain("桥架");
  });

  it("「综合单价下浮5%」（无范围词）→ 全量，「综合」不被误当范围", async () => {
    const p = await plan("综合单价下浮5%");
    const s = await resolve(p.steps[0]);
    expect(s?.tool).toBe("quantity.adjust");
    expect(s?.args.allowedItemIds).toBeUndefined();
  });
});

describe("单方造价指标路由", () => {
  it("「单方造价是多少」→ cost.feeSummary（带面积指标）", async () => {
    const p = await plan("这个项目单方造价是多少");
    const s = await resolve(p.steps[0]);
    expect(s?.tool).toBe("cost.feeSummary");
  });
  it("「建筑面积设为12000㎡」→ project.setFact", async () => {
    const p = await plan("建筑面积设为12000㎡");
    const s = await resolve(p.steps[0]);
    expect(s?.tool).toBe("project.setFact");
    expect(s?.args).toMatchObject({ key: "建筑面积" });
  });

  it("「单方造价控制到500元/㎡」→ 按面积换算目标总价反算", async () => {
    const p = await plan("单方造价控制到500元/㎡", [{ key: "建筑面积", value: "12000" }]);
    const s = await resolve(p.steps[0]);
    expect(s?.tool).toBe("quantity.adjust");
    expect(s?.args.targetTotal).toBe(6000000);
    expect(s?.args.apply).toBe(true);
  });

  it("单方造价反算但无建筑面积事实 → 不出步骤，提示先填面积", async () => {
    const p = await plan("单方造价控制到500元/㎡");
    expect(p.steps).toHaveLength(0);
    expect(p.fallbackMessage).toContain("建筑面积");
  });

  it("「单方造价500元/㎡合理吗」→ 询问不是调价，走 feeSummary", async () => {
    const p = await plan("单方造价500元/㎡合理吗");
    const s = await resolve(p.steps[0]);
    expect(s?.tool).toBe("cost.feeSummary");
  });
});

describe("类别词修饰造价/费用的范围化比例调整", () => {
  it("「电缆造价下浮5%」→ 只调电缆项（allowedItemIds），不是整体总价", async () => {
    const p = await plan("电缆造价下浮5%");
    const s = await resolve(p.steps[0]);
    expect(s?.tool).toBe("quantity.adjust");
    expect(s?.args.allowedItemIds).toEqual(["i1"]);
    // allTotal 3000 − 电缆小计 1000×5% = 2950
    expect(s?.args.targetTotal).toBe(2950);
  });

  it("「含税总价下浮5%」剥前缀后无类别词 → 仍走整体反算", async () => {
    const p = await plan("含税总价下浮5%");
    const s0 = await resolve(p.steps[0]);
    expect(s0?.tool).toBe("cost.calculate");
    const s1 = await resolve(p.steps[1], [{ observation: { exclTax: "1000.00", inclTax: null } }]);
    expect(s1?.args.allowedItemIds).toBeUndefined();
  });

  it.each(["校验量价合价", "检查合价是否算错", "做一下算术校验", "帮我清标"])(
    "「%s」→ boq.findArithmeticMismatches",
    async (text) => {
      const p = await plan(text);
      const s = await resolve(p.steps[0]);
      expect(s?.tool).toBe("boq.findArithmeticMismatches");
    },
  );
});

describe("单位工程费用汇总路由", () => {
  it.each(["各单位工程费用汇总", "各单位工程占比", "按单位工程汇总多少钱"])(
    "「%s」→ cost.unitSummary",
    async (text) => {
      const p = await plan(text);
      const s = await resolve(p.steps[0]);
      expect(s?.tool).toBe("cost.unitSummary");
    },
  );
});

describe("删除清单项路由", () => {
  it("「删除配电箱项」→ boq.search 定位 → boq.deleteItems", async () => {
    const p = await plan("删除配电箱项");
    const s0 = await resolve(p.steps[0]);
    expect(s0?.tool).toBe("boq.search");
    const s1 = await resolve(p.steps[1], [{ observation: [{ id: "x1" }, { id: "x2" }] }]);
    expect(s1?.tool).toBe("boq.deleteItems");
    expect(s1?.args.ids).toEqual(["x1", "x2"]);
  });

  it("搜索无命中 → 不出删除步骤", async () => {
    const p = await plan("删除不存在的某某项");
    const s1 = await resolve(p.steps[1], [{ observation: [] }]);
    expect(s1).toBeNull();
  });

  it("「删除重复项」不进删除路由（删谁有歧义）", async () => {
    const p = await plan("删除重复项");
    const tools = [];
    for (const s of p.steps) tools.push((await resolve(s, [{ observation: [] }]))?.tool);
    expect(tools).not.toContain("boq.deleteItems");
  });
});

describe("补录清单项路由", () => {
  it("「补录 灭火器 20个 单价85元」→ boq.addItem", async () => {
    const p = await plan("补录 灭火器 20个 单价85元");
    const s = await resolve(p.steps[0]);
    expect(s?.tool).toBe("boq.addItem");
    expect(s?.args).toMatchObject({ name: "灭火器", quantity: "20", unit: "个", unitPrice: "85" });
  });
  it("缺数量/单价 → 不给步骤只回格式提示", async () => {
    const p = await plan("补录 灭火器");
    expect(p.steps).toHaveLength(0);
    expect(p.fallbackMessage).toContain("补录格式");
  });
});

describe("补录总额计价项", () => {
  it("「补录总价措施 安全文明施工费 12000元」→ feeType+totalPrice", async () => {
    const p = await plan("补录总价措施 安全文明施工费 12000元");
    const s = await resolve(p.steps[0]);
    expect(s?.tool).toBe("boq.addItem");
    expect(s?.args).toMatchObject({ name: "安全文明施工费", feeType: "总价措施", totalPrice: "12000" });
  });
  it("「补录其他项目 暂列金额 5万元」→ 万换算为 50000", async () => {
    const p = await plan("补录其他项目 暂列金额 5万元");
    const s = await resolve(p.steps[0]);
    expect(s?.args).toMatchObject({ name: "暂列金额", feeType: "其他项目", totalPrice: "50000" });
  });
  it("无类型词但名称像措施费 → 默认总价措施", async () => {
    const p = await plan("补录 夜间施工增加费 8000");
    const s = await resolve(p.steps[0]);
    expect(s?.args).toMatchObject({ name: "夜间施工增加费", feeType: "总价措施", totalPrice: "8000" });
  });
});

describe("非标编码检查路由", () => {
  it.each(["检查清单编码格式", "有没有非标编码", "查一下自编编码", "编码是不是12位"])(
    "「%s」→ boq.findInvalidCodes", async (m) => {
      const p = await plan(m);
      const s = await resolve(p.steps[0]);
      expect(s?.tool).toBe("boq.findInvalidCodes");
    }
  );
});

describe("缺编码检查路由", () => {
  it.each(["哪些项缺编码", "有没有没编码的清单项", "检查编码是否缺失"])(
    "「%s」→ boq.findMissingCodes", async (m) => {
      const p = await plan(m);
      const s = await resolve(p.steps[0]);
      expect(s?.tool).toBe("boq.findMissingCodes");
    }
  );
  it("「有没有非标编码」仍走非标编码而非缺编码", async () => {
    const p = await plan("有没有非标编码");
    const s = await resolve(p.steps[0]);
    expect(s?.tool).toBe("boq.findInvalidCodes");
  });
});

describe("甲供材核对路由", () => {
  it.each(["核对甲供材", "甲供材有没有重复计价", "发包人供货的材料检查一遍"])(
    "「%s」→ material.checkOwnerSupplied", async (m) => {
      const p = await plan(m);
      const s = await resolve(p.steps[0]);
      expect(s?.tool).toBe("material.checkOwnerSupplied");
    }
  );
});

describe("检查并导出路由", () => {
  it("「全面检查清单并导出清单Excel」→ 先检查再导出", async () => {
    const p = await plan("全面检查清单并导出清单Excel");
    expect(p.steps).toHaveLength(2);
    expect((await resolve(p.steps[0]))?.tool).toBe("boq.compare");
    expect((await resolve(p.steps[1]))?.tool).toBe("report.exportExcel");
  });
  it("纯「导出Excel」不前置检查", async () => {
    const p = await plan("导出Excel");
    expect(p.steps).toHaveLength(1);
    expect((await resolve(p.steps[0]))?.tool).toBe("report.exportExcel");
  });
});

describe("甲供材扣减路由", () => {
  it.each(["扣减甲供材已计的主材价", "甲供材不要计价", "把甲供材的主材价清零"])(
    "「%s」→ material.clearOwnerSuppliedPrice", async (m) => {
      const p = await plan(m);
      const s = await resolve(p.steps[0]);
      expect(s?.tool).toBe("material.clearOwnerSuppliedPrice");
    }
  );
});

describe("编码修正路由", () => {
  it("「把配电箱的编码改为030404017001」→ boq.update 只改命中的项", async () => {
    const p = await plan("把镀锌钢管的编码改为031001001001");
    const s = await resolve(p.steps[0]);
    expect(s?.tool).toBe("boq.update");
    expect(s?.args.patches).toEqual([{ id: "i2", code: "031001001001" }]);
  });

  it("「给电缆补编码031202001001」→ boq.update 编码补丁", async () => {
    const p = await plan("给电力电缆补编码031202001001");
    const s = await resolve(p.steps[0]);
    expect(s?.tool).toBe("boq.update");
    expect(s?.args.patches).toEqual([{ id: "i1", code: "031202001001" }]);
  });

  it("「查非标编码」走检查路由不被修正路由截胡", async () => {
    const p = await plan("查一下有没有非标编码");
    const s = await resolve(p.steps[0]);
    expect(s?.tool).toBe("boq.findInvalidCodes");
  });
});

describe("主材暂估价设值路由", () => {
  it("「电缆主材暂估价设为45」→ boq.update 写 mainMaterialPrice 不动综合单价", async () => {
    const p = await plan("电力电缆的主材暂估价设为45");
    const s = await resolve(p.steps[0]);
    expect(s?.tool).toBe("boq.update");
    expect(s?.args.patches).toEqual([{ id: "i1", mainMaterialPrice: "45.00" }]);
  });

  it("「把电缆单价改为5元」仍走 unitPrice 不被截胡", async () => {
    const p = await plan("电力电缆单价改为5元");
    const s = await resolve(p.steps[p.steps.length - 1]);
    expect(s?.tool).toBe("boq.update");
    expect((s?.args.patches as { unitPrice?: string }[] | undefined)?.[0]?.unitPrice).toBe("5.00");
  });
});
