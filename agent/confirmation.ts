import { randomUUID } from "node:crypto";
import { prisma } from "@database/client";
import { toJson } from "@shared/json";
import { waitForConfirm, resolveConfirm } from "./pending";
import type { ToolContext } from "./tools/registry";

/** One confirmation protocol for rule plans, model calls, and file imports. */
export async function requestToolConfirmation(
  ctx: ToolContext,
  tool: string,
  args: unknown,
  description: string
): Promise<boolean> {
  const confirmId = randomUUID();
  const approval = waitForConfirm(ctx.runId, tool, description);
  try {
    await prisma.agentRun.update({
      where: { id: ctx.runId },
      data: {
        status: "AWAITING_CONFIRM",
        pendingAction: toJson({ confirmId, tool, args, description }),
      },
    });
    await ctx.emit("confirm_request", { confirmId, tool, description, args });
    const approved = await approval;
    await prisma.agentRun.update({
      where: { id: ctx.runId },
      data: { status: "RUNNING", pendingAction: "{}" },
    });
    await ctx.emit("confirm_resolved", { confirmId, approved });
    return approved;
  } finally {
    // Persistence/event failures must not leave a resolver and timer alive for ten minutes.
    resolveConfirm(ctx.runId, false);
  }
}
