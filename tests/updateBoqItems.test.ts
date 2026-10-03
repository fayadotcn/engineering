import { describe, expect, it, vi } from "vitest";

// updateBoqItems 的 feeType/unitProject 修正口径：
// - 分层变更后按新口径解释合价（总价措施直填合价、分部分项量×价重算）
// - 非总额计价行直改合价显式拒绝（不再静默接受派生值）

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
}));
vi.mock("@database/client", () => ({
  prisma: {
    boqItem: { findMany: mocks.findMany, update: mocks.update },
    $transaction: async (arg: unknown) =>
      typeof arg === "function" ? arg({ boqItem: mocks }) : Promise.all(arg as Promise<unknown>[]),
  },
}));

import Decimal from "decimal.js";
import { updateBoqItems } from "../boq/service";

// Prisma Decimal 字段返回 decimal.js 实例——mock 必须同型，否则 isFinite 等不可用
const row = (over: Record<string, unknown> = {}) => ({
  id: "i1", projectId: "p1", fileId: "f1", sheetName: "s", rowIndex: 0,
  code: "0301", name: "清单项", rawFeature: "", unit: "m",
  quantity: new Decimal("10"), quantityExpr: "", unitPrice: new Decimal("50"), mainMaterialPrice: new Decimal("0"),
  laborUnitPrice: new Decimal("0"), machineUnitPrice: new Decimal("0"), pricingPlan: "[]",
  totalPrice: new Decimal("500"), feeType: "分部分项", sectionPath: "", unitProject: "",
  taxIncluded: false, isHeader: false, sortOrder: 0, discipline: "OTHER",
  features: "{}", createdAt: new Date(), updatedAt: new Date(), ...over,
});

const setup = (cur: Record<string, unknown>, after: Record<string, unknown>) => {
  mocks.findMany.mockReset();
  mocks.findMany.mockResolvedValueOnce([cur]).mockResolvedValueOnce([after]);
  mocks.update.mockClear();
};

describe("updateBoqItems feeType/unitProject", () => {
  it("分部分项直改合价被拒绝（派生值不可直写）", async () => {
    const cur = row();
    setup(cur, cur);
    await expect(updateBoqItems("p1", [{ id: "i1", patch: { totalPrice: "999" } }]))
      .rejects.toThrow("自动计算");
  });

  it("改分层为总价措施后同次可直填合价", async () => {
    const cur = row();
    setup(cur, { ...cur, feeType: "总价措施", totalPrice: "1200" });
    const { after } = await updateBoqItems("p1", [
      { id: "i1", patch: { feeType: "总价措施", totalPrice: "1200" } },
    ]);
    const data = mocks.update.mock.calls[0][0].data as Record<string, { toString(): string }>;
    expect(data.feeType).toBe("总价措施");
    expect(data.totalPrice.toString()).toBe("1200");
    expect(after[0].feeType).toBe("总价措施");
  });

  it("总价措施改回分部分项：合价按量×价重算", async () => {
    const cur = row({ feeType: "总价措施", quantity: new Decimal("0"), unitPrice: new Decimal("0"), totalPrice: new Decimal("1200") });
    setup(cur, { ...cur, feeType: "分部分项", totalPrice: "0" });
    await updateBoqItems("p1", [{ id: "i1", patch: { feeType: "分部分项" } }]);
    const data = mocks.update.mock.calls[0][0].data as Record<string, { toString(): string }>;
    expect(data.feeType).toBe("分部分项");
    expect(data.totalPrice.toString()).toBe("0"); // 0×0 重算覆盖源直填值
  });

  it("单位工程归属修正透传且去空白", async () => {
    const cur = row();
    setup(cur, { ...cur, unitProject: "2号楼" });
    await updateBoqItems("p1", [{ id: "i1", patch: { unitProject: "  2号楼  " } }]);
    expect(mocks.update.mock.calls[0][0].data.unitProject).toBe("2号楼");
  });
});
