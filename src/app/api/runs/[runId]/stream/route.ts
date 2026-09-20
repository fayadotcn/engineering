import { prisma } from "@database/client";
import { subscribeRun } from "@agent/events";
import { fromJson } from "@shared/json";
import type { AgentEventDTO } from "@shared/types";

// SSE stream: replay persisted events (reconnect-safe), then live.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let closed = false;
  let lastSeq = -1;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: AgentEventDTO) => {
        if (closed || e.seq <= lastSeq) return;
        lastSeq = e.seq;
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(e)}\n\n`)
        );
        if (e.type === "run_finished") {
          closed = true;
          unsubscribe?.();
          controller.close();
        }
      };

      // replay
      const past = await prisma.agentEvent.findMany({
        where: { runId },
        orderBy: { seq: "asc" },
      });
      for (const p of past) {
        send({ seq: p.seq, type: p.type as AgentEventDTO["type"], payload: fromJson(p.payload, {}) });
      }
      if (closed) return;

      const run = await prisma.agentRun.findUnique({ where: { id: runId } });
      if (run && run.status !== "RUNNING") {
        send({
          seq: lastSeq + 1,
          type: "run_finished",
          payload: { status: run.status },
        });
        return;
      }
      unsubscribe = subscribeRun(runId, send);

      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(`: ping\n\n`));
      }, 15000);
      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe?.();
        try { controller.close(); } catch {}
      });
    },
    cancel() {
      closed = true;
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
