import { NextResponse } from "next/server";
import { prisma } from "@database/client";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return NextResponse.json({ error: "造价对话已由 DeepSeek Harness 统一执行，请打开对话面板", url: "http://127.0.0.1:3210" }, { status: 410 });
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
