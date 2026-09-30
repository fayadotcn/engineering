import { prisma } from "@database/client";
import { makeEmitter } from "./events";
import { executeTool } from "./executor";
import { getTool, type ToolContext, type ToolResult } from "./tools/registry";
import { waitForConfirm } from "./pending";
import { toJson } from "@shared/json";
import { randomUUID } from "crypto";

// Deterministic file ingestion only. Harness owns all model conversations.

export interface StartRunInput {
  projectId: string;
  userId?: string;
  message: string;
  extra?: Record<string, unknown>; // e.g. { ingestFileId }
}

export async function startRun(input: StartRunInput): Promise<{ runId: string }> {
  if (typeof input.extra?.ingestFileId !== "string") throw new Error("请在 Harness 对话面板发起造价任务");
  const run = await prisma.agentRun.create({
    data: {
      projectId: input.projectId,
      userMessage: input.message,
      // 文件导入是确定性流程（文件已知、无决策点），不走 LLM 规划
      planner: "import",
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

  await emit("activity", { text: "正在分析项目资料" });

  const summaries: string[] = [];
  let cancelled = false;
  // 确认门：confirm 标记的工具先暂停 run，等用户批准才执行。
  // 规则引擎和 LLM 路径都经过这里，行为一致。
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
    await ingestFile(String(input.extra!.ingestFileId), toolCtx, execute, summaries);

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

async function ingestFile(
  fileId: string,
  toolCtx: ToolContext,
  execute: (c: ToolContext, t: string, a: unknown) => Promise<ToolResult>,
  summaries: string[]
) {
  for (const tool of ["file.inspect", "file.ingest", "project.summary"]) {
    const result = await execute(toolCtx, tool, tool === "project.summary" ? {} : { fileId });
    const observation = result.observation as { error?: string; cancelled?: boolean; ok?: boolean; reason?: string } | null;
    if (observation?.error || observation?.ok === false) throw new Error(observation.error ?? observation.reason ?? "工具执行失败");
    if (result.message) summaries.push(result.message);
    if (observation?.cancelled) break;
  }
}
