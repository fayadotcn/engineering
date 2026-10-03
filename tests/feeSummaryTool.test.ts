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
import "@agent/tools/costTools";

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
