import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { startRun } from "@agent/runtime";

// 按当前（可能已被用户修正的）列映射重新导入：走 agent run，全程留痕。
export async function POST(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const file = await prisma.projectFile.findUnique({ where: { id } });
  if (!file) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { runId } = await startRun({
    projectId: file.projectId,
    message: `重新导入文件「${file.filename}」`,
    extra: { ingestFileId: file.id },
  });
  return NextResponse.json({ runId });
}
