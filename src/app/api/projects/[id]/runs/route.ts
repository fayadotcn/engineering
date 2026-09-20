import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { fromJson } from "@shared/json";

// Conversation history: reconstruct blocks from persisted runs + events.
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const runs = await prisma.agentRun.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "asc" },
    take: 50,
    include: { events: { orderBy: { seq: "asc" } } },
  });
  return NextResponse.json(
    runs.map((r) => ({
      id: r.id,
      userMessage: r.userMessage,
      status: r.status,
      createdAt: r.createdAt,
      events: r.events.map((e) => ({
        seq: e.seq,
        type: e.type,
        payload: fromJson(e.payload, {}),
      })),
    }))
  );
}
