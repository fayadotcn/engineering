import { parseSemanticFeature } from "@cost-engine/semantic";
import type { ParsedSheet } from "@file/excel";

// 材料/人工价格行构建：把任意格式价格表（ParsedSheet）归一化为 MaterialPrice 行。
// 纯函数、零 IO——归一化规则（期次/价格类型/地区）全部在这里，可单测可复算。

/** 与 projectTools 共用的省份/地区识别（文件名兜底提取地区用） */
export const REGION_RE =
  /海南|四川|广东|广西|湖南|湖北|北京|上海|天津|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|贵州|云南|陕西|甘肃|青海|新疆|西藏|宁夏|内蒙古|[一-龥]{2,4}(?:省|市|州|盟)/;

export interface PriceDefaults {
  brand?: string;
  region?: string;
  period?: string;
  priceType?: string;
}

export interface PriceRowInput {
  name: string;
  spec: string;
  unit: string;
  brand: string;
  price: number;
  priceType: string; // INFO | MARKET | SUPPLY | LABOR
  region: string;
  period: string; // 归一化 YYYY-MM，无法解析保留原文
  features: string; // JSON BoqSemanticFeature
  raw: string; // JSON row.cells + 未映射列原文
}

/**
 * 期次归一化为 YYYY-MM（排序键见 periodKey）。
 * 「2024-06」「2024.6」「2024年6月」「2026.9.16」「2024年第3期」→ 标准式；
 * 解析不了的保留原文（≤20字），空值返回 ""。
 */
export function normalizePeriod(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const m =
    s.match(/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*月?/) ??
    s.match(/(20\d{2})(\d{2})(?!\d)/); // 202406 紧凑式
  if (m) {
    const mo = Number(m[2]);
    if (mo >= 1 && mo <= 12) return `${m[1]}-${String(mo).padStart(2, "0")}`;
  }
  const q =
    s.match(/(20\d{2})\s*年?\s*第?\s*([一二三四1234])\s*季/) ??
    s.match(/(20\d{2})\s*[Qq]([1-4])/);
  if (q) {
    const qn = "1234".includes(q[2]) ? Number(q[2]) : "一二三四".indexOf(q[2]) + 1;
    if (qn >= 1) return `${q[1]}-Q${qn}`;
  }
  return s.slice(0, 20);
}

/** 「2024-06」→ 202406；「2024-Q2」→ 202402；不可比期次 → 0（不参与新旧排序） */
export function periodKey(period: string | null | undefined): number {
  const s = String(period ?? "").trim();
  const m = s.match(/(20\d{2})-(\d{2})/);
  if (m) return Number(m[1]) * 100 + Number(m[2]);
  const q = s.match(/(20\d{2})-Q([1-4])/);
  if (q) return Number(q[1]) * 100 + Number(q[2]);
  return 0;
}

/** 价格类型归一化：信息价 INFO / 市场价 MARKET / 供应商价 SUPPLY / 人工价 LABOR */
export function normalizePriceType(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (/信息价|信息|造价|定额站|造价管理/.test(s)) return "INFO";
  if (/人工|劳务|工日|台班|台时/.test(s)) return "LABOR";
  if (/供应|厂商|厂家|报价|询价|供应商/.test(s)) return "SUPPLY";
  if (/市场|行情|市场价/.test(s)) return "MARKET";
  return s.length <= 10 ? s : "";
}

/** 文件名期次兜底：「2026.9.16 上上报价 三亚.xlsx」→ 2026-09 */
export function filenamePeriod(filename: string): string {
  return normalizePeriod(filename.match(/20\d{2}\s*[-/.年]\s*\d{1,2}/)?.[0] ?? "");
}

/** 文件名地区兜底：省份词或「xx市/xx省」片段 */
export function filenameRegion(filename: string): string {
  return filename.match(REGION_RE)?.[0] ?? "";
}

const num = (s: string | undefined): number => {
  const n = Number(String(s ?? "").replace(/[,，\s元]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/** 人工类单位（工日/台班）——priceType 缺省推断与手工补录共用 */
export const LABOR_UNIT = /^(工日|工|台班|台时|工·日)$/;

/** 中文单位 → 引擎惯例单位（BOQ/定额用 m/m2/kg 口径） */
const UNIT_NORM: Record<string, string> = {
  米: "m",
  平方米: "m2",
  平米: "m2",
  立方米: "m3",
  立方: "m3",
  公斤: "kg",
  千克: "kg",
  千米: "km",
  公里: "km",
};

/** 「单价(元/米)」「单价 元/台」→ 米/台：无单位列时从价格表头推单位 */
const unitFromPriceHeader = (header: string): string => {
  const m = String(header ?? "").match(/[元块¥]\s*[/每]\s*([一-龥a-zA-Z0-9²³]{1,8})/);
  if (!m) return "";
  return UNIT_NORM[m[1]] ?? m[1];
};

/** 未映射列里的规格碎片：「3*10」「DN100」「0.6/1kV」「860*2260」并入 spec，备注类文本不进 */
const SPECISH = /\d/;
const SPECISH_SHAPE = /[x×*\/\-]|DN|DE|Φ|mm|kV|KV|V|W|MPa/i;

/**
 * 由 ParsedSheet[] 构建价格行。只消费 QUOTATION 型 sheet——
 * BOQ 型的「综合单价」不是材料价（红线：unitPrice 五要素组价结果），
 * 管理员可在映射面板改类型后重新导入。
 */
export function buildPriceRows(
  sheets: ParsedSheet[],
  defaults: PriceDefaults = {},
  filename = ""
): {
  rows: PriceRowInput[];
  skippedBoqSheets: string[];
  skippedNoPrice: number;
} {
  const rows: PriceRowInput[] = [];
  const skippedBoqSheets: string[] = [];
  let skippedNoPrice = 0;
  const fileRegion = filenameRegion(filename);
  const filePeriod = filenamePeriod(filename);

  for (const sheet of sheets) {
    if (sheet.type === "BOQ" || sheet.type === "PENDING_QUOTE") {
      skippedBoqSheets.push(sheet.sheetName);
      continue;
    }
    // MATERIAL_PRICE（信息价/市场价表）与 QUOTATION 同管道进价格库
    if (sheet.type !== "QUOTATION" && sheet.type !== "MATERIAL_PRICE") continue;
    const usedCols = new Set(
      Object.values(sheet.columns).filter((v): v is number => v !== undefined)
    );
    // 无单位列的报价单：「单价(元/米)」表头自带单位
    const priceCol =
      sheet.columns.price ?? sheet.columns.unitPrice ?? sheet.columns.laborPrice;
    const headerUnit =
      sheet.columns.unit === undefined && priceCol !== undefined
        ? unitFromPriceHeader(sheet.headerLabels[priceCol] ?? "")
        : "";
    for (const row of sheet.rows) {
      const c = row.cells;
      // 规格碎片：规格列右侧未映射列里的型号/尺寸片段并入 spec（覆盖合并单元格拆列的报价单）
      let spec = (c.spec ?? "").trim();
      for (let i = 0; i < row.raw.length; i++) {
        if (usedCols.has(i)) continue;
        const v = (row.raw[i] ?? "").trim();
        if (
          v && v.length <= 30 && SPECISH.test(v) && SPECISH_SHAPE.test(v) &&
          !spec.includes(v)
        )
          spec = spec ? `${spec} ${v}` : v;
      }
      const price = num(c.price ?? "") || num(c.unitPrice ?? "") || num(c.laborPrice ?? "");
      // isItem 之外的兜底：供应商报价单常无「名称」列——有规格有价也是有效价格行
      if (!row.isItem && !(spec && price)) continue;
      const name = (c.materialName || c.name || spec).trim().replace(/[。；;，,]+$/, "");
      if (!name) continue;
      // 非正价格（0/负数/面议等非数值）不入库——价格库里零价负价只会污染匹配
      if (price <= 0) {
        skippedNoPrice++;
        continue;
      }
      const unit = (c.unit ?? "").trim() || headerUnit;
      rows.push({
        name,
        spec: spec.replace(/[。；;，,]+$/, ""),
        unit,
        brand: (c.brand ?? "").trim() || (defaults.brand ?? ""),
        price: Math.round(price * 100) / 100,
        priceType:
          normalizePriceType(c.priceType) ||
          defaults.priceType ||
          (LABOR_UNIT.test(unit) ? "LABOR" : "MARKET"),
        region: (c.region ?? "").trim() || defaults.region || fileRegion,
        period: normalizePeriod(c.period) || defaults.period || filePeriod,
        features: JSON.stringify(parseSemanticFeature(`${name} ${spec}`, "")),
        raw: JSON.stringify({
          ...c,
          __unmapped: row.raw.filter((v, i) => !usedCols.has(i) && v.trim()),
        }),
      });
    }
  }
  return { rows, skippedBoqSheets, skippedNoPrice };
}
