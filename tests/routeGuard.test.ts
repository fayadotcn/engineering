import { describe, expect, it, vi } from "vitest";

// 活 run 守卫契约（R244）：工作区写路由在 RUNNING/AWAITING_CONFIRM 期间
// 一律 409——直连 API 不能在 run 写盘中途插入用户写（丢失更新）。
// findLiveRun 查的是 agentRun.findFirst + liveRunWhere，测试只需让
// agentRun.findFirst 返回活 run 对象即可触发守卫。

const db = vi.hoisted(() => ({
  liveRun: null as null | { id: string },
  boqItem: { id: "i1", projectId: "p1", isHeader: false, feeType: "分部分项" } as null | Record<string, unknown>,
  receipt: { id: "r1", projectId: "p1" } as null | Record<string, unknown>,
}));

vi.mock("@database/client", () => ({
  prisma: {
    agentRun: { findFirst: vi.fn(async () => db.liveRun) },
    boqItem: {
      findMany: vi.fn(async () => (db.boqItem ? [db.boqItem] : [])),
      findUnique: vi.fn(async () => db.boqItem),
    },
    project: { findUnique: vi.fn(async () => ({ id: "p1" })) },
    actionReceipt: { findUnique: vi.fn(async () => db.receipt) },
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === "function" ? (arg as (t: unknown) => unknown)({}) : arg
    ),
  },
}));

// 服务层不应被触达——守卫必须先于业务逻辑返回
vi.mock("@boq/service", () => ({
  updateBoqItems: vi.fn(async () => {
    throw new Error("守卫未拦截：updateBoqItems 不应执行");
  }),
  createBoqItem: vi.fn(async () => {
    throw new Error("守卫未拦截：createBoqItem 不应执行");
  }),
}));
vi.mock("@boq/revert", () => ({
  revertReceipt: vi.fn(async () => {
    throw new Error("守卫未拦截：revertReceipt 不应执行");
  }),
  RevertError: class extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  },
}));

import { PATCH as patchItem, DELETE as deleteItem } from "../src/app/api/boq-items/[id]/route";
import { POST as createItem } from "../src/app/api/boq-items/route";
import { POST as batchDelete } from "../src/app/api/boq-items/batch-delete/route";
import { POST as batchAdjust } from "../src/app/api/boq-items/batch-adjust/route";
import { POST as batchPatch } from "../src/app/api/boq-items/batch-patch/route";
import { POST as revertReceiptRoute } from "../src/app/api/receipts/[id]/revert/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (body: unknown) =>
  new Request("http://t/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("活 run 期间工作区写一律 409", () => {
  it("PATCH /api/boq-items/[id] → 409", async () => {
    db.liveRun = { id: "r" };
    const res = await patchItem(json({ unitPrice: "10" }) as never, params("i1"));
    expect(res.status).toBe(409);
  });

  it("DELETE /api/boq-items/[id] → 409", async () => {
    db.liveRun = { id: "r" };
    const res = await deleteItem(new Request("http://t/x", { method: "DELETE" }) as never, params("i1"));
    expect(res.status).toBe(409);
  });

  it("POST /api/boq-items（补录）→ 409", async () => {
    db.liveRun = { id: "r" };
    const res = await createItem(json({ projectId: "p1", name: "测试行" }) as never);
    expect(res.status).toBe(409);
  });

  it("batch-delete → 409", async () => {
    db.liveRun = { id: "r" };
    const res = await batchDelete(json({ ids: ["i1"] }) as never);
    expect(res.status).toBe(409);
  });

  it("batch-adjust → 409", async () => {
    db.liveRun = { id: "r" };
    const res = await batchAdjust(json({ ids: ["i1"], field: "unitPrice", mode: "value", value: "10" }) as never);
    expect(res.status).toBe(409);
  });

  it("batch-patch → 409", async () => {
    db.liveRun = { id: "r" };
    const res = await batchPatch(json({ patches: [{ id: "i1", unitPrice: "10" }] }) as never);
    expect(res.status).toBe(409);
  });

  it("POST /api/receipts/[id]/revert → 409", async () => {
    db.liveRun = { id: "r" };
    const res = await revertReceiptRoute(new Request("http://t/x", { method: "POST" }) as never, params("r1"));
    expect(res.status).toBe(409);
  });
});

describe("无活 run 时守卫放行", () => {
  it("PATCH /api/boq-items/[id] 进入业务层（mock 抛出即证明穿透）", async () => {
    db.liveRun = null;
    const res = await patchItem(json({ unitPrice: "10" }) as never, params("i1"));
    // updateBoqItems mock 抛错 → 路由 catch 成 400——证明请求确实到达了业务层
    expect(res.status).toBe(400);
  });
});
