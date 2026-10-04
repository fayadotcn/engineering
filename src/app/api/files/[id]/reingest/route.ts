import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { ActiveRunError, startRun } from "@agent/runtime";

// 按当前（可能已被用户修正的）列映射重新导入：走 agent run，全程留痕。
export async function POST(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const file = await prisma.projectFile.findUnique({ where: { id } });
  if (!file) return NextResponse.json({ error: "not found" }, { status: 404 });
  // 该文件的导入 run 还在跑时禁止再起一个——两个并发导入会交错
  // deleteByFile/createMany。与删除守卫同一条 live 查询口径
  const live = await prisma.agentRun.findFirst({
    where: {
      projectId: file.projectId,
      status: { in: ["RUNNING", "AWAITING_CONFIRM"] },
      userMessage: { contains: `「${file.filename}」` },
      createdAt: { gt: new Date(Date.now() - 15 * 60 * 1000) },
    },
    select: { id: true },
  });
  if (live)
    return NextResponse.json({ error: "该文件正在导入/待核对，完成后再重导", runId: live.id }, { status: 409 });
  try {
    const { runId } = await startRun({
      projectId: file.projectId,
      message: `重新导入文件「${file.filename}」`,
      extra: { ingestFileId: file.id },
    });
    return NextResponse.json({ runId });
  } catch (e) {
    if (e instanceof ActiveRunError)
      return NextResponse.json({ error: "已有任务在执行或等待确认，完成后再重导", runId: e.runId }, { status: 409 });
    throw e;
  }
}
