import { describe, expect, it, vi } from "vitest";
import type { AgentEventDTO } from "@shared/types";

// agent/events.ts 发射器契约：
// 持久化事件占非负 seq 并落库；live 瞬时事件占负数 seq 只推 SSE——
// 崩溃接管按 _max+1 续号时不会重用已被客户端去重集见过的 seq（R141）。

const store = vi.hoisted(() => ({
  created: [] as { runId: string; seq: number; type: string }[],
}));
vi.mock("@database/client", () => ({
  prisma: { agentEvent: { create: vi.fn(async ({ data }: { data: { runId: string; seq: number; type: string } }) => { store.created.push(data); return data; }) } },
}));

import { makeEmitter, subscribeRun } from "../agent/events";

const collect = (runId: string) => {
  const seen: AgentEventDTO[] = [];
  const off = subscribeRun(runId, (e) => seen.push(e));
  return { seen, off };
};

describe("makeEmitter seq 命名空间", () => {
  it("持久化事件从 startSeq 递增且落库", async () => {
    store.created.length = 0;
    const { seen, off } = collect("r1");
    const emit = makeEmitter("r1", 5);
    await emit("thought", { text: "a" });
    await emit("message", { text: "b" });
    off();
    expect(seen.map((e) => e.seq)).toEqual([5, 6]);
    expect(store.created.map((c) => c.seq)).toEqual([5, 6]);
  });

  it("live 事件用负数 seq 且不落库", async () => {
    store.created.length = 0;
    const { seen, off } = collect("r2");
    const emit = makeEmitter("r2", 0);
    emit.live("model_delta", { text: "…" });
    emit.live("model_delta", { text: "……" });
    await emit("thought", { text: "t" });
    off();
    expect(seen.map((e) => e.seq)).toEqual([-1, -2, 0]);
    expect(store.created.length).toBe(1); // 只有持久化的 thought
    expect(store.created[0].seq).toBe(0);
  });

  it("崩溃接管续号不与已推送的 live seq 冲突", async () => {
    store.created.length = 0;
    const { seen, off } = collect("r3");
    // 原发射器：持久化 seq 0/1 + 两个 live 事件（-1/-2）
    const dead = makeEmitter("r3", 0);
    await dead("thought", {});
    await dead("tool_call", {});
    dead.live("model_delta", {});
    dead.live("model_delta", {});
    // 接管：按持久化 _max+1=2 续号——发出的 error 绝不可复用 -1/-2 或 0/1
    const takeover = makeEmitter("r3", 2);
    await takeover("error", { message: "原进程崩溃" });
    off();
    const seqs = seen.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // 无重复 seq → 去重集不会误丢
    expect(seen.at(-1)!.type).toBe("error");
    expect(seen.at(-1)!.seq).toBe(2);
  });

  it("退订后不再收事件；不同 run 互不串流", async () => {
    const a = collect("rA");
    const b = collect("rB");
    const emitA = makeEmitter("rA", 0);
    const emitB = makeEmitter("rB", 0);
    await emitA("thought", {});
    b.off(); // rB 退订
    await emitB("thought", {});
    a.off();
    expect(a.seen.length).toBe(1);
    expect(b.seen.length).toBe(0);
  });
});
