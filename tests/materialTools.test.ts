import { describe, expect, it, vi } from "vitest";
import { parseSemanticFeature } from "@cost-engine/semantic";
import type { BoqItemDTO, QuotationItemDTO } from "@shared/types";

// 工具级测试：mock 服务层，直接调 handler。验证 applyQuotation 的
// 多源取最高置信度、零量跳过、onlyItemIds 与「只写主材暂估价」红线。

const db = vi.hoisted(() => ({
  items: [] as BoqItemDTO[],
  quotes: [] as QuotationItemDTO[],
}));

vi.mock("@boq/service", () => ({
  listBoq: vi.fn(async () => db.items),
  updateBoqItems: vi.fn(async (_pid: string, patches: { id: string; patch: Record<string, unknown> }[]) => {
    const before = db.items.filter((i) => patches.some((p) => p.id === i.id));
    const after = before.map((b) => ({ ...b, ...patches.find((p) => p.id === b.id)!.patch }));
    return { before, after };
  }),
}));
vi.mock("@material/service", () => ({ listQuotations: vi.fn(async () => db.quotes) }));
vi.mock("@dataset/service", () => ({
  getPricePrefs: vi.fn(async () => ({})),
  searchMaterialPrices: vi.fn(async () => []),
  matchLibraryForItem: vi.fn(async () => null),
}));

import "../agent/tools/materialTools";
import { getTool } from "../agent/tools/registry";

let n = 0;
const boq = (name: string, feature: string, unit = "m", qty = "10"): BoqItemDTO => ({
  id: `b${++n}`, projectId: "p", fileId: null, sheetName: "s", rowIndex: n,
  code: "", name, rawFeature: feature, unit, quantity: qty, unitPrice: "0",
  mainMaterialPrice: "0", laborUnitPrice: "0", machineUnitPrice: "0", pricingPlan: [],
  feeType: "分部分项", totalPrice: "0", sectionPath: "", isHeader: false,
  sortOrder: n, discipline: "OTHER", features: parseSemanticFeature(name, feature),
});
const quote = (materialName: string, spec: string, price: string, unit = "m"): QuotationItemDTO => ({
  id: `q${++n}`, materialName, spec, unit, brand: "", price, sheetName: "s",
  features: parseSemanticFeature(materialName, spec),
});

const ctx = { projectId: "p", runId: "r1", userId: "u", emit: vi.fn() };
const call = (tool: string, args: unknown = {}) =>
  getTool(tool)!.handler!(ctx as never, args as never) as Promise<{
    observation: Record<string, unknown>;
    message?: string;
    receipts?: { actionType: string }[];
  }>;

describe("material.applyQuotation 询价写回", () => {
  it("同项多条命中取置信度最高者，并记 multiSource", async () => {
    const item = boq("电力电缆", "YJV-4x35+1x16");
    db.items = [item];
    // 全名命中（高置信）在前、子串命中（低置信）在后——旧逻辑会取后者，新逻辑取高分
    db.quotes = [
      quote("电力电缆", "4x35+1x16", "60"),
      quote("电缆", "4x35+1x16", "50"),
    ];
    const r = await call("material.applyQuotation");
    expect(r.observation.applied).toBe(1);
    expect(r.observation.multiSource).toBe(1);
    const { updateBoqItems } = await import("@boq/service");
    const patches = vi.mocked(updateBoqItems).mock.calls.at(-1)![1];
    expect(patches[0].patch.mainMaterialPrice).toBe("60");
    expect(patches[0].patch.unitPrice).toBeUndefined(); // 红线：只写主材暂估价
  });

  it("工程量为 0 的清单项不写回", async () => {
    db.items = [boq("电力电缆", "4x35", "m", "0")];
    db.quotes = [quote("电力电缆", "4x35", "60")];
    const r = await call("material.applyQuotation");
    expect(r.observation.applied).toBe(0);
  });

  it("onlyItemIds 限定写回范围", async () => {
    const a = boq("电力电缆", "4x35");
    const b = boq("电力电缆", "4x35");
    db.items = [a, b];
    db.quotes = [quote("电力电缆", "4x35", "60")];
    const r = await call("material.applyQuotation", { onlyItemIds: [a.id] });
    expect(r.observation.applied).toBe(1);
    const { updateBoqItems } = await import("@boq/service");
    const patches = vi.mocked(updateBoqItems).mock.calls.at(-1)![1];
    expect(patches.map((p) => p.id)).toEqual([a.id]);
  });

  it("写回产生 MATERIAL_PRICE_FILL 回执", async () => {
    db.items = [boq("电力电缆", "4x35")];
    db.quotes = [quote("电力电缆", "4x35", "60")];
    const r = await call("material.applyQuotation");
    expect(r.receipts?.[0]?.actionType).toBe("MATERIAL_PRICE_FILL");
  });
});

describe("material.compareQuotation", () => {
  it("无询价数据时报错提示先上传", async () => {
    db.items = [boq("电力电缆", "4x35")];
    db.quotes = [];
    const r = await call("material.compareQuotation");
    expect(String(r.observation.error)).toContain("没有询价数据");
  });
});
