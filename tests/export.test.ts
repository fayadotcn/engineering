import { beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { buildExportWorkbook, writeBackPrices } from "@file/excel";
import type { BoqItemDTO } from "@shared/types";
import { getTool, type ToolContext } from "@agent/tools/registry";

const mocks = vi.hoisted(() => ({ files: vi.fn(), file: vi.fn(), items: vi.fn(), put: vi.fn(), get: vi.fn(), artifact: vi.fn(), inspect: vi.fn(), feeParams: vi.fn() }));
vi.mock("@database/client", () => ({ prisma: { projectFile: { findMany: mocks.files, findUnique: mocks.file }, artifact: { create: mocks.artifact } } }));
vi.mock("@boq/service", () => ({ listBoq: mocks.items }));
vi.mock("@project/facts", () => ({ loadFeeParams: mocks.feeParams }));
vi.mock("@file/storage", () => ({ storage: { put: mocks.put, get: mocks.get } }));
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
    // J=主材暂估价（表-08「其中暂估价」口径）；K=定价状态：可计价行显式标已定价/未定价，非计价行留白；未定价行整行淡琥珀底色
    expect(wb.worksheets[1].getCell("K3").value).toBe("已定价");
    expect(wb.worksheets[1].getCell("K4").value).toBe("");
    expect(wb.worksheets[1].getCell("L4").value).toBe("总价措施");
    // M=单位工程（无归属留白），N=源文件，O=源工作表
    expect(wb.worksheets[1].getCell("N4").value).toBe("招标清单.xlsx");
    expect(wb.worksheets[1].getCell("K5").value).toBe("未定价");
    expect((wb.worksheets[1].getRow(5).getCell(1).fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFFF7E0");
    expect(wb.worksheets[2].getCell("N2").value).toBe("结算清单.xlsx");
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
    await expect(writeBackPrices(original, [{ sheetName: "安装", rowIndex: 2, totalPrice: "abc" }], { 安装: { totalPrice: 3 } })).rejects.toThrow("写回数值无效");
  });

  it("无源表坐标的行（rowIndex=-1 复制/补录行）跳过而非中止整本写回", async () => {
    const book = new ExcelJS.Workbook(); const ws = book.addWorksheet("安装");
    ws.addRow(["项目", "工程量", "综合单价", "合价"]);
    ws.addRow(["设备", 2, 10, 20]);
    const original = Buffer.from(await book.xlsx.writeBuffer());
    // 历史坑：复制行带 fileId 但 rowIndex=-1，getRow(-1) 抛 Invalid Address
    // 会让整次写回失败——现在跳过它、其余行照常写
    const wb = await load(await writeBackPrices(original, [
      { sheetName: "安装", rowIndex: -1, unitPrice: "99", totalPrice: "99" },
      { sheetName: "安装", rowIndex: 0, unitPrice: "98" },
      { sheetName: "安装", rowIndex: 2, unitPrice: "12.5", totalPrice: "25" },
    ], { 安装: { quantity: 1, unitPrice: 2, totalPrice: 3 } }));
    expect(wb.worksheets[0].getCell("C2").value).toBe(12.5);
    expect(wb.worksheets[0].getCell("D2").value).toBe(25);
  });

  it("写回不覆盖源表「详见…」注解格，总额计价行只写合价", async () => {
    const book = new ExcelJS.Workbook();
    const ws = book.addWorksheet("措施");
    ws.addRow(["项目名称", "费率%", "合价", "工程量"]);
    ws.addRow(["安全文明施工费", 0.05, "详见本标准表 E.4.2", "项"]); // row 2：注解+费率+单位原文
    ws.addRow(["夜间施工增加费", 0.02, 800, "项"]);               // row 3：真金额
    mocks.get.mockResolvedValue(Buffer.from(await book.xlsx.writeBuffer()));
    mocks.file.mockResolvedValue({
      id: "f1", projectId: "p1", filename: "清单.xlsx", storageKey: "k1",
      meta: JSON.stringify({ mapping: { 措施: { columns: { unitPrice: 1, totalPrice: 2, quantity: 3 } } } }),
    });
    mocks.items.mockResolvedValue([
      // 金额格是注解 → 导入落 0 且 __nonNumeric 留痕；写 0 会抹掉「详见」原文
      item({ id: "fee", sheetName: "措施", rowIndex: 2, feeType: "总价措施", name: "安全文明施工费",
             quantity: "0", unitPrice: "0", totalPrice: "0", rawCells: { __nonNumeric: ["totalPrice"] } }),
      item({ id: "night", sheetName: "措施", rowIndex: 3, feeType: "总价措施", name: "夜间施工增加费",
             quantity: "0", unitPrice: "0", totalPrice: "950" }),
    ]);
    const result = await getTool("excel.write")!.handler!(ctx, { fileId: "f1" });
    expect(result.observation).toMatchObject({ writtenRows: 1, skippedAnnotated: 1 });
    const w = (await load(mocks.put.mock.calls[0][0])).getWorksheet("措施")!;
    expect(w.getCell("B2").value).toBe(0.05);                     // 费率格不被结构 0 覆盖
    expect(w.getCell("C2").value).toBe("详见本标准表 E.4.2");     // 注解原文保留
    expect(w.getCell("D2").value).toBe("项");                     // 量列原文保留
    expect(w.getCell("C3").value).toBe(950);                      // 真合价照常写回
    expect(w.getCell("B3").value).toBe(0.02);                     // 另一行费率同样不动
  });

  it("可计价行源格是非数值注解且量仍为 0 时跳过该格", async () => {
    const book = new ExcelJS.Workbook();
    const ws = book.addWorksheet("清单");
    ws.addRow(["名称", "工程量", "综合单价", "合价"]);
    ws.addRow(["临时设施", "按图计算", "", ""]); // row 2：量格是注解
    mocks.get.mockResolvedValue(Buffer.from(await book.xlsx.writeBuffer()));
    mocks.file.mockResolvedValue({
      id: "f1", projectId: "p1", filename: "清单.xlsx", storageKey: "k1",
      meta: JSON.stringify({ mapping: { 清单: { columns: { quantity: 1, unitPrice: 2, totalPrice: 3 } } } }),
    });
    mocks.items.mockResolvedValue([
      item({ sheetName: "清单", rowIndex: 2, quantity: "0", unitPrice: "60",
             totalPrice: "0", rawCells: { __nonNumeric: ["quantity"] } }),
    ]);
    await getTool("excel.write")!.handler!(ctx, { fileId: "f1" });
    const w = (await load(mocks.put.mock.calls[0][0])).getWorksheet("清单")!;
    expect(w.getCell("B2").value).toBe("按图计算"); // 量注解保留
    expect(w.getCell("C2").value).toBe(60);        // 单价正常写回
  });
});
