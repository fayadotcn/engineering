import { describe, expect, it, vi } from "vitest";

// createBoqItem 服务口径：总额计价行直填合价、普通行量×价、复制行继承归属+移位、跨项目锚点拒绝

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  aggregate: vi.fn(async () => ({ _max: { sortOrder: 4 } })),
  updateMany: vi.fn(async () => ({ count: 0 })),
  create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "new1", projectId: data.projectId, fileId: data.fileId ?? null,
    sheetName: data.sheetName, rowIndex: data.rowIndex, code: data.code ?? "",
    name: data.name, rawFeature: data.rawFeature ?? "", unit: data.unit ?? "",
    quantity: data.quantity, quantityExpr: data.quantityExpr ?? "",
    unitPrice: data.unitPrice, mainMaterialPrice: data.mainMaterialPrice,
    laborUnitPrice: data.laborUnitPrice, machineUnitPrice: data.machineUnitPrice,
    pricingPlan: data.pricingPlan ?? "[]", totalPrice: data.totalPrice,
    feeType: data.feeType, sectionPath: data.sectionPath ?? "",
    unitProject: data.unitProject ?? "", taxIncluded: false,
    isHeader: false, sortOrder: data.sortOrder, discipline: data.discipline,
    features: data.features ?? "{}", createdAt: new Date(), updatedAt: new Date(),
  })),
}));
vi.mock("@database/client", () => ({
  prisma: {
    boqItem: { findUnique: mocks.findUnique, aggregate: mocks.aggregate, updateMany: mocks.updateMany, create: mocks.create },
    $transaction: async (arg: unknown) =>
      typeof arg === "function" ? arg({ boqItem: mocks }) : Promise.all(arg as Promise<unknown>[]),
  },
}));

import { createBoqItem } from "../boq/service";

const srcRow = {
  id: "src1", projectId: "p1", fileId: "f1", sheetName: "给排水", sectionPath: "地下室",
  sortOrder: 2, discipline: "PLUMBING", unitProject: "水泵房",
};

describe("createBoqItem", () => {
  it("普通行：合价=量×价，追加到末尾", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const it = await createBoqItem("p1", { name: "灭火器", unit: "个", quantity: "20", unitPrice: "85" });
    expect(it.totalPrice).toBe("1700");
    expect(mocks.create.mock.calls.at(-1)![0].data.sortOrder).toBe(5);
    expect(mocks.create.mock.calls.at(-1)![0].data.sheetName).toBe("手工补录");
  });
  it("总价措施：量价强制为 0，直填合价", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const it = await createBoqItem("p1", { name: "安全文明施工费", feeType: "总价措施", quantity: "5", unitPrice: "99", totalPrice: "12000" });
    const d = mocks.create.mock.calls.at(-1)![0].data as Record<string, { toString(): string }>;
    expect(d.quantity.toString()).toBe("0");
    expect(d.unitPrice.toString()).toBe("0");
    expect(it.totalPrice).toBe("12000");
  });
  it("负数/非数字 → 抛校验错", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(createBoqItem("p1", { name: "x", quantity: "-3" })).rejects.toThrow("非负");
    await expect(createBoqItem("p1", { name: "x", unitPrice: "abc" })).rejects.toThrow();
  });
  it("insertAfter 复制：继承源行归属，其后行 sortOrder 后移", async () => {
    mocks.findUnique.mockResolvedValue(srcRow);
    const it = await createBoqItem("p1", { name: "潜水排污泵", unit: "台", quantity: "2", unitPrice: "3800", insertAfter: "src1" });
    const d = mocks.create.mock.calls.at(-1)![0].data;
    expect(d.fileId).toBe("f1");
    expect(d.sectionPath).toBe("地下室");
    expect(d.unitProject).toBe("水泵房");
    expect(d.discipline).toBe("PLUMBING");
    expect(d.sortOrder).toBe(3);
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ fileId: "f1", sortOrder: { gt: 2 } }) })
    );
    expect(it.sheetName).toBe("给排水");
  });
  it("跨项目锚点 → 拒绝", async () => {
    mocks.findUnique.mockResolvedValue({ ...srcRow, projectId: "p2" });
    await expect(createBoqItem("p1", { name: "x", insertAfter: "src1" })).rejects.toThrow("源行不存在");
  });
  it("只给计算式 → 自动求值为工程量", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const it = await createBoqItem("p1", { name: "套管", unit: "个", quantityExpr: "3×12+5", unitPrice: "10" });
    expect(it.quantity).toBe("41");
    expect(it.totalPrice).toBe("410");
  });
});
