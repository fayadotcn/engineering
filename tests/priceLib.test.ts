import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { inspectWorkbook, parseWorkbook } from "../file/excel";
import {
  buildPriceRows,
  normalizePeriod,
  normalizePriceType,
  filenamePeriod,
  filenameRegion,
  periodKey,
} from "../dataset/priceParse";
import { pickBestPriceRow, applicableBrands, type PriceCandidate } from "../dataset/priceMatch";

async function wb(rows: unknown[][], sheetName = "报价"): Promise<Buffer> {
  const w = new ExcelJS.Workbook();
  const s = w.addWorksheet(sheetName);
  rows.forEach((r) => s.addRow(r as any[]));
  return Buffer.from(await w.xlsx.writeBuffer());
}

describe("normalizePeriod", () => {
  it("各种期次格式归一化为 YYYY-MM", () => {
    expect(normalizePeriod("2024-06")).toBe("2024-06");
    expect(normalizePeriod("2024.6")).toBe("2024-06");
    expect(normalizePeriod("2024年6月")).toBe("2024-06");
    expect(normalizePeriod("2026.9.16")).toBe("2026-09");
    expect(normalizePeriod("2026-09-15")).toBe("2026-09");
    expect(normalizePeriod(" 2025/3 ")).toBe("2025-03");
    expect(normalizePeriod("2024年第2期")).toBe("2024年第2期"); // 保留原文
    expect(normalizePeriod("")).toBe("");
    expect(normalizePeriod(undefined)).toBe("");
  });
  it("季度式归一化为 YYYY-Qn", () => {
    expect(normalizePeriod("2024年第2季度")).toBe("2024-Q2");
    expect(normalizePeriod("2024Q3")).toBe("2024-Q3");
  });
  it("periodKey 可排序", () => {
    expect(periodKey("2024-06")).toBe(202406);
    expect(periodKey("2026-09-15")).toBe(202609);
    expect(periodKey("2024-Q3")).toBe(202403);
    expect(periodKey("第6期")).toBe(0);
  });
});

describe("normalizePriceType / filename 兜底", () => {
  it("价格类型归一化", () => {
    expect(normalizePriceType("信息价")).toBe("INFO");
    expect(normalizePriceType("成都市造价信息")).toBe("INFO");
    expect(normalizePriceType("供应商报价")).toBe("SUPPLY");
    expect(normalizePriceType("市场价")).toBe("MARKET");
    expect(normalizePriceType("人工费")).toBe("LABOR");
    expect(normalizePriceType("")).toBe("");
  });
  it("文件名提取期次与地区", () => {
    expect(filenamePeriod("2026.9.16 成都江源新蓉电缆有限公司 上上报价 三亚.xlsx")).toBe("2026-09");
    expect(filenamePeriod("机电询价.xlsx")).toBe("");
    expect(filenameRegion("2026.9.16 上上报价 三亚.xlsx")).toBe(""); // 三亚无后缀不猜
    expect(filenameRegion("四川省2024年6月信息价.xlsx")).toBe("四川");
    expect(filenameRegion("成都市信息价.xlsx")).toBe("成都市");
  });
});

describe("buildPriceRows", () => {
  it("封面行+表头在第6行的供应商报价单：地区列/碎片规格合并/文件名期次兜底", async () => {
    // 还原「2026.9.16 上上报价 三亚.xlsx」结构
    const buf = await wb([
      ["", "", "", "", "", "", "", "", "", ""],
      ["", "", "", "中国第一 世界第七", "", "", "", "", "", ""],
      ["产  品  报  价  单", "", "", "", "", "", "", "", "", ""],
      ["序号", "产品型号及规格", "", "", "", "数量(米)", "单价(元/米)", "总价(元)", "地区", "备注"],
      [1, "WDZB1-YJY-0.6/1kV", "", "", "3*10", 1062, 35.94, 38168.28, "海南省三亚市", ""],
      [2, "WDZB1-YJY-0.6/1kV", "", "", "4*25+1*16", 500, 128.5, 64250, "海南省三亚市", ""],
    ]);
    const sheets = parseWorkbook(buf, {});
    // 无表头命中或低置信也照跑——buildPriceRows 只关心已映射列
    const { rows } = buildPriceRows(sheets, {}, "2026.9.16 上上报价 三亚.xlsx");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const r = rows[0];
    expect(r.price).toBe(35.94);
    expect(r.region).toBe("海南省三亚市");
    expect(r.period).toBe("2026-09"); // 文件名兜底
    expect(r.spec).toContain("3x10"); // 未映射列碎片并入，分隔符归一为 x
  });

  it("综合单价式 BOQ sheet 不进价格库（红线：综合单价≠材料价）", async () => {
    const buf = await wb([
      ["序号", "项目名称", "项目特征", "计量单位", "工程量", "综合单价(元)", "品牌"],
      [1, "电力电缆", "规格：WDZB1-YJY-3*10", "m", 100, 39.51, "亨通"],
      [2, "电力电缆", "规格：WDZB1-YJY-4*25", "m", 200, 143.04, "亨通"],
    ]);
    const sheets = parseWorkbook(buf, {});
    const { rows, skippedBoqSheets } = buildPriceRows(sheets, {}, "电缆询价.xlsx");
    expect(rows).toHaveLength(0);
    expect(skippedBoqSheets.length).toBeGreaterThanOrEqual(1);
  });

  it("询价表正常入库：名称/品牌/单价", async () => {
    const buf = await wb([
      ["序号", "材料名称", "规格型号", "单位", "品牌", "询价"],
      [1, "镀锌钢管", "DN100", "m", "华岐", 86],
      [2, "闸阀", "DN50 铜", "个", "开维喜", 122],
    ]);
    const sheets = parseWorkbook(buf, {});
    const { rows } = buildPriceRows(sheets, { region: "海南", period: "2026-08", priceType: "SUPPLY" });
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe("镀锌钢管");
    expect(rows[0].brand).toBe("华岐");
    expect(rows[0].region).toBe("海南");
    expect(rows[0].period).toBe("2026-08");
    expect(rows[0].priceType).toBe("SUPPLY");
  });

  it("工日单位行自动标 LABOR", async () => {
    const buf = await wb([
      ["序号", "工种", "单位", "单价"],
      [1, "电工", "工日", 320],
      [2, "普工", "工日", 240],
    ]);
    const sheets = parseWorkbook(buf, {});
    const { rows } = buildPriceRows(sheets);
    expect(rows).toHaveLength(2);
    expect(rows[0].priceType).toBe("LABOR");
    expect(rows[0].price).toBe(320);
  });

  it("无单位列时从价格表头「元/X」推单位（归一为引擎口径）", async () => {
    const buf = await wb([
      ["序号", "产品型号及规格", "单价(元/米)", "地区"],
      [1, "WDZB1-YJY-0.6/1kV 3*10", 35.94, "海南"],
      [2, "WDZB1-YJY-0.6/1kV 4*25+1*16", 128.5, "海南"],
    ]);
    const sheets = parseWorkbook(buf, {});
    const { rows } = buildPriceRows(sheets);
    expect(rows).toHaveLength(2);
    expect(rows[0].unit).toBe("m"); // 米→m
  });
});

describe("pickBestPriceRow", () => {
  const row = (over: Partial<PriceCandidate>): PriceCandidate => ({
    name: "镀锌钢管", spec: "DN100", unit: "m", brand: "", price: 80,
    priceType: "MARKET", region: "", period: "", ...over,
  });

  it("默认偏好最新期次", () => {
    const pick = pickBestPriceRow(
      [row({ price: 80, period: "2024-06" }), row({ price: 85, period: "2026-09" })],
      { name: "镀锌钢管", spec: "DN100" }
    );
    expect(pick!.row.price).toBe(85);
  });

  it("指定品牌优先，异品牌留痕", () => {
    const pick = pickBestPriceRow(
      [
        row({ price: 80, brand: "华岐", period: "2026-09" }),
        row({ price: 78, brand: "友发", period: "2026-09" }),
      ],
      { name: "镀锌钢管", spec: "DN100" },
      { brands: [{ appliesTo: "", value: "友发" }] }
    );
    expect(pick!.row.brand).toBe("友发");
  });

  it("异品牌兜底但仍可选中（备注记录偏差）", () => {
    const pick = pickBestPriceRow(
      [row({ price: 80, brand: "华岐" })],
      { name: "镀锌钢管" },
      { brands: [{ appliesTo: "", value: "友发" }] }
    );
    expect(pick!.row.brand).toBe("华岐");
    expect(pick!.notes.join()).toContain("非指定");
  });

  it("分类品牌偏好只作用于对应材料", () => {
    const prefs = { brands: [{ appliesTo: "电缆", value: "上上" }] };
    expect(applicableBrands(prefs, "电力电缆")).toEqual(["上上"]);
    expect(applicableBrands(prefs, "镀锌钢管")).toEqual([]);
  });

  it("指定期次取截至该期最新", () => {
    const pick = pickBestPriceRow(
      [
        row({ price: 70, period: "2024-01" }),
        row({ price: 80, period: "2024-06" }),
        row({ price: 99, period: "2026-09" }),
      ],
      { name: "镀锌钢管" },
      { period: "2024-08" }
    );
    expect(pick!.row.price).toBe(80);
  });

  it("地区偏好命中加权", () => {
    const pick = pickBestPriceRow(
      [
        row({ price: 80, region: "四川", period: "2026-09" }),
        row({ price: 81, region: "海南", period: "2026-09" }),
      ],
      { name: "镀锌钢管" },
      { region: "海南" }
    );
    expect(pick!.row.region).toBe("海南");
  });

  it("型号式价格行（无材料名列）：规格词根命中名称未命中的行", () => {
    // 报价单 name=型号「WDZB1-YJY-0.6/1kV 3*10」，清单项 name=「电力电缆」
    const pick = pickBestPriceRow(
      [
        row({ name: "WDZB1-YJY-0.6/1kV 3*10", spec: "WDZB1-YJY-0.6/1kV 3*10", price: 35.94 }),
        row({ name: "BVR-450/750V 2.5", spec: "BVR-450/750V 2.5", price: 2.4 }),
      ],
      { name: "电力电缆", spec: "WDZB1-YJY-3*10" }
    );
    expect(pick!.row.price).toBe(35.94);
    expect(pick!.notes.join()).toContain("名称未直接命中");
  });

  it("规格分隔符归一：查询 4x35 命中库行 4×35（specExact）", () => {
    const pick = pickBestPriceRow(
      [
        row({ name: "电力电缆", spec: "4×35", price: 120 }),
        row({ name: "电力电缆", spec: "3x10", price: 30 }),
      ],
      { name: "电力电缆", spec: "4x35" }
    );
    expect(pick!.row.price).toBe(120);
    expect(pick!.notes.join()).not.toContain("截面/尺寸档不同");
  });

  it("型号词根相同但截面不同：正确选中同截面行", () => {
    const pick = pickBestPriceRow(
      [
        row({ name: "WDZB1-YJY-0.6/1kV 3*10", spec: "WDZB1-YJY-0.6/1kV 3*10", price: 35.94 }),
        row({ name: "WDZB1-YJY-0.6/1kV 4*25+1*16", spec: "WDZB1-YJY-0.6/1kV 4*25+1*16", price: 128.5 }),
      ],
      { name: "电力电缆", spec: "WDZB1-YJY-4*25+1*16" }
    );
    expect(pick!.row.price).toBe(128.5); // 4*25+1*16 截面命中，3*10 被拉开
  });

  it("候选全无期次时退到入库时间最新（「最新」对无期次表生效）", () => {
    const pick = pickBestPriceRow(
      [
        row({ price: 80, createdAt: "2024-01-01T00:00:00Z" }),
        row({ price: 85, createdAt: "2026-09-01T00:00:00Z" }),
        row({ price: 90, createdAt: "2025-06-01T00:00:00Z" }),
      ],
      { name: "镀锌钢管", spec: "DN100" }
    );
    expect(pick!.row.price).toBe(85);
  });
});

describe("pickBestPriceRow 稳定性修正", () => {
  const row2 = (over: Partial<PriceCandidate>): PriceCandidate => ({
    name: "镀锌钢管", spec: "DN100", unit: "m", brand: "", price: 80,
    priceType: "MARKET", region: "", period: "", ...over,
  });

  it("同分时取期次较新者，不依赖候选顺序", () => {
    // 两候选期次都晚于指定期 → 期次分同为 0，总分相等。
    // 旧逻辑按迭代序取先入队的旧期次行；修后同分裁决取期次较新者。
    const pick = pickBestPriceRow(
      [
        row2({ price: 80, period: "2024-06" }),
        row2({ price: 81, period: "2025-06" }),
      ],
      { name: "镀锌钢管", spec: "DN100" },
      { period: "2024-01" } // 两候选都晚于该期 → 期次维度零分，打平
    );
    expect(pick!.row.period).toBe("2025-06");
  });

  it("单位别名归一：价格行「米」对清单「m」也得单位分", () => {
    const pick = pickBestPriceRow(
      [row2({ unit: "米" }), row2({ unit: "吨" })],
      { name: "镀锌钢管", spec: "DN100", unit: "m" }
    );
    expect(pick!.row.unit).toBe("米");
  });

  it("材料词命中名称时做归一化比较（大小写/空白不丢配）", () => {
    const pick = pickBestPriceRow(
      [row2({ name: "热镀锌钢管" }), row2({ name: "PPR管" })],
      { name: "管材", material: "镀锌" }
    );
    expect(pick!.row.name).toBe("热镀锌钢管");
  });
});

describe("pickBestPriceRow 价格类型语义", () => {
  const r3 = (over: Partial<PriceCandidate>): PriceCandidate => ({
    name: "", spec: "", unit: "", brand: "", price: 10,
    priceType: "MARKET", region: "", period: "", ...over,
  });
  it("工日单位的清单项优先取 LABOR 价格行", () => {
    const pick = pickBestPriceRow(
      [r3({ name: "普工", priceType: "MARKET", price: 300 }), r3({ name: "普工", priceType: "LABOR", price: 180 })],
      { name: "普工", unit: "工日" }
    );
    expect(pick!.row.priceType).toBe("LABOR");
  });
  it("材料项遇 LABOR 行降权并留痕", () => {
    const pick = pickBestPriceRow(
      [r3({ name: "综合工日", priceType: "LABOR" }), r3({ name: "综合工日", priceType: "MARKET" })],
      { name: "综合工日", unit: "m" }
    );
    expect(pick!.row.priceType).toBe("MARKET");
    const labor = pickBestPriceRow(
      [r3({ name: "综合工日", priceType: "LABOR" })],
      { name: "综合工日", unit: "m" }
    );
    expect(labor!.notes.some((n) => n.includes("人工费"))).toBe(true);
  });
});
