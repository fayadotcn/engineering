import type { RunContext } from "./context";
import type { Plan, PlanStep, StepOrFn } from "./planner";
import type { ToolResult } from "./tools/registry";

// 一键报价（autopilot）：把造价师的标准动作链固化成确定性管线，
// 用户点一次就跑完「补主材价 → 定额匹配 → 测算 → 写回综合单价 → 措施费 → 费用汇总」。
// 写操作仍过确认门——傻瓜式 ≠ 不经确认；只是全程只打扰这一次。
// 管线全部走现有专业工具，不绕开 cost-engine 红线。

const take = (results: ToolResult[]) =>
  (results.at(-1)?.observation ?? {}) as Record<string, unknown>;

/** 最近一次 quota.calculate 的观测：中间隔着 confirm 写回步，不能只看末尾结果 */
const calcObservation = (results: ToolResult[]) =>
  [...results]
    .reverse()
    .map((r) => (r?.observation ?? {}) as Record<string, unknown>)
    .find((o) => "needsMainPrice" in o);

/** 管理费率/利润率是 applyCalc 的硬门槛（确实不计须显式填 0%）——缺了宁可跳过写回 */
function missingRateKeys(ctx: RunContext): string[] {
  return ["管理费率", "利润率"].filter(
    (k) => !ctx.facts.some((f) => f.key === k && f.value.trim() !== "")
  );
}

export function autopilotPlan(ctx: RunContext): Plan {
  if (!ctx.boq.itemCount) {
    return {
      steps: [],
      fallbackMessage: "项目里还没有工程清单。先把清单 Excel / PDF 拖进来，我识别完就能一键报价。",
    };
  }

  const missing = missingRateKeys(ctx);
  const steps: StepOrFn[] = [
    { tool: "material.matchLibrary", args: {}, activity: "用材料库给缺价项找主材价" },
    // 材料库 0 命中时不写回、不弹确认——没有可写的内容
    (results): PlanStep | null =>
      Number(take(results).matched ?? 0) > 0
        ? { tool: "material.fillFromLibrary", args: {}, activity: "写回主材暂估价（需确认）" }
        : null,
    { tool: "quota.match", args: {}, activity: "匹配定额子目" },
    { tool: "quota.calculate", args: {}, activity: "按定额测算综合单价" },
    // 费率未确认时跳过写回：测算结果已在视图里，提示用户补设置后再写回。
    // 动态步在执行时重查台账——同一条消息里先用 prefSteps 写入的费率（如「管理费率设为5%，一键报价」）能即时生效。
    async (): Promise<PlanStep | null> => {
      const { getFacts } = await import("@project/facts");
      const facts = await getFacts(ctx.projectId);
      const now = ["管理费率", "利润率"].filter(
        (k) => !facts.some((f) => f.key === k && f.value.trim() !== "")
      );
      return now.length
        ? null
        : { tool: "quota.applyCalc", args: {}, activity: "写回综合单价（需确认）" };
    },
    // 系数措施费依赖本次测算写出的「定额人工费明细」；测算 0 匹配就跳过
    (results): PlanStep | null =>
      Number(calcObservation(results)?.matched ?? 0) > 0
        ? { tool: "cost.measureFees", args: {}, activity: "按川标系数计取措施费" }
        : null,
    { tool: "cost.feeSummary", args: {}, activity: "汇总费用与税金" },
    // 收尾勾稽：项目里有甲供材表时自动核对——发包人供货又计主材价 = 重复计价红旗
    ...(ctx.files.some((f) => f.kind === "OWNER_SUPPLIED")
      ? [{ tool: "material.checkOwnerSupplied", args: {}, activity: "核对甲供材是否被重复计价" }]
      : []),
  ];

  return {
    steps,
    fallbackMessage: missing.length
      ? `已自动完成主材补价与定额测算，但台账还缺「${missing.join("、")}」——综合单价暂未写回。` +
        `到「设置」页填写（确实不计取就填 0%）后回复「写回组价」，我接着把综合单价写进清单并汇总费用。`
      : undefined,
  };
}
