import { NextResponse } from "next/server";
import { prisma } from "@database/client";

// 空闲轮询的轻量探针：前端 10s 一次只打这一个请求（KB 级/亚毫秒），
// 指纹变了才做全量 init——原来每 10s 拉 boq+runs+summary 约 2MB。
// 指纹覆盖全部变化通道：写操作必有回执、文件/清单行数、最新 run 状态、最新台账。
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [receipt, run, boqCount, fileCount, fact] = await Promise.all([
    prisma.actionReceipt.findFirst({ where: { projectId: id }, orderBy: { createdAt: "desc" }, select: { id: true } }),
    prisma.agentRun.findFirst({ where: { projectId: id }, orderBy: { createdAt: "desc" }, select: { id: true, status: true } }),
    prisma.boqItem.count({ where: { projectId: id } }),
    prisma.projectFile.count({ where: { projectId: id } }),
    prisma.costFact.findFirst({ where: { projectId: id }, orderBy: { createdAt: "desc" }, select: { id: true } }),
  ]);
  return NextResponse.json({
    receiptId: receipt?.id ?? null,
    runId: run?.id ?? null,
    runStatus: run?.status ?? null,
    boqCount,
    fileCount,
    factId: fact?.id ?? null,
  });
}
