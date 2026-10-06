import { prisma } from "@database/client";
import { makeEmitter } from "./events";
import { executeTool } from "./executor";
import { getTool, type ToolContext, type ToolResult } from "./tools/registry";
import { requestToolConfirmation } from "./confirmation";
import { createAgentRun, finishAgentRun } from "./runs";
import { resolveContext, type RunContext } from "./context";
import { askModel, modelConfig, runLLMLoop } from "./llm";
import { RulePlanner, type Plan, type PlanStep } from "./planner";
import { AUTO_PROJECT_NAME } from "@shared/types";

// Agent runtime: one run per user message.
// message → resolveContext → LLM loop（配置了模型）或 RulePlanner →
// confirm-gated executeTool → persisted events → SSE。
// 文件导入（extra.ingestFileId）是确定性流程，不走规划。

export interface StartRunInput {
  projectId: string;
  userId?: string;
  message: string;
  extra?: Record<string, unknown>; // e.g. { ingestFileId }
}

export async function startRun(input: StartRunInput): Promise<{ runId: string }> {
  const isImport = typeof input.extra?.ingestFileId === "string";
  const isAutopilot = input.extra?.autopilot === true;
  const run = await createAgentRun({
    projectId: input.projectId,
    message: input.message,
    planner: isImport ? "import" : isAutopilot ? "autopilot" : modelConfig() ? "llm" : "rule",
  });
  // fire-and-forget: events stream via subscribeRun
  void executeRun(run.id, input).catch(async (e) => {
    // 接管发事件必须用「已发事件数之后的 seq」——SSE 按 seq 去重，
    // 从 0 重起的 error/run_finished 会被当作已见过而丢弃，客户端永远收不到结束信号
    const last = await prisma.agentEvent.aggregate({ _max: { seq: true }, where: { runId: run.id } }).catch(() => null);
    const emit = makeEmitter(run.id, (last?._max.seq ?? -1) + 1);
    await emit("error", { text: e instanceof Error ? e.message : String(e) });
    await finishAgentRun(run.id, "FAILED");
    await emit("run_finished", { status: "FAILED" });
  });
  return { runId: run.id };
}

async function executeRun(runId: string, input: StartRunInput) {
  const emit = makeEmitter(runId);
  const toolCtx: ToolContext = {
    projectId: input.projectId,
    runId,
    userId: input.userId ?? "local",
    emit,
  };

  const summaries: string[] = [];
  let cancelled = false;
  // 确认门：confirm 标记的工具先暂停 run，等用户批准才执行。
  // 规则引擎、LLM 与导入路径都经过这里，行为一致。
  const execute = async (c: ToolContext, t: string, a: unknown): Promise<ToolResult> => {
    const def = getTool(t);
    if (def?.implemented && def.confirm) {
      const parsed = def.schema.safeParse(a ?? {});
      if (!parsed.success) return executeTool(c, t, a);
      const description = await def.confirm(parsed.data, c);
      if (!description) return executeTool(c, t, a); // 本次调用不需要确认
      const approved = await requestToolConfirmation(c, t, a, description);
      if (!approved) {
        cancelled = true;
        return { observation: { cancelled: true }, message: `已取消：${description}` };
      }
    }
    return executeTool(c, t, a);
  };

  try {
    const fileId = input.extra?.ingestFileId;
    if (typeof fileId === "string") {
      await emit("activity", { text: "正在分析项目资料" });
      await ingestFile(fileId, toolCtx, execute, summaries);
    } else {
      const ctx = await resolveContext(input.projectId);
      // autopilot 必须确定性：配了模型也走规则管线，避免 LLM 自由发挥改流程
      const useLLM = !!modelConfig() && !input.extra?.autopilot;
      await emit("activity", { text: useLLM ? "正在理解任务" : "正在分析任务" });
      if (useLLM) {
        try {
          const final = await runLLMLoop(ctx, input.message, toolCtx, execute);
          summaries.push(final);
        } catch (e) {
          // 模型不可达 → 降内置规则引擎，任务不断；model_fallback 事件让前端持续显示"固定任务模式"
          const reason = e instanceof Error ? e.message.slice(0, 120) : "error";
          await emit("model_fallback", { reason });
          await emit("activity", {
            text: `模型暂不可用，切换为固定任务模式`,
          });
          await runPlan(ctx, input, toolCtx, execute, summaries);
        }
      } else {
        await runPlan(ctx, input, toolCtx, execute, summaries);
      }
    }

    const summary = summaries.filter(Boolean).join("\n") || "完成。";
    await emit("message", { role: "agent", text: summary });
    const status = cancelled ? "CANCELLED" : "DONE";
    await finishAgentRun(runId, status, summary);
    // 先改名再发 run_finished：客户端收到结束事件立刻刷新工程信息，顺序反过来会漏名
    // 自动命名是润色不是任务本体：失败静默，不影响 run 终态
    await autoNameProject(input).catch(() => {});
    await emit("run_finished", { status });
  } catch (e) {
    await emit("error", { text: e instanceof Error ? e.message : String(e) });
    await finishAgentRun(runId, "FAILED");
    await emit("run_finished", { status: "FAILED" });
  }
}

/** 首页快捷启动的工程带哨兵名（AUTO_PROJECT_NAME）：首个 run 结束后按任务文本 +
 *  已上传文件名自动起名。有模型走 askModel 一句话总结；无模型退回文件名/消息截断。
 *  用户手工改过名（不再是哨兵值）时不动。改名留 PROJECT_RENAME 回执供审计。 */
async function autoNameProject(input: StartRunInput) {
  const project = await prisma.project.findUnique({ where: { id: input.projectId }, select: { name: true } });
  if (!project || project.name !== AUTO_PROJECT_NAME) return;
  const files = await prisma.projectFile.findMany({
    where: { projectId: input.projectId },
    select: { filename: true },
    orderBy: { createdAt: "asc" },
    take: 6,
  });
  const material = [
    `用户任务：${input.message}`,
    files.length ? `上传文件：${files.map((f) => f.filename).join("、")}` : "",
  ].filter(Boolean).join("\n");
  let name = modelConfig()
    ? await askModel(
        "你是工程造价项目的命名助手。根据用户任务和上传文件名，给出一个简短的工程名称。只输出名称本身：不超过16个汉字，不带引号、标点和「工程」二字以外的前缀。",
        material,
      )
    : null;
  if (!name) name = files[0]?.filename.replace(/\.[^.]+$/, "") ?? input.message;
  name = name.replace(/[\s"'“”‘’《》<>【】，。；：,.;!?！？]+/g, "").slice(0, 18).trim();
  if (!name || name === AUTO_PROJECT_NAME) return;
  await prisma.project.update({ where: { id: input.projectId }, data: { name } });
  await prisma.actionReceipt.create({
    data: {
      projectId: input.projectId,
      actionType: "PROJECT_RENAME",
      summary: `自动命名工程：${name}`,
      before: JSON.stringify({ name: project.name }),
      after: JSON.stringify({ name }),
      reversible: false,
      createdBy: "agent",
    },
  });
}

async function runPlan(
  ctx: RunContext,
  input: StartRunInput,
  toolCtx: ToolContext,
  execute: (c: ToolContext, t: string, a: unknown) => Promise<ToolResult>,
  summaries: string[]
) {
  const plan: Plan = await new RulePlanner().plan(ctx, input.message, input.extra);
  const results: ToolResult[] = [];
  for (const step of plan.steps) {
    const resolved: PlanStep | null = typeof step === "function" ? await step(results) : step;
    if (!resolved) continue;
    if (resolved.activity) await toolCtx.emit("activity", { text: resolved.activity });
    const result = await execute(toolCtx, resolved.tool, resolved.args);
    results.push(result);
    if (result.message) summaries.push(result.message);
    const observation = result.observation as { cancelled?: boolean } | null;
    if (observation?.cancelled) break;
  }
  // fallbackMessage 只在动态定位全部落空（一个步骤都没产出）时兜底——
  // 步骤已执行还挂「没有匹配」是自相矛盾的误导；恒显提示走 tailNote。
  if (plan.tailNote) summaries.push(plan.tailNote);
  if (!results.length && plan.fallbackMessage) summaries.push(plan.fallbackMessage);
}

async function ingestFile(
  fileId: string,
  toolCtx: ToolContext,
  execute: (c: ToolContext, t: string, a: unknown) => Promise<ToolResult>,
  summaries: string[]
) {
  let boqish = true;
  for (const tool of ["file.inspect", "file.ingest", "project.summary"]) {
    if (tool === "project.summary" && !boqish) continue; // 询价/参考资料不产生清单行，0 行汇总是误导性噪声
    const result = await execute(toolCtx, tool, tool === "project.summary" ? {} : { fileId });
    const observation = result.observation as { error?: string; cancelled?: boolean; ok?: boolean; reason?: string; kind?: string } | null;
    if (observation?.error || observation?.ok === false) throw new Error(observation.error ?? observation.reason ?? "工具执行失败");
    if (tool === "file.ingest" && typeof observation?.kind === "string") boqish = observation.kind.startsWith("BOQ_");
    if (result.message) summaries.push(result.message);
    if (observation?.cancelled) break;
  }
  // 傻瓜式引导：清单进来了就告诉用户下一步只需一句话
  if (boqish && !summaries.some((s) => s.includes("已取消")))
    summaries.push("回复「一键报价」，我会自动补主材价、匹配定额测算并汇总费用（写回清单前会请你确认）。");
}
