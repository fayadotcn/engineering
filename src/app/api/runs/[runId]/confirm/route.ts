import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { resolveConfirm } from "@agent/pending";

// Approve / reject a paused confirm-flagged tool call.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId: id } = await params;
  const { approve } = (await req.json()) as { approve?: boolean };
  const run = await prisma.agentRun.findUnique({ where: { id } });
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (run.status !== "AWAITING_CONFIRM")
    return NextResponse.json(
      { error: `run 不在待确认状态（${run.status}）` },
      { status: 409 }
    );
  const ok = resolveConfirm(id, approve !== false);
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
  return NextResponse.json({ ok: true, approved: approve !== false });
}
