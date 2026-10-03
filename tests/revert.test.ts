import { describe, expect, it, vi } from "vitest";
import Decimal from "decimal.js";

// revertReceipt 服务级测试：字段还原 / 后续修改冲突 409 / 删除重建 / 补录移除。

const db = vi.hoisted(() => ({
  items: [] as Record<string, unknown>[],
  receipts: [] as Record<string, unknown>[],
  createdReceipts: [] as Record<string, unknown>[],
  updateCalls: [] as { id: string; patch: Record<string, unknown> }[],
}));

vi.mock("@database/client", () => ({
  prisma: {
    actionReceipt: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        db.receipts.find((r) => r.id === where.id) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        db.createdReceipts.push(data);
        return { id: "rev1" };
      }),
      update: vi.fn(async () => ({})),
    },
    projectFile: {
      findMany: vi.fn(async () => [{ id: "f1" }]),
    },
    boqItem: {
      findMany: vi.fn(async () => db.items),
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
        db.items.push(...data);
        return { count: data.length };
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        const gone = new Set<string>(where.id.in);
        db.items = db.items.filter((i) => !gone.has(i.id as string));
        return { count: gone.size };
      }),
    },
    $transaction: async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]),
  },
}));

vi.mock("@boq/service", async () => {
  const orig = await vi.importActual<typeof import("@boq/service")>("@boq/service");
  return {
    ...orig,
    listBoq: vi.fn(async () => db.items),
    updateBoqItems: vi.fn(async (_p: string, patches: { id: string; patch: Record<string, unknown> }[]) => {
      db.updateCalls.push(...patches);
      const before = patches.map((p) => ({ ...db.items.find((i) => i.id === p.id)! }));
      return { before, after: patches.map((p) => ({ id: p.id, ...p.patch })) };
    }),
  };
});

import { revertReceipt } from "../boq/revert";

const itemRow = (over: Record<string, unknown> = {}) => ({
  id: "i1", projectId: "p1", fileId: "f1", name: "电缆", unitPrice: new Decimal("100"),
  quantity: new Decimal("10"), totalPrice: new Decimal("1000"), feeType: "分部分项",
  quantityExpr: "", mainMaterialPrice: new Decimal("0"), laborUnitPrice: new Decimal("0"),
  machineUnitPrice: new Decimal("0"), pricingPlan: "[]", rawFeature: "", unitProject: "",
  code: "0301", isHeader: false, ...over,
});

const receipt = (over: Record<string, unknown> = {}) => ({
  id: "r1", projectId: "p1", reversible: true, summary: "修改清单",
  before: JSON.stringify([{ id: "i1", unitPrice: "80", quantity: "10", feeType: "分部分项" }]),
  after: JSON.stringify([{ id: "i1", unitPrice: "100", quantity: "10", feeType: "分部分项" }]),
  ...over,
});

describe("revertReceipt", () => {
  it("字段还原：before/after 差异字段写回 before 值", async () => {
    db.items = [itemRow()];
    db.receipts = [receipt()];
    db.updateCalls = []; db.createdReceipts = [];
    const r = await revertReceipt("r1");
    expect(db.updateCalls).toEqual([{ id: "i1", patch: { unitPrice: "80" } }]);
    expect(r.reverted).toBe(1);
    expect(db.createdReceipts[0].actionType).toBe("REVERT");
  });

  it("行已有后续修改 → 409 拒绝", async () => {
    // after 里 unitPrice=100，但当前行已是 120（后续又改过）→ 不能覆盖
    db.items = [itemRow({ unitPrice: new Decimal("120") })];
    db.receipts = [receipt()];
    db.updateCalls = [];
    await expect(revertReceipt("r1")).rejects.toThrow("后续修改");
    expect(db.updateCalls).toEqual([]);
  });

  it("删除类回执：before 有 after 无 → 原样重建", async () => {
    db.items = [];
    db.receipts = [receipt({
      before: JSON.stringify([itemRow({ unitPrice: new Decimal("80") })]),
      after: JSON.stringify([]),
    })];
    db.createdReceipts = [];
    const r = await revertReceipt("r1");
    expect(r.reverted).toBe(1);
    expect(db.items.length).toBe(1);
    expect(String(db.items[0].unitPrice)).toBe("80");
  });

  it("补录类回执：after 有 before 无 → 移除该行", async () => {
    db.items = [itemRow({ id: "new1" })];
    db.receipts = [receipt({
      before: JSON.stringify([]),
      after: JSON.stringify([{ id: "new1", name: "电缆", unitPrice: "100", quantity: "10", feeType: "分部分项" }]),
    })];
    const r = await revertReceipt("r1");
    expect(r.removedIds).toEqual(["new1"]);
    expect(db.items.length).toBe(0);
  });

  it("不可撤销/不存在 → 409/404", async () => {
    db.items = [];
    db.receipts = [receipt({ reversible: false })];
    await expect(revertReceipt("r1")).rejects.toThrow("不可撤销");
    await expect(revertReceipt("nope")).rejects.toThrow("不存在");
  });
});
