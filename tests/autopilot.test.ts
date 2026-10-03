import { describe, expect, it, vi } from "vitest";
import { RulePlanner, type PlanStep } from "../agent/planner";
import type { RunContext } from "../agent/context";
import type { ToolResult } from "../agent/tools/registry";

// applyCalc 门槛步在运行时重查台账：测试用 hoisted 表模拟（含本条消息内联写入的费率）
const dbFacts = vi.hoisted(() => ({ current: [] as { key: string; value: string }[] }));
vi.mock("@project/facts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@project/facts")>();
  return { ...orig, getFacts: vi.fn(async () => dbFacts.current.map((f) => ({ ...f, source: "USER_PROVIDED" }))) };
});

// 一键报价（autopilot）：确定性管线计划的形状与动态跳步逻辑。
// 不跑真实工具，只断言产出的步骤序列和动态函数对观测的反应。

const ctx = (facts: { key: string; value: string }[], itemCount = 12): RunContext => {
  dbFacts.current = facts; // 台账与上下文一致（含 prefSteps 已写入的场景由测试显式设置）
  return {
    projectId: "p1",
    projectName: "测试工程",
    files: [],
    facts: facts.map((f) => ({ ...f, source: "USER_PROVIDED" })),
    boq: { itemCount, pricedCount: 0, totalAmount: "0.00" },
    quotationCount: 0,
    recentChanges: [],
    history: [],
  };
};

const rates = [
  { key: "管理费率", value: "30%" },
  { key: "利润率", value: "10%" },
];

const toolSeq = async (steps: Awaited<ReturnType<RulePlanner["plan"]>>["steps"], observations: Record<string, unknown>[] = []) => {
  const seq: string[] = [];
  const results: ToolResult[] = [];
  for (const step of steps) {
    const resolved: PlanStep | null = typeof step === "function" ? await step(results) : step;
    if (!resolved) continue;
    seq.push(resolved.tool);
    results.push({ observation: observations[seq.length - 1] ?? {} });
  }
  return seq;
};

describe("autopilot 一键报价管线", () => {
  it("费率齐全：补价→匹配→测算→写回→措施费→汇总 全链路", async () => {
    const plan = await new RulePlanner().plan(ctx(rates), "一键智能报价", { autopilot: true });
    const seq = await toolSeq(plan.steps, [
      { matched: 5 },            // material.matchLibrary 命中
      { applied: 5 },            // material.fillFromLibrary
      { matched: 10 },           // quota.match
      { matched: 10, needsMainPrice: 1 }, // quota.calculate
      { applied: 10 },           // quota.applyCalc
      { lines: 2 },              // cost.measureFees
      { grandTotal: "1" },       // cost.feeSummary
    ]);
    expect(seq).toEqual([
      "material.matchLibrary",
      "material.fillFromLibrary",
      "quota.match",
      "quota.calculate",
      "quota.applyCalc",
      "cost.measureFees",
      "cost.feeSummary",
    ]);
    expect(plan.fallbackMessage).toBeUndefined();
  });

  it("材料库 0 命中：跳过写回（不打扰确认门）", async () => {
    const plan = await new RulePlanner().plan(ctx(rates), "一键智能报价", { autopilot: true });
    const seq = await toolSeq(plan.steps, [
      { matched: 0 },                    // material.matchLibrary 无命中 → fill 步动态跳过
      { matched: 10 },                   // quota.match
      { matched: 10, needsMainPrice: 0 },// quota.calculate
      { applied: 10 },                   // quota.applyCalc
    ]);
    expect(seq).not.toContain("material.fillFromLibrary");
    expect(seq).toEqual([
      "material.matchLibrary", "quota.match", "quota.calculate",
      "quota.applyCalc", "cost.measureFees", "cost.feeSummary",
    ]);
  });

  it("缺管理费率/利润率：不写回综合单价，提示补设置", async () => {
    const plan = await new RulePlanner().plan(ctx([]), "一键智能报价", { autopilot: true });
    const seq = await toolSeq(plan.steps, [
      { matched: 3 },
      { applied: 3 },
      { matched: 8 },
      { matched: 8, needsMainPrice: 0 },
    ]);
    expect(seq).not.toContain("quota.applyCalc");
    // 测算有匹配时措施费仍计取
    expect(seq).toContain("cost.measureFees");
    expect(plan.tailNote).toContain("管理费率");
    expect(plan.tailNote).toContain("写回组价");
  });

  it("测算 0 匹配：跳过措施费（无人工费基数）", async () => {
    const plan = await new RulePlanner().plan(ctx(rates), "一键智能报价", { autopilot: true });
    const seq = await toolSeq(plan.steps, [
      { matched: 0 },
      { matched: 0 },
      { matched: 0, needsMainPrice: 0 },
      { applied: 0 },
    ]);
    expect(seq).not.toContain("cost.measureFees");
    expect(seq.at(-1)).toBe("cost.feeSummary");
  });

  it("文本触发词同样落到管线", async () => {
    const plan = await new RulePlanner().plan(ctx(rates), "帮我自动报价");
    const tools = plan.steps.filter((s): s is PlanStep => typeof s !== "function").map((s) => s.tool);
    expect(tools).toContain("quota.calculate");
    expect(tools).toContain("cost.feeSummary");
  });

  it("内联费率 + 一键报价：先写台账再跑管线，运行时已齐 → 照常写回", async () => {
    const plan = await new RulePlanner().plan(
      ctx([]),
      "管理费率设为30%，利润率设为10%，一键智能报价"
    );
    const staticTools = plan.steps.filter((s): s is PlanStep => typeof s !== "function").map((s) => s.tool);
    expect(staticTools.slice(0, 2)).toEqual(["project.setFact", "project.setFact"]);
    // 模拟 prefSteps 落库后的运行时台账
    dbFacts.current = rates;
    const seq = await toolSeq(plan.steps);
    expect(seq).toContain("quota.applyCalc");
    expect(plan.fallbackMessage).toBeUndefined();
  });

  it("内联费率只写一项：仍提示补另一项，不写回", async () => {
    const plan = await new RulePlanner().plan(ctx([]), "管理费率设为30%，一键智能报价");
    dbFacts.current = [{ key: "管理费率", value: "30%" }];
    const seq = await toolSeq(plan.steps);
    expect(seq).not.toContain("quota.applyCalc");
    expect(plan.tailNote).toContain("利润率");
  });

  it("空清单：不排步骤，直接引导上传", async () => {
    const plan = await new RulePlanner().plan(ctx(rates, 0), "一键智能报价", { autopilot: true });
    expect(plan.steps).toEqual([]);
    expect(plan.fallbackMessage).toContain("清单");
  });
});

describe("组价写回路由（autopilot 缺费率后的续接指令）", () => {
  const seq = (m: string) =>
    new RulePlanner().plan(ctx(rates), m).then((p) =>
      p.steps.filter((s): s is PlanStep => typeof s !== "function").map((s) => s.tool));

  it.each(["写回组价", "把测算写回清单", "套用定额价", "定额测算并组价写回"])(
    "「%s」→ 测算 + 写回综合单价",
    async (m) => expect(await seq(m)).toEqual(["quota.calculate", "quota.applyCalc"])
  );

  it("「定额组价」只测算不写回", async () =>
    expect(await seq("按四川2020定额组价")).toEqual(["quota.match", "quota.calculate"]));

  it("「写回源文件」仍走 excel.write", async () =>
    expect(await seq("把结果写回源文件")).toEqual(["excel.write"]));
});

describe("总价反算路由", () => {
  const plan = (m: string, facts: { key: string; value: string }[] = []) =>
    new RulePlanner().plan(ctx(facts), m);

  it("中文金额单位：「500万」= 5,000,000，不是 500", async () => {
    const p = await plan("总价控制到500万");
    const step = p.steps[0] as PlanStep;
    expect(step.tool).toBe("quantity.adjust");
    expect(step.args.targetTotal).toBe(5_000_000);
  });

  it("「1.2亿」/「80万」/裸数字", async () => {
    expect((await plan("总价调整到1.2亿")).steps[0] as PlanStep).toMatchObject({ args: { targetTotal: 120_000_000 } });
    expect((await plan("把总价降为80万")).steps[0] as PlanStep).toMatchObject({ args: { targetTotal: 800_000 } });
    expect((await plan("总价控制到450000")).steps[0] as PlanStep).toMatchObject({ args: { targetTotal: 450000 } });
  });

  it("含税口径：台账税率「9%」走归一化，不产出 NaN", async () => {
    const p = await plan("含税总价控制到500万", [{ key: "税率", value: "9%" }]);
    expect((p.steps[0] as PlanStep).args.taxRate).toBeCloseTo(0.09);
  });

  it("含税但台账无税率/税率非法：默认 9% 且提示", async () => {
    const p1 = await plan("含税总价控制到500万");
    expect((p1.steps[0] as PlanStep).args.taxRate).toBeCloseTo(0.09);
    expect(p1.tailNote).toContain("9%");
    const p2 = await plan("含税总价控制到500万", [{ key: "税率", value: "待定" }]);
    expect((p2.steps[0] as PlanStep).args.taxRate).toBeCloseTo(0.09);
    expect(p2.tailNote).toContain("9%");
  });
});

describe("autopilot 甲供材收尾", () => {
  it("有 OWNER_SUPPLIED 文件时管线尾部追加甲供材核对", async () => {
    const c = ctx([{ key: "管理费率", value: "5%" }, { key: "利润率", value: "3%" }]);
    c.files = [{ id: "f1", filename: "甲供材表.xlsx", kind: "OWNER_SUPPLIED", status: "PARSED" }];
    const plan = await new RulePlanner().plan(c, "一键报价", { autopilot: true });
    const seq = await toolSeq(plan.steps, Array(9).fill({ matched: 1 }));
    expect(seq.at(-1)).toBe("material.checkOwnerSupplied");
  });
  it("无甲供材文件 → 不追加", async () => {
    const plan = await new RulePlanner().plan(ctx([{ key: "管理费率", value: "5%" }, { key: "利润率", value: "3%" }]), "一键报价", { autopilot: true });
    const seq = await toolSeq(plan.steps, Array(9).fill({ matched: 1 }));
    expect(seq).not.toContain("material.checkOwnerSupplied");
    expect(seq.at(-1)).toBe("cost.feeSummary");
  });
});
