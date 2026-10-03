import { describe, expect, it, vi } from "vitest";

// boq.deleteItems 工具级测试：prisma 行 mock，验证归属校验/回执快照/删除调用。

const db = vi.hoisted(() => ({
  rows: [] as { id: string; projectId: string; name: string }[],
  deleted: [] as string[],
}));

vi.mock("@boq/service", () => ({
  listBoq: vi.fn(async () => []),
  updateBoqItems: vi.fn(),
}));
vi.mock("@database/client", () => ({
  prisma: {
    boqItem: {
      findMany: vi.fn(async (w: { where: { id: { in: string[] }; projectId: string } }) =>
        db.rows.filter((r) => w.where.id.in.includes(r.id) && r.projectId === w.where.projectId)),
      deleteMany: vi.fn(async (w: { where: { id: { in: string[] } } }) => {
        db.deleted.push(...w.where.id.in);
        return { count: w.where.id.in.length };
      }),
    },
  },
}));

import "../agent/tools/boqTools";
import { getTool } from "../agent/tools/registry";

const ctx = { projectId: "p1", runId: "r1", userId: "u", emit: vi.fn() };
const call = (args: unknown) =>
  getTool("boq.deleteItems")!.handler!(ctx as never, args as never) as Promise<{
    observation: Record<string, unknown>;
    receipts?: { actionType: string; before: unknown; after: unknown }[];
  }>;

describe("boq.deleteItems", () => {
  it("删除本项目的行，回执带全字段快照（revert recreate 路径输入）", async () => {
    db.rows = [{ id: "a", projectId: "p1", name: "配电箱" }];
    db.deleted = [];
    const r = await call({ ids: ["a"] });
    expect(r.observation.deleted).toBe(1);
    expect(db.deleted).toEqual(["a"]);
    expect(r.receipts?.[0].actionType).toBe("BOQ_DELETE");
    expect((r.receipts?.[0].before as unknown[]).length).toBe(1);
    expect(r.receipts?.[0].after).toEqual([]);
  });

  it("跨项目/不存在的 id → 报错不删", async () => {
    db.rows = [{ id: "a", projectId: "other", name: "x" }];
    db.deleted = [];
    const r = await call({ ids: ["a"] });
    expect(String(r.observation.error)).toContain("不存在");
    expect(db.deleted).toEqual([]);
  });

  it("重复 id 去重", async () => {
    db.rows = [{ id: "a", projectId: "p1", name: "x" }];
    db.deleted = [];
    const r = await call({ ids: ["a", "a"] });
    expect(r.observation.deleted).toBe(1);
  });
});
