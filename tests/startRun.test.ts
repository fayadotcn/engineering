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
    findFirst: vi.fn(async ({ where }: { where: { status: { in: string[] }; createdAt: { gt: Date } } }) =>
      db.runs.find((r) => where.status.in.includes(r.status) && r.createdAt > where.createdAt.gt) ?? null),
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

import { ActiveRunError, startRun } from "../agent/runtime";

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

  it("终态 run 不拦截；ingestFileId → planner=import", async () => {
    db.runs = [{ id: "done", status: "DONE", createdAt: new Date() }];
    db.created = [];
    await startRun({ projectId: "p", message: "导入文件「a.xlsx」", extra: { ingestFileId: "f1" } });
    expect(db.created[0]).toMatchObject({ planner: "import" });
  });
});

describe("markZombieRunsFailed 启动清尾", () => {
  it("RUNNING/AWAITING_CONFIRM 全部判 FAILED（重启后这些 run 不可能再结束）", async () => {
    const { markZombieRunsFailed } = await import("../agent/runtime");
    const mod = await import("@database/client");
    const spy = vi.spyOn(mod.prisma.agentRun, "updateMany");
    await markZombieRunsFailed();
    expect(spy).toHaveBeenCalledWith({
      where: { status: { in: ["RUNNING", "AWAITING_CONFIRM"] } },
      data: expect.objectContaining({ status: "FAILED" }),
    });
  });
});
