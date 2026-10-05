import { describe, expect, it, vi } from "vitest";

// boq.deleteItems 工具级测试：prisma 行 mock，验证归属校验/回执快照/删除调用。

const db = vi.hoisted(() => ({
  rows: [] as { id: string; projectId: string; name: string }[],
  boqRows: [] as Record<string, unknown>[],
  files: [] as { id: string; filename: string; kind: string; status: string; stage: string; period: string; createdAt: Date }[],
  deleted: [] as string[],
  receipts: [] as { id: string; projectId: string; summary: string; reversible: boolean; actionType?: string }[],
  revertedIds: [] as string[],
}));

vi.mock("@boq/service", () => ({
  listBoq: vi.fn(async () => db.boqRows),
  updateBoqItems: vi.fn(async (_p: string, patches: { id: string; patch: Record<string, unknown> }[]) => ({
    before: patches.map((p) => ({ id: p.id })),
    after: patches.map((p) => ({ id: p.id, ...p.patch })),
  })),
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
vi.mock("@database/client", () => {
  const prisma: Record<string, unknown> = {
    actionReceipt: {
      findMany: vi.fn(async (w: { where: { projectId: string; reversible?: boolean } }) =>
        db.receipts.filter((r) => r.projectId === w.where.projectId && (w.where.reversible === undefined || r.reversible === w.where.reversible))),
      findFirst: vi.fn(async (w: { where: { id: string; projectId: string } }) =>
        db.receipts.find((r) => r.id === w.where.id && r.projectId === w.where.projectId) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const r = { id: `rc${db.receipts.length + 1}`, reversible: true, ...data };
        db.receipts.push(r as (typeof db.receipts)[number]);
        return r;
      }),
    },
    boqItem: {
      findMany: vi.fn(async (w: { where: { id: { in: string[] }; projectId: string } }) =>
        db.rows.filter((r) => w.where.id.in.includes(r.id) && r.projectId === w.where.projectId)),
      deleteMany: vi.fn(async (w: { where: { id: { in: string[] } } }) => {
        db.deleted.push(...w.where.id.in);
        return { count: w.where.id.in.length };
      }),
    },
    projectFile: {
      findMany: vi.fn(async () => db.files),
    },
    costFact: { findFirst: vi.fn(async () => null) },
  };
  // 事务回调拿到同一 mock 面（真实 Prisma 的 tx 与 prisma 同形）
  prisma.$transaction = (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);
  return { prisma };
});

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

  it("回执随删除同一事务落库：handler 返回 persistedId，executor 不重复 create", async () => {
    db.rows = [{ id: "a", projectId: "p1", name: "配电箱" }];
    db.deleted = [];
    db.receipts = [];
    const r = await call({ ids: ["a"] });
    // 事务内已写库：db.receipts 有行、返回的 receipt 标记 persistedId
    expect(db.receipts.length).toBe(1);
    expect(db.receipts[0].actionType).toBe("BOQ_DELETE");
    expect((r.receipts?.[0] as { persistedId?: string }).persistedId).toBe(db.receipts[0].id);
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

describe("boq.update", () => {
  it("同 patch 改成分层为总价措施时允许直改合价（口径看变更后）", async () => {
    db.boqRows = [{ id: "i1", feeType: "分部分项", name: "行", code: "" }];
    const r = await callTool("boq.update", { patches: [{ id: "i1", feeType: "总价措施", totalPrice: "500" }] });
    expect(r.observation.updated).toBe(1);
  });
  it("未改分层的分部分项行直改合价 → 拒绝", async () => {
    db.boqRows = [{ id: "i1", feeType: "分部分项", name: "行", code: "" }];
    await expect(callTool("boq.update", { patches: [{ id: "i1", totalPrice: "500" }] })).rejects.toThrow("合价由工程量");
  });
});

describe("boq.compareFiles", () => {
  const file = (id: string, filename: string, stage: string) => ({
    id, filename, kind: "BOQ_TENDER", status: "PARSED", stage, period: "", createdAt: new Date(),
  });
  const boqItem = (id: string, fileId: string) => ({
    id, projectId: "p1", fileId, sheetName: "s", rowIndex: 1,
    code: "030001001001", name: "镀锌钢管", rawFeature: "DN100", unit: "m", quantity: "10",
    unitPrice: "100", mainMaterialPrice: "0", laborUnitPrice: "0", machineUnitPrice: "0",
    pricingPlan: [], feeType: "分部分项", totalPrice: "1000", sectionPath: "",
    isHeader: false, sortOrder: 0, discipline: "OTHER", features: {},
  });

  it("只指定 A 且 A 恰为自动配对的 B → 另一侧自动换一份（与导出对审同口径）", async () => {
    db.files = [file("f1", "招标清单.xlsx", "招标"), file("f2", "结算清单.xlsx", "结算")];
    db.boqRows = [boqItem("i1", "f1"), boqItem("i2", "f2")];
    const r = (await callTool("boq.compareFiles", { fileAId: "f2" })) as {
      observation: { fileA?: string; fileB?: string; error?: string };
    };
    expect(r.observation.error).toBeUndefined();
    expect(r.observation.fileA).toBe("结算清单.xlsx");
    expect(r.observation.fileB).toBe("招标清单.xlsx");
  });

  it("双侧显式指定同一文件 → 报文件选择无效", async () => {
    db.files = [file("f1", "招标清单.xlsx", "招标"), file("f2", "结算清单.xlsx", "结算")];
    db.boqRows = [boqItem("i1", "f1")];
    const r = (await callTool("boq.compareFiles", { fileAId: "f1", fileBId: "f1" })) as {
      observation: { error?: string };
    };
    expect(r.observation.error).toContain("无效");
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
