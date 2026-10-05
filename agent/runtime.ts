import { prisma } from "@database/client";
import { makeEmitter } from "./events";
import { executeTool } from "./executor";
import { getTool, type ToolContext, type ToolResult } from "./tools/registry";
import { waitForConfirm } from "./pending";
import { toJson } from "@shared/json";
import { randomUUID } from "node:crypto";
import { resolveContext, type RunContext } from "./context";
import { modelConfig, runLLMLoop } from "./llm";
import { RulePlanner, type Plan, type PlanStep } from "./planner";

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

export class ActiveRunError extends Error {
  constructor(public runId: string) {
    super("已有任务在执行或等待确认");
  }
}

// 活 run 判定窗口与文件删除/reingest 守卫同口径：超窗视为僵尸 run 不再拦截
export const LIVE_WINDOW_MS = 15 * 60 * 1000;

/**
 * 活 run 查询条件：RUNNING 按创建窗口判（超窗=僵尸，懒清理）；
 * AWAITING_CONFIRM 不按窗判——本进程里它必然配对一个活 resolver
 * （确认门 10 分钟超时即收口），创建超窗只是「跑了很久才到确认门」，
 * 按 createdAt 判死会放行第二个 run 并发写清单（真实竞态）。
 */
export const liveRunWhere = () => ({
  status: { in: ["RUNNING", "AWAITING_CONFIRM"] },
  OR: [
    { status: "AWAITING_CONFIRM" },
    { createdAt: { gt: new Date(Date.now() - LIVE_WINDOW_MS) } },
  ],
});

/**
 * 进程启动时清尾：RUNNING/AWAITING_CONFIRM 的执行器与确认门 resolver 只活在
 * 旧进程内存里，重启后这些 run 永远不可能结束——立即判 FAILED，释放
 * 「单项目单活 run」守卫，用户不必等 15 分钟懒清理窗口。
 */
export function markZombieRunsFailed() {
  return prisma.agentRun.updateMany({
    where: { status: { in: ["RUNNING", "AWAITING_CONFIRM"] } },
    data: {
      status: "FAILED",
      summary: "服务重启，任务中断，请重新发送",
      finishedAt: new Date(),
    },
  });
}

// 本进程是否已做过启动清尾：每个进程首个 startRun 前清一次僵尸。
// 不用 instrumentation.register()——它会连工具/存储图一起打进不允许
// Node 内置模块的 bundle；进程内首调清尾等效且零打包面。
// flag 必须存 globalThis：dev 热重载会重建 module graph，普通模块变量会让
// 新图把本进程仍存活的 AWAITING_CONFIRM run（resolver 在 globalThis 上活着）
// 误杀成 FAILED。
const sweepState = (globalThis as typeof globalThis & { __zombiesSwept?: boolean });
const zombiesSwept = () => sweepState.__zombiesSwept === true;
const markSwept = () => { sweepState.__zombiesSwept = true; };

export function findLiveRun(projectId: string) {
  return prisma.agentRun.findFirst({
    where: { projectId, ...liveRunWhere() },
    select: { id: true },
  });
}

export async function startRun(input: StartRunInput): Promise<{ runId: string }> {
  // 本进程第一次起任务前清尾：数据库里遗留的 RUNNING/AWAITING_CONFIRM 都属
  // 于已死进程（本进程的 resolver/执行器不可能属于重启前的 run），立即判 FAILED。
  if (!zombiesSwept()) {
    markSwept();
    await markZombieRunsFailed().catch(() => { /* 清尾失败由懒清理兜底，不阻塞启动 */ });
  }
  const isImport = typeof input.extra?.ingestFileId === "string";
  const isAutopilot = input.extra?.autopilot === true;
  // 单项目单任务串行：检查+建单同事务，双窗口/直连 API 也不会起并发 run
  // （两个 run 交错 deleteByFile/createMany 或并发写清单是真实风险）
  const run = await prisma.$transaction(async (tx) => {
    const live = await tx.agentRun.findFirst({
      where: { projectId: input.projectId, ...liveRunWhere() },
      select: { id: true },
    });
    if (live) throw new ActiveRunError(live.id);
    return tx.agentRun.create({
      data: {
        projectId: input.projectId,
        userMessage: input.message,
        planner: isImport ? "import" : isAutopilot ? "autopilot" : modelConfig() ? "llm" : "rule",
      },
    });
  });
  // fire-and-forget: events stream via subscribeRun
  void executeRun(run.id, input).catch(async (e) => {
    // 接管发事件必须用「已发事件数之后的 seq」——SSE 按 seq 去重，
    // 从 0 重起的 error/run_finished 会被当作已见过而丢弃，客户端永远收不到结束信号
    const last = await prisma.agentEvent.aggregate({ _max: { seq: true }, where: { runId: run.id } }).catch(() => null);
    const emit = makeEmitter(run.id, (last?._max.seq ?? -1) + 1);
    await emit("error", { text: e instanceof Error ? e.message : String(e) });
    await emit("run_finished", { status: "FAILED" });
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "FAILED", finishedAt: new Date() },
    });
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
      const description = parsed.success ? await def.confirm(parsed.data) : `执行 ${t}`;
      if (!description) return executeTool(c, t, a); // 本次调用不需要确认
      const confirmId = randomUUID();
      const approval = waitForConfirm(runId, t, description);
      await prisma.agentRun.update({
        where: { id: runId },
        data: {
          status: "AWAITING_CONFIRM",
          pendingAction: toJson({ confirmId, tool: t, args: a, description }),
        },
      });
      await c.emit("confirm_request", { confirmId, tool: t, description, args: a as Record<string, unknown> });
      const approved = await approval;
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "RUNNING", pendingAction: "{}" },
      });
      await c.emit("confirm_resolved", { confirmId, approved });
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
    await emit("run_finished", { status: cancelled ? "CANCELLED" : "DONE" });
    await prisma.agentRun.update({
      where: { id: runId },
      data: { status: cancelled ? "CANCELLED" : "DONE", summary, finishedAt: new Date() },
    });
  } catch (e) {
    await emit("error", { text: e instanceof Error ? e.message : String(e) });
    await emit("run_finished", { status: "FAILED" });
    await prisma.agentRun.update({
      where: { id: runId },
      data: { status: "FAILED", finishedAt: new Date() },
    });
  }
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
