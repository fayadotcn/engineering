import { NextResponse } from "next/server";
import { startRun } from "@agent/runtime";
import { prisma } from "@database/client";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const { message } = await req.json();
  if (!message?.trim())
    return NextResponse.json({ error: "message required" }, { status: 400 });
  const { runId } = await startRun({ projectId, message: message.trim() });
  return NextResponse.json({ runId });
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
