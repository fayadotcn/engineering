import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BoqItemDTO, PricingPlanLine } from "@shared/types";

// quota.setItemQuota 工具级测试：费率前置、缺主材价守卫、replace/append/clear。

const db = vi.hoisted(() => ({
  items: [] as BoqItemDTO[],
  facts: new Map<string, string>(),
  updates: [] as { id: string; patch: Record<string, unknown> }[],
}));

vi.mock("@boq/service", () => ({
  listBoq: vi.fn(async () => db.items),
  updateBoqItems: vi.fn(async (_p: string, patches: { id: string; patch: Record<string, unknown> }[]) => {
    db.updates.push(...patches);
    const before = db.items.filter((i) => patches.some((p) => p.id === i.id));
    const after = before.map((b) => ({ ...b, ...patches.find((p) => p.id === b.id)!.patch }));
    return { before, after };
  }),
}));
vi.mock("@material/service", () => ({ listQuotations: vi.fn(async () => []) }));
vi.mock("@dataset/service", () => ({ findLibraryPrice: vi.fn(async () => null), getPricePrefs: vi.fn(async () => ({})) }));
vi.mock("@quota/service", () => ({
  getQuotaLibrary: vi.fn(async () => [
    {
      code: "5H0332", name: "镀锌钢管安装 DN100", unit: "10m", unitScale: 10,
      labor: 100, material: 20, machine: 5, mainQtyPerUnit: 1.02,
      detail: { mainMaterial: "镀锌钢管" },
      match: {},
    },
    {
      code: "5H0999", name: "管道冲洗消毒", unit: "100m", unitScale: 100,
      labor: 30, material: 5, machine: 0, mainQtyPerUnit: 0,
      detail: {},
      match: {},
    },
  ]),
}));
vi.mock("@project/facts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@project/facts")>();
  return {
    ...orig,
    getFact: vi.fn(async (_p: string, key: string) =>
      db.facts.has(key) ? { value: db.facts.get(key) } : null),
    setFact: vi.fn(),
  };
});

const specRows = vi.hoisted(() => ({ rows: [] as { book: string; title: string; content: string }[] }));
vi.mock("@database/client", () => ({
  prisma: { specSection: { findMany: vi.fn(async () => specRows.rows) } },
}));

import "../agent/tools/quotaTools";
import { getTool } from "../agent/tools/registry";

const ctx = { projectId: "p", runId: "r1", userId: "u", emit: vi.fn() };
const item = (over: Partial<BoqItemDTO> = {}): BoqItemDTO => ({
  id: "i1", projectId: "p", fileId: "f", sheetName: "s", rowIndex: 1,
  code: "", name: "镀锌钢管", rawFeature: "DN100", unit: "m", quantity: "10",
  unitPrice: "80", mainMaterialPrice: "50", laborUnitPrice: "0", machineUnitPrice: "0",
  pricingPlan: [], feeType: "分部分项", totalPrice: "800", sectionPath: "",
  isHeader: false, sortOrder: 0, discipline: "PLUMBING", features: {}, ...over,
});
const call = (args: unknown) =>
  getTool("quota.setItemQuota")!.handler!(ctx as never, args as never) as Promise<{
    observation: Record<string, unknown>; message?: string; receipts?: { summary: string }[];
  }>;

beforeEach(() => {
  db.items = [item()];
  db.updates = [];
  db.facts = new Map([["管理费率", "5%"], ["利润率", "3%"]]);
});

describe("quota.setItemQuota", () => {
  it("缺管理费率/利润率 → 报错不写", async () => {
    db.facts.clear();
    await expect(call({ itemId: "i1", quotaCode: "5H0332" })).rejects.toThrow("尚未确认");
    expect(db.updates.length).toBe(0);
  });
  it("定额有主材但清单项缺暂估价 → 报错", async () => {
    db.items = [item({ mainMaterialPrice: "0" })];
    await expect(call({ itemId: "i1", quotaCode: "5H0332" })).rejects.toThrow("缺价");
  });
  it("定额无声明主材（detail.mainMaterial 空）→ 不加主材价，防重复计", async () => {
    const r = await call({ itemId: "i1", quotaCode: "5H0999" });
    const plan = db.updates[0].patch.pricingPlan as PricingPlanLine[];
    expect(plan.length).toBe(1);
    expect(plan[0].mainPrice).toBeNull();
    expect(r.observation.unitPrice).toBeTruthy();
  });
  it("replace 替换主项 / append 增列", async () => {
    await call({ itemId: "i1", quotaCode: "5H0332", mode: "replace" });
    expect((db.updates.at(-1)!.patch.pricingPlan as PricingPlanLine[]).length).toBe(1);
    db.items = [item({ pricingPlan: [{ quotaCode: "5H0332", quotaName: "x", labor: "1", materialAux: "0", machine: "0", fee: "0", mainMaterialName: null, mainQty: null, mainPrice: null, subtotal: "1" }] })];
    await call({ itemId: "i1", quotaCode: "5H0999", mode: "append" });
    expect((db.updates.at(-1)!.patch.pricingPlan as PricingPlanLine[]).length).toBe(2);
  });
  it("clear 清空方案保留现价", async () => {
    db.items = [item({ pricingPlan: [{ quotaCode: "x", quotaName: "x", labor: "1", materialAux: "0", machine: "0", fee: "0", mainMaterialName: null, mainQty: null, mainPrice: null, subtotal: "1" }] })];
    const r = await call({ itemId: "i1", quotaCode: "", clear: true });
    expect((db.updates.at(-1)!.patch.pricingPlan as PricingPlanLine[]).length).toBe(0);
    expect(r.message).toContain("保留现值");
  });
  it("未知定额编号 → 返回错误观察", async () => {
    const r = await call({ itemId: "i1", quotaCode: "ZZZ" });
    expect(r.observation.error).toContain("ZZZ");
  });
});

describe("spec.search 定额说明检索", () => {
  const specCall = (args: { query: string }) =>
    getTool("spec.search")!.handler!(ctx as never, args as never) as Promise<{
      observation: { hits: { title: string }[] };
      views?: { id: string }[];
      message?: string;
    }>;
  it("关键词命中条文并出视图，同词检索复用同一视图 id", async () => {
    specRows.rows = [
      { book: "给排水", title: "管道安装说明", content: "管道安装定额已含沟槽连接管件，不含支吊架制作安装" },
      { book: "消防", title: "消火栓说明", content: "消火栓箱安装按成套产品考虑" },
    ];
    const r = await specCall({ query: "沟槽连接" });
    expect(r.observation.hits.length).toBeGreaterThan(0);
    expect(r.observation.hits[0].title).toBe("管道安装说明");
    expect(r.views?.[0].id).toBe("view:spec:沟槽连接");
    const r2 = await specCall({ query: "沟槽连接" });
    expect(r2.views?.[0].id).toBe(r.views?.[0].id);
  });
  it("无命中时不产出视图", async () => {
    specRows.rows = [{ book: "电气", title: "电缆说明", content: "电缆敷设按延长米计算" }];
    const r = await specCall({ query: "脚手架" });
    expect(r.views).toEqual([]);
    expect(r.message).toContain("未找到");
  });
});
