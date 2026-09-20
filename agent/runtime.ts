import { prisma } from "@database/client";
import { makeEmitter } from "./events";
import { resolveContext, type RunContext } from "./context";
import { executeTool } from "./executor";
import { RulePlanner, type Plan, type PlanStep } from "./planner";
import { modelConfig, runLLMLoop } from "./llm";
import type { ToolContext, ToolResult } from "./tools/registry";

// CostAgent Runtime — the unified loop:
// user msg -> resolve context -> plan -> execute tools -> observe -> final.
// LLM plans when a model is configured; RulePlanner keeps the whole loop
// functional (and fully deterministic) without any key.

export interface StartRunInput {
  projectId: string;
  userId?: string;
  message: string;
  extra?: Record<string, unknown>; // e.g. { ingestFileId }
}

export async function startRun(input: StartRunInput): Promise<{ runId: string }> {
  const run = await prisma.agentRun.create({
    data: {
      projectId: input.projectId,
      userMessage: input.message,
      planner: modelConfig() ? "llm" : "rule",
    },
  });
  // fire-and-forget: events stream via subscribeRun
  void executeRun(run.id, input).catch(async (e) => {
    const emit = makeEmitter(run.id);
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

  const ctx = await resolveContext(input.projectId);
  const useLLM = !!modelConfig();
  await emit("activity", { text: useLLM ? "正在理解任务" : "正在分析任务" });

  const summaries: string[] = [];
  const execute = (c: ToolContext, t: string, a: unknown) => executeTool(c, t, a);

  try {
    if (useLLM) {
      try {
        const final = await runLLMLoop(ctx, input.message, toolCtx, execute);
        summaries.push(final);
      } catch (e) {
        // model unreachable -> degrade to rule planner, keep the loop alive
        await emit("activity", {
          text: `模型不可用（${e instanceof Error ? e.message.slice(0, 60) : "error"}），切换到内置规则引擎`,
        });
        await runPlan(ctx, input, toolCtx, execute, summaries);
      }
    } else {
      await runPlan(ctx, input, toolCtx, execute, summaries);
    }

    const summary = summaries.filter(Boolean).join("\n") || "完成。";
    await emit("message", { role: "agent", text: summary });
    await emit("run_finished", { status: "DONE" });
    await prisma.agentRun.update({
      where: { id: runId },
      data: { status: "DONE", summary, finishedAt: new Date() },
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
  const planner = new RulePlanner();
  const plan: Plan = await planner.plan(ctx, input.message, input.extra);
  const results: ToolResult[] = [];

  for (const step of plan.steps) {
    const resolved: PlanStep | null =
      typeof step === "function" ? await step(results) : step;
    if (!resolved) continue;
    if (resolved.activity) await toolCtx.emit("activity", { text: resolved.activity });
    const result = await execute(toolCtx, resolved.tool, resolved.args);
    results.push(result);
    if (result.message) summaries.push(result.message);
  }
  if (plan.fallbackMessage) summaries.push(plan.fallbackMessage);
}
