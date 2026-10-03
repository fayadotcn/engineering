import { beforeEach, describe, expect, it, vi } from "vitest";
import Decimal from "decimal.js";
import ExcelJS from "exceljs";
import { getTool, type ToolContext } from "@agent/tools/registry";
import type { BoqItemDTO } from "@shared/types";

// report.generate：主要材料表两路归集（定额组价主材行 + 主材暂估价）+ 项目汇总写单方造价。
const mocks = vi.hoisted(() => ({
  items: vi.fn(), facts: vi.fn(), fact: vi.fn(), fees: vi.fn(),
  files: vi.fn(), file: vi.fn(), put: vi.fn(), artifact: vi.fn(), inspect: vi.fn(),
  quotes: vi.fn(),
}));
vi.mock("@database/client", () => ({ prisma: { projectFile: { findMany: mocks.files, findUnique: mocks.file }, artifact: { create: mocks.artifact } } }));
vi.mock("@boq/service", () => ({ listBoq: mocks.items }));
vi.mock("@material/service", () => ({ listQuotations: mocks.quotes }));
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
  laborBase: null, laborAdjustRate: new Decimal(0), coeffMeasureFee: new Decimal(0),
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
  mocks.quotes.mockResolvedValue([]);
});

describe("report.generate 主要材料表与单方造价", () => {
  it("定额组价主材行归集：数量=清单量×耗量，按合价降序", async () => {
    mocks.items.mockResolvedValue([
      item({
        pricingPlan: [
          { quotaCode: "5A0001", quotaName: "钢管安装", labor: "10", materialAux: "2", machine: "1", fee: "3", subtotal: "67.04", mainMaterialName: "镀锌钢管", mainQty: "1.02", mainPrice: "50", suggested: false },
          { quotaCode: "5A0002", quotaName: "套管", labor: "5", materialAux: "1", machine: "0", fee: "1", subtotal: "106", mainMaterialName: "建议项不算", mainQty: "1", mainPrice: "99", suggested: true },
        ],
      }),
      item({
        id: "i2", name: "阀门", quantity: "4", totalPrice: "400", unitPrice: "100",
        pricingPlan: [{ quotaCode: "5A0003", quotaName: "阀门安装", labor: "8", materialAux: "1", machine: "0", fee: "2", subtotal: "91", mainMaterialName: "闸阀", mainQty: "1", mainPrice: "80", suggested: false }],
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
    expect(String((r.views?.[0] as { summary?: string } | undefined)?.summary)).toContain("主要材料表");
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
  mocks.quotes.mockResolvedValue([]);
    await getTool("report.generate")!.handler!(ctx, {});
    wb = await load(mocks.put.mock.calls[1][0]);
    const labels2: string[] = [];
    wb.getWorksheet("项目汇总")!.eachRow((row) => labels2.push(String((row.values as unknown[])[1] ?? "")));
    expect(labels2).not.toContain("单方造价（元/㎡，含税）");
  });

  it("异常摘要覆盖全部检查维度 + 费用符合性行", async () => {
    mocks.items.mockResolvedValue([
      item({ id: "a1", name: "镀锌钢管", quantity: "10", unitPrice: "85", totalPrice: "999" }), // 算术不符：10×85=850≠999
      item({ id: "a2", name: "镀锌钢管", quantity: "5", unitPrice: "92", totalPrice: "460" }),  // 相同项不同价（同规格特征空）
      item({ id: "a3", name: "镀锌钢管", quantity: "8", unitPrice: "85", totalPrice: "680", code: "C1" }),
      item({ id: "a4", name: "阀门", quantity: "2", unitPrice: "100", totalPrice: "200", code: "C1" }), // 一码多名
    ]);
    const r = await getTool("report.generate")!.handler!(ctx, {});
    const wb = await load(mocks.put.mock.calls[0][0]);
    const s5 = wb.getWorksheet("异常摘要")!;
    const types: string[] = [];
    s5.eachRow((row) => types.push(String((row.values as unknown[])[1] ?? "")));
    expect(types).toContain("合价算术不符");
    expect(types).toContain("一码多名");
    // taxRate=0.09 / regulationRate=0 → 规费未计取 + 措施费未计取 出现在符合性提示
    expect(types).toContain("符合性提示");
    expect((r.observation as { grandTotal?: string }).grandTotal).toBeTruthy();
  });

  it("综合单价分析表：已确认子目分解人材机管利，建议行不入表", async () => {
    mocks.items.mockResolvedValue([
      item({
        pricingPlan: [
          { quotaCode: "5A0001", quotaName: "钢管安装", labor: "10", materialAux: "2", machine: "1", fee: "3", subtotal: "67.04", mainMaterialName: "镀锌钢管", mainQty: "1.02", mainPrice: "50" },
          { quotaCode: "5A0002", quotaName: "冲洗消毒", labor: "5", materialAux: "1", machine: "0", fee: "1", subtotal: "7", mainMaterialName: null, mainQty: null, mainPrice: null, suggested: true },
        ],
      }),
      item({ id: "i2", name: "无组价项", pricingPlan: [] }),
    ]);
    const r = await getTool("report.generate")!.handler!(ctx, {});
    const wb = await load(mocks.put.mock.calls[0][0]);
    const sP = wb.getWorksheet("综合单价分析");
    expect(sP).toBeTruthy();
    const rows: (string | number)[][] = [];
    sP!.eachRow((row) => rows.push((row.values as (string | number)[]).slice(1)));
    const line = rows.find((x) => x[2] === "5A0001")!;
    expect(line[5]).toBeCloseTo(10);   // 人工费
    expect(line[7]).toBeCloseTo(51);   // 主材费 = 50×1.02
    expect(line[10]).toBeCloseTo(67.04); // 小计
    expect(rows.some((x) => x[2] === "5A0002")).toBe(false); // suggested 不入表
    expect(rows.some((x) => String(x[3]).includes("综合单价"))).toBe(true); // 合计行
    expect(String((r.views?.[0] as { summary?: string } | undefined)?.summary)).toContain("综合单价分析");
  });

  it("清单为空 → 不生成报告", async () => {
    mocks.items.mockResolvedValue([]);
    const r = await getTool("report.generate")!.handler!(ctx, {});
    expect((r.observation as { error?: string }).error).toContain("清单为空");
    expect(mocks.put).not.toHaveBeenCalled();
  });
});

describe("report.generate 甲供材表", () => {
  it("甲供材行命中已计主材价的清单项 → 标「重复计价」", async () => {
    mocks.items.mockResolvedValue([item({ name: "镀锌钢管", mainMaterialPrice: "80", features: { material: "镀锌钢管", brand: "国标", tokens: ["dn100", "镀锌", "钢管"] } })]);
    mocks.quotes.mockResolvedValue([{ id: "q1", fileId: "f1", materialName: "镀锌钢管", spec: "DN100", brand: "国标", unit: "m", price: "75", sheetName: "甲供", features: { material: "镀锌钢管", brand: "国标", tokens: ["dn100", "镀锌", "钢管"] } }]);
    const r = await getTool("report.generate")!.handler!(ctx, {});
    const wb = await load(mocks.put.mock.calls[0][0]);
    const sO = wb.getWorksheet("甲供材表");
    expect(sO).toBeTruthy();
    const cells: string[] = [];
    sO!.eachRow((row) => cells.push(String((row.values as unknown[]).slice(1).join("|"))));
    expect(cells.some((c) => c.includes("重复计价"))).toBe(true);
    expect(String((r.views?.[0] as { summary?: string } | undefined)?.summary)).toContain("甲供材表");
    // 异常摘要同样留痕
    const sA = wb.getWorksheet("异常摘要");
    const aCells: string[] = [];
    sA!.eachRow((row) => aCells.push(String((row.values as unknown[]).slice(1).join("|"))));
    expect(aCells.some((c) => c.includes("甲供材重复计价") && c.includes("镀锌钢管"))).toBe(true);
  });
  it("甲供材行未命中清单 → 标「未命中清单」", async () => {
    mocks.items.mockResolvedValue([item({ name: "镀锌钢管" })]);
    mocks.quotes.mockResolvedValue([{ id: "q1", fileId: "f1", materialName: "橡塑保温管壳", spec: "", brand: "", unit: "m3", price: "900", sheetName: "甲供", features: {} }]);
    await getTool("report.generate")!.handler!(ctx, {});
    const wb = await load(mocks.put.mock.calls[0][0]);
    const cells: string[] = [];
    wb.getWorksheet("甲供材表")!.eachRow((row) => cells.push(String((row.values as unknown[]).slice(1).join("|"))));
    expect(cells.some((c) => c.includes("未命中清单"))).toBe(true);
  });
  it("无甲供材行 → 不出该 sheet", async () => {
    mocks.items.mockResolvedValue([item({})]);
    mocks.quotes.mockResolvedValue([]);
    await getTool("report.generate")!.handler!(ctx, {});
    const wb = await load(mocks.put.mock.calls[0][0]);
    expect(wb.getWorksheet("甲供材表")).toBeUndefined();
  });
});

describe("report.generate 措施与其他项目表", () => {
  it("总价措施/其他项目行单列成表并带合计", async () => {
    mocks.items.mockResolvedValue([
      item({ name: "镀锌钢管" }),
      item({ id: "i9", name: "安全文明施工费", feeType: "总价措施", quantity: "1", unitPrice: "0", totalPrice: "5000" }),
      item({ id: "i10", name: "暂列金额", feeType: "其他项目", quantity: "1", unitPrice: "0", totalPrice: "30000" }),
    ]);
    await getTool("report.generate")!.handler!(ctx, {});
    const wb = await load(mocks.put.mock.calls[0][0]);
    const sL = wb.getWorksheet("措施与其他项目");
    expect(sL).toBeTruthy();
    const cells: string[] = [];
    sL!.eachRow((row) => cells.push(String((row.values as unknown[]).slice(1).join("|"))));
    expect(cells.some((c) => c.includes("安全文明施工费") && c.includes("总价措施"))).toBe(true);
    expect(cells.some((c) => c.includes("暂列金额") && c.includes("其他项目"))).toBe(true);
    expect(cells.some((c) => c.includes("合计") && c.includes("35000"))).toBe(true);
    // 不进分部分项表
    const sB = wb.getWorksheet("分部分项清单")!;
    const bCells: string[] = [];
    sB.eachRow((row) => bCells.push(String((row.values as unknown[]).slice(1).join("|"))));
    expect(bCells.some((c) => c.includes("安全文明施工费"))).toBe(false);
  });
  it("无总额计价行 → 不出该 sheet", async () => {
    mocks.items.mockResolvedValue([item({})]);
    await getTool("report.generate")!.handler!(ctx, {});
    const wb = await load(mocks.put.mock.calls[0][0]);
    expect(wb.getWorksheet("措施与其他项目")).toBeUndefined();
  });
});

describe("report.generate 单位工程汇总", () => {
  it("多个单位工程 → 出汇总 sheet 带合计", async () => {
    mocks.items.mockResolvedValue([
      item({ id: "i1", unitProject: "1#楼", totalPrice: "1000" }),
      item({ id: "i2", unitProject: "2#楼", totalPrice: "2000" }),
    ]);
    await getTool("report.generate")!.handler!(ctx, {});
    const wb = await load(mocks.put.mock.calls[0][0]);
    const sU = wb.getWorksheet("单位工程汇总");
    expect(sU).toBeTruthy();
    const cells: string[] = [];
    sU!.eachRow((row) => cells.push(String((row.values as unknown[]).slice(1).join("|"))));
    expect(cells.some((c) => c.includes("1#楼") && c.includes("1000"))).toBe(true);
    expect(cells.some((c) => c.includes("合计") && c.includes("3000"))).toBe(true);
  });
  it("单一未注明单位工程 → 不出该 sheet", async () => {
    mocks.items.mockResolvedValue([item({})]);
    await getTool("report.generate")!.handler!(ctx, {});
    const wb = await load(mocks.put.mock.calls[0][0]);
    expect(wb.getWorksheet("单位工程汇总")).toBeUndefined();
  });
});
