import { describe, expect, it, vi } from "vitest";
import type { AgentEventDTO } from "@shared/types";

// SSE 路由契约：先订阅再回放（期间到的事件进队列不丢）、
// lastSeq 去重只作用于非负 seq、终态 run 补合成 run_finished 后关流。

const db = vi.hoisted(() => ({
  run: null as null | { id: string; status: string },
  events: [] as { seq: number; type: string; payload: unknown }[],
}));
vi.mock("@database/client", () => ({
  prisma: {
    agentRun: { findUnique: vi.fn(async () => db.run) },
    agentEvent: {
      findMany: vi.fn(async () => db.events),
      create: vi.fn(async () => ({})),
    },
  },
}));

import { GET } from "../src/app/api/runs/[runId]/stream/route";
import { makeEmitter } from "../agent/events";

const open = (runId = "r1") =>
  GET(new Request(`http://t/api/runs/${runId}/stream`), { params: Promise.resolve({ runId }) });

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const readUntil = async (res: Response, until: (evts: AgentEventDTO[]) => boolean, ms = 3000) => {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const evts: AgentEventDTO[] = [];
  let buf = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !until(evts)) {
    const got = await Promise.race([
      reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), 80)),
    ]);
    if (got === null) continue;
    const { done, value } = got as { done: boolean; value?: Uint8Array };
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const p of parts) {
      const line = p.trim();
      if (line.startsWith("data:")) evts.push(JSON.parse(line.slice(5)) as AgentEventDTO);
    }
  }
  await reader.cancel().catch(() => {});
  return evts;
};

describe("SSE /api/runs/[runId]/stream", () => {
  it("run 不存在 → 404", async () => {
    db.run = null;
    const res = await open("nope");
    expect(res.status).toBe(404);
  });

  it("先回放持久化事件；负 seq live 事件直通不被 lastSeq 滤掉", async () => {
    db.run = { id: "r1", status: "RUNNING" };
    db.events = [
      { seq: 0, type: "thought", payload: {} },
      { seq: 5, type: "activity", payload: {} },
    ];
    const res = await open();
    await tick();
    const emit = makeEmitter("r1", 10); // 接管式续号：live 用负 seq，持久化从 10 起
    emit.live("model_delta", { text: "a" });
    emit.live("model_delta", { text: "b" });
    await emit("message", { text: "done" }); // seq=10
    const evts = await readUntil(res, (e) => e.some((x) => x.type === "message"));
    expect(evts.map((e) => e.seq)).toEqual([0, 5, -1, -2, 10]);
  });

  it("live 到达且 seq 已见 → 去重丢弃", async () => {
    db.run = { id: "r1", status: "RUNNING" };
    db.events = [{ seq: 0, type: "thought", payload: {} }];
    const res = await open();
    await tick();
    const emit = makeEmitter("r1", 0); // 同 seq 重发（重连重叠窗口）
    await emit("activity", { text: "dup" }); // seq=0 已见
    await emit("activity", { text: "new" }); // seq=1
    const evts = await readUntil(res, (e) => e.some((x) => (x.payload as { text?: string }).text === "new"));
    expect(evts.map((e) => e.seq)).toEqual([0, 1]);
  });

  it("终态 run 回放完补合成 run_finished 并关流", async () => {
    db.run = { id: "r1", status: "DONE" };
    db.events = [{ seq: 0, type: "thought", payload: {} }];
    const res = await open();
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const evts: AgentEventDTO[] = [];
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break; // 流必须自然关闭
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const p of parts) {
        const line = p.trim();
        if (line.startsWith("data:")) evts.push(JSON.parse(line.slice(5)) as AgentEventDTO);
      }
    }
    expect(evts.map((e) => e.type)).toEqual(["thought", "run_finished"]);
    expect(evts[1].seq).toBe(1);
    expect((evts[1].payload as { status: string }).status).toBe("DONE");
  });
});
