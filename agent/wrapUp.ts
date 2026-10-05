// 轮数上限的收尾（纯函数，无 IO）：模型循环用尽 maxRounds 时，
// 绝不可以用一句「已达到最大推理轮数」结束——先把本轮真实执行过的动作汇总成可读进度。
// 历史坑：一次 145 项综合单价写回 + 2 条回执全部落库，用户侧只看到「已达上限」，误判为中断。

export interface ExecutedStep {
  tool: string;
  brief: string;
}

/** 模型收尾轮提示词：不带工具，只要求输出阶段性总结。 */
export const WRAP_UP_PROMPT =
  "工具调用轮数已达上限。请立刻基于上面已有的工具结果，用中文输出阶段性总结（不要再调用工具）：" +
  "① 本轮已完成什么（含关键数字：项数/金额/回执）② 哪些没做完、卡在什么输入上 ③ 建议的下一步。" +
  "不要复述过程，不要道歉。";

/** 从工具 observation 里挑出对用户有意义的要点（错误/数量/金额），纯函数便于回归。 */
export function observationBrief(observation: unknown, limit = 3): string {
  if (observation === null || observation === undefined) return "";
  if (typeof observation === "string") return observation.replace(/\s+/g, " ").trim().slice(0, 60);
  if (typeof observation === "number" || typeof observation === "boolean") return String(observation);
  if (Array.isArray(observation)) return observation.length ? `${observation.length} 条` : "";
  const o = observation as Record<string, unknown>;
  // 优先级：错误 → 写回/匹配结果 → 计数 → 金额。命中 limit 条即止，避免长 JSON 灌进回复
  const keys = [
    "error", "message", "applied", "updated", "imported", "deleted", "skippedIncomplete",
    "matched", "unpriced", "count", "total", "itemCount", "pricedCount", "totalAmount",
    "unmatchedHints", "needsMainPrice",
  ];
  const parts: string[] = [];
  for (const k of keys) {
    const v = o[k];
    if (v === undefined || v === null || v === "") continue;
    const text = Array.isArray(v) ? `${v.length} 条` : typeof v === "object" ? JSON.stringify(v) : String(v);
    parts.push(`${k}=${text.replace(/\s+/g, " ").slice(0, 48)}`);
    if (parts.length >= limit) break;
  }
  return parts.join(" ");
}

/** 模型收尾调用失败/为空时的确定性兜底摘要——至少让用户看到本轮做了什么。 */
export function capFallbackSummary(executed: ExecutedStep[], maxRounds: number): string {
  if (!executed.length)
    return `已达最大推理轮数（${maxRounds} 轮），本轮没有执行到工具。当前进度请查看工作区。`;
  const lines = executed.slice(-12).map((s) => `· ${s.tool}${s.brief ? `：${s.brief}` : ""}`);
  const more = executed.length > 12 ? `（仅列最后 12 步，共 ${executed.length} 步）` : "";
  return [
    `已达最大推理轮数（${maxRounds} 轮），本轮已执行 ${executed.length} 步${more}：`,
    ...lines,
    "上述结果已写入工作区（写操作均有回执、可撤销）。回「继续」可接着往下做，或直接说要做的下一步。",
  ].join("\n");
}
