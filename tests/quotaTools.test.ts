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
      match: { category: "管道", material: /镀锌/, diameter: /DN100/ },
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
  prisma: {
    specSection: { findMany: vi.fn(async () => specRows.rows) },
    quotaRow: { findMany: vi.fn(async () => []) },
  },
}));

import "../agent/tools/quotaTools";
import { getTool } from "../agent/tools/registry";
import { previewProjectPricing, applyProjectPricing } from "@quota/pricing";

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
  it("定额有主材但清单项缺暂估价 → 不写入并报缺价", async () => {
    db.items = [item({ mainMaterialPrice: "0" })];
    const r = await call({ itemId: "i1", quotaCode: "5H0332" });
    expect(r.observation.error).toContain("缺价");
    expect(db.updates.length).toBe(0);
  });
  it("定额无声明主材（detail.mainMaterial 空）→ 不加主材价，防重复计", async () => {
    const r = await call({ itemId: "i1", quotaCode: "5H0999" });
    const plan = db.updates[0].patch.pricingPlan as PricingPlanLine[];
    expect(plan.length).toBe(1);
    expect(plan[0].mainPrice).toBeNull();
    expect((r.observation.items as { unitPrice: string }[])[0].unitPrice).toBeTruthy();
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

describe("quota.search 结果序确定性", () => {
  const qCall = (query: string) =>
    getTool("quota.search")!.handler!(ctx as never, { query } as never) as Promise<{
      observation: { code: string; name: string }[];
    }>;
  it("命中按编号定序，与库内原始顺序无关", async () => {
    const { getQuotaLibrary } = await import("@quota/service");
    // 乱序库：编号小的在后面——输出必须仍按编号升序
    vi.mocked(getQuotaLibrary).mockResolvedValueOnce([
      { code: "5H0999", name: "管道冲洗消毒", unit: "100m", unitScale: 100, labor: 30, material: 5, machine: 0, mainQtyPerUnit: 0, detail: {}, match: {} },
      { code: "5H0332", name: "管道镀锌钢管 DN100", unit: "10m", unitScale: 10, labor: 100, material: 20, machine: 5, mainQtyPerUnit: 1.02, detail: {}, match: {} },
    ] as never);
    const r = await qCall("管道");
    expect(r.observation.map((h) => h.code)).toEqual(["5H0332", "5H0999"]);
  });
});

describe("quota.search 语义检索", () => {
  const qCall = (query: string) =>
    getTool("quota.search")!.handler!(ctx as never, { query } as never) as Promise<{
      observation: {
        code: string; name: string;
        unpricedMaterials: { name: string; qtyPerUnit: number }[];
        mainMaterial: string | null;
      }[];
    }>;
  it("「镀锌钢管 DN65」命中定额名写「公称直径65mm以内」的子目（非整串匹配）", async () => {
    const { getQuotaLibrary } = await import("@quota/service");
    // 与 getQuotaLibrary 生产形态一致：material regex 必带 materialLabel
    vi.mocked(getQuotaLibrary).mockResolvedValueOnce([
      { code: "5H0007", name: "室外管道 镀锌钢管 螺纹连接 公称直径 65mm以内", unit: "10m", unitScale: 10, labor: 17.6, material: 18.83, machine: 1.44, mainQtyPerUnit: 1.015, detail: {}, match: { category: "管道", material: /镀锌钢管/, materialLabel: "镀锌钢管", diameter: /^DN65$/, connection: /螺纹/, connectionLabel: "螺纹" } },
      { code: "5H0104", name: "室内管道 镀锌钢管 螺纹连接 公称直径 65mm以内", unit: "10m", unitScale: 10, labor: 67.98, material: 20.92, machine: 17.13, mainQtyPerUnit: 1.02, detail: { mainMaterial: "镀锌钢管" }, materials: [{ name: "镀锌钢管接头零件", unit: "个", qtyPerUnit: 0.425 }, { name: "型钢", unit: "kg", qtyPerUnit: 0.6254 }, { name: "镀锌钢管", unit: "m", qtyPerUnit: 1.02 }], match: { category: "管道", material: /镀锌钢管/, materialLabel: "镀锌钢管", diameter: /^DN65$/, connection: /螺纹/, connectionLabel: "螺纹" } },
      { code: "5H0108", name: "室内管道 镀锌钢管 螺纹连接 公称直径 150mm以内", unit: "10m", unitScale: 10, labor: 110.15, material: 27.87, machine: 32.4, mainQtyPerUnit: 1.02, detail: {}, match: { category: "管道", material: /镀锌钢管/, materialLabel: "镀锌钢管", diameter: /^DN150$/, connection: /螺纹/, connectionLabel: "螺纹" } },
      { code: "5A1246", name: "制冰设备安装 盐水制冰设备 冰池盖 包镀锌铁皮", unit: "台", unitScale: 1, labor: 31.8, material: 80.22, machine: 0, mainQtyPerUnit: 1, detail: {}, match: { category: "设备", material: /镀锌钢板/, materialLabel: "镀锌钢板" } },
    ] as never);
    const r = await qCall("镀锌钢管 DN65");
    const codes = r.observation.map((h) => h.code);
    expect(codes).toContain("5H0007");
    expect(codes).toContain("5H0104");
    // 档位相邻的 DN150 同种管子目可以出现，但异类设备行（镀锌铁皮）不得进结果
    expect(codes).not.toContain("5A1246");
    // 同档行排最前
    expect(codes.slice(0, 2).sort()).toEqual(["5H0007", "5H0104"]);
    // 未计价材料含量透出：管件/型钢与主材同列——「不含主材」口径不能把管件丢掉
    const hit = r.observation.find((h) => h.code === "5H0104")!;
    expect(hit.unpricedMaterials.map((m) => m.name)).toContain("镀锌钢管接头零件");
    expect(hit.mainMaterial).toBe("镀锌钢管");
  });
  it("定额编号检索仍走字面命中", async () => {
    const { getQuotaLibrary } = await import("@quota/service");
    vi.mocked(getQuotaLibrary).mockResolvedValueOnce([
      { code: "5H0332", name: "管道镀锌钢管 DN100", unit: "10m", unitScale: 10, labor: 100, material: 20, machine: 5, mainQtyPerUnit: 1.02, detail: {}, match: {} },
    ] as never);
    const r = await qCall("5h0332");
    expect(r.observation.map((h) => h.code)).toEqual(["5H0332"]);
  });
});

describe("quota.calculate 主材询价规格归一化", () => {
  it("询价规格 4×35 命中清单特征 4x35（×/x 等价），不再回退材料库", async () => {
    const { listQuotations } = await import("@material/service");
    const { findLibraryPrice } = await import("@dataset/service");
    vi.mocked(listQuotations).mockResolvedValueOnce([{
      id: "q1", fileId: "f", materialName: "电力电缆", spec: "4×35", unit: "m",
      brand: "", price: "60", sheetName: "s", features: {},
    }] as never);
    vi.mocked(findLibraryPrice).mockClear();
    db.items = [item({ name: "电力电缆", rawFeature: "YJV-4x35+1x16", features: { specification: "4x35" } as never })];
    await getTool("quota.calculate")!.handler!(ctx as never, {} as never);
    expect(vi.mocked(findLibraryPrice)).not.toHaveBeenCalled(); // 项目询价已命中
  });
});

describe("组价服务与工具适配", () => {
  it("测算价与实际写回相等，组价方案排除建议行，主材价不被改写", async () => {
    const preview = await previewProjectPricing("p", "r1");
    const calculated = preview.rows.find(r => r.itemId === "i1")!;
    expect(calculated.quotaCode).toBeTruthy();
    const applied = await applyProjectPricing("p");
    expect(applied.applied).toBe(1);
    expect(db.updates[0].patch.unitPrice).toBe(calculated.calcPrice);
    expect(db.updates[0].patch.pricingPlan).toEqual(calculated.plan!.filter(l => !l.suggested));
    expect(db.updates[0].patch).not.toHaveProperty("mainMaterialPrice");
  });

  it("缺材料价测算不完整，默认跳过，显式指定才写回", async () => {
    db.items = [item({ mainMaterialPrice: "0" })];
    const preview = await previewProjectPricing("p");
    expect(preview.needMain).toBe(1);
    expect(preview.rows[0].deviation).toBeNull();
    expect((await applyProjectPricing("p")).applied).toBe(0);
    expect(db.updates).toEqual([]);
    expect((await applyProjectPricing("p", { includeIncomplete: true })).applied).toBe(1);
  });

  it("费率缺失拒绝写回，显式 0% 可以组价，每种费率只读取一次", async () => {
    db.facts.clear();
    await expect(applyProjectPricing("p")).rejects.toThrow("管理费率尚未确认");
    expect(db.updates).toEqual([]);
    db.facts = new Map([["管理费率", "0%"], ["利润率", "0%"]]);
    const { getFact } = await import("@project/facts");
    vi.mocked(getFact).mockClear();
    expect((await applyProjectPricing("p")).applied).toBe(1);
    expect(getFact).toHaveBeenCalledTimes(2);
  });

  it("指定目标项时只写目标，仍返回可撤销的前后快照", async () => {
    db.items = [item(), item({ id: "i2" })];
    const result = await applyProjectPricing("p", { onlyItemIds: ["i2"] });
    expect(result.applied).toBe(1);
    expect(db.updates.map(p => p.id)).toEqual(["i2"]);
    expect(result.before[0].unitPrice).toBe("80");
    expect(result.after[0].unitPrice).toBe(db.updates[0].patch.unitPrice);
  });
});

describe("spec.search 定额说明检索", () => {
  const specCall = (args: { query: string }) =>
    getTool("spec.search")!.handler!(ctx as never, args as never) as Promise<{
      observation: { hits: { title: string; book: string }[] };
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
  it("同分按册名定序——DB 返回乱序时输出仍稳定", async () => {
    specRows.rows = [
      { book: "消防", title: "章二", content: "沟槽连接件按设计计算" },
      { book: "给排水", title: "章一", content: "沟槽连接件按设计计算" },
    ];
    const r = await specCall({ query: "沟槽" });
    expect(r.observation.hits.map((h) => h.book)).toEqual(["给排水", "消防"]);
  });
});
