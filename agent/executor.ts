import { prisma } from "@database/client";
import { toJson } from "@shared/json";
import { getTool, type ToolContext, type ToolResult } from "./tools/registry";
import type { WorkspaceView } from "@shared/types";
import "./tools"; // register all tools

// Tool Executor: validates args, times the call, persists ToolCall,
// writes ActionReceipts, pushes workspace views. Never lets a tool
// crash the run — failures become observations.

export interface ExecutedStep {
  tool: string;
  args: unknown;
  result: ToolResult;
}

export async function executeTool(
  ctx: ToolContext,
  toolName: string,
  args: unknown
): Promise<ToolResult> {
  const def = getTool(toolName);
  await ctx.emit("tool_started", {
    tool: toolName,
    args: JSON.stringify(args ?? {}).slice(0, 400),
  });
  const started = Date.now();

  const finish = async (result: ToolResult, status: "OK" | "ERROR") => {
    const call = await prisma.toolCall.create({
      data: {
        runId: ctx.runId,
        projectId: ctx.projectId,
        tool: toolName,
        args: toJson(args),
        result: toJson(result.observation),
        status,
        finishedAt: new Date(),
      },
    });
    // persist receipts first so diff views can reference receiptId
    let firstReceiptId: string | undefined;
    for (const r of result.receipts ?? []) {
      const rec = await prisma.actionReceipt.create({
        data: {
          runId: ctx.runId,
          toolCallId: call.id,
          projectId: ctx.projectId,
          actionType: r.actionType,
          summary: r.summary,
          before: toJson(r.before),
          after: toJson(r.after),
          reversible: r.reversible ?? true,
        },
      });
      firstReceiptId ??= rec.id;
      await ctx.emit("receipt", {
        receiptId: rec.id,
        actionType: r.actionType,
        summary: r.summary,
      });
    }
    for (const view of result.views ?? []) {
      const v: WorkspaceView =
        view.kind === "diff" && firstReceiptId
          ? { ...view, receiptId: firstReceiptId }
          : view;
      await ctx.emit("workspace_patch", { view: v });
    }
    await ctx.emit("tool_finished", {
      tool: toolName,
      status,
      ms: Date.now() - started,
      message: result.message,
    });
    return result;
  };

  try {
    if (!def) return finish({ observation: { error: `未知工具 ${toolName}` } }, "ERROR");
    if (!def.implemented || !def.handler)
      return finish(
        { observation: { error: `${toolName} 尚未实现` }, message: `${toolName} 尚未实现` },
        "ERROR"
      );
    const parsed = def.schema.safeParse(args ?? {});
    if (!parsed.success)
      return finish(
        { observation: { error: `参数校验失败: ${parsed.error.message}` } },
        "ERROR"
      );
    const result = await def.handler(ctx, parsed.data);
    const observation = result.observation as { error?: string; ok?: boolean; reason?: string } | null;
    if (observation?.error || observation?.ok === false)
      return finish({ ...result, message: result.message ?? observation.error ?? observation.reason ?? "工具执行失败" }, "ERROR");
    return finish(result, "OK");
  } catch (e) {
    return finish(
      { observation: { error: e instanceof Error ? e.message : String(e) } },
      "ERROR"
    );
  }
}
