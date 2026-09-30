import type { RunContext } from "./context";
import type { ToolContext, ToolResult } from "./tools/registry";
import { toolSchemasForLLM, toolNameFromWire } from "./tools/registry";

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
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
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

/** 流式调用（DeepSeek/OpenAI 兼容 SSE）：内容增量经 onText 实时回吐，
 *  tool_calls 按 index 累积拼装；流失败抛错由调用方降级为非流式。 */
async function callOpenAIStream(
  cfg: ModelConfig,
  messages: LLMMsg[],
  tools: ReturnType<typeof toolSchemasForLLM>,
  onText: (accumulated: string) => void
): Promise<LLMMsg> {
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
      stream: true,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`模型请求失败 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  if (!res.body) throw new Error("模型响应无流");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let lastFlush = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        const l = line.trim();
        if (!l.startsWith("data:")) continue;
        const data = l.slice(5).trim();
        if (data === "[DONE]") continue;
        let json: {
          choices?: { delta?: {
            content?: string;
            tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
          } }[];
        };
        try { json = JSON.parse(data); } catch { continue; }
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          const now = Date.now();
          if (now - lastFlush > 120) { lastFlush = now; onText(content); }
        }
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? 0;
          const cur = calls.get(i) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(i, cur);
        }
      }
    }
  }
  if (content) onText(content); // 收尾全量
  return {
    role: "assistant",
    // DeepSeek 严格反序列化：带 tool_calls 时 content 须为 null 而非 ""
    content: calls.size ? content || null : content,
    tool_calls: [...calls.values()].filter((c) => c.name).map((c) => ({
      id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      type: "function" as const, // DeepSeek 要求显式 type 字段
      function: { name: c.name, arguments: c.args || "{}" },
    })),
  };
}

const SYSTEM_PROMPT = `你是安装工程造价 Agent，运行在一个造价工作台上。
你可以通过工具真正读取项目数据、检查清单、修改单价/工程量、匹配询价、汇总金额、导出 Excel。

规则：
- 所有金额、工程量、汇总、比较必须调用工具完成，禁止自己心算金额
- 修改类操作与文件导入会经系统确认门等待用户批准，你无需再向用户确认，除非任务本身不明确
- 项目事实（地区/税率/品牌/价格文件）在下方上下文给出，优先使用，不要重复猜测
- 动手前先用一句话说明你打算怎么做，之后每步操作之间也可以简短说明（这些说明会实时展示给用户）
- 回复用中文，简洁专业。先给结论，再给关键数字
- 如果没有合适的工具，说明你需要什么信息

当前项目上下文：
{CONTEXT}`;

async function callAnthropic(
  cfg: ModelConfig,
  system: string,
  messages: unknown[],
  tools: ReturnType<typeof toolSchemasForLLM>
) {
  const res = await fetch(`${cfg.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 4096,
      system,
      messages,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`模型请求失败 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<{
    content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
    stop_reason: string;
  }>;
}

async function runAnthropicLoop(
  cfg: ModelConfig,
  ctx: RunContext,
  userMessage: string,
  toolCtx: ToolContext,
  execute: (c: ToolContext, t: string, a: unknown) => Promise<ToolResult>,
  contextBlock: string,
  maxRounds: number
): Promise<string> {
  const system = SYSTEM_PROMPT.replace("{CONTEXT}", contextBlock);
  const messages: unknown[] = [
    ...ctx.history.slice(-6).map((h) => ({ role: h.role, content: h.text })),
    { role: "user", content: userMessage },
  ];
  const tools = toolSchemasForLLM();
  for (let round = 0; round < maxRounds; round++) {
    const res = await callAnthropic(cfg, system, messages, tools);
    messages.push({ role: "assistant", content: res.content });
    const toolUses = res.content.filter((b) => b.type === "tool_use");
    const narration = res.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (narration && toolUses.length)
      await toolCtx.emit("thought", { text: narration.slice(0, 800) });
    if (!toolUses.length) {
      return res.content.filter((b) => b.type === "text").map((b) => b.text).join("") || "已完成。";
    }
    const results = [];
    for (const tu of toolUses) {
      const result = await execute(toolCtx, toolNameFromWire(tu.name!), tu.input ?? {});
      results.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result.observation).slice(0, 8000),
      });
    }
    messages.push({ role: "user", content: results });
  }
  return "已达到最大推理轮数，当前进度请查看工作区。";
}

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

  if (cfg.provider === "anthropic") {
    return runAnthropicLoop(cfg, ctx, userMessage, toolCtx, execute, contextBlock, maxRounds);
  }

  for (let round = 0; round < maxRounds; round++) {
    const streamId = `r${round}`;
    let msg: LLMMsg;
    // 首个 token 之前没有事件流动——每 4s 心跳更新当前 activity 文案，
    // 消除「卡在正在理解任务」的黑盒感
    let waited = 0;
    const heartbeat = setInterval(() => {
      waited += 4;
      toolCtx.emit.live?.("activity_live", { text: `正在等待模型响应 ${waited}s` });
    }, 4000);
    try {
      msg = await callOpenAIStream(cfg, messages, tools, (text) => {
        toolCtx.emit.live?.("thought_delta", { streamId, text: text.slice(0, 1500) });
      });
    } catch {
      msg = await callOpenAI(cfg, messages, tools); // 流式不支持/中断 → 非流式兜底
    } finally {
      clearInterval(heartbeat);
    }
    messages.push(msg);

    if (!msg.tool_calls?.length) {
      // 最终答复轮：流式增量已实时预览；完整文本由 message 事件承载，这里不再落 thought 避免重复
      return msg.content || "已完成。";
    }
    if (msg.content?.trim())
      await toolCtx.emit("thought", { text: msg.content.trim().slice(0, 800), streamId });
    for (const call of msg.tool_calls) {
      let args: unknown = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = {};
      }
      const result = await execute(toolCtx, toolNameFromWire(call.function.name), args);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result.observation).slice(0, 8000),
      });
    }
  }
  return "已达到最大推理轮数，当前进度请查看工作区。";
}
