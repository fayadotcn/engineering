import * as XLSX from "xlsx";
import ExcelJS from "exceljs";
import { createHash } from "crypto";
import { D, lineTotal, round2 } from "@cost-engine/money";
import { reconcilePriceRole } from "@shared/mapping";

// Excel reading: SheetJS (xls + xlsx). Write-back: exceljs (preserves styles).
// Handles real-world 广联达-style exports: two-row headers, merged cells,
// page-break noise rows, headerless data sheets, and embedded
// "1、名称：X  2、型号规格：Y" feature text.

export interface ParsedRow {
  rowIndex: number; // 1-based excel row
  cells: Record<string, string>;
  /** 续行合并后的整行原文（按列序） */
  raw: string[];
  isHeader: boolean;
  isItem: boolean;
}

export interface ColumnMap {
  seq?: number;
  code?: number;
  name?: number;
  feature?: number;
  unit?: number;
  quantity?: number;
  unitPrice?: number;
  totalPrice?: number;
  materialName?: number;
  spec?: number;
  brand?: number;
  price?: number;
  laborPrice?: number;
  machinePrice?: number;
  region?: number;
  period?: number;
  priceType?: number;
  [k: string]: number | undefined;
}

export interface SheetParse {
  sheetName: string;
  headerRow: number;
  columns: ColumnMap;
  rows: ParsedRow[];
  rawRows: string[][];
}

const COLUMN_SYNONYMS: Record<keyof ColumnMap, RegExp> = {
  seq: /^序号$|^序$|^编号$|^no\.?$|^s\/n$|^item\s*no\.?$/i,
  code: /项目编码|清单编码|编码|项目编号|^code$|item\s*code/i,
  name: /项目名称.*特征|项目名称|分部分项名称|工程名称|^名称$|项目$|^item$|^description$|^desc\.?$|item\s*description/i,
  feature: /项目特征|特征描述|特征/,
  unit: /计量单位|^单位$|^unit$|^uom$/i,
  quantity: /工程数量|工程量|数量|计算式|^qty\.?$|^quantity$/i,
  unitPrice: /综合单价|除税单价|含税单价|^rate$|unit\s*price|unit\s*rate/i,
  totalPrice: /综合合价|合价|金额|总价|^合计$|^amount$|^total$|total\s*(amount|price)/i,
  materialName: /材料名称|设备名称|主材|物料名称|品名|工种|工序名称|人工名称|^material$|material\s*name/i,
  spec: /规格型号|型号规格|规格|型号|规格参数|^spec\.?$|specification|^model$/i,
  brand: /品牌|厂家|厂商|制造商|^brand$|manufacturer|^maker$/i,
  region: /地区|区域|所在城市|价格地区|工程地点|供应地区|^region$|^city$/i,
  period: /价格期|期次|价格日期|报价日期|信息价期|数据期|^日期$|^时间$|月份|^period$|price\s*date/i,
  priceType: /价格类型|价格类别|价格性质|价格来源|^price\s*type$|^source$/i,
  price: /询价|报价|材料单价|主材价|价格|单价|^price$|unit\s*cost/i,
  laborPrice: /人工单价|人工费单价|人工.*单价|单价.*人工|^人工费$|^人工$|labou?r\s*(rate|price|cost)/i,
  machinePrice: /机械单价|机械费单价|机械.*单价|^机械费$|^机械$|machine\s*(rate|price)/i,
};

// 角色尝试顺序即优先级：laborPrice/machinePrice 必须排在 price 前，
// 否则「人工单价」会被 price 的裸「单价」同义词抢走。
const BOQ_COLS: (keyof ColumnMap)[] = [
  "seq", "code", "feature", "unit", "quantity", "unitPrice", "totalPrice",
  "laborPrice", "machinePrice", "name",
];
// priceType/period 必须排在 price 前：「价格类型」「报价日期」都含「价格/报价」，
// 会被 price 同义词抢走；laborPrice/machinePrice 同理先于 price。
const QUOTE_COLS: (keyof ColumnMap)[] = [
  "seq", "spec", "brand", "unit", "region", "period", "priceType",
  "laborPrice", "machinePrice", "price", "materialName",
];

const cellText = (v: unknown): string => {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
};

const NOISE_ROW = /第\s*\d+\s*页|共\s*\d+\s*页|^工程名称[:：]|^标段[:：]|^编制|^复核/;
const CODE_RE = /^\d{9,15}$/;
const UNIT_RE = /^(m|米|个|套|台|根|块|组|kg|t|吨|m2|m3|㎡|m³|处|点|只|条|盏|座|km|100m|10m|宗|项|樘|面|箱|桶|具|台·次|工日)$/i;

/** Extract "1、名称：铜芯电力电缆  2、型号规格：YJV-4*150" style embedded fields. */
export function extractEmbedded(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /\d+\s*[、.]\s*([^:：\n]{1,12})[:：]\s*([^\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out[m[1].trim()] = m[2].trim();
  return out;
}

const hasEmbedded = (s: string) => /[、.]\s*(名称|型号规格|材质|安装部位|连接形式|规格)[:：]/.test(s);

export const colLetter = (i: number): string => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** 数值解析：去千分位/空格；不可解析返回 null。 */
const numVal = (v: string | undefined): number | null => {
  const t = (v ?? "").replace(/[,\s]/g, "");
  return t !== "" && Number.isFinite(Number(t)) ? Number(t) : null;
};

interface ColDetect {
  map: ColumnMap;
  conf: Record<string, number>;
  ev: Record<string, string>;
}

function detectColumns(headerCells: string[], kinds: (keyof ColumnMap)[]): ColDetect {
  const map: ColumnMap = {};
  const conf: Record<string, number> = {};
  const ev: Record<string, string> = {};
  headerCells.forEach((h, idx) => {
    const text = h.replace(/\s+/g, "");
    if (!text) return;
    for (const col of kinds) {
      if (map[col] !== undefined) continue;
      const re = COLUMN_SYNONYMS[col];
      if (re.test(text)) {
        if (col === "name" && /材料名称|设备名称|物料|品名/.test(text)) continue;
        if (col === "unitPrice" && /材料|主材|人工|机械/.test(text)) continue;
        if (col === "price" && /综合单价|人工|机械/.test(text)) continue;
        map[col] = idx;
        // 「人工费/人工」单独成列时只是费用列，未必是单价——降置信
        conf[col] = col === "laborPrice" && /^人工费$|^人工$/.test(text) ? 0.7 : 0.9;
        ev[col] = `表头「${h.trim()}」`;
        break;
      }
    }
  });
  return { map, conf, ev };
}

function headerScore(cells: string[], kinds: (keyof ColumnMap)[]): number {
  const { map } = detectColumns(cells, kinds);
  return kinds.filter((k) => map[k] !== undefined).length;
}

/** Merge two header rows cell-wise (merged-cell exports split titles). */
const mergeRows = (a: string[], b: string[]) => {
  const n = Math.max(a.length, b.length);
  return Array.from({ length: n }, (_, i) => `${a[i] ?? ""}${b[i] ?? ""}`.trim());
};

/** Headerless sheets: infer columns from data-content profiles. */
function profileColumnsDetect(rows: string[][]): ColDetect {
  const map = profileColumns(rows);
  const conf: Record<string, number> = {};
  const ev: Record<string, string> = {};
  for (const k of Object.keys(map)) {
    conf[k] = 0.6;
    ev[k] = "无表头，按数据画像推断";
  }
  return { map, conf, ev };
}

/** 列宽与尾部裁剪：Excel 维度虚高（整列引用报到 1048576 行），
 *  Math.max(...rows.map) 的展开写法在超大行数上会栈溢出，一律走循环。 */
const colWidth = (rows: string[][]) => {
  let w = 0;
  for (const r of rows) if (r.length > w) w = r.length;
  return w;
};
const trimTail = (rows: string[][]) => {
  let n = rows.length;
  while (n > 0 && !rows[n - 1].some((c) => c.trim())) n--;
  return rows.slice(0, n);
};

function profileColumns(rows: string[][]): ColumnMap {
  const width = colWidth(rows);
  const stat = (col: number) => {
    let codes = 0, units = 0, nums = 0, embedded = 0, text = 0;
    for (const r of rows.slice(0, 60)) {
      const v = (r[col] ?? "").trim();
      if (!v) continue;
      if (CODE_RE.test(v)) codes++;
      if (UNIT_RE.test(v)) units++;
      if (v !== "" && !isNaN(Number(v.replace(/,/g, "")))) nums++;
      if (hasEmbedded(v)) embedded++;
      if (/[\p{Script=Han}]/u.test(v)) text++;
    }
    return { codes, units, nums, embedded, text };
  };
  const map: ColumnMap = {};
  // code column: dense 9-15 digit values
  let best = -1, bestScore = 3;
  for (let c = 0; c < width; c++) {
    const s = stat(c);
    if (s.codes > bestScore) { best = c; bestScore = s.codes; }
  }
  if (best >= 0) map.code = best;
  // unit column
  best = -1; bestScore = 3;
  for (let c = 0; c < width; c++) {
    if (c === map.code) continue;
    const s = stat(c);
    if (s.units > bestScore) { best = c; bestScore = s.units; }
  }
  if (best >= 0) map.unit = best;
  // embedded feature column (multi-line "名称：")
  for (let c = 0; c < width; c++) {
    if (Object.values(map).includes(c)) continue;
    if (stat(c).embedded >= 3) { map.feature = c; break; }
  }
  // quantity: numeric column right after unit
  if (map.unit !== undefined) {
    for (let c = map.unit + 1; c < Math.min(map.unit + 3, width); c++) {
      if (stat(c).nums >= 3) { map.quantity = c; break; }
    }
  }
  // name: short-ish han text column that isn't feature
  best = -1; bestScore = 3;
  for (let c = 0; c < width; c++) {
    if (Object.values(map).includes(c)) continue;
    const s = stat(c);
    const short = rows.slice(0, 60).filter((r) => {
      const v = (r[c] ?? "").trim();
      return v && v.length <= 12 && /[\p{Script=Han}]/u.test(v);
    }).length;
    if (s.text > bestScore && short >= s.text * 0.6) { best = c; bestScore = s.text; }
  }
  if (best >= 0) map.name = best;
  return map;
}

export type SheetType = "BOQ" | "QUOTATION" | "GENERIC";

/** 计价表体系费用口径。规费/税金/汇总表是计算结果而非清单项，不映射。 */
export type SheetFeeType = "分部分项" | "单价措施" | "总价措施" | "其他项目";

/** 表-11 总价措施 / 单价措施 / 表-12 其他项目 等 sheet 名 → 费用口径。
 *  表-08 全名是「分部分项工程和单价措施项目清单与计价表」——两种口径混在一张表里，
 *  表级默认必须是分部分项，由分部标题行（"单价措施项目"）逐段切换。 */
export function feeTypeOfSheet(sheetName: string): SheetFeeType | null {
  if (/总价措施/.test(sheetName)) return "总价措施";
  if (/其他项目|暂列|计日工|总承包服务/.test(sheetName)) return "其他项目";
  if (/单价措施/.test(sheetName) && !/分部分项/.test(sheetName)) return "单价措施";
  return null;
}

export interface SheetMapping {
  type: SheetType;
  /** -1 = 无表头 */
  headerRow: number;
  merged: boolean;
  /** role → 0-based 列 */
  columns: Record<string, number>;
}

export interface SheetInspection extends SheetMapping {
  sheetName: string;
  /** 双行已合并的表头文本；无表头时为列字母 A,B,C… */
  headerCells: string[];
  /** 数据区前 6 行（已过滤噪声行），宽度 = colCount */
  sample: string[][];
  colCount: number;
  rowCount: number;
  confidence: Record<string, number>;
  evidence: Record<string, string>;
  /** 有表头: sha1(headerCells 去空白小写 join \u0001)；无表头 null */
  fingerprint: string | null;
  /** excel.ts 内固定 false，由工具层套模板后置 true */
  templateHit: boolean;
  /** 已映射角色置信度最小值，无映射为 0（含 typeConfidence） */
  minConfidence: number;
  /** 类型判定置信度：<0.9 表示清单/询价存在真实歧义，应走确认门 */
  typeConfidence: number;
  /** 类型判定依据（中文，可直接展示） */
  typeEvidence: string;
}

export interface ParsedSheet {
  type: SheetType;
  sheetName: string;
  headerRow: number;
  columns: ColumnMap;
  rows: ParsedRow[];
  /** 双行已合并的表头文本；无表头时为列字母 */
  headerLabels: string[];
  /** 措施/其他项目表的费用口径（分部分项表为 undefined） */
  feeType?: SheetFeeType;
}

/**
 * 数值一致性锁定：量×价=合价 的算术关系是列角色最强的证据，
 * 比表头同义词更可靠（裸「单价」到底是综合单价还是材料价由它裁决）。
 * 表头/无表头都跑；只取数据区前 80 行。
 */
function lockByArithmetic(
  dataRows: string[][],
  headerCells: string[],
  det: ColDetect,
  colCount: number
): { locked: boolean; stolenPrice?: number } {
  const data = dataRows.slice(0, 80);
  const numCols: number[] = [];
  for (let c = 0; c < colCount; c++) {
    let ne = 0, nn = 0;
    for (const r of data) {
      const v = (r[c] ?? "").trim();
      if (!v) continue;
      ne++;
      if (numVal(v) !== null) nn++;
    }
    if (ne >= 3 && nn >= ne * 0.6) numCols.push(c);
  }
  let bestL: { a: number; b: number; c: number; hits: number; all: number } | null = null;
  for (let i = 0; i < numCols.length; i++)
    for (let j = i + 1; j < numCols.length; j++) {
      const a = numCols[i], b = numCols[j];
      for (const c of numCols) {
        if (c === a || c === b) continue;
        let hits = 0, all = 0;
        for (const r of data) {
          const va = numVal(r[a]), vb = numVal(r[b]), vc = numVal(r[c]);
          if (va === null || vb === null || vc === null) continue;
          all++;
          if (
            va !== 0 && vb !== 0 && vc !== 0 &&
            Math.abs(va * vb - vc) <= Math.max(0.011, 0.005 * Math.abs(vc))
          )
            hits++;
        }
        if (
          hits >= 3 && hits >= 0.5 * all &&
          (!bestL || hits > bestL.hits || (hits === bestL.hits && c > bestL.c))
        )
          bestL = { a, b, c, hits, all };
      }
    }
  if (!bestL) return { locked: false };

  const hd = (i: number) => (headerCells[i] ?? "").replace(/\s+/g, "");
  const aQty = COLUMN_SYNONYMS.quantity.test(hd(bestL.a));
  const bQty = COLUMN_SYNONYMS.quantity.test(hd(bestL.b));
  // a/b 中表头命中 quantity 同义词者 → quantity，另一个 → unitPrice；
  // 都不命中则左 → quantity、右 → unitPrice
  const qtyCol = aQty && !bQty ? bestL.a : bQty && !aQty ? bestL.b : Math.min(bestL.a, bestL.b);
  const priceCol = qtyCol === bestL.a ? bestL.b : bestL.a;
  const evBase = `数量×单价≈合价（${bestL.hits}/${bestL.all} 行）`;
  const setRole = (role: string, col: number) => {
    for (const k of Object.keys(det.map)) if (det.map[k] === col) delete det.map[k];
    det.map[role] = col;
    det.conf[role] = 0.97;
    det.ev[role] = evBase + (hd(col) ? `（表头「${headerCells[col]?.trim()}」）` : "");
  };
  setRole("quantity", qtyCol);
  setRole("totalPrice", bestL.c);
  // 分项成本价（材料/人工/机械/询价/费率列）不是综合单价：只锁量与合价
  if (/材料|主材|人工|机械|询价|报价|费率/.test(hd(priceCol))) return { locked: true };
  const stolenPrice = COLUMN_SYNONYMS.price.test(hd(priceCol)) ? priceCol : undefined;
  setRole("unitPrice", priceCol);
  return { locked: true, stolenPrice };
}

/** 单表结构识别：表头定位 → 同义词映射 → 算术锁定 → 类型判定。 */
function detectSheet(rows: string[][], sheetName: string): SheetInspection {
  const colCount = colWidth(rows);

  // best header: single row OR merged pair, first 15 rows
  let best = { row: -1, score: 0, merged: false };
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    for (const merged of [false, true]) {
      if (merged && i + 1 >= rows.length) continue;
      const cells = merged ? mergeRows(rows[i], rows[i + 1]) : rows[i];
      const bq = headerScore(cells, BOQ_COLS);
      const qt = headerScore(cells, QUOTE_COLS);
      const joined = cells.join();
      const boqish = bq >= 3 && /编码|名称|特征|工程量|单位|单价|合价|code|item|qty|quantity|rate|amount/i.test(joined);
      const quoteish = qt >= 3 && /材料|规格|单价|品牌|名称|material|brand|price|spec/i.test(joined);
      const score = Math.max(boqish ? bq : 0, quoteish ? qt : 0);
      if (score > best.score) best = { row: i, score, merged };
    }
  }

  let headerRow = -1;
  let dataStart = 0;
  let headerCells: string[];
  let det: ColDetect;
  if (best.score >= 3) {
    headerRow = best.row;
    headerCells = best.merged ? mergeRows(rows[headerRow], rows[headerRow + 1]) : rows[headerRow];
    // unified detection: QUOTATION keys first, then BOQ keys fill the gaps
    const q = detectColumns(headerCells, QUOTE_COLS);
    const b = detectColumns(headerCells, BOQ_COLS);
    det = {
      map: { ...q.map, ...b.map },
      conf: { ...q.conf, ...b.conf },
      ev: { ...q.ev, ...b.ev },
    };
    dataStart = headerRow + (best.merged ? 2 : 1);
  } else {
    headerCells = Array.from({ length: colCount }, (_, i) => colLetter(i));
    det = profileColumnsDetect(rows.filter((r) => r.some((c) => c.trim())));
  }
  const columns = det.map;
  const hd = (i: number) => (headerCells[i] ?? "").replace(/\s+/g, "");

  const { locked, stolenPrice } = lockByArithmetic(
    rows.slice(dataStart), headerCells, det, colCount
  );

  // 类型判定：内容信号 > 表头信号 > 可用性兜底。
  // 措施/其他项目表（表-11/表-12）只有 名称+编码+金额，没有量/价/单位——
  // 但它们是真实造价组成（安全文明施工费、暂列金额等），必须导入，不能丢。
  const sheetFeeType = feeTypeOfSheet(sheetName);
  const headerText = headerCells.join(" ");
  const boqSignal =
    /项目编码|项目特征|综合单价|工程量|清单|item\s*code|^qty|quantity/i.test(headerText) ||
    (headerRow < 0 && columns.code !== undefined);
  // 强信号=材料名/品牌/询价字样；弱信号=只有「规格型号」——它同时出现在
  // 简式清单（名称+规格型号+数量+单价+合价）与询价单里，属真实歧义
  const strongQuote = /材料名称|设备名称|品牌|厂家|询价|报价|brand|manufacturer/i.test(headerText);
  const weakQuote = /规格型号|型号规格/.test(headerText);
  const quoteSignal = strongQuote || weakQuote;
  const hasQty =
    columns.quantity !== undefined &&
    rows.slice(dataStart, dataStart + 80).filter((r) => numVal(r[columns.quantity!]) !== null).length >= 3;
  const boqUsable =
    (columns.name !== undefined || columns.code !== undefined) &&
    (columns.quantity !== undefined || columns.unitPrice !== undefined || columns.unit !== undefined ||
      (sheetFeeType !== null && columns.totalPrice !== undefined));
  // 算术锁定把 price 列提升为 unitPrice 时，询价判定仍认它
  const priceCol = columns.price ?? stolenPrice;
  const quoteUsable =
    (columns.materialName !== undefined || columns.spec !== undefined || columns.name !== undefined) &&
    priceCol !== undefined;

  let type: SheetType;
  let typeConfidence: number;
  let typeEvidence: string;
  if (sheetFeeType !== null && boqUsable) {
    type = "BOQ";
    typeConfidence = 0.95;
    typeEvidence = "表名含措施/其他项目";
  } else if (boqSignal && boqUsable) {
    type = "BOQ";
    typeConfidence = 0.95;
    typeEvidence = "表头含项目编码/工程量/综合单价等清单信号";
  } else if (quoteSignal && !boqSignal && quoteUsable) {
    type = "QUOTATION"; // 询价表带数量/合价也保持询价
    if (strongQuote) {
      typeConfidence = 0.9;
      typeEvidence = "表头含材料名称/品牌/询价";
    } else {
      typeConfidence = 0.6;
      typeEvidence = "仅有型号规格+数量×单价=合价，可能是询价单也可能是简式清单";
    }
  } else if (locked || (hasQty && (columns.unitPrice !== undefined || priceCol !== undefined || columns.totalPrice !== undefined))) {
    type = "BOQ";
    typeConfidence = locked ? 0.85 : 0.75;
    typeEvidence = "有工程量与单价，按清单处理";
    // 有工程量的清单里，裸「单价」按综合单价处理（分项成本价列除外）
    if (
      columns.unitPrice === undefined && columns.price !== undefined &&
      !/材料|主材|人工|机械|询价|报价/.test(hd(columns.price))
    ) {
      columns.unitPrice = columns.price;
      delete columns.price;
      det.conf.unitPrice = 0.8;
      det.ev.unitPrice = "有工程量列，裸「单价」按综合单价处理";
    }
  } else if (quoteUsable) {
    type = "QUOTATION";
    typeConfidence = 0.7;
    typeEvidence = "有名称/规格与单价列，按询价表处理";
  } else {
    type = boqUsable ? "BOQ" : "GENERIC";
    typeConfidence = boqUsable ? 0.6 : 0.5;
    typeEvidence = boqUsable ? "可映射清单列" : "未识别到清单/询价结构";
  }
  if (type === "QUOTATION" && columns.price === undefined && priceCol !== undefined) {
    // 询价表的单价列就是 price：被算术锁定提升为 unitPrice 的还原回去
    if (columns.unitPrice === priceCol) delete columns.unitPrice;
    columns.price = priceCol;
    det.conf.price = Math.max(det.conf.price ?? 0, 0.9);
    det.ev.price = det.ev.price ?? `表头「${headerCells[priceCol]?.trim()}」`;
  }

  const fingerprint =
    headerRow >= 0
      ? createHash("sha1")
          .update(headerCells.map((c) => c.replace(/\s+/g, "").toLowerCase()).join(""))
          .digest("hex")
      : null;
  const confs = [...Object.keys(columns).map((k) => det.conf[k] ?? 0.9), typeConfidence];
  return {
    sheetName,
    type,
    headerRow,
    merged: best.score >= 3 ? best.merged : false,
    columns: columns as Record<string, number>,
    headerCells,
    sample: rows.slice(dataStart, dataStart + 6).map((r) =>
      Array.from({ length: colCount }, (_, i) => r[i] ?? "")
    ),
    colCount,
    rowCount: Math.max(0, rows.length - dataStart),
    confidence: det.conf,
    evidence: det.ev,
    fingerprint,
    templateHit: false,
    minConfidence: confs.length ? Math.min(...confs) : 0,
    typeConfidence,
    typeEvidence,
  };
}

/**
 * 文件名辅助信号：仅在类型判定拿不准（typeConfidence<0.9）时纠偏。
 * 「规格型号+数量+单价+合价」结构在简式清单与询价单间真实歧义，
 * 文件名是唯一可得的区分证据；两类词都命中/都不命中则不干预。
 */
export function applyTypeHint(
  insp: SheetInspection,
  filename: string
): SheetInspection {
  if (insp.typeConfidence >= 0.9) return insp;
  if (insp.type !== "BOQ" && insp.type !== "QUOTATION") return insp;
  const isQuoteName = /询价|报价|价格表|材料价|信息价/.test(filename);
  const isBoqName = /清单|招标|投标|中标|结算|预算|控制价|送审|财评/.test(filename);
  if (isQuoteName === isBoqName) return insp;

  const type: SheetType = isQuoteName ? "QUOTATION" : "BOQ";
  let typeEvidence = insp.typeEvidence;
  const confidence = { ...insp.confidence };
  const evidence = { ...insp.evidence };
  const { columns, moved } = reconcilePriceRole(type, insp.columns, insp.headerCells);
  if (moved === "unitPrice→price") {
    // 询价表的单价列就是 price，置信沿用
    confidence.price = confidence.unitPrice ?? 0.9;
    delete confidence.unitPrice;
    evidence.price = evidence.unitPrice ?? "";
    delete evidence.unitPrice;
  } else if (moved === "price→unitPrice") {
    confidence.unitPrice = 0.85;
    delete confidence.price;
    evidence.unitPrice = "文件名含清单词，裸「单价」按综合单价处理";
  }
  typeEvidence += isQuoteName ? "；文件名含「询价/报价」" : "；文件名含「清单/招标」";
  const confs = [...Object.keys(columns).map((k) => confidence[k] ?? 0.9), 0.9];
  return {
    ...insp,
    type,
    columns,
    confidence,
    evidence,
    typeConfidence: 0.9,
    typeEvidence,
    minConfidence: confs.length ? Math.min(...confs) : 0,
  };
}

export function inspectWorkbook(buffer: Buffer): SheetInspection[] {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const out: SheetInspection[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const raw: unknown[][] = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      raw: true,
      defval: "",
    });
    if (!raw.length) continue;
    const rows = trimTail(
      raw
        .map((r) => r.map(cellText))
        .filter((r) => !NOISE_ROW.test(r.join(" ")))
    );
    if (!rows.length) continue;
    out.push(detectSheet(rows, sheetName));
  }
  return out;
}

export function parseWorkbook(
  buffer: Buffer,
  opts?: { mapping?: Record<string, SheetMapping> }
): ParsedSheet[] {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheets: ParsedSheet[] = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const raw: unknown[][] = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      raw: true,
      defval: "",
    });
    if (!raw.length) continue;
    const rows = trimTail(
      raw
        .map((r) => r.map(cellText))
        .filter((r) => !NOISE_ROW.test(r.join(" ")))
    );

    const override = opts?.mapping?.[sheetName];
    let insp: SheetInspection;
    if (override) {
      const colCount = colWidth(rows);
      const headerCells =
        override.headerRow >= 0
          ? override.merged
            ? mergeRows(rows[override.headerRow] ?? [], rows[override.headerRow + 1] ?? [])
            : rows[override.headerRow] ?? []
          : Array.from({ length: colCount }, (_, i) => colLetter(i));
      insp = {
        ...override,
        sheetName,
        headerCells,
        sample: [],
        colCount,
        rowCount: 0,
        confidence: {},
        evidence: {},
        fingerprint: null,
        templateHit: false,
        minConfidence: 0,
        typeConfidence: 1,
        typeEvidence: "用户/模板指定映射",
      };
    } else {
      insp = detectSheet(rows, sheetName);
    }
    const { type, headerRow } = insp;
    const columns = insp.columns as ColumnMap;
    const headerCells = insp.headerCells;
    const dataStart = headerRow < 0 ? 0 : headerRow + (insp.merged ? 2 : 1);
    const sheetFeeType = feeTypeOfSheet(sheetName);

    // merge continuation rows (multi-line feature/spec text split vertically)
    // 但名称列有文字的独立行是「分部标题/小计」等结构行，绝不能并进上一条子目——
    // 否则小计行的金额数字会污染上一条的合价列（"1589.16\n4395.33" → Decimal 抛错）
    const SUBTOTAL_RE = /小计\s*$|合\s*计\s*$|总计\s*$/; // 名称以小计/合计/总计结尾的都是汇总行
    const merged: { cells: string[]; origIndex: number }[] = [];
    for (let i = dataStart; i < rows.length; i++) {
      const cells = rows[i];
      const nameCell = columns.name !== undefined ? (cells[columns.name] ?? "").trim() : "";
      const hasAnchor =
        (columns.seq !== undefined && cells[columns.seq]?.trim()) ||
        (columns.code !== undefined && cells[columns.code]?.trim()) ||
        (columns.unit !== undefined && cells[columns.unit]?.trim()) ||
        (columns.quantity !== undefined && cells[columns.quantity]?.trim()) ||
        (columns.price !== undefined && cells[columns.price]?.trim()) ||
        (columns.unitPrice !== undefined && cells[columns.unitPrice]?.trim());
      // 汇总/小计行：不导入也不合并（分部合计由系统自己算）
      if (!hasAnchor && SUBTOTAL_RE.test(nameCell)) continue;
      if (
        !hasAnchor && merged.length && cells.some((c) => c.trim()) &&
        !nameCell // 真续行：名称列为空，只有特征/规格列有延续文本
      ) {
        const prev = merged[merged.length - 1].cells;
        cells.forEach((c, ci) => {
          if (c.trim()) prev[ci] = prev[ci] ? prev[ci] + "\n" + c : c;
        });
        continue;
      }
      merged.push({ cells: [...cells], origIndex: i });
    }

    const parsedRows: ParsedRow[] = [];
    for (const { cells, origIndex } of merged) {
      const get = (k: keyof ColumnMap) =>
        columns[k] !== undefined ? cells[columns[k]!] ?? "" : "";
      // 分页重复的表头行：≥2 个已映射列的值命中自己的列名同义词（"项目编码"/"项目名称"/"工程量"）→ 跳过
      let echo = 0;
      for (const [k, ci] of Object.entries(columns)) {
        if (ci === undefined) continue;
        const v = (cells[ci] ?? "").replace(/\s/g, "");
        if (v && COLUMN_SYNONYMS[k as keyof ColumnMap]?.test(v)) echo++;
      }
      if (echo >= 2) continue;
      // embedded "N、名称：X / 型号规格：Y" fields — scan the whole row
      const joined = cells.filter((c) => hasEmbedded(c)).join("\n");
      const emb = joined ? extractEmbedded(joined) : {};
      let name = (get("name") || get("materialName") || emb["名称"] || "").trim();
      let feature = (get("feature") || joined).trim();
      const spec = (emb["型号规格"] || emb["规格"] || get("spec") || "").trim();
      const quoteName = (get("materialName") || emb["名称"] || name).trim();

      const hasNum = (k: keyof ColumnMap) =>
        get(k) !== "" && !isNaN(Number(get(k).replace(/,/g, "")));
      // 措施/其他项目表里「安全文明施工费」等条目只有名称+金额，没有编码/量/单位——
      // 名称+数字金额也算有效计价行，否则整表费用丢失
      const isItem =
        (name.length > 0 || quoteName.length > 0) &&
        (hasNum("quantity") || hasNum("unitPrice") || hasNum("price") ||
          get("unit") !== "" || get("code") !== "" ||
          (sheetFeeType !== null && hasNum("totalPrice")));
      const isHeader =
        name.length > 0 && !isItem && !hasNum("quantity") && !hasNum("unitPrice") && !hasNum("price");
      const anyText = cells.some((c) => c.trim().length > 0);
      if (!anyText) continue;
      parsedRows.push({
        rowIndex: origIndex + 1,
        raw: [...cells],
        cells: {
          ...Object.fromEntries(
            Object.keys(COLUMN_SYNONYMS).map((k) => [
              k,
              get(k as keyof ColumnMap),
            ])
          ),
          name,
          feature,
          spec,
          materialName: quoteName,
        },
        isHeader,
        isItem,
      });
    }
    sheets.push({ type, sheetName, headerRow, columns, rows: parsedRows, headerLabels: headerCells, feeType: sheetFeeType ?? undefined });
  }
  return sheets;
}

/* ---------- write-back: update price cells in the original workbook ---------- */

export interface CellPatch {
  sheetName: string;
  rowIndex: number;
  unitPrice?: string;
  quantity?: string;
  totalPrice?: string;
  priceCol?: number;
  qtyCol?: number;
  totalCol?: number;
}

export async function writeBackPrices(
  original: Buffer,
  patches: CellPatch[],
  columnsBySheet: Record<string, ColumnMap>
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  let loaded = true;
  try {
    await wb.xlsx.load(original as unknown as ArrayBuffer);
  } catch {
    loaded = false;
  }

  const bySheet = new Map<string, CellPatch[]>();
  patches.forEach((p) => {
    const arr = bySheet.get(p.sheetName) ?? [];
    arr.push(p);
    bySheet.set(p.sheetName, arr);
  });

  if (loaded) {
    for (const [sheetName, ps] of bySheet) {
      const ws = wb.getWorksheet(sheetName);
      if (!ws) continue;
      const cols = columnsBySheet[sheetName] ?? {};
      for (const p of ps) {
        const row = ws.getRow(p.rowIndex);
        if (p.unitPrice !== undefined && (p.priceCol ?? cols.unitPrice) !== undefined) {
          row.getCell((p.priceCol ?? cols.unitPrice)! + 1).value = Number(p.unitPrice);
        }
        if (p.quantity !== undefined && (p.qtyCol ?? cols.quantity) !== undefined) {
          row.getCell((p.qtyCol ?? cols.quantity)! + 1).value = Number(p.quantity);
        }
        if (p.totalPrice !== undefined && (p.totalCol ?? cols.totalPrice) !== undefined) {
          row.getCell((p.totalCol ?? cols.totalPrice)! + 1).value = Number(p.totalPrice);
        }
        row.commit();
      }
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  const out = new ExcelJS.Workbook();
  for (const [sheetName, ps] of bySheet) {
    const ws = out.addWorksheet(sheetName);
    ws.addRow(["行号", "综合单价", "工程量", "合价"]);
    ps.forEach((p) =>
      ws.addRow([p.rowIndex, p.unitPrice ?? "", p.quantity ?? "", p.totalPrice ?? ""])
    );
  }
  return Buffer.from(await out.xlsx.writeBuffer());
}

/** Build a fresh export workbook from current DB items grouped by sheet. */
export async function buildExportWorkbook(
  sheets: {
    sheetName: string;
    columns: { code?: number; name?: number; feature?: number; unit?: number; quantity?: number; unitPrice?: number; totalPrice?: number };
    headerLabels: string[];
    rows: {
      rowIndex: number;
      isHeader: boolean;
      values: Record<string, string>;
    }[];
  }[]
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.sheetName);
    const labels = s.headerLabels;
    ws.addRow(labels).font = { bold: true };
    for (const r of s.rows) {
      ws.addRow(labels.map((l) => {
        const v = r.values[l] ?? "";
        const num = Number(v.replace(/,/g, ""));
        return v !== "" && !isNaN(num) && /单价|合价|工程量|金额|价格/.test(l)
          ? num
          : v;
      }));
    }
    ws.columns.forEach((c: Partial<ExcelJS.Column>) => (c.width = 18));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const recomputeTotal = (qty: string, price: string) =>
  lineTotal(qty, price).toString();

export const roundPrice = (v: string) => round2(D(v)).toString();
