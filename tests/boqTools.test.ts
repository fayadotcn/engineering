import { describe, expect, it, vi } from "vitest";

// boq.deleteItems 工具级测试：prisma 行 mock，验证归属校验/回执快照/删除调用。

const db = vi.hoisted(() => ({
  rows: [] as { id: string; projectId: string; name: string }[],
  deleted: [] as string[],
  receipts: [] as { id: string; projectId: string; summary: string; reversible: boolean }[],
  revertedIds: [] as string[],
}));

vi.mock("@boq/service", () => ({
  listBoq: vi.fn(async () => []),
  updateBoqItems: vi.fn(),
  createBoqItem: vi.fn(async (_p: string, input: Record<string, unknown>) => ({
    id: "new1", projectId: "p1", fileId: null, sheetName: "手工补录", rowIndex: -1,
    code: input.code ?? "", name: input.name, rawFeature: input.rawFeature ?? "",
    unit: input.unit ?? "", quantity: input.quantity ?? "0", unitPrice: input.unitPrice ?? "0",
    mainMaterialPrice: "0", laborUnitPrice: "0", machineUnitPrice: "0", pricingPlan: [],
    feeType: input.feeType ?? "分部分项",
    totalPrice: input.feeType === "总价措施" || input.feeType === "其他项目"
      ? input.totalPrice ?? "0"
      : String(Number(input.quantity ?? 0) * Number(input.unitPrice ?? 0)),
    sectionPath: "", isHeader: false, sortOrder: 99, discipline: "OTHER", features: {},
  })),
}));
vi.mock("@database/client", () => ({
  prisma: {
    actionReceipt: {
      findMany: vi.fn(async (w: { where: { projectId: string; reversible?: boolean } }) =>
        db.receipts.filter((r) => r.projectId === w.where.projectId && (w.where.reversible === undefined || r.reversible === w.where.reversible))),
      findFirst: vi.fn(async (w: { where: { id: string; projectId: string } }) =>
        db.receipts.find((r) => r.id === w.where.id && r.projectId === w.where.projectId) ?? null),
    },
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
const callTool = (tool: string, args: unknown) =>
  getTool(tool)!.handler!(ctx as never, args as never) as Promise<{
    observation: Record<string, unknown>;
    receipts?: { actionType: string; before: unknown; after: unknown }[];
  }>;
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

describe("boq.addItem", () => {
  it("补录产生回执：before 空、after 带新行（revert 走 removeIds 路径）", async () => {
    const r = await callTool("boq.addItem", { name: "灭火器", quantity: "20", unit: "个", unitPrice: "85" });
    expect(r.observation.itemId).toBe("new1");
    expect(r.receipts?.[0].before).toEqual([]);
    expect((r.receipts?.[0].after as { name: string }[])[0].name).toBe("灭火器");
  });
});

vi.mock("@boq/revert", () => ({
  revertReceipt: vi.fn(async (id: string) => {
    db.revertedIds.push(id);
    return { reverted: 2, receiptId: "rev1", affectedIds: ["a"], restored: [], removedIds: [] };
  }),
  RevertError: class RevertError extends Error {
    constructor(public status: number, message: string) { super(message); }
  },
}));

describe("receipt.undo", () => {
  it("无参数 → 撤销最近一条可撤销回执", async () => {
    db.receipts = [
      { id: "r-new", projectId: "p1", summary: "修改 1 个清单项", reversible: true },
      { id: "r-old", projectId: "p1", summary: "删除 1 个清单项", reversible: true },
    ];
    db.revertedIds = [];
    const r = await callTool("receipt.undo", {});
    expect(db.revertedIds).toEqual(["r-new"]);
    expect(r.observation.reverted).toBe(2);
  });

  it("query 按摘要定位（找不到 → 报错不动数据）", async () => {
    db.receipts = [
      { id: "r-new", projectId: "p1", summary: "修改 1 个清单项", reversible: true },
      { id: "r-del", projectId: "p1", summary: "删除 3 个清单项", reversible: true },
    ];
    db.revertedIds = [];
    const r = await callTool("receipt.undo", { query: "删除" });
    expect(db.revertedIds).toEqual(["r-del"]);
    const r2 = await callTool("receipt.undo", { query: "导出" });
    expect(String(r2.observation.error)).toContain("没有可撤销");
    expect(db.revertedIds).toEqual(["r-del"]);
  });

  it("receiptId 跨项目 → 归属守卫拒绝", async () => {
    db.receipts = [{ id: "r-x", projectId: "other", summary: "x", reversible: true }];
    db.revertedIds = [];
    const r = await callTool("receipt.undo", { receiptId: "r-x" });
    expect(String(r.observation.error)).toContain("不属于当前项目");
    expect(db.revertedIds).toEqual([]);
  });
});
