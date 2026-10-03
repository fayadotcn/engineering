import { beforeEach, describe, expect, it, vi } from "vitest";
import Decimal from "decimal.js";
import ExcelJS from "exceljs";
import { getTool, type ToolContext } from "@agent/tools/registry";
import type { BoqItemDTO } from "@shared/types";

// report.generate：主要材料表两路归集（定额组价主材行 + 主材暂估价）+ 项目汇总写单方造价。
const mocks = vi.hoisted(() => ({
  items: vi.fn(), facts: vi.fn(), fact: vi.fn(), fees: vi.fn(),
  files: vi.fn(), file: vi.fn(), put: vi.fn(), artifact: vi.fn(), inspect: vi.fn(),
}));
vi.mock("@database/client", () => ({ prisma: { projectFile: { findMany: mocks.files, findUnique: mocks.file }, artifact: { create: mocks.artifact } } }));
vi.mock("@boq/service", () => ({ listBoq: mocks.items }));
vi.mock("@file/storage", () => ({ storage: { put: mocks.put } }));
vi.mock("@file/inspection", () => ({ ensureInspection: mocks.inspect, mappingToView: vi.fn() }));
vi.mock("@project/facts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@project/facts")>();
  return { ...orig, getFacts: mocks.facts, getFact: mocks.fact, loadFeeParams: mocks.fees, setFact: vi.fn() };
});
import "@agent/tools/excelTools";

const ctx: ToolContext = { projectId: "p1", runId: "r1", userId: "u", emit: vi.fn() };
const item = (patch: Partial<BoqItemDTO>): BoqItemDTO => ({
  id: "i1", projectId: "p1", fileId: "f1", sheetName: "清单", rowIndex: 2,
  code: "030001", name: "镀锌钢管", rawFeature: "DN100", unit: "m", quantity: "10", unitPrice: "120",
  mainMaterialPrice: "0", laborUnitPrice: "0", machineUnitPrice: "0", pricingPlan: [], totalPrice: "1200",
  feeType: "分部分项", sectionPath: "", isHeader: false, sortOrder: 0, discipline: "PLUMBING", features: {}, ...patch,
});
const fees = () => ({
  measureRate: new Decimal(0), regulationRate: new Decimal(0), provisionalRate: new Decimal(0),
  provisionalAmount: new Decimal(0), taxRate: new Decimal(0.09), addonRate: new Decimal(0),
  laborBase: null, coeffMeasureFee: new Decimal(0),
  set: { measure: false, regulation: false, provisional: false, tax: true },
});
const load = async (buffer: Buffer) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.files.mockResolvedValue([{ id: "f1", filename: "清单.xlsx" }]);
  mocks.put.mockResolvedValue("report.xlsx");
  mocks.artifact.mockImplementation(async ({ data }) => ({ id: "a1", ...data }));
  mocks.fees.mockResolvedValue(fees());
  mocks.facts.mockResolvedValue([]);
});

describe("report.generate 主要材料表与单方造价", () => {
  it("定额组价主材行归集：数量=清单量×耗量，按合价降序", async () => {
    mocks.items.mockResolvedValue([
      item({
        pricingPlan: [
          { quotaCode: "5A0001", quotaName: "钢管安装", quantity: 1, labor: 10, materialAux: 2, machine: 1, mainMaterialName: "镀锌钢管", mainQty: 1.02, mainPrice: 50, suggested: false },
          { quotaCode: "5A0002", quotaName: "套管", quantity: 1, labor: 5, materialAux: 1, machine: 0, mainMaterialName: "建议项不算", mainQty: 1, mainPrice: 99, suggested: true },
        ],
      }),
      item({
        id: "i2", name: "阀门", quantity: "4", totalPrice: "400", unitPrice: "100",
        pricingPlan: [{ quotaCode: "5A0003", quotaName: "阀门安装", quantity: 1, labor: 8, materialAux: 1, machine: 0, mainMaterialName: "闸阀", mainQty: 1, mainPrice: 80, suggested: false }],
      }),
    ]);
    const r = await getTool("report.generate")!.handler!(ctx, {});
    const wb = await load(mocks.put.mock.calls[0][0]);
    const sM = wb.getWorksheet("主要材料表");
    expect(sM).toBeTruthy();
    const rows: (string | number)[][] = [];
    sM!.eachRow((row) => rows.push((row.values as (string | number)[]).slice(1)));
    // 闸阀 4×1×80=320 > 镀锌钢管 10×1.02×50=510 → 钢管在前
    expect(rows[1][1]).toBe("镀锌钢管");
    expect(rows[1][4]).toBeCloseTo(10.2); // 数量=10×1.02
    expect(rows[1][6]).toBeCloseTo(510);  // 合价
    expect(rows[1][7]).toBe("定额组价");
    expect(rows[2][1]).toBe("闸阀");
    expect(rows.some((x) => x.includes("建议项不算"))).toBe(false);
    expect(r.views?.[0] && String(r.views[0].summary)).toContain("主要材料表");
  });

  it("无主材价的组价方案退回主材暂估价口径", async () => {
    mocks.items.mockResolvedValue([
      item({ mainMaterialPrice: "66.5", features: { material: "钢管", diameter: "DN100" } }),
    ]);
    await getTool("report.generate")!.handler!(ctx, {});
    const wb = await load(mocks.put.mock.calls[0][0]);
    const sM = wb.getWorksheet("主要材料表");
    const vals = (sM!.getRow(2).values as (string | number)[]).slice(1);
    expect(vals[1]).toBe("钢管");
    expect(vals[2]).toBe("DN100");
    expect(vals[4]).toBeCloseTo(10);
    expect(vals[5]).toBeCloseTo(66.5);
    expect(vals[7]).toBe("主材暂估价");
  });

  it("项目汇总带建筑面积与单方造价；无面积不写指标行", async () => {
    mocks.items.mockResolvedValue([item({})]);
    mocks.facts.mockResolvedValue([{ key: "建筑面积", value: "12000", source: "USER_PROVIDED", factType: "PRICING", confidence: 1 }]);
    await getTool("report.generate")!.handler!(ctx, {});
    let wb = await load(mocks.put.mock.calls[0][0]);
    const s1 = wb.getWorksheet("项目汇总")!;
    const labels: string[] = [];
    s1.eachRow((row) => labels.push(String((row.values as unknown[])[1] ?? "")));
    expect(labels).toContain("建筑面积（㎡）");
    expect(labels).toContain("单方造价（元/㎡，含税）");
    // 含税 1200×1.09=1308 ÷12000 = 0.109 → 0.11（eachRow 跳过空行，行号按实际单元格定位）
    let unit: number | null = null;
    s1.eachRow((row) => {
      if (String((row.values as unknown[])[1] ?? "") === "单方造价（元/㎡，含税）")
        unit = Number(row.getCell(2).value);
    });
    expect(unit).toBeCloseTo(0.11);

    mocks.facts.mockResolvedValue([]);
    await getTool("report.generate")!.handler!(ctx, {});
    wb = await load(mocks.put.mock.calls[1][0]);
    const labels2: string[] = [];
    wb.getWorksheet("项目汇总")!.eachRow((row) => labels2.push(String((row.values as unknown[])[1] ?? "")));
    expect(labels2).not.toContain("单方造价（元/㎡，含税）");
  });

  it("清单为空 → 不生成报告", async () => {
    mocks.items.mockResolvedValue([]);
    const r = await getTool("report.generate")!.handler!(ctx, {});
    expect(r.observation.error).toContain("清单为空");
    expect(mocks.put).not.toHaveBeenCalled();
  });
});
