import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { ActiveRunError, startRun } from "@agent/runtime";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const body = (await req.json().catch(() => null)) as { message?: string; extra?: Record<string, unknown> } | null;
  const message = body?.message?.trim();
  if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });
  if (message.length > 4000) return NextResponse.json({ error: "指令过长" }, { status: 400 });
  if (!await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } }))
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  try {
    const { runId } = await startRun({ projectId, message, extra: body?.extra });
    return NextResponse.json({ runId });
  } catch (e) {
    // 已有存活任务：拒绝并发而不是让两个 run 交错写清单/导入
    if (e instanceof ActiveRunError)
      return NextResponse.json({ error: "已有任务在执行或等待确认，请先完成或取消", runId: e.runId }, { status: 409 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "启动任务失败" }, { status: 500 });
  }
}

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const runs = await prisma.agentRun.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return NextResponse.json(runs);
}
