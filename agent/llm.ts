import type { RunContext } from "./context";
import type { ToolContext, ToolResult } from "./tools/registry";
import { toolSchemasForLLM } from "./tools/registry";

// Model layer: provider-agnostic. openai-compatible covers OpenAI, DeepSeek,
// Moonshot, and most relay gateways; anthropic covers Claude endpoints.
// Business logic never references a provider directly.

interface ModelConfig {
  provider: "openai-compatible" | "anthropic";
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function modelConfig(): ModelConfig | null {
  const provider = process.env.MODEL_PROVIDER as
    | ModelConfig["provider"]
    | "rule"
    | undefined;
  const baseUrl = process.env.MODEL_BASE_URL;
  const apiKey = process.env.MODEL_API_KEY;
  const model = process.env.MODEL_NAME;
  if (!provider || provider === "rule" || !baseUrl || !apiKey || !model) return null;
  if (provider !== "openai-compatible" && provider !== "anthropic") return null;
  return { provider, baseUrl: baseUrl.replace(/\/$/, ""), apiKey, model };
}

interface LLMMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

async function callOpenAI(
  cfg: ModelConfig,
  messages: LLMMsg[],
  tools: ReturnType<typeof toolSchemasForLLM>
) {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      tools: tools.map((t) => ({ type: "function", function: t })),
      tool_choice: "auto",
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`模型请求失败 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices[0].message as LLMMsg;
}

const SYSTEM_PROMPT = `你是安装工程造价 Agent，运行在一个造价工作台上。
你可以通过工具真正读取项目数据、检查清单、修改单价/工程量、匹配询价、汇总金额、导出 Excel。

规则：
- 所有金额、工程量、汇总、比较必须调用工具完成，禁止自己心算金额
- 修改类操作（boq.update / material.applyQuotation / quantity.adjust）会自动生成回执，执行前不需要向用户确认，除非任务本身不明确
- 项目事实（地区/税率/品牌/价格文件）在下方上下文给出，优先使用，不要重复猜测
- 回复用中文，简洁专业。先给结论，再给关键数字
- 如果没有合适的工具，说明你需要什么信息

当前项目上下文：
{CONTEXT}`;

export async function runLLMLoop(
  ctx: RunContext,
  userMessage: string,
  toolCtx: ToolContext,
  execute: (ctx: ToolContext, tool: string, args: unknown) => Promise<ToolResult>,
  maxRounds = 8
): Promise<string> {
  const cfg = modelConfig();
  if (!cfg) throw new Error("未配置模型");

  const contextBlock = [
    `项目: ${ctx.projectName}`,
    `清单: ${ctx.boq.itemCount} 项，已定价 ${ctx.boq.pricedCount}，合价 ${ctx.boq.totalAmount} 元`,
    `文件: ${ctx.files.map((f) => `${f.filename}(${f.kind})`).join("，") || "无"}`,
    `询价条目: ${ctx.quotationCount}`,
    `事实台账: ${ctx.facts.map((f) => `${f.key}=${f.value}`).join("，") || "空"}`,
    ctx.recentChanges.length ? `最近变更: ${ctx.recentChanges.join("；")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const messages: LLMMsg[] = [
    { role: "system", content: SYSTEM_PROMPT.replace("{CONTEXT}", contextBlock) },
    ...ctx.history.slice(-6).map((h) => ({ role: h.role as "user" | "assistant", content: h.text })),
    { role: "user", content: userMessage },
  ];
  const tools = toolSchemasForLLM();

  for (let round = 0; round < maxRounds; round++) {
    let msg: LLMMsg;
    if (cfg.provider === "openai-compatible") {
      msg = await callOpenAI(cfg, messages, tools);
    } else {
      throw new Error(`provider ${cfg.provider} 暂未接入，请用 openai-compatible`);
    }
    messages.push(msg);

    if (!msg.tool_calls?.length) {
      return msg.content || "已完成。";
    }
    for (const call of msg.tool_calls) {
      let args: unknown = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = {};
      }
      const result = await execute(toolCtx, call.function.name, args);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result.observation).slice(0, 8000),
      });
    }
  }
  return "已达到最大推理轮数，当前进度请查看工作区。";
}
