import { prisma } from "@database/client";
import { toJson } from "@shared/json";
import type { AgentEventDTO, AgentEventType } from "@shared/types";

// Event bus: every event is persisted to AgentEvent AND pushed to SSE
// subscribers of this run. Single-node dev: in-memory pub/sub is enough.

type Listener = (e: AgentEventDTO) => void;

const subscribers = new Map<string, Set<Listener>>();

export function subscribeRun(runId: string, fn: Listener): () => void {
  const set = subscribers.get(runId) ?? new Set();
  set.add(fn);
  subscribers.set(runId, set);
  return () => {
    set.delete(fn);
    if (!set.size) subscribers.delete(runId);
  };
}

export function makeEmitter(runId: string) {
  let seq = 0;
  return async function emit(
    type: AgentEventType | string,
    payload: Record<string, unknown>
  ) {
    const e: AgentEventDTO = { seq: seq++, type: type as AgentEventType, payload };
    await prisma.agentEvent.create({
      data: { runId, seq: e.seq, type: e.type, payload: toJson(payload) },
    });
    for (const fn of subscribers.get(runId) ?? []) fn(e);
  };
}
