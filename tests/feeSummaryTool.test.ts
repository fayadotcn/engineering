import { beforeEach, describe, expect, it, vi } from "vitest";
import Decimal from "decimal.js";
import { getTool, type ToolContext } from "@agent/tools/registry";
import type { BoqItemDTO } from "@shared/types";

// cost.feeSummary 的单方造价指标：台账「建筑面积」>0 时按 元/㎡ 出指标，写进视图与回复。
const mocks = vi.hoisted(() => ({ items: vi.fn(), facts: vi.fn(), fact: vi.fn(), fees: vi.fn(), files: vi.fn() }));
vi.mock("@database/client", () => ({ prisma: { projectFile: { findMany: mocks.files } } }));
vi.mock("@boq/service", () => ({ listBoq: mocks.items, updateBoqItems: vi.fn() }));
vi.mock("@project/facts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@project/facts")>();
  return { ...orig, getFacts: mocks.facts, getFact: mocks.fact, loadFeeParams: mocks.fees, setFact: vi.fn() };
});
const rateMocks = vi.hoisted(() => ({ rates: vi.fn() }));
vi.mock("@dataset/service", () => ({ getMeasureFeeRates: rateMocks.rates }));
import "@agent/tools/costTools";
import { setFact } from "@project/facts";

const ctx: ToolContext = { projectId: "p1", runId: "r1", userId: "u", emit: vi.fn() };
type Obs = { indicators?: { label: string; value: string }[]; grandTotal?: string; error?: string };
const obs = (r: { observation: unknown }) => r.observation as Obs;
const item = (patch: Partial<BoqItemDTO>): BoqItemDTO => ({
  id: "i1", projectId: "p1", fileId: "f1", sheetName: "清单", rowIndex: 2,
  code: "030001", name: "镀锌钢管", rawFeature: "DN100", unit: "m", quantity: "1000", unitPrice: "12000",
  mainMaterialPrice: "0", laborUnitPrice: "0", machineUnitPrice: "0", pricingPlan: [], totalPrice: "12000000",
  feeType: "分部分项", sectionPath: "", isHeader: false, sortOrder: 0, discipline: "PLUMBING", features: {}, ...patch,
});
const fees = (tax: number) => ({
  measureRate: new Decimal(0), regulationRate: new Decimal(0), provisionalRate: new Decimal(0),
  provisionalAmount: new Decimal(0), taxRate: new Decimal(tax), addonRate: new Decimal(0),
  laborBase: null, laborAdjustRate: new Decimal(0), coeffMeasureFee: new Decimal(0),
  set: { measure: false, regulation: false, provisional: false, tax: tax > 0 },
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.items.mockResolvedValue([item({})]);
  mocks.files.mockResolvedValue([{ id: "f1", filename: "清单.xlsx" }]);
  mocks.fees.mockResolvedValue(fees(0.09));
});

describe("cost.feeSummary 单方造价指标", () => {
  it("有建筑面积 → 出 含税/税前 单方造价指标并进视图", async () => {
    mocks.facts.mockResolvedValue([{ key: "建筑面积", value: "12000㎡", source: "USER_PROVIDED" }]);
    const r = await getTool("cost.feeSummary")!.handler!(ctx, {});
    // 税前 1200万 ÷ 12000㎡ = 1000 元/㎡；含税 1308万 ÷ 12000㎡ = 1090 元/㎡
    expect(obs(r).indicators).toEqual([
      { label: "建筑面积", value: "12000 ㎡" },
      { label: "单方造价(含税)", value: "1090.00 元/㎡" },
      { label: "单方造价(税前)", value: "1000.00 元/㎡" },
    ]);
    expect((r.views?.[0] as { indicators?: unknown }).indicators).toEqual(obs(r).indicators);
    expect(r.message).toContain("1090.00 元/㎡");
  });

  it("面积事实缺失或非法 → 不出指标", async () => {
    mocks.facts.mockResolvedValue([]);
    const r1 = await getTool("cost.feeSummary")!.handler!(ctx, {});
    expect(obs(r1).indicators).toBeUndefined();
    expect(r1.message).not.toContain("元/㎡");

    mocks.facts.mockResolvedValue([{ key: "建筑面积", value: "待定", source: "USER_PROVIDED" }]);
    const r2 = await getTool("cost.feeSummary")!.handler!(ctx, {});
    expect(obs(r2).indicators).toBeUndefined();
  });

  it("面积接受 万 口径（「1.2万平米」= 12000）", async () => {
    mocks.facts.mockResolvedValue([{ key: "建筑面积", value: "1.2万平米", source: "USER_PROVIDED" }]);
    const r = await getTool("cost.feeSummary")!.handler!(ctx, {});
    expect(obs(r).indicators?.[1].value).toBe("1090.00 元/㎡");
  });
});

describe("cost.measureFees 台账写回", () => {
  it("计取为 0 也写台账——清掉上一轮残留，防 feeSummary 虚增", async () => {
    // 只有「系统调整费」费率且未启用 → total = 0.00
    rateMocks.rates.mockResolvedValue([{
      fyid: 1, name: "采暖系统调整费", book: "5H", category: "系统调整费",
      base: "定额人工费*费率", baseWithMachine: false,
      tiers: [{ tier: "-", rate: 0.15, laborPct: 25, materialPct: 65, machinePct: 10 }],
    }]);
    mocks.fact.mockImplementation(async (_p: string, key: string) =>
      key === "定额人工费明细" ? { value: JSON.stringify({ "5H": "1000.00" }) } : null);
    const r = await getTool("cost.measureFees")!.handler!(ctx, {});
    const calls = vi.mocked(setFact).mock.calls.map((c) => c[1] as { key: string; value: string });
    expect(calls.find((c) => c.key === "系数措施费")?.value).toBe("0.00");
    expect(calls.find((c) => c.key === "系数措施费明细")?.value).toBe("[]");
    expect(r.message).toContain("已清为 0");
  });
});
