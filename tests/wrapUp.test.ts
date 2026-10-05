import { describe, expect, it } from "vitest";
import { WRAP_UP_PROMPT, capFallbackSummary, observationBrief } from "../agent/wrapUp";

// 回归钉：轮数用尽时 run 不能以一句「已达到最大推理轮数，当前进度请查看工作区」结束——
// 真实事故：145 项综合单价写回 + 2 条回执已落库，用户只看到占位文案，误判任务中断。
describe("轮数上限收尾", () => {
  it("observationBrief 只挑对用户有意义的字段（错误/写回数/金额），不灌整段 JSON", () => {
    expect(observationBrief({ applied: 145, skippedIncomplete: 0, mgmtRate: 0.05 })).toBe(
      "applied=145 skippedIncomplete=0"
    );
    expect(observationBrief({ error: "管理费率尚未确认" })).toBe("error=管理费率尚未确认");
    expect(
      observationBrief({ itemCount: 204, pricedCount: 153, totalAmount: "404676.52", other: { deep: 1 } })
    ).toBe("itemCount=204 pricedCount=153 totalAmount=404676.52");
    expect(observationBrief("识别到 3 个工作表")).toBe("识别到 3 个工作表");
    expect(observationBrief([{ id: 1 }, { id: 2 }])).toBe("2 条");
    expect(observationBrief(null)).toBe("");
  });

  it("兜底摘要列出本轮真实执行过的工具与结果要点", () => {
    const text = capFallbackSummary(
      [
        { tool: "project.read", brief: "" },
        { tool: "quota.calculate", brief: "total=204 matched=145" },
        { tool: "quota.applyCalc", brief: "applied=145" },
      ],
      8
    );
    expect(text).toContain("已达最大推理轮数（8 轮）");
    expect(text).toContain("本轮已执行 3 步");
    expect(text).toContain("quota.applyCalc：applied=145");
    expect(text).toContain("工作区");
  });

  it("没执行到工具时也要说清「本轮没动数据」，且提示词禁止再调工具", () => {
    const text = capFallbackSummary([], 8);
    expect(text).toContain("没有执行到工具");
    expect(text).not.toContain("本轮已执行");
    expect(WRAP_UP_PROMPT).toContain("不要再调用工具");
    expect(WRAP_UP_PROMPT).toContain("阶段性总结");
  });

  it("执行步数超过 12 时只列最后 12 步并注明总数（避免回复被长列表淹没）", () => {
    const steps = Array.from({ length: 15 }, (_, i) => ({ tool: `tool.${i}`, brief: `n=${i}` }));
    const text = capFallbackSummary(steps, 8);
    expect(text).toContain("共 15 步");
    expect(text).toContain("tool.14");
    expect(text).not.toContain("· tool.0：");
  });
});
