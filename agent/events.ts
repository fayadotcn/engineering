import { prisma } from "@database/client";
import { toJson } from "@shared/json";
import type { AgentEventDTO, AgentEventType } from "@shared/types";

// Event bus: every event is persisted to AgentEvent AND pushed to SSE
// subscribers of this run. Single-node dev: in-memory pub/sub is enough.

type Listener = (e: AgentEventDTO) => void;

const shared = globalThis as typeof globalThis & { costRunSubscribers?: Map<string, Set<Listener>> };
const subscribers = (shared.costRunSubscribers ??= new Map<string, Set<Listener>>());

export function subscribeRun(runId: string, fn: Listener): () => void {
  const set = subscribers.get(runId) ?? new Set();
  set.add(fn);
  subscribers.set(runId, set);
  return () => {
    set.delete(fn);
    if (!set.size) subscribers.delete(runId);
  };
}

export type Emit = {
  (type: AgentEventType | string, payload: Record<string, unknown>): Promise<void>;
  /** 瞬时事件：只推 SSE 不落库（模型流式增量）。seq 共享递增保证客户端有序；
   *  断线重放看不到它——最终态由完整的 thought/message 事件承担。 */
  live(type: string, payload: Record<string, unknown>): void;
};

export function makeEmitter(runId: string, startSeq = 0): Emit {
  let seq = startSeq;
  const emit = async function (
    type: AgentEventType | string,
    payload: Record<string, unknown>
  ) {
    const e: AgentEventDTO = { seq: seq++, type: type as AgentEventType, payload };
    await prisma.agentEvent.create({
      data: { runId, seq: e.seq, type: e.type, payload: toJson(payload) },
    });
    for (const fn of subscribers.get(runId) ?? []) fn(e);
  } as Emit;
  emit.live = (type, payload) => {
    const e: AgentEventDTO = { seq: seq++, type: type as AgentEventType, payload };
    for (const fn of subscribers.get(runId) ?? []) fn(e);
  };
  return emit;
}
