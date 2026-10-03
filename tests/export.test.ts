import { beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { buildExportWorkbook, writeBackPrices } from "@file/excel";
import type { BoqItemDTO } from "@shared/types";
import { getTool, type ToolContext } from "@agent/tools/registry";

const mocks = vi.hoisted(() => ({ files: vi.fn(), file: vi.fn(), items: vi.fn(), put: vi.fn(), artifact: vi.fn(), inspect: vi.fn(), feeParams: vi.fn() }));
vi.mock("@database/client", () => ({ prisma: { projectFile: { findMany: mocks.files, findUnique: mocks.file }, artifact: { create: mocks.artifact } } }));
vi.mock("@boq/service", () => ({ listBoq: mocks.items }));
vi.mock("@project/facts", () => ({ loadFeeParams: mocks.feeParams }));
vi.mock("@file/storage", () => ({ storage: { put: mocks.put } }));
vi.mock("@file/inspection", () => ({ ensureInspection: mocks.inspect, mappingToView: vi.fn() }));
import "@agent/tools/excelTools";

const ctx: ToolContext = { projectId: "p1", runId: "r1", userId: "user", emit: vi.fn() };
const item = (patch: Partial<BoqItemDTO>): BoqItemDTO => ({
  id: "i1", projectId: "p1", fileId: "f1", sheetName: "清单", rowIndex: 2,
  code: "030001", name: "镀锌钢管", rawFeature: "DN100", unit: "m", quantity: "10", unitPrice: "50",
  mainMaterialPrice: "0", laborUnitPrice: "0", machineUnitPrice: "0", pricingPlan: [], totalPrice: "500", feeType: "分部分项", sectionPath: "",
  isHeader: false, sortOrder: 0, discipline: "PLUMBING", features: {}, ...patch,
});
const load = async (buffer: Buffer) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
};
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.files.mockResolvedValue([{ id: "f1", filename: "招标清单.xlsx" }, { id: "f2", filename: "结算清单.xlsx" }]);
  const { D } = await import("@cost-engine/money");
  mocks.feeParams.mockResolvedValue({
    measureRate: D(0), regulationRate: D(0), provisionalRate: D(0), provisionalAmount: D(0),
    taxRate: D(0.09), addonRate: D(0), laborBase: null, laborAdjustRate: D(0), coeffMeasureFee: D(0),
    set: { measure: false, regulation: false, provisional: false, tax: true },
  });
  mocks.put.mockResolvedValue("export.xlsx");
  mocks.artifact.mockImplementation(async ({ data }) => ({ id: "a1", ...data }));
});

describe("可追溯的清单导出", () => {
  it("不同文件的同名表分别导出，保留类别与来源，标题行不占清单序号", async () => {
    mocks.items.mockResolvedValue([
      item({ id: "header", isHeader: true, name: "给排水工程" }),
      item({ sortOrder: 1, quantity: "41", quantityExpr: "3层×12个+5" }),
      item({ id: "fee", sortOrder: 2, feeType: "总价措施", name: "安全文明施工费", quantity: "0", unitPrice: "0", totalPrice: "1250.50" }),
      item({ id: "noprice", sortOrder: 3, unitPrice: "0", totalPrice: "0" }),
      item({ id: "i2", fileId: "f2", totalPrice: "600", unitPrice: "60" }),
    ]);
    const result = await getTool("report.exportExcel")!.handler!(ctx, {});
    expect(result.receipts?.[0].actionType).toBe("EXPORT");
    const wb = await load(mocks.put.mock.calls[0][0]);
    // 首页固定费用汇总（交付口径），其后按源表分页
    expect(wb.worksheets.map(s => s.name)).toEqual(["费用汇总", "清单", "清单 (2)"]);
    const feeWs = wb.worksheets[0];
    const feeRows: string[] = [];
    feeWs.eachRow((r) => { const v = r.getCell(5).value; if (typeof v === "number") feeRows.push(String(r.getCell(2).value)); });
    expect(feeRows).toContain("税前工程造价");
    expect(wb.worksheets[1].getCell("A2").value).toBe("");
    expect(wb.worksheets[1].getCell("A3").value).toBe("1");
    expect(wb.worksheets[1].getCell("B3").value).toBe("030001");
    expect(wb.worksheets[1].getCell("F3").value).toBe(41);
    expect(wb.worksheets[1].getCell("G3").value).toBe("3层×12个+5");
    expect(wb.worksheets[1].getCell("G4").value).toBe("");
    expect(wb.worksheets[1].getCell("I4").value).toBe(1250.5);
    // J=定价状态：可计价行显式标已定价/未定价，非计价行留白；未定价行整行淡琥珀底色
    expect(wb.worksheets[1].getCell("J3").value).toBe("已定价");
    expect(wb.worksheets[1].getCell("J4").value).toBe("");
    expect(wb.worksheets[1].getCell("K4").value).toBe("总价措施");
    // L=单位工程（无归属留白），M=源文件，N=源工作表
    expect(wb.worksheets[1].getCell("M4").value).toBe("招标清单.xlsx");
    expect(wb.worksheets[1].getCell("J5").value).toBe("未定价");
    expect((wb.worksheets[1].getRow(5).getCell(1).fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFFF7E0");
    expect(wb.worksheets[2].getCell("M2").value).toBe("结算清单.xlsx");
    expect(wb.worksheets[2].getCell("I2").value).toBe(600);
  });

  it("超长、非法及忽略大小写后的重复表名仍能完整导出", async () => {
    const names = ["长表名".repeat(15), "长表名".repeat(15) + "甲", "a/b", "a?b", "Sheet", "sheet", "''"];
    const wb = await load(await buildExportWorkbook(names.map((sheetName, index) => ({
      sheetName, columns: {}, headerLabels: ["项目名称", "合价"],
      rows: [{ rowIndex: 2, isHeader: false, values: { 项目名称: `行${index}`, 合价: "12.50" } }],
    }))));
    expect(wb.worksheets).toHaveLength(names.length);
    expect(new Set(wb.worksheets.map(s => s.name.toLowerCase())).size).toBe(names.length);
    for (const ws of wb.worksheets) { expect(ws.name.length).toBeLessThanOrEqual(31); expect(ws.getCell("B2").value).toBe(12.5); }
  });

  it("跨项目文件不能被读取映射或导出写回", async () => {
    mocks.file.mockResolvedValue({ id: "foreign", projectId: "p2", filename: "清单.xlsx" });
    for (const name of ["excel.mapColumns", "excel.write"])
      await expect(getTool(name)!.handler!(ctx, { fileId: "foreign" })).rejects.toThrow(/当前项目/);
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("源表写回只更新映射单元格，保留其他内容和样式", async () => {
    const book = new ExcelJS.Workbook(); const ws = book.addWorksheet("安装");
    ws.addRow(["项目", "工程量", "综合单价", "合价", "备注"]);
    ws.addRow(["设备", 2, 10, 20, "需保留"]); ws.getCell("E2").font = { bold: true };
    const original = Buffer.from(await book.xlsx.writeBuffer());
    const wb = await load(await writeBackPrices(original, [{ sheetName: "安装", rowIndex: 2, quantity: "3", quantityExpr: "3层×12个-33", unitPrice: "12.5", totalPrice: "37.5" }], { 安装: { quantity: 1, unitPrice: 2, totalPrice: 3 } }));
    expect(wb.worksheets[0].getCell("B2").value).toBe(3);
    expect(String(wb.worksheets[0].getCell("B2").note)).toContain("3层×12个-33");
    expect(wb.worksheets[0].getCell("D2").value).toBe(37.5);
    expect(wb.worksheets[0].getCell("E2").value).toBe("需保留");
    expect(wb.worksheets[0].getCell("E2").font.bold).toBe(true);
    await expect(writeBackPrices(original, [{ sheetName: "不存在", rowIndex: 2, totalPrice: "1" }], {})).rejects.toThrow("找不到工作表");
    await expect(writeBackPrices(original, [{ sheetName: "安装", rowIndex: 2, totalPrice: "1" }], {})).rejects.toThrow("没有已确认");
    await expect(writeBackPrices(Buffer.from("损坏的文件"), [], {})).rejects.toThrow("无法保留原格式");
  });
});
