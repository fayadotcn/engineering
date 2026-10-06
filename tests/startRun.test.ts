import { describe, expect, it, vi } from "vitest";

// startRun 并发守卫：同项目存在 RUNNING/AWAITING_CONFIRM 的活 run 时拒绝再起——
// 两个 run 交错 deleteByFile/createMany 或并发写清单是真实风险。
// 超 15 分钟的 run 视为僵尸（进程死过），不再拦截。

const db = vi.hoisted(() => ({
  runs: [] as { id: string; status: string; createdAt: Date }[],
  created: [] as Record<string, unknown>[],
}));
vi.mock("@database/client", () => {
  const agentRun = {
    findFirst: vi.fn(async ({ where }: { where: { status: { in: string[] }; OR?: { status?: string; createdAt?: { gt: Date } }[] } }) =>
      db.runs.find((r) =>
        where.status.in.includes(r.status) &&
        (where.OR ?? [{ createdAt: { gt: new Date(0) } }]).some((c) =>
          c.status ? r.status === c.status : r.createdAt > c.createdAt!.gt)) ?? null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      db.created.push(data);
      const row = { id: `run-${db.created.length}`, status: "RUNNING", createdAt: new Date(), ...data };
      db.runs.push(row as typeof db.runs[number]);
      return row;
    }),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 0 })),
  };
  const tx = {
    agentRun,
    agentEvent: { create: vi.fn(async () => ({})), aggregate: vi.fn(async () => ({ _max: { seq: null } })) },
  };
  return { prisma: { ...tx, $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } };
});

import { ActiveRunError } from "../agent/runs";
import { startRun } from "../agent/runtime";

const fresh = () => ({ id: "live-1", status: "RUNNING", createdAt: new Date() });

describe("startRun 单项目单任务串行", () => {
  it("有活 run → ActiveRunError，且不建单", async () => {
    db.runs = [fresh()];
    db.created = [];
    await expect(startRun({ projectId: "p", message: "测算组价" })).rejects.toThrow(ActiveRunError);
    await expect(startRun({ projectId: "p", message: "x" })).rejects.toMatchObject({ runId: "live-1" });
    expect(db.created.length).toBe(0);
  });

  it("AWAITING_CONFIRM 同样拦截（待确认期间发消息不再起并发）", async () => {
    db.runs = [{ id: "wait-1", status: "AWAITING_CONFIRM", createdAt: new Date() }];
    db.created = [];
    await expect(startRun({ projectId: "p", message: "x" })).rejects.toMatchObject({ runId: "wait-1" });
    expect(db.created.length).toBe(0);
  });

  it("超窗僵尸 run 不拦截", async () => {
    db.runs = [{ id: "zombie", status: "RUNNING", createdAt: new Date(Date.now() - 16 * 60 * 1000) }];
    db.created = [];
    const { runId } = await startRun({ projectId: "p", message: "x" });
    expect(db.created.length).toBe(1);
    expect(runId).toBe("run-1");
  });

  it("创建超窗但仍挂确认门的 run 仍拦截——resolver 活着就不能放行并发写", async () => {
    // 真实竞态：长 LLM 循环 + 确认门最长挂 10 分钟，按 createdAt 判死会让
    // 第二个 run 在旧 run 等待确认期间起跑，两边同时写清单
    db.runs = [{ id: "wait-old", status: "AWAITING_CONFIRM", createdAt: new Date(Date.now() - 20 * 60 * 1000) }];
    db.created = [];
    await expect(startRun({ projectId: "p", message: "x" })).rejects.toMatchObject({ runId: "wait-old" });
    expect(db.created.length).toBe(0);
  });

  it("终态 run 不拦截；ingestFileId → planner=import", async () => {
    db.runs = [{ id: "done", status: "DONE", createdAt: new Date() }];
    db.created = [];
    await startRun({ projectId: "p", message: "导入文件「a.xlsx」", extra: { ingestFileId: "f1" } });
    expect(db.created[0]).toMatchObject({ planner: "import" });
  });
});

describe("markZombieRunsFailed 启动清尾", () => {
  it("RUNNING/AWAITING_CONFIRM 全部判 FAILED（重启后这些 run 不可能再结束）", async () => {
    const { markZombieRunsFailed } = await import("../agent/runs");
    const mod = await import("@database/client");
    const spy = vi.spyOn(mod.prisma.agentRun, "updateMany");
    await markZombieRunsFailed();
    expect(spy).toHaveBeenCalledWith({
      where: { status: { in: ["RUNNING", "AWAITING_CONFIRM"] } },
      data: expect.objectContaining({ status: "FAILED" }),
    });
  });

  it("进程内首个 startRun 自动清尾一次，后续不再重复扫", async () => {
    vi.resetModules();
    // 清尾 flag 在 globalThis（防 dev 热重载误杀活 run）——测试需显式复位
    delete (globalThis as { __runInitialization?: Promise<void> }).__runInitialization;
    const mod = await import("@database/client");
    const spy = vi.spyOn(mod.prisma.agentRun, "updateMany");
    const { startRun: freshStart } = await import("../agent/runtime");
    db.runs = [];
    db.created = [];
    await freshStart({ projectId: "p", message: "x" });
    expect(spy).toHaveBeenCalledTimes(1);
    // 第二次会被刚建的活 run 拦下——拦截无所谓，关键是清尾没再跑
    await freshStart({ projectId: "p", message: "y" }).catch(() => {});
    expect(spy).toHaveBeenCalledTimes(1);
    vi.resetModules();
  });
});
