import { describe, expect, it, vi, afterEach } from "vitest";

// R231 回归：用户在确认门点「取消」后，LLM 循环必须停——原来只把
// {cancelled:true} 塞回工具结果继续跑，同一条消息里的下一个带确认工具
// 会再挂起一张确认卡片，连环打扰已表态的用户（runPlan 有 break，LLM 漏了）。

import { runLLMLoop } from "../agent/llm";
import type { ToolResult } from "../agent/tools/registry";

const ctx = {
  projectId: "p1",
  projectName: "测试项目",
  files: [],
  facts: [],
  boq: { itemCount: 0, pricedCount: 0, totalAmount: "0" },
  quotationCount: 0,
  recentChanges: [],
  history: [],
};

const toolCtx = {
  runId: "r1",
  projectId: "p1",
  userId: "u",
  emit: Object.assign(async () => {}, { live: () => {} }),
} as never;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function mockModelWithTwoToolCalls() {
  // 第一轮：流式失败（ok:false）→ 非流式兜底返回一条含两个 tool_calls 的消息
  const calls = [
    // callOpenAIStream
    { ok: false, status: 500, text: async () => "boom" },
    // callOpenAI 兜底
    {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "t1", type: "function", function: { name: "boq.updateItems", arguments: "{}" } },
                { id: "t2", type: "function", function: { name: "boq.updateItems", arguments: "{}" } },
              ],
            },
          },
        ],
      }),
    },
  ];
  let i = 0;
  vi.stubGlobal("fetch", vi.fn(async () => calls[Math.min(i++, calls.length - 1)]));
}

describe("LLM 循环确认取消", () => {
  it("确认门取消后同轮后续工具不再执行", async () => {
    vi.stubEnv("MODEL_PROVIDER", "openai-compatible");
    vi.stubEnv("MODEL_BASE_URL", "http://fake.local");
    vi.stubEnv("MODEL_API_KEY", "k");
    vi.stubEnv("MODEL_NAME", "m");
    mockModelWithTwoToolCalls();

    const execute = vi.fn(async (): Promise<ToolResult> => ({
      observation: { cancelled: true },
      message: "已取消：测试",
    }));

    const out = await runLLMLoop(ctx, "改价", toolCtx, execute, 4);
    expect(execute).toHaveBeenCalledTimes(1); // 第二个 tool_call 被跳过
    expect(out).toContain("取消");
  });
});
