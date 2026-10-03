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
