import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { fromJson } from "@shared/json";

// Conversation history: reconstruct blocks from persisted runs + events.
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // 服务重启后残留的 RUNNING/AWAITING_CONFIRM 永远不会结束（确认门 resolver 已丢，
  // 确认门超时 10 分钟，15 分钟一定是死的）——懒清理为 FAILED
  await prisma.agentRun.updateMany({
    where: {
      projectId: id,
      status: { in: ["RUNNING", "AWAITING_CONFIRM"] },
      createdAt: { lt: new Date(Date.now() - 15 * 60 * 1000) },
    },
    data: {
      status: "FAILED",
      summary: "服务重启，任务中断，请重新发送",
      finishedAt: new Date(),
    },
  });
  // 取最近 50 条 run（desc 再反转为时间序）——asc+take 会在 run 数>50 时丢掉最新记录
  const desc = await prisma.agentRun.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { events: { orderBy: { seq: "asc" } } },
  });
  const runs = desc.reverse();
  // 同一 view 的 workspace_patch 只保留最后一次（重放时旧 patch 会被覆盖，白传流量）
  const parsed = runs.map((r) => ({
    run: r,
    events: r.events.map((e) => ({
      seq: e.seq,
      type: e.type,
      payload: fromJson(e.payload, {}) as { view?: { id?: string } },
    })),
  }));
  const lastPatch = new Map<string, { seq: number; payload: { view?: { id?: string } } }>();
  for (const { events } of parsed)
    for (const e of events)
      if (e.type === "workspace_patch" && e.payload.view?.id)
        lastPatch.set(e.payload.view.id, e);
  // 被覆盖的 patch 只回传 view.id 占位（重放时随即被后续同 id 的完整 patch 替换），省流量
  return NextResponse.json(
    parsed.map(({ run: r, events }) => ({
      id: r.id,
      userMessage: r.userMessage,
      status: r.status,
      createdAt: r.createdAt,
      events: events.map((e) =>
        e.type === "workspace_patch" && e.payload.view?.id && lastPatch.get(e.payload.view.id) !== e
          ? { ...e, payload: { view: { id: e.payload.view.id } } }
          : e
      ),
    }))
  );
}
