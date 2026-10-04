import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { inspectWorkbook, parseWorkbook, type ParsedSheet } from "../file/excel";
import { rowToBoqInput } from "../boq/mapRow";
import { importableRowCount } from "../boq/ingestRules";
import { withImportCounts, type SheetMeta } from "../file/inspection";
import { feeSummary } from "../cost-engine/fees";
import { analyzeCostComposition } from "../cost-engine/costComposition";
import { D } from "../cost-engine/money";
import type { BoqItemDTO } from "../shared/types";

async function wb(rows: unknown[][], sheetName = "Sheet1"): Promise<Buffer> {
  const w = new ExcelJS.Workbook();
  const s = w.addWorksheet(sheetName);
  rows.forEach((r) => s.addRow(r as any[]));
  return Buffer.from(await w.xlsx.writeBuffer());
}
const only = (sheets: ParsedSheet[]) => sheets[0];
const named = (s: ParsedSheet) =>
  s.rows.filter((r) => r.isItem && (r.cells.name ?? "").trim());

// 真实文件回归（匿名化的结构）：这些结构此前会整表 0 行 / 整簿不识别
describe("导入管道真实结构修复", () => {
  it("询价单「名称及规格型号」单列：不再整表 0 行，型号当材料名", async () => {
    const buf = await wb([
      ["序号", "名称及规格型号", "单位", "数量", "含税单价(元)", "含税合价(元)", "品牌/产地"],
      [1, "YJV-8.7/10KV 3*185", "m", 150, 7.19, 1078.5, "三电玉塔"],
      [2, "YJV-8.7/10KV 3*240", "m", 80, 9.1, 728, "三电玉塔"],
      [3, "BV-2.5", "m", 1000, 2.31, 2310, "塔牌"],
    ], "电线电缆");
    const s = only(parseWorkbook(buf));
    expect(s.type).toBe("QUOTATION");
    expect(s.columns.name ?? s.columns.materialName).toBe(1);
    expect(named(s)).toHaveLength(3);
    expect(named(s)[0].cells.name).toContain("YJV");
  });

  it("报价清单表头「单项工作名称」也认名称", async () => {
    const buf = await wb([
      ["中微达信-消防改造清单"],
      ["序号", "单项工作名称", "计量单位", "数量", "单价", "合计"],
      [1, "喷淋头", "只", 19, 53, 1007],
      [2, "镀锌钢管 DN25", "米", 95.63, 42, 4016.46],
      ["", "", "", "", "", ""],
      [3, "镀锌钢管 DN32", "米", 14.41, 55, 792.55],
    ]);
    const s = only(parseWorkbook(buf));
    expect(s.columns.name).toBe(1);
    const items = named(s);
    expect(items).toHaveLength(3);
    expect(items[0].cells.name).toBe("喷淋头");
    expect(items[0].cells.unitPrice).toBe("53");
  });

  it("打印版清单：封面/说明几十行后才出现表头也能识别（表头块拆行）", async () => {
    const rows: unknown[][] = [];
    for (let i = 0; i < 30; i++) rows.push([i === 0 ? "工程名称：某项目" : ""]);
    rows.push(["标段：某标段"]);
    rows.push(["分部分项工程和单价措施项目清单与计价表"]);
    // 表头标签各自一行（打印版稀疏列）
    rows.push(["", "", "", "", ""]);
    rows.push(["", "序号", "", "项目编码", "", "项目名称", "项目特征描述", "", "工程量"]);
    rows.push(["", "", "", "", "", "", "", "", "", "单位"]);
    rows.push(["", "", "", "", "", "", "", "", "", "", "综合单价", "", "合价"]);
    rows.push(["", 1, "", "030411001001", "", "配管", "JDG20", "", 100, "m", 30, "", 3000]);
    rows.push(["", 2, "", "030411001002", "", "配线", "BV2.5", "", 200, "m", 5, "", 1000]);
    const buf = await wb(rows, "1.1 分部分项");
    const s = only(parseWorkbook(buf));
    expect(s.type).toBe("BOQ");
    expect(s.headerRow).toBeGreaterThan(20);
    expect(s.columns.unitPrice).toBeDefined();
    expect(s.columns.totalPrice).toBeDefined();
    const items = named(s);
    expect(items).toHaveLength(2);
    expect(items[0].cells.name).toBe("配管");
    expect(items[0].cells.unitPrice).toBe("30");
    expect(items[0].cells.totalPrice).toBe("3000");
  });

  it("无表头清单：长型号名（>12 字）也认名称列，不再整表 GENERIC", async () => {
    const buf = await wb([
      ["配电箱 F/B1-6AEPZ", "台", 1],
      ["配电箱 F/B1-6AL", "台", 1],
      ["配电箱 F/B1-6LQTSB", "台", 2],
      ["配电箱 F/B1-6PLB", "台", 1],
    ]);
    const s = only(parseWorkbook(buf));
    expect(s.columns.name).toBe(0);
    expect(s.type === "BOQ" || s.type === "PENDING_QUOTE").toBe(true);
    const items = named(s);
    expect(items).toHaveLength(4);
    expect(items[0].cells.name).toContain("配电箱");
  });

  it("只有名称+单位（待询价材料表）：按待报价清单导入而不是丢掉", async () => {
    const buf = await wb([
      ["低噪声离心风机箱PF(Y)-B1-（1-1~2、2-1~2）风量：36000m³/h，全压：660Pa，功率：15KW", "台"],
      ["低噪声离心风机箱PF-B1-1 风量：4000m³/h，全压：400Pa，功率：1.5KW", "台"],
      ["低噪声离心风机箱PF-B1-2 风量：2500m³/h，全压：450Pa，功率：1.1KW", "台"],
      ["低噪声离心风机箱PF-B1-3 风量：3000m³/h，全压：450Pa，功率：1.1KW", "台"],
      ["低噪声离心风机箱PF-B1-4 风量：4000m³/h，全压：450Pa，功率：1.5KW", "台"],
    ]);
    const s = only(parseWorkbook(buf));
    expect(s.type).toBe("PENDING_QUOTE");
    expect(named(s)).toHaveLength(5);
  });

  it("企业定额/标准清单库：不产清单行（否则 7000+ 条 0 量 0 价污染项目）", async () => {
    const rows: unknown[][] = [
      ["企业定额标准清单"],
      ["一级编码", "一级名称", "二级编码", "二级名称", "清单编号", "清单名称", "工作内容", "计算规则", "基本单位", "备注"],
    ];
    for (let i = 1; i <= 20; i++)
      rows.push(["01", "房屋建筑", "0101", "土石方", `01010100${1000 + i}`, `平整场地${i}`, "挖填找平", "按面积计算", "m2", ""]);
    const buf = await wb(rows, "定额");
    const s = only(parseWorkbook(buf));
    expect(s.type).toBe("GENERIC");
    expect(importableRowCount(s)).toBe(0);
  });

  it("同一 sheet 里第二张表（规费税金表）不按首表列位解析", async () => {
    const buf = await wb([
      ["序号", "项目编码", "项目名称", "项目特征", "单位", "工程量", "综合单价", "合价"],
      [1, "030411001001", "配管", "JDG20", "m", 100, 30, 3000],
      [2, "030411001002", "配线", "BV2.5", "m", 200, 5, 1000],
      [],
      ["序号", "项目名称", "计算基础说明", "计算基础", "税率(%)", "金额(元)"],
      [1, "增值税", "分部分项+措施+其他", "", 9, 360],
      [2, "规费", "定额人工费", "", 2, 80],
    ], "表-08 分部分项");
    const s = only(parseWorkbook(buf));
    const items = named(s);
    expect(items).toHaveLength(2);
    expect(items.map((r) => r.cells.name)).toEqual(["配管", "配线"]);
  });

  it("名称类表头不被其它角色抢走：「工程量清单项目名称」含「工程量」也仍是名称列", async () => {
    const buf = await wb([
      ["序号", "工程量清单项目名称", "计量单位", "二阶段清标工程量", "清标单价", "合同清单工程量"],
      [1, "消火栓泵组", "组", 1, 3500, 1],
      [2, "喷淋泵组", "组", 1, 4200, 1],
      [3, "湿式报警阀", "套", 2, 800, 2],
    ], "进度计量审核表");
    const insp = inspectWorkbook(buf)[0];
    expect(insp.columns.name).toBe(1);
    expect(insp.columns.quantity).toBe(3);
    const s2 = only(parseWorkbook(buf));
    const items = named(s2);
    expect(items).toHaveLength(3);
    expect(items[0].cells.name).toBe("消火栓泵组");
  });

  it("多版本量价（清标量/上报量/审核量）判对比表，不当清单导入", async () => {
    const buf = await wb([
      ["序号", "工程量清单项目名称", "计量单位", "二阶段清标工程量", "现场代表审核工程量", "9月进度上报量", "清标单价", "合同金额"],
      [1, "消火栓泵组", "组", 1, 1, 1, 3500, 3500],
      [2, "喷淋泵组", "组", 1, 1, 1, 4200, 4200],
    ], "附件3-进度计量审核表");
    const s2 = only(parseWorkbook(buf));
    expect(s2.type).toBe("COMPARE");
    expect(importableRowCount(s2)).toBe(0); // 对比表不产清单行
  });

  it("「材料名称」列仍归 materialName（名称守卫不能把它一起挡掉）", async () => {
    const buf = await wb([
      ["序号", "材料名称", "规格型号", "单位", "品牌", "询价"],
      [1, "镀锌钢管", "DN100", "m", "华岐", 86],
      [2, "闸阀", "DN50 铜", "个", "开维喜", 122],
    ], "电缆询价");
    const s2 = only(parseWorkbook(buf));
    expect(s2.columns.materialName).toBe(1);
    expect(s2.columns.spec).toBe(2);
    expect(s2.rows.filter((r) => r.isItem)[0].cells.materialName).toBe("镀锌钢管");
  });

  it("表-08「其中：人工费/材料费/机械费/管理费/利润」分解列被识别并落 __decomp", async () => {
    const buf = await wb([
      ["序号", "项目编码", "项目名称", "单位", "工程量", "综合单价", "合价", "其中：人工费", "其中：材料费", "其中：机械费", "其中：管理费", "其中：利润"],
      [1, "030411001001", "配管", "m", 100, 30, 3000, 500, 2000, 200, 150, 150],
    ], "表-08 分部分项");
    const insp = inspectWorkbook(buf)[0];
    expect(insp.columns.laborFee).toBe(7);
    expect(insp.columns.materialFee).toBe(8);
    expect(insp.columns.profitFee).toBe(11);
    const s = only(parseWorkbook(buf));
    const row = named(s)[0];
    const input = rowToBoqInput(row, s, {
      projectId: "p", fileId: "f", sortOrder: 0, section: "", feeType: "分部分项",
    }) as any;
    const raw = JSON.parse(input.rawCells);
    expect(raw.__decomp).toEqual({ labor: "500", machine: "200", material: "2000", mgmt: "150", profit: "150" });
    // 人/机折算成每清单单位值（合价 ÷ 工程量）
    expect(String(input.laborUnitPrice)).toBe("5");
    expect(String(input.machineUnitPrice)).toBe("2");
  });
});

// 确认前的 0 行预警：识别结果里必须带「将导入 N 行」，否则用户点了确认才发现整表没进来
describe("列映射「将导入 N 行」", () => {
  it("正常表算出行数；名称列全空的表算出 0 行", async () => {
    const ok = await wb([
      ["序号", "项目名称", "单位", "工程量", "综合单价", "合价"],
      [1, "配管", "m", 100, 30, 3000],
      [2, "配线", "m", 200, 5, 1000],
    ], "清单");
    const bad = await wb([
      ["序号", "项目名称", "单位", "工程量", "综合单价", "合价"],
      [1, "", "m", 100, 30, 3000],
      [2, "", "m", 200, 5, 1000],
      [3, "", "m", 50, 8, 400],
    ], "清单");
    for (const [buf, want] of [[ok, 2], [bad, 0]] as [Buffer, number][]) {
      const mapping: Record<string, SheetMeta> = {};
      for (const insp of inspectWorkbook(buf))
        mapping[insp.sheetName] = { ...insp, userEdited: false, needsConfirm: false };
      await withImportCounts(buf, mapping);
      expect(mapping["清单"].itemsToImport).toBe(want);
    }
  });
});

describe("费用口径：含税单价不重复计税", () => {
  const params = (over: Record<string, unknown> = {}) => ({
    measureRate: D(0), provisionalRate: D(0), provisionalAmount: D(0),
    regulationRate: D(0.02), laborBase: null, taxRate: D(0.09),
    addonRate: D(0), laborAdjustRate: D(0), coeffMeasureFee: D(0), set: {},
    ...over,
  }) as any;
  const item = (over: Partial<BoqItemDTO>): BoqItemDTO => ({
    id: "x", projectId: "p", fileId: null, sheetName: "s", rowIndex: 1,
    code: "", name: "项", rawFeature: "", unit: "m", quantity: "1",
    unitPrice: "1", mainMaterialPrice: "0", laborUnitPrice: "0", machineUnitPrice: "0",
    pricingPlan: [], totalPrice: "0", feeType: "分部分项", sectionPath: "",
    isHeader: false, sortOrder: 0, discipline: "OTHER", features: {},
    ...over,
  } as BoqItemDTO);

  it("含税单价的单价措施行不再并入税前造价（也不二次计税）", () => {
    const items = [
      item({ id: "1", name: "分部分项", totalPrice: "1000", taxIncluded: false }),
      item({ id: "2", name: "单价措施(含税)", totalPrice: "100", feeType: "单价措施", taxIncluded: true }),
    ];
    const f = feeSummary(items, params());
    expect(f.preTax).toBe("1020.00");     // 1000 + 规费 20（含税 100 不进基数）
    expect(f.grandTotal).toBe("1211.80"); // 1020 + 税 91.80 + 含税 100
    expect(f.rows.some((r) => r.name.includes("含税价清单"))).toBe(true);
  });

  it("含税单价的分部分项行同样不并入税前", () => {
    const f = feeSummary([item({ totalPrice: "1090", taxIncluded: true })], params());
    expect(f.preTax).toBe("0.00");
    expect(f.grandTotal).toBe("1090.00");
  });
});

describe("成本构成：表-08 分解列直采", () => {
  it("分解列齐全时人材机为真值、管利进 other，且可算毛利率", () => {
    const items = [{
      id: "1", projectId: "p", fileId: null, sheetName: "s", rowIndex: 1,
      code: "", name: "配管", rawFeature: "", unit: "m", quantity: "100",
      unitPrice: "30", mainMaterialPrice: "0", laborUnitPrice: "5", machineUnitPrice: "2",
      pricingPlan: [], totalPrice: "3000",
      rawCells: { __decomp: { labor: "500", machine: "200", material: "2000", mgmt: "150", profit: "150" } },
      feeType: "分部分项", sectionPath: "", isHeader: false, sortOrder: 0, discipline: "OTHER", features: {},
    } as unknown as BoqItemDTO];
    const c = analyzeCostComposition(items);
    expect(c.rows[0].labor).toBe("500.00");
    expect(c.rows[0].material).toBe("2000.00");
    expect(c.rows[0].machine).toBe("200.00");
    expect(c.rows[0].other).toBe("300.00");
    expect(c.rows[0].directCost).toBe("2700.00");
    expect(c.totals.margin).toBe("300.00");
    expect(c.coverage.imported).toBe(1);
  });
});
