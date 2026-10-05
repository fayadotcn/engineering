import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { applyTypeHint, inspectWorkbook, parseWorkbook, type ParsedSheet } from "../file/excel";
import { reconcilePriceRole } from "../shared/mapping";
import { rowToBoqInput } from "../boq/mapRow";

async function wb(rows: unknown[][], sheetName = "Sheet1"): Promise<Buffer> {
  const w = new ExcelJS.Workbook();
  const s = w.addWorksheet(sheetName);
  rows.forEach((r) => s.addRow(r as any[]));
  return Buffer.from(await w.xlsx.writeBuffer());
}

const firstSheet = (sheets: ParsedSheet[]) => sheets[0];

describe("通用清单列映射", () => {
  it("简式清单（裸「单价」+数量×单价=合价）→ BOQ，单价锁定为综合单价", async () => {
    const buf = await wb([
      ["序号", "名称", "规格", "单位", "数量", "单价", "合价"],
      [1, "镀锌钢管", "DN100", "m", 120, 85.5, 10260],
      [2, "电缆", "YJV-4*25", "m", 200, 40, 8000],
      [3, "桥架", "200*100", "m", 50, 96, 4800],
      [4, "配电箱", "XL-21", "台", 2, 3500, 7000],
    ]);
    const s = firstSheet(parseWorkbook(buf));
    expect(s.type).toBe("BOQ");
    expect(s.columns.quantity).toBe(4);
    expect(s.columns.unitPrice).toBe(5);
    expect(s.columns.totalPrice).toBe(6);
    expect(s.columns.price).toBeUndefined();
    const insp = inspectWorkbook(buf)[0];
    expect(insp.confidence.unitPrice).toBeGreaterThanOrEqual(0.95);
    const items = s.rows.filter((r) => r.isItem);
    expect(items).toHaveLength(4);
    expect(items[0].cells.unitPrice).toBe("85.5");
  });

  it("英文表头 No/Item/Spec/Unit/Qty/Rate/Amount → BOQ", async () => {
    const buf = await wb([
      ["No", "Item", "Spec", "Unit", "Qty", "Rate", "Amount"],
      [1, "Steel pipe", "DN100", "m", 120, 85.5, 10260],
      [2, "Cable", "YJV-4*25", "m", 200, 40, 8000],
      [3, "Tray", "200*100", "m", 50, 96, 4800],
    ]);
    const s = firstSheet(parseWorkbook(buf));
    expect(s.type).toBe("BOQ");
    expect(s.columns.name).toBe(1);
    expect(s.columns.unit).toBe(3);
    expect(s.columns.quantity).toBe(4);
    expect(s.columns.unitPrice).toBe(5);
    expect(s.columns.totalPrice).toBe(6);
    expect(s.rows.filter((r) => r.isItem)).toHaveLength(3);
  });

  it("标准表-08（首行大标题）→ BOQ，指纹非空", async () => {
    const buf = await wb(
      [
        ["分部分项工程和单价措施项目清单与计价表"],
        ["序号", "项目编码", "项目名称", "项目特征描述", "计量单位", "工程量", "综合单价", "合价"],
        [1, "031001001001", "镀锌钢管", "1、DN100", "m", 120, 85.5, 10260],
        [2, "031001001002", "镀锌钢管", "1、DN50", "m", 60, 40.2, 2412],
        [3, "031001001003", "阀门", "1、DN100", "个", 4, 320, 1280],
      ],
      "表-08"
    );
    const s = firstSheet(parseWorkbook(buf));
    expect(s.type).toBe("BOQ");
    expect(s.columns.code).toBe(1);
    expect(s.columns.name).toBe(2);
    expect(s.columns.feature).toBe(3);
    expect(s.columns.unit).toBe(4);
    expect(s.columns.quantity).toBe(5);
    expect(s.columns.unitPrice).toBe(6);
    expect(s.columns.totalPrice).toBe(7);
    const insp = inspectWorkbook(buf)[0];
    expect(insp.fingerprint).not.toBeNull();
    expect(insp.minConfidence).toBeGreaterThanOrEqual(0.9);
  });

  it("成本表（材料单价+人工单价分列）→ BOQ，单价由合价÷工程量推导", async () => {
    const buf = await wb([
      ["名称", "单位", "数量", "材料单价", "人工单价", "合计"],
      ["风机", "台", 120, 60, 25, 10200],
      ["水泵", "台", 4, 800, 300, 4400],
      ["阀组", "套", 10, 150, 50, 2000],
    ]);
    const s = firstSheet(parseWorkbook(buf));
    expect(s.type).toBe("BOQ");
    expect(s.columns.price).toBe(3);
    expect(s.columns.laborPrice).toBe(4);
    expect(s.columns.totalPrice).toBe(5);
    expect(s.columns.unitPrice).toBeUndefined();
    const item = s.rows.find((r) => r.isItem)!;
    const out = rowToBoqInput(item, s, {
      projectId: "p", fileId: "f", sortOrder: 0, section: "", feeType: "分部分项",
    });
    expect(String(out.unitPrice)).toBe("85");
    expect(out.__flags.derivedUnitPrice).toBe(true);
    expect((out.rawCells ? JSON.parse(out.rawCells as string) : {})["人工单价"]).toBe("25");
  });

  it("询价表带数量/合价仍判 QUOTATION", async () => {
    const buf = await wb([
      ["序号", "材料名称", "规格型号", "品牌", "单位", "数量", "单价", "合价"],
      [1, "铜芯电缆", "YJV-4*25", "上上", "m", 200, 40, 8000],
      [2, "镀锌钢管", "DN100", "友发", "m", 120, 85.5, 10260],
      [3, "桥架", "200*100", "华鹏", "m", 50, 96, 4800],
    ]);
    const s = firstSheet(parseWorkbook(buf));
    expect(s.type).toBe("QUOTATION");
    expect(s.columns.price).toBe(6);
  });

  it("总价措施表（名称+费率+金额）→ BOQ / 总价措施", async () => {
    const buf = await wb(
      [
        ["序号", "项目编码", "项目名称", "计算基础", "费率", "金额"],
        [1, "", "安全文明施工费", "分部分项工程费", "3%", 5000],
        [2, "", "夜间施工增加费", "分部分项工程费", "0.5%", 800],
        [3, "", "二次搬运费", "分部分项工程费", "0.3%", 480],
      ],
      "总价措施项目清单与计价表"
    );
    const s = firstSheet(parseWorkbook(buf));
    expect(s.type).toBe("BOQ");
    expect(s.feeType).toBe("总价措施");
    expect(s.rows.filter((r) => r.isItem).length).toBe(3);
  });

  it("表头指纹：同表头同指纹、异表头异指纹、无表头为 null", async () => {
    const mk = (vals: number[][]) =>
      wb([
        ["名称", "单位", "数量", "材料单价", "人工单价", "合计"],
        ...vals.map((v) => ["风机", "台", ...v]),
      ]);
    const a = inspectWorkbook(await mk([[120, 60, 25, 10200]]))[0];
    const b = inspectWorkbook(await mk([[10, 1, 2, 12]]))[0];
    expect(a.fingerprint).not.toBeNull();
    expect(a.fingerprint).toBe(b.fingerprint);
    const c = inspectWorkbook(
      await wb([
        ["名称", "单位", "数量", "单价", "合价"],
        ["风机", "台", 12, 85, 1020],
      ])
    )[0];
    expect(c.fingerprint).not.toBe(a.fingerprint);
    const headless = inspectWorkbook(
      await wb([
        [1, "031001001001", "", "镀锌钢管", "1、DN100", "", "m", 12],
        [2, "031001001002", "", "镀锌钢管", "1、DN50", "", "m", 60],
        [3, "031001001003", "", "阀门", "1、DN100", "", "个", 4],
      ])
    )[0];
    expect(headless.headerRow).toBe(-1);
    expect(headless.fingerprint).toBeNull();
  });

  it("用户覆盖映射优先于自动检测", async () => {
    const buf = await wb([
      ["序号", "名称", "规格", "单位", "数量", "单价", "合价"],
      [1, "镀锌钢管", "DN100", "m", 120, 85.5, 10260],
      [2, "电缆", "YJV-4*25", "m", 200, 40, 8000],
      [3, "桥架", "200*100", "m", 50, 96, 4800],
    ]);
    const s = parseWorkbook(buf, {
      mapping: {
        Sheet1: {
          type: "BOQ",
          headerRow: 0,
          merged: false,
          columns: { name: 1, quantity: 4, unitPrice: 6 },
        },
      },
    })[0];
    const item = s.rows.find((r) => r.isItem)!;
    // 故意把合价列映射成单价 → 生效
    expect(item.cells.unitPrice).toBe("10260");
  });

  it("无表头数据表 → 画像推断待报价清单（有量无价）、headerRow -1、置信≤0.7", async () => {
    const buf = await wb([
      [1, "031001001001", "", "镀锌钢管", "1、材质：镀锌\n2、规格：DN100", "", "m", 12],
      [2, "031001001002", "", "镀锌钢管", "1、材质：镀锌\n2、规格：DN50", "", "m", 60],
      [3, "031001001003", "", "阀门", "1、规格：DN100", "", "个", 4],
      [4, "031001001004", "", "阀门", "1、规格：DN50", "", "个", 6],
    ]);
    const s = firstSheet(parseWorkbook(buf));
    // 编码+名称+特征+单位+工程量但零价列 → 待报价清单（仍按清单导入，单价留空）
    expect(s.type).toBe("PENDING_QUOTE");
    expect(s.headerRow).toBe(-1);
    const insp = inspectWorkbook(buf)[0];
    expect(insp.minConfidence).toBeLessThanOrEqual(0.7);
  });

  it("无表头错位布局「名|量|空|单位|价」：左侧数值列认工程量，单价不抢量位", async () => {
    // 真实缺陷样本（抗震支吊架 Sheet3）：unit 右一列是单价，右扫会把单价错钉成 quantity
    const buf = await wb([
      ["抗震支吊架 DN65", 12, "", "套", 450],
      ["抗震支吊架 DN80", 8, "", "套", 520],
      ["抗震支吊架 DN100", 15, "", "套", 610],
      ["抗震支吊架 DN150", 6, "", "套", 890],
    ]);
    const insp = inspectWorkbook(buf)[0];
    expect(insp.columns.quantity).toBe(1);
    expect(insp.columns.unitPrice).toBe(4);
    const s = firstSheet(parseWorkbook(buf));
    const items = s.rows.filter((r) => r.isItem);
    expect(items.map((r) => r.cells.quantity)).toEqual(["12", "8", "15", "6"]);
    expect(items.map((r) => r.cells.unitPrice)).toEqual(["450", "520", "610", "890"]);
  });

  it("无表头错位布局「序号|名称|量|单位|价|合价」：量左价右，序号不抢量位", async () => {
    const buf = await wb([
      [1, "电缆 YJV-4*35", 120, "m", 85, 10200],
      [2, "电缆 YJV-4*50", 80, "m", 110, 8800],
      [3, "电缆 YJV-4*70", 60, "m", 150, 9000],
      [4, "电缆 YJV-4*95", 45, "m", 195, 8775],
    ]);
    const insp = inspectWorkbook(buf)[0];
    expect(insp.columns.quantity).toBe(2);
    expect(insp.columns.unitPrice).toBe(4);
    expect(insp.columns.totalPrice).toBe(5);
  });

  it("无表头「名|数字规格|单位|量|价」：规格列是纯数字也不抢量位", async () => {
    // 右侧有 ≥2 数值列时仍走右扫——左邻数字列是规格（304/316 材质号）不是量
    const buf = await wb([
      ["钢板", 304, "t", 3, 12000],
      ["钢板", 316, "t", 2, 18500],
      ["钢管", 304, "t", 5, 9800],
      ["钢管", 316, "t", 4, 15200],
    ]);
    const insp = inspectWorkbook(buf)[0];
    expect(insp.columns.quantity).toBe(3);
    expect(insp.columns.unitPrice).toBe(4);
  });

  it("非乘积三数值列（单价×(1+税率)=含税价）不触发算术锁定", async () => {
    const buf = await wb([
      ["名称", "单位", "数量", "单价", "税率", "金额合计"],
      ["钢板", "t", 3, 100, 0.13, 339],
      ["铝材", "t", 2, 200, 0.13, 452],
      ["铜排", "t", 5, 500, 0.13, 1695],
      ["螺栓", "套", 8, 50, 0.13, 452],
    ]);
    const insp = inspectWorkbook(buf)[0];
    // 金额合计列是表头映射命中的 totalPrice；锁定不应再改出别的 totalPrice
    expect(insp.columns.totalPrice).toBe(5);
    expect(insp.confidence.totalPrice ?? 1).toBeLessThan(0.97);
  });

  it("简式清单带「规格型号」：类型歧义 → QUOTATION 但 minConfidence≤0.6 走确认门", async () => {
    const buf = await wb([
      ["序号", "名称", "规格型号", "单位", "数量", "单价", "合价"],
      [1, "镀锌钢管", "DN100", "m", 120, 85.5, 10260],
      [2, "电缆", "YJV-4*25", "m", 200, 40, 8000],
      [3, "桥架", "200*100", "m", 50, 96, 4800],
      [4, "配电箱", "XL-21", "台", 2, 3500, 7000],
    ]);
    const insp = inspectWorkbook(buf)[0];
    expect(insp.type).toBe("QUOTATION");
    expect(insp.typeConfidence).toBeLessThan(0.9);
    expect(insp.minConfidence).toBeLessThanOrEqual(0.6);
    expect(insp.columns.price).toBe(5);
  });

  it("applyTypeHint：清单文件名纠偏为 BOQ 并把裸单价挪为综合单价", async () => {
    const buf = await wb([
      ["序号", "名称", "规格型号", "单位", "数量", "单价", "合价"],
      [1, "镀锌钢管", "DN100", "m", 120, 85.5, 10260],
      [2, "电缆", "YJV-4*25", "m", 200, 40, 8000],
      [3, "桥架", "200*100", "m", 50, 96, 4800],
    ]);
    const insp = inspectWorkbook(buf)[0];
    const hinted = applyTypeHint(insp, "水电清单.xlsx");
    expect(hinted.type).toBe("BOQ");
    expect(hinted.columns.unitPrice).toBe(5);
    expect(hinted.columns.price).toBeUndefined();
    expect(hinted.typeConfidence).toBeGreaterThanOrEqual(0.9);
  });

  it("applyTypeHint：询价文件名确认 QUOTATION 且单价列归 price", async () => {
    const buf = await wb([
      ["序号", "型号规格", "单位", "数量", "单价(元)", "合价(元)"],
      [1, "YJV-4*150", "米", 153.75, 692.72, 106505.7],
      [2, "YJV-4*25", "米", 200, 40, 8000],
      [3, "YJV-4*50", "米", 50, 96, 4800],
    ]);
    const insp = inspectWorkbook(buf)[0];
    const hinted = applyTypeHint(insp, "电线电缆询价.xlsx");
    expect(hinted.type).toBe("QUOTATION");
    expect(hinted.columns.price).toBe(4);
    expect(hinted.typeConfidence).toBeGreaterThanOrEqual(0.9);
  });

  it("强询价信号（材料名称+品牌）不受文件名影响", async () => {
    const buf = await wb([
      ["序号", "材料名称", "规格型号", "品牌", "单位", "数量", "单价", "合价"],
      [1, "铜芯电缆", "YJV-4*25", "上上", "m", 200, 40, 8000],
      [2, "镀锌钢管", "DN100", "友发", "m", 120, 85.5, 10260],
      [3, "桥架", "200*100", "华鹏", "m", 50, 96, 4800],
    ]);
    const insp = inspectWorkbook(buf)[0];
    expect(insp.type).toBe("QUOTATION");
    expect(insp.typeConfidence).toBeGreaterThanOrEqual(0.9);
    const hinted = applyTypeHint(insp, "水电清单.xlsx");
    expect(hinted.type).toBe("QUOTATION"); // ≥0.9 不干预
  });

  it("标准表-08 typeConfidence≥0.9", async () => {
    const buf = await wb(
      [
        ["序号", "项目编码", "项目名称", "项目特征描述", "计量单位", "工程量", "综合单价", "合价"],
        [1, "031001001001", "镀锌钢管", "1、DN100", "m", 120, 85.5, 10260],
        [2, "031001001002", "镀锌钢管", "1、DN50", "m", 60, 40.2, 2412],
        [3, "031001001003", "阀门", "1、DN100", "个", 4, 320, 1280],
      ],
      "表-08"
    );
    expect(inspectWorkbook(buf)[0].typeConfidence).toBeGreaterThanOrEqual(0.9);
  });

  it("rowToBoqInput：同名表头列不互相覆盖", async () => {
    const buf = await wb([
      ["序号", "名称", "单位", "数量", "单价", "金额", "金额"],
      [1, "镀锌钢管", "m", 120, 85.5, 10260, "备注值"],
      [2, "电缆", "m", 200, 40, 8000, "x"],
      [3, "桥架", "m", 50, 96, 4800, "y"],
    ]);
    const s = firstSheet(parseWorkbook(buf));
    const item = s.rows.find((r) => r.isItem)!;
    const out = rowToBoqInput(item, s, {
      projectId: "p", fileId: "f", sortOrder: 0, section: "", feeType: "分部分项",
    });
    const raw = JSON.parse(out.rawCells as string);
    expect(raw["金额"]).toBe("10260");
    expect(raw["金额(G)"]).toBe("备注值");
  });

  it("reconcilePriceRole：改清单时裸「单价」挪为综合单价", () => {
    const hdr = ["序号", "名称", "规格型号", "单位", "数量", "单价", "合价"];
    const r = reconcilePriceRole("BOQ", { price: 5, quantity: 4 }, hdr);
    expect(r.moved).toBe("price→unitPrice");
    expect(r.columns.unitPrice).toBe(5);
    expect(r.columns.price).toBeUndefined();
    // 分项成本价列不动
    const r2 = reconcilePriceRole("BOQ", { price: 5, quantity: 4 },
      ["序号", "名称", "规格型号", "单位", "数量", "材料单价", "合价"]);
    expect(r2.moved).toBeNull();
    expect(r2.columns.price).toBe(5);
    // 改询价表时 unitPrice 挪回 price
    const r3 = reconcilePriceRole("QUOTATION", { unitPrice: 5, quantity: 4 }, hdr);
    expect(r3.moved).toBe("unitPrice→price");
    expect(r3.columns.price).toBe(5);
    expect(r3.columns.unitPrice).toBeUndefined();
  });

  it("reconcilePriceRole：询价表里的「综合单价」列不升格为材料价", () => {
    // 分包报价表标了「综合单价」的列不是材料价——升格会污染价格库
    const r = reconcilePriceRole("QUOTATION", { unitPrice: 5, quantity: 4 },
      ["序号", "名称", "规格型号", "单位", "数量", "综合单价", "合价"]);
    expect(r.moved).toBeNull();
    expect(r.columns.unitPrice).toBeUndefined();
    expect(r.columns.price).toBeUndefined();
    // 相邻的裸「单价」列不受影响，照常升格
    const r2 = reconcilePriceRole("QUOTATION", { unitPrice: 5, quantity: 4 },
      ["序号", "名称", "规格型号", "单位", "数量", "单价", "合价"]);
    expect(r2.moved).toBe("unitPrice→price");
  });

  it("rowToBoqInput：工程量「暂估」→ quantity 0 且标记 nonNumeric", async () => {
    const buf = await wb([
      ["序号", "名称", "规格", "单位", "数量", "单价", "合价"],
      [1, "镀锌钢管", "DN100", "m", 120, 85.5, 10260],
      [2, "临时措施", "", "项", "暂估", "", ""],
      [3, "桥架", "200*100", "m", 50, 96, 4800],
    ]);
    const s = firstSheet(parseWorkbook(buf));
    const row = s.rows.find((r) => r.cells.name === "临时措施")!;
    const out = rowToBoqInput(row, s, {
      projectId: "p", fileId: "f", sortOrder: 0, section: "", feeType: "分部分项",
    });
    expect(String(out.quantity)).toBe("0");
    expect(out.__flags.nonNumericQty).toBe(true);
    const raw = JSON.parse(out.rawCells as string);
    expect(raw.__nonNumeric).toContain("quantity");
  });

  it("rowToBoqInput：合价非数值退回 量×价，不落 0", async () => {
    const buf = await wb([
      ["序号", "名称", "单位", "数量", "单价", "合价"],
      [1, "镀锌钢管", "m", 120, 85.5, "—"],
      [2, "电缆", "m", 200, 40, 8000],
      [3, "桥架", "m", 50, 96, 4800],
    ]);
    const s = firstSheet(parseWorkbook(buf));
    const row = s.rows.find((r) => r.cells.name === "镀锌钢管")!;
    const out = rowToBoqInput(row, s, {
      projectId: "p", fileId: "f", sortOrder: 0, section: "", feeType: "分部分项",
    });
    expect(String(out.totalPrice)).toBe("10260");
    const raw = JSON.parse(out.rawCells as string);
    expect(raw.__nonNumeric).toContain("totalPrice");
  });

  it("「含税单价」→ taxIncluded=true；「不含税/除税单价」不误判含税", async () => {
    const incl = await wb([
      ["序号", "名称", "单位", "工程量", "含税单价", "合价"],
      [1, "镀锌钢管", "m", 120, 85.5, 10260],
      [2, "电缆", "m", 200, 40, 8000],
      [3, "桥架", "m", 50, 96, 4800],
    ]);
    expect(inspectWorkbook(incl)[0].taxIncluded).toBe(true);

    const excl = await wb([
      ["序号", "名称", "单位", "工程量", "不含税单价", "合价"],
      [1, "镀锌钢管", "m", 120, 85.5, 10260],
      [2, "电缆", "m", 200, 40, 8000],
      [3, "桥架", "m", 50, 96, 4800],
    ]);
    expect(inspectWorkbook(excl)[0].taxIncluded).toBe(false);

    // 单价列说「除税」，哪怕另一列写「合价(含税)」也不标含税
    const mixed = await wb([
      ["序号", "名称", "单位", "工程量", "除税单价", "合价(含税)"],
      [1, "镀锌钢管", "m", 120, 76.15, 10260],
      [2, "电缆", "m", 200, 35.78, 8000],
      [3, "桥架", "m", 50, 85.71, 4800],
    ]);
    expect(inspectWorkbook(mixed)[0].taxIncluded).toBe(false);
  });

  it("货币符号/千分位/括号负数/「元」后缀的数字单元格解析为数值", async () => {
    const buf = await wb([
      ["序号", "名称", "单位", "工程量", "单价", "合价"],
      [1, "镀锌钢管", "m", "1,200", "￥85.50", "￥102,600"],
      [2, "电缆", "m", 200, "40元", 8000],
      [3, "让利项", "m", 10, "(5)", -50],
    ]);
    const s = firstSheet(parseWorkbook(buf));
    expect(s.type).toBe("BOQ");
    const rows = s.rows.filter((r) => r.isItem);
    const ctx = { projectId: "p", fileId: "f", sortOrder: 0, section: "", feeType: "分部分项" as const };
    const out0 = rowToBoqInput(rows[0], s, { ...ctx });
    expect(String(out0.unitPrice)).toBe("85.5");
    expect(String(out0.quantity)).toBe("1200");
    const out1 = rowToBoqInput(rows[1], s, { ...ctx, sortOrder: 1 });
    expect(String(out1.unitPrice)).toBe("40");
    const out2 = rowToBoqInput(rows[2], s, { ...ctx, sortOrder: 2 });
    expect(String(out2.unitPrice)).toBe("-5");
    expect(out2.__flags.nonNumericQty).toBeFalsy();
  });

  it("「口径与汇总」式标签-值表 → FACTS（原先落 GENERIC 整表丢事实）", async () => {
    const buf = await wb(
      [
        ["项目", "亿伟三期项目"],
        ["清单行数", "204"],
        ["分部分项合价(元)", "404676.52"],
        ["计价口径", "地区=马来西亚；税率6%；管理费率5%；利润率20%"],
      ],
      "口径与汇总"
    );
    const s = inspectWorkbook(buf)[0];
    expect(s.type).toBe("FACTS");
    expect(s.typeEvidence).toContain("汇总/说明");
  });

  it("「材料价格汇总」表有材料名+库价列 → 仍 MATERIAL_PRICE，不被表名抢走", async () => {
    const buf = await wb(
      [
        ["材料名称", "规格型号", "单位", "信息价"],
        ["镀锌钢管", "DN100", "m", 58.5],
        ["电缆", "YJV-4*25", "m", 40],
      ],
      "材料价格汇总"
    );
    const s = inspectWorkbook(buf)[0];
    expect(s.type).toBe("MATERIAL_PRICE");
  });
});
