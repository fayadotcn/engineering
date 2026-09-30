import { prisma } from "@database/client";
import { subscribeRun } from "@agent/events";
import { fromJson } from "@shared/json";
import type { AgentEventDTO } from "@shared/types";

export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  if (!await prisma.agentRun.findUnique({ where: { id: runId } })) return Response.json({ error: "任务不存在" }, { status: 404 });
  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closeController: (() => void) | undefined;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    if (heartbeat) clearInterval(heartbeat);
    req.signal.removeEventListener("abort", cleanup);
    closeController?.();
  };
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastSeq = -1;
      let replaying = true;
      const queued: AgentEventDTO[] = [];
      closeController = () => { try { controller.close(); } catch {} };
      const send = (e: AgentEventDTO) => {
        if (closed || e.seq <= lastSeq) return;
        lastSeq = e.seq;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        if (e.type === "run_finished") cleanup();
      };
      // Subscribe first so completion during the database replay cannot be lost.
      unsubscribe = subscribeRun(runId, e => replaying ? queued.push(e) : send(e));
      req.signal.addEventListener("abort", cleanup);
      if (req.signal.aborted) { cleanup(); return; }
      try {
        const past = await prisma.agentEvent.findMany({ where: { runId }, orderBy: { seq: "asc" } });
        for (const p of past) send({ seq: p.seq, type: p.type as AgentEventDTO["type"], payload: fromJson(p.payload, {}) });
        replaying = false;
        for (const e of queued.sort((a, b) => a.seq - b.seq)) send(e);
        if (closed) return;
        const run = await prisma.agentRun.findUnique({ where: { id: runId } });
        if (run && ["DONE", "FAILED", "CANCELLED"].includes(run.status)) {
          send({ seq: lastSeq + 1, type: "run_finished", payload: { status: run.status } });
          return;
        }
        // AWAITING_CONFIRM remains connected until approval or cancellation.
        heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(": ping\n\n")); }, 15000);
      } catch (error) { cleanup(); }
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
