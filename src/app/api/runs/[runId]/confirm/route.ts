import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { resolveConfirm } from "@agent/pending";
import { preflight } from "@shared/cors";
import { z } from "zod";

// Harness 面板在确认卡上直接批准导入，因此这条路由要能应答跨源预检。
export const OPTIONS = preflight;

// Approve / reject a paused confirm-flagged tool call.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId: id } = await params;
  const input = z.object({ approve: z.boolean() }).strict().safeParse(await req.json().catch(() => null));
  if (!input.success) return NextResponse.json({ error: "请明确批准或取消此导入" }, { status: 400 });
  const { approve } = input.data;
  const run = await prisma.agentRun.findUnique({ where: { id } });
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (run.status !== "AWAITING_CONFIRM")
    return NextResponse.json(
      { error: `run 不在待确认状态（${run.status}）` },
      { status: 409 }
    );
  const ok = resolveConfirm(id, approve);
  if (!ok) {
    // 服务进程重启导致待确认上下文丢失
    await prisma.agentRun.update({
      where: { id },
      data: { status: "FAILED", summary: "确认上下文已失效，请重新发送指令", finishedAt: new Date() },
    });
    return NextResponse.json(
      { error: "执行环境已重启，确认上下文失效，请重新发送指令" },
      { status: 410 }
    );
  }
  return NextResponse.json({ ok: true, approved: approve });
}
