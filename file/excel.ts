import * as XLSX from "xlsx";
import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
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
  /** 表-08「其中：人工费」等分解列——**合价口径**（整行金额，不是每单位单价）。
   *  落 rawCells.__decomp 供成本构成消费；labor/machine 另折算每单位值进 BoqItem。 */
  laborFee?: number;
  machineFee?: number;
  materialFee?: number;
  mgmtFee?: number;
  profitFee?: number;
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
  name: /项目名称.*特征|项目名称|分部分项名称|单项工作名称|分项工作名称|工作名称|清单名称|名称及规格型号|名称及型号|工程名称|^名称$|项目$|^item$|^description$|^desc\.?$|item\s*description/i,
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
  // 表-08「其中：人工费/材料费/机械费/管理费/利润」（合价口径）。双行表头
  // 「其中」+「人工费」合并后成「其中人工费」，两种形态都要命中；带「合计/小计」
  // 的变体一并收编——它们同样是整行金额。
  laborFee: /其中.*人工|人工费合计|人工费小计/,
  machineFee: /其中.*机械|机械费合计|机械费小计/,
  materialFee: /其中.*材料|材料费合计|材料费小计/,
  mgmtFee: /其中.*管理|管理费合计|管理费小计/,
  profitFee: /其中.*利润|利润合计|利润小计/,
};

// 角色尝试顺序即优先级：laborPrice/machinePrice 必须排在 price 前，
// 否则「人工单价」会被 price 的裸「单价」同义词抢走。
const BOQ_COLS: (keyof ColumnMap)[] = [
  "seq", "code", "feature", "unit", "quantity", "unitPrice", "totalPrice",
  "laborPrice", "machinePrice", "laborFee", "machineFee", "materialFee", "mgmtFee", "profitFee",
  "name",
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

// 分页页脚/表头噪声行。页码词必须「整行几乎都是页码」才算噪声——
// 清单特征常写「详见图集01SS105第65页」，若用 /第\s*\d+\s*页/ 全行扫
// 会把真实子目整行删掉（漏项漏钱；曾因此丢 减压器 行 1281.28 元）。
const PAGE_TOKEN = String.raw`(?:第\s*\d+\s*页|共\s*\d+\s*页|第\s*\d+\s*\/\s*\d+\s*页|\d+\s*\/\s*\d+)`;
const PAGE_ONLY = new RegExp(`^[\\s\\-—–·,，、]*(?:${PAGE_TOKEN}[\\s\\-—–·,，、]*)+$`);
const NOISE_HEAD = /^\s*(?:工程名称\s*[:：]|标段\s*[:：]|编制|复核)/;
const isNoiseRow = (joined: string): boolean =>
  NOISE_HEAD.test(joined) || PAGE_ONLY.test(joined);
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

/** 金钱文本归一：￥/¥/$ 前缀、会计括号负数 (123)→-123、「元」后缀（与 boq/mapRow.ts 同口径）。 */
const moneyish = (s: string): string =>
  s.replace(/[￥¥$＄]/g, "").replace(/^\((.+)\)$/, "-$1").replace(/元$/, "");

/** 数值解析：去千分位/货币符/空格；不可解析返回 null。 */
const numVal = (v: string | undefined): number | null => {
  const t = moneyish((v ?? "").replace(/[,\s]/g, ""));
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
        // 名称类表头不许被其它角色抢走：「工程量清单项目名称」含「工程量」，
        // 会被 quantity 先命中 → 名称列丢失 → 整表无名行全部丢弃（真实文件回归）。
        if (col !== "name" && col !== "materialName" && /名称|品名|项目内容|工作内容/.test(text)) continue;
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
      if (numVal(v) !== null) nums++;
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
  // 量/价定位以 unit 列为锚。右侧 ≥2 个数值列时按广联达式右扫（单位|量|价|合价），
  // 量×价=合价的算术锁定再兜底裁决（错位布局「名|量|单位|价|合价」靠它回正）；
  // 右侧只有 1 个数值列时它是价不是量，工程量只能来自 unit 左侧紧邻的数值列
  // （「名|量|空|单位|价」——左扫被文本列挡住就停，再往左常是序号/规格列）。
  if (map.unit !== undefined) {
    const rightNums: number[] = [];
    for (let c = map.unit + 1; c < Math.min(map.unit + 5, width); c++) {
      if (stat(c).nums >= 3) rightNums.push(c);
    }
    let leftQty = -1;
    for (let c = map.unit - 1; c >= Math.max(0, map.unit - 3); c--) {
      if (Object.values(map).includes(c)) continue;
      const s = stat(c);
      if (s.nums >= 3) { leftQty = c; break; }
      if (s.text > 0) break;
    }
    if (rightNums.length === 1 && leftQty >= 0) {
      map.quantity = leftQty;
      map.unitPrice = rightNums[0];
    } else if (rightNums.length) {
      map.quantity = rightNums[0];
      if (rightNums[1] !== undefined) map.unitPrice = rightNums[1];
      if (rightNums[2] !== undefined) map.totalPrice = rightNums[2];
    } else if (leftQty >= 0) {
      map.quantity = leftQty;
    }
  }
  // name：汉字文本列。型号后缀的长名（「配电箱 F/B1-6AEPZ」）不该因超 12 字被丢掉，
  // 上限放宽到 30；数字占多数的列是量/价列，排除；短标签占比高的列优先（特征/
  // 工作内容这类长描述列只在没有更像名称的列时才兜底）。
  best = -1; let bestRank = 0;
  for (let c = 0; c < width; c++) {
    if (Object.values(map).includes(c)) continue;
    const s = stat(c);
    if (s.text < 3 || s.nums > s.text) continue;
    const short = rows.slice(0, 60).filter((r) => {
      const v = (r[c] ?? "").trim();
      return v && v.length <= 30 && /[\p{Script=Han}]/u.test(v);
    }).length;
    const rank = s.text * (short >= s.text * 0.5 ? 2 : 1);
    if (rank > bestRank) { bestRank = rank; best = c; }
  }
  if (best >= 0) map.name = best;
  return map;
}

/**
 * Sheet 类型学（真实文件归纳）：
 * BOQ 清单 | QUOTATION 询价表 | GENERIC 忽略
 * COMPARE 对比表（两版量价+差值列，不导入清单，走对审）
 * APPROVAL 报审资料（材料/设备报审、合格证，走文档视图）
 * PENDING_QUOTE 待报价清单（有量无价，按清单导入、单价留空）
 * FACTS 汇总/说明表（表-03/04/13、扉页，不产清单行）
 * MATERIAL_PRICE 材料价格表（信息价/市场价/调价表，按询价管道进价格库）
 */
export type SheetType =
  | "BOQ" | "QUOTATION" | "GENERIC"
  | "COMPARE" | "APPROVAL" | "PENDING_QUOTE" | "FACTS" | "MATERIAL_PRICE";

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
  /** 单价列为含税价（表头含「含税」）→ BoqItem.taxIncluded */
  taxIncluded?: boolean;
  /** 单项/单位工程（多单位工程项目），sheet 名【A‖B】/表内「单位工程名称：X」 */
  unitProject?: string;
  /** 本表数据区结束行（不含）。同一 sheet 里第二张表的表头行号——打印版/
   *  宏业多表导出常见；-1/缺省 = 一直到表尾。 */
  dataEndRow?: number;
  /** 表头占用的行数（打印版清单会把「单位/综合单价/合价」拆到下面几行，
   *  表头块累积后可能 >1）。缺省按 merged?2:1 算。 */
  headerSpan?: number;
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
  /** 单价列含税 → BoqItem.taxIncluded */
  taxIncluded?: boolean;
  /** 单项/单位工程归属（sheet 名【A‖B】解析） */
  unitProject?: string;
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
  // 分项成本价（材料/人工/机械/询价/费率列）不是综合单价：只锁量与合价。
  // 「报价」不在排除内——投标报价列就是综合单价，询价表会经 QUOTATION 还原回 price。
  if (/材料|主材|人工|机械|询价|费率/.test(hd(priceCol))) return { locked: true };
  const stolenPrice = COLUMN_SYNONYMS.price.test(hd(priceCol)) ? priceCol : undefined;
  setRole("unitPrice", priceCol);
  return { locked: true, stolenPrice };
}

/**
 * 表头块累积：打印版清单把表头标签拆到**各自一行**的稀疏列里
 * （真实文件：「计量」一行、「序号|项目编码|项目名称|项目特征描述|工程量」一行、
 * 「单位」一行、「综合单价|合价」一行）。只认一行会漏掉价列与单位列，
 * 整表被判「无价」→ 综合单价全丢。
 * 只吸收短标签行，且列位不能与已有表头重复（重复=数据行，立即停），
 * 所以不会把数据行并进表头。
 */
const accumulateHeader = (
  rows: string[][],
  anchor: number
): { cells: string[]; span: number } => {
  const cells = [...(rows[anchor] ?? [])];
  // 锚点行自己的列位：再出现同样的列 = 数据行（名称/量/价列）→ 立即停。
  // 被吸收行带来的列允许续写（打印版把「计量」「单位」上下拆开）。
  const anchorCols = new Set(cells.map((c, i) => (c.trim() ? i : -1)).filter((i) => i >= 0));
  const labelRow = (row: string[]): [number, string][] | null => {
    const filled = (row ?? [])
      .map((c, i) => [i, c.trim()] as const)
      .filter(([, c]) => c);
    if (!filled.length) return [];
    if (filled.length > 3) return null;
    if (filled.some(([, c]) => c.length > 24 || numVal(c) !== null)) return null;
    if (filled.some(([i]) => anchorCols.has(i))) return null; // 锚点列位重复 → 数据行
    return filled.map(([i, c]) => [i, c] as [number, string]);
  };
  // 上方至多 1 行（「计量」在「单位」上一行的情况；再多会把上张表的表头卷进来）
  if (anchor - 1 >= 0) {
    const up = labelRow(rows[anchor - 1]);
    if (up) for (const [i, c] of up) cells[i] = cells[i] ? cells[i] + c : c;
  }
  let bottom = anchor;
  for (let k = 1; k <= 6 && anchor + k < rows.length; k++) {
    const filled = labelRow(rows[anchor + k]);
    if (filled === null) break;
    if (!filled.length) { bottom = anchor + k; continue; } // 表头块内的空行
    for (const [i, c] of filled) cells[i] = cells[i] ? cells[i] + c : c;
    bottom = anchor + k;
  }
  return { cells, span: bottom - anchor + 1 };
};

/** 表头指纹：去空白小写后的 sha1（ImportTemplate 与多表边界共用同一口径）。 */
const headerFingerprint = (cells: string[]): string =>
  createHash("sha1")
    .update(cells.map((c) => c.replace(/\s+/g, "").toLowerCase()).join("\u0001"))
    .digest("hex");

/** 单表结构识别：表头定位 → 同义词映射 → 算术锁定 → 类型判定。 */
function detectSheet(rows: string[][], sheetName: string): SheetInspection {
  const colCount = colWidth(rows);

  // 表头候选打分（单行或双行合并）
  const scanHeader = (from: number, to: number) => {
    let hit = { row: -1, score: 0, merged: false, single: 0 };
    for (let i = from; i < Math.min(to, rows.length); i++) {
      for (const merged of [false, true]) {
        if (merged && i + 1 >= rows.length) continue;
        const cells = merged ? mergeRows(rows[i], rows[i + 1]) : rows[i];
        const bq = headerScore(cells, BOQ_COLS);
        const qt = headerScore(cells, QUOTE_COLS);
        const joined = cells.join();
        const boqish = bq >= 3 && /编码|名称|特征|工程量|单位|单价|合价|code|item|qty|quantity|rate|amount/i.test(joined);
        const quoteish = qt >= 3 && /材料|规格|单价|品牌|名称|material|brand|price|spec/i.test(joined);
        const score = Math.max(boqish ? bq : 0, quoteish ? qt : 0);
        // 同分优先「本行标签更多」的行：打印版把「计量」单摆一行，
        // 真表头那一行的标签更全（用单行格数比较，不受双行合并影响）
        const single = (rows[i] ?? []).filter((c) => c.trim()).length;
        if (score > hit.score || (score === hit.score && score >= 3 && single > hit.single))
          hit = { row: i, score, merged, single };
      }
    }
    return hit;
  };
  // 先扫前 15 行（常规文件行为不变）；找不到再深扫前 200 行——打印版清单
  // 前面是封面/编制说明/汇总表，真表头常在几十上百行之后（真实文件：第 145 行）。
  // 深扫要求该行以「短标签」为主，避免把数据行误判成表头。
  let best = scanHeader(0, 15);
  if (best.score < 3) {
    const deep = scanHeader(15, 200);
    const cells = deep.row < 0 ? [] : deep.merged ? mergeRows(rows[deep.row] ?? [], rows[deep.row + 1] ?? []) : rows[deep.row] ?? [];
    const filled = cells.filter((c) => c.trim());
    const labels = filled.filter((c) => c.trim().length <= 24).length;
    if (deep.score >= 3 && filled.length >= 3 && labels >= filled.length * 0.6) best = deep;
  }

  let headerRow = -1;
  let dataStart = 0;
  let headerCells: string[];
  let det: ColDetect;
  let headerSpan = 1;
  if (best.score >= 3) {
    headerRow = best.row;
    headerCells = best.merged ? mergeRows(rows[headerRow], rows[headerRow + 1]) : rows[headerRow];
    headerSpan = best.merged ? 2 : 1;
    // 表头块累积：能多认出列角色才采用（打印版稀疏表头 vs 正常单行表头）
    const acc = accumulateHeader(rows, headerRow);
    const scoreOf = (hc: string[]) => headerScore(hc, BOQ_COLS) + headerScore(hc, QUOTE_COLS);
    if (scoreOf(acc.cells) >= scoreOf(headerCells)) {
      headerCells = acc.cells;
      headerSpan = acc.span;
    }
    // unified detection: QUOTATION keys first, then BOQ keys fill the gaps
    const q = detectColumns(headerCells, QUOTE_COLS);
    const b = detectColumns(headerCells, BOQ_COLS);
    det = {
      map: { ...q.map, ...b.map },
      conf: { ...q.conf, ...b.conf },
      ev: { ...q.ev, ...b.ev },
    };
    dataStart = headerRow + headerSpan;
  } else {
    headerCells = Array.from({ length: colCount }, (_, i) => colLetter(i));
    det = profileColumnsDetect(rows.filter((r) => r.some((c) => c.trim())));
  }
  const columns = det.map;
  const hd = (i: number) => (headerCells[i] ?? "").replace(/\s+/g, "");

  const { locked, stolenPrice } = lockByArithmetic(
    rows.slice(dataStart), headerCells, det, colCount
  );

  // 表尾边界：打印版/宏业导出常把多张表挤在一个 sheet（清单 + 措施 + 规费税金）。
  // 第 2 张表头（指纹与首表不同）之后的行不再按首表列位解析——否则规费/税金行
  // 会被当成清单项导入（真值变假项）。指纹相同的重复表头是分部续表，不裁剪。
  let dataEndRow = -1;
  if (headerRow >= 0) {
    const roleCols = [...new Set(Object.values(columns).filter((c): c is number => typeof c === "number"))];
    const norm = (x?: string) => (x ?? "").replace(/\s+/g, "");
    // 同一张表的重复表头（分部续表）：角色列上的标签与首表一致 → 不裁剪。
    // 纯指纹比对在这里不够——表头块累积会把上下相邻的拆行标签卷进来，
    // 粘出来的文本可能不同，但角色列上的标签是同一套。
    const sameHeaderLabels = (probe: string[]) => {
      const hits = roleCols.filter((c) => norm(probe[c]) && norm(probe[c]) === norm(headerCells[c])).length;
      return hits >= Math.max(2, Math.ceil(roleCols.length * 0.6));
    };
    for (let i = dataStart + 1; i < rows.length; i++) {
      const filled = rows[i].filter((c) => c.trim());
      if (filled.length < 3) continue;
      if (filled.filter((c) => c.trim().length <= 24).length < 3) continue; // 数据行不长这样
      const cand = accumulateHeader(rows, i).cells;
      if (headerScore(cand, BOQ_COLS) < 3 && headerScore(cand, QUOTE_COLS) < 3) continue;
      if (sameHeaderLabels(cand)) continue;
      dataEndRow = i;
      break;
    }
  }

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

  /* —— 非清单类型信号（真实文件归纳，判定顺序见 docs/restructure-design.md） —— */
  // FACTS：汇总/说明表（表-03/04/13、扉页、编制说明、总价汇总页）
  const factsSignal =
    /表\s*[-—_]?\s*0?3(?!\d)|表\s*[-—_]?\s*0?4(?!\d)|表\s*[-—_]?\s*13(?!\d)|单项工程.{0,8}汇总|单位工程.{0,8}汇总|工程项目.{0,8}汇总|规费.{0,6}税金|税金.{0,6}规费|扉页|编制说明|总说明|封面|招标控制价.{0,4}汇总|投标总价/.test(sheetName) ||
    (/招标人|投标人|法定代表人|编制单位|造价咨询/.test(headerText) && rows.length <= 30);
  // COMPARE：两版量/价并列。差值列（价差/量差/增减）是直接证据；
  // 双列版本要按词干去重——「投标报价单价」+「投标报价合价」是一组价不是两版
  // 版本/口径词：用于识别「同一张表里多版本量价」的对比表。清标量/上报量是典型的
  // 两版口径（招标控制量 vs 申报量），漏掉它们会把进度计量审核表当清单导入。
  const VERSION_RE = /送审|审定|审核|审批|批准|报审|报批|投标|招标|标底|拦标|控制价|预算|结算|上期|本期|初审|终审|复核|原报|核后|已报|申请|批复|清标|上报/;
  const stripPrice = (h: string) => h.replace(/综合单价|单价|合价|金额|价格|报价|价|元|（[^）]*）|\([^)]*\)|\s/g, "");
  const stripQty = (h: string) => h.replace(/工程数量|工程量|数量|工程|量|\s|（[^）]*）|\([^)]*\)/g, "");
  const versionedStems = (word: RegExp, strip: (h: string) => string) =>
    new Set(
      headerCells
        .filter((h) => word.test(h) && VERSION_RE.test(h))
        .map((h) => strip(h.replace(/\s/g, "")))
        .filter((s) => s.length > 0)
    );
  const deltaCol = headerCells.some((h) =>
    /差额|价差|量差|差异|增减|偏差|对比|核增|核减|下浮|浮动|变动|误差/.test(h.replace(/\s/g, ""))
  );
  const priceFamCount = headerCells.filter((h) => /单价|报价|合价|金额|价格|价/.test(h)).length;
  const compareSignal =
    deltaCol ||
    versionedStems(/单价|报价|合价|金额|价格|价/, stripPrice).size >= 2 ||
    versionedStems(/工程量|数量/, stripQty).size >= 2 ||
    (/对比|对审|清标|比较|分析/.test(sheetName) && priceFamCount >= 2);
  // APPROVAL：材料/设备报审、合格证、进场报验——审批流程文件，非计价数据
  const approvalSignal =
    /报审|报验|出厂证明|合格证|质量证明|使用部位|进场验收|开箱/.test(sheetName) ||
    /报审|报验|出厂证明|合格证|质量证明|使用部位|进场验收/.test(headerText);
  // MATERIAL_PRICE：信息价/市场价/调价表——材料名/规格列 + 库价类价列或地区/期次元数据
  const libPriceCol = headerCells.some((h) =>
    /材料单价|参考单价|信息价|市场价|供应价|综合价|除税价|调定价|核定价/.test(h.replace(/\s/g, ""))
  );
  const priceMeta =
    columns.region !== undefined || columns.period !== undefined || columns.priceType !== undefined;
  const materialPriceSignal =
    !boqSignal &&
    (columns.materialName !== undefined || columns.spec !== undefined || columns.brand !== undefined) &&
    (libPriceCol || (priceMeta && priceCol !== undefined));
  // PENDING_QUOTE：名称+单位+工程量齐但没有任何价列（待报价清单/器材表）
  const noPriceCol =
    columns.unitPrice === undefined && priceCol === undefined && columns.totalPrice === undefined;
  // LIBRARY：企业定额/标准清单库（一级/二级编码体系 + 清单编号 + 计算规则/工作内容），
  // 天生没有工程量列。当清单导入会产出成千上万条 0 量 0 价「清单项」污染全表。
  const librarySignal =
    !columns.quantity &&
    (/一级编码|二级编码|三级编码|四级编码|清单编号|计算规则/.test(headerText) ||
      /企业定额|标准清单|定额库|^定额$|定额表/.test(sheetName));

  let type: SheetType;
  let typeConfidence: number;
  let typeEvidence: string;
  if (sheetFeeType !== null && boqUsable) {
    type = "BOQ";
    typeConfidence = 0.95;
    typeEvidence = "表名含措施/其他项目";
  } else if (factsSignal) {
    type = "FACTS";
    typeConfidence = 0.85;
    typeEvidence = "汇总/说明类表（规费税金/工程汇总/扉页），不产清单行";
  } else if (librarySignal) {
    type = "GENERIC";
    typeConfidence = 0.85;
    typeEvidence = "企业定额/标准清单库（编码体系+计算规则、无工程量列）——按资料忽略，不产清单行；确需导入可在列映射里改成「清单」";
  } else if (compareSignal) {
    type = "COMPARE";
    typeConfidence = deltaCol ? 0.9 : 0.8;
    typeEvidence = "含两版量/价与差值列，是对比表——不导入清单，可用文件对审";
  } else if (approvalSignal) {
    type = "APPROVAL";
    typeConfidence = 0.85;
    typeEvidence = "报审/证明类资料，按文档处理";
  } else if (boqUsable && hasQty && noPriceCol) {
    // 有量无价先于清单信号：招标工程量清单/器材表天生无价列，
    // 语义上是「待报价」——仍按清单导入（单价 0 走未定价流程），类型标清
    type = "PENDING_QUOTE";
    typeConfidence = 0.8;
    typeEvidence = "有名称/单位/工程量但无价格列，按待报价清单导入（单价留空待补）";
  } else if (boqUsable && noPriceCol && !hasQty) {
    // 只有名称+单位、既无工程量也无任何价列（器材清册/待询价材料表）：
    // 按待报价清单导入（量价留空，走缺价补价流程），而不是当垃圾表丢掉
    type = "PENDING_QUOTE";
    typeConfidence = 0.7;
    typeEvidence = "有名称/单位但无工程量也无价格列，按待报价清单导入（量价留空待补）";
  } else if (boqSignal && boqUsable) {
    type = "BOQ";
    typeConfidence = 0.95;
    typeEvidence = "表头含项目编码/工程量/综合单价等清单信号";
  } else if (materialPriceSignal) {
    type = "MATERIAL_PRICE";
    typeConfidence = 0.85;
    typeEvidence = "材料价格表（信息价/市场价），按询价管道处理";
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
    // 有工程量的清单里，裸「单价」按综合单价处理（分项成本价列除外）；
    // 「报价」不挡——投标/清标文件里它就是综合单价口径
    if (
      columns.unitPrice === undefined && columns.price !== undefined &&
      !/材料|主材|人工|机械|询价/.test(hd(columns.price))
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
  } else if (!boqUsable && /汇总|说明|口径|扉页|附注|编制依据|计价依据|取费|费用构成|造价指标/.test(sheetName)) {
    // 汇总/口径/说明页：标签+金额或散文式「税率6%」口径行——不产清单行，
    // 但要走 FACTS 管道让 factsExtract 取台账真值（GENERIC 会整表静默丢掉）
    type = "FACTS";
    typeConfidence = 0.7;
    typeEvidence = "汇总/说明类表（按表名识别），不产清单行";
  } else {
    type = boqUsable ? "BOQ" : "GENERIC";
    typeConfidence = boqUsable ? 0.6 : 0.5;
    typeEvidence = boqUsable ? "可映射清单列" : "未识别到清单/询价结构";
  }
  if ((type === "QUOTATION" || type === "MATERIAL_PRICE") && columns.price === undefined && priceCol !== undefined) {
    // 询价/价格表的单价列就是 price：被算术锁定提升为 unitPrice 的还原回去
    if (columns.unitPrice === priceCol) delete columns.unitPrice;
    columns.price = priceCol;
    det.conf.price = Math.max(det.conf.price ?? 0, 0.9);
    det.ev.price = det.ev.price ?? `表头「${headerCells[priceCol]?.trim()}」`;
  }

  // 单项/单位工程：sheet 名「【单项‖单位】」/「A‖B」取内容，去掉表号/清单词段
  const upMatch =
    sheetName.match(/【\s*([^】]+?)\s*】/) ?? sheetName.match(/^\s*([^\s—_-]{2,30}?)\s*(?:‖|\|\|)/);
  const unitProject = upMatch?.[1]
    ?.split(/[‖|]/)
    .map((s) => s.trim())
    .filter((s) => s && !/分部分项|清单|计价|措施|汇总|表\s*[-—_]?\s*\d/.test(s))
    .join("‖") || undefined;
  // 价列表头含「含税」→ 单价含税。注意「不含税」也含「含税」子串，
  // 必须排除否定式（不含税/未含税/除税/税前），否则除税价表会被误标含税。
  // 单价列自己声明「除税/不含税」时优先以它为准（哪怕合价列写着含税）。
  const saysIncl = (h: string) => /含税/.test(h) && !/不含税|未含税|除税|税前/.test(h);
  const saysExcl = (h: string) => /不含税|未含税|除税|税前/.test(h);
  const upHd = columns.unitPrice !== undefined ? headerCells[columns.unitPrice] ?? "" : "";
  const prHd = columns.price !== undefined ? headerCells[columns.price] ?? "" : "";
  const taxIncluded =
    saysExcl(upHd) || saysExcl(prHd)
      ? false
      : saysIncl(upHd) || saysIncl(prHd) || headerCells.some(saysIncl);

  const fingerprint = headerRow >= 0 ? headerFingerprint(headerCells) : null;
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
    rowCount: Math.max(0, (dataEndRow >= 0 ? dataEndRow : rows.length) - dataStart),
    dataEndRow: dataEndRow >= 0 ? dataEndRow : undefined,
    headerSpan,
    confidence: det.conf,
    evidence: det.ev,
    fingerprint,
    templateHit: false,
    minConfidence: confs.length ? Math.min(...confs) : 0,
    typeConfidence,
    typeEvidence,
    taxIncluded,
    unitProject,
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
        .filter((r) => !isNoiseRow(r.join(" ")))
    );
    if (!rows.length) continue;
    out.push(detectSheet(rows, sheetName));
  }
  // 单位工程兜底：sheet 名本身就是单位工程名（多单位工程工作簿常见形态），
  // 只对清单类表生效，且排除明显是表名而非工程名的命名
  for (const s of out) {
    if (s.unitProject || (s.type !== "BOQ" && s.type !== "PENDING_QUOTE")) continue;
    if (
      /工程|楼|栋|房|库|区|车间|站|馆|场|中心/.test(s.sheetName) &&
      !/清单|计价|措施|汇总|报价|询价|对比|报审|说明|分析|表\s*[-—_]?\s*\d/.test(s.sheetName)
    )
      s.unitProject = s.sheetName.trim();
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
        .filter((r) => !isNoiseRow(r.join(" ")))
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
    const dataStart = headerRow < 0 ? 0 : headerRow + (insp.headerSpan ?? (insp.merged ? 2 : 1));
    // 同一 sheet 内的第 2 张表（措施表/规费税金表）不按首表列位解析
    const dataEnd = insp.dataEndRow && insp.dataEndRow > dataStart ? insp.dataEndRow : rows.length;
    const sheetFeeType = feeTypeOfSheet(sheetName);

    // merge continuation rows (multi-line feature/spec text split vertically)
    // 但名称列有文字的独立行是「分部标题/小计」等结构行，绝不能并进上一条子目——
    // 否则小计行的金额数字会污染上一条的合价列（"1589.16\n4395.33" → Decimal 抛错）
    const SUBTOTAL_RE = /小计\s*$|合\s*计\s*$|总计\s*$/; // 名称以小计/合计/总计结尾的都是汇总行
    const merged: { cells: string[]; origIndex: number }[] = [];
    for (let i = dataStart; i < dataEnd; i++) {
      const cells = rows[i];
      const nameCell = columns.name !== undefined ? (cells[columns.name] ?? "").trim() : "";
      const hasAnchor =
        (columns.seq !== undefined && cells[columns.seq]?.trim()) ||
        (columns.code !== undefined && cells[columns.code]?.trim()) ||
        (columns.unit !== undefined && cells[columns.unit]?.trim()) ||
        (columns.quantity !== undefined && cells[columns.quantity]?.trim()) ||
        (columns.price !== undefined && cells[columns.price]?.trim()) ||
        (columns.unitPrice !== undefined && cells[columns.unitPrice]?.trim());
      // 汇总/小计行：不导入也不合并（分部合计由系统自己算）。
      // 带锚点（序号/编码）的合计行同样跳过——否则表-11/12 里「序号|合计|金额」
      // 会被当 lump-sum 条目导入，feeSummary 把合计行当真费用又算一遍。
      // FACTS 表例外——表-04 的「合计/总计」行正是 factsExtract 要取的真值，不能丢。
      if (SUBTOTAL_RE.test(nameCell) && type !== "FACTS") continue;
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

    // 打印版清单把一个逻辑行的名称拆到相邻行（「干作业成孔灌注」+「桩」两行夹住
    // 一条只带编码/量/价的行）。名称列为空 → isItem=false → 整行当无名行丢掉（漏项）。
    // 回收规则：锚点行缺名称时，取它上下 ±2 行内「无锚点且名称列有短文本」的碎片，
    // 按行序拼回名称；被吃掉的行不再单独出项（它们本来也不是完整清单行）。
    const hasAnchorCell = (cells: string[]) =>
      (["seq", "code", "quantity", "unitPrice", "price"] as const).some(
        (k) => columns[k] !== undefined && (cells[columns[k]!] ?? "").trim()
      );
    const nameCellOf = (cells: string[]) =>
      columns.name !== undefined ? (cells[columns.name] ?? "").trim() : "";
    const consumed = new Set<number>();
    for (let mi = 0; mi < merged.length; mi++) {
      if (consumed.has(mi) || !hasAnchorCell(merged[mi].cells) || nameCellOf(merged[mi].cells)) continue;
      const frags: { idx: number; text: string }[] = [];
      for (let d = -2; d <= 2; d++) {
        const j = mi + d;
        if (d === 0 || j < 0 || j >= merged.length || consumed.has(j)) continue;
        if (hasAnchorCell(merged[j].cells)) continue;
        const t = nameCellOf(merged[j].cells);
        if (!t || t.length > 30) continue;
        frags.push({ idx: j, text: t });
      }
      if (!frags.length || columns.name === undefined) continue;
      frags.sort((a, b) => a.idx - b.idx);
      merged[mi].cells[columns.name] = frags.map((f) => f.text).join("");
      for (const f of frags) consumed.add(f.idx);
    }

    const parsedRows: ParsedRow[] = [];
    for (let mi = 0; mi < merged.length; mi++) {
      if (consumed.has(mi)) continue;
      const { cells, origIndex } = merged[mi];
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
      // 询价/价格表常没有「材料名称」列，型号列就是材料身份——此时用规格兜底成名称，
      // 否则整表被判成「无名行」全部丢弃（真实文件：名称及规格型号 / 只有规格型号）
      const specFallback =
        type === "QUOTATION" || type === "MATERIAL_PRICE"
          ? (emb["型号规格"] || emb["规格"] || get("spec") || "").trim()
          : "";
      let name = (get("name") || get("materialName") || emb["名称"] || specFallback || "").trim();
      let feature = (get("feature") || joined).trim();
      const spec = (emb["型号规格"] || emb["规格"] || get("spec") || "").trim();
      const quoteName = (get("materialName") || emb["名称"] || name).trim();

      const hasNum = (k: keyof ColumnMap) => numVal(get(k)) !== null;
      // 措施/其他项目表里「安全文明施工费」等条目只有名称+金额，没有编码/量/单位——
      // 名称+数字金额也算有效计价行，否则整表费用丢失。
      // 金额列写成「详见本标准表 E.4.2」（真实现金流在附表里）时同样是有效行，
      // 只是金额落 0 等补——总价措施/其他项目表按「有名称即成行」处理。
      const lumpSheet = sheetFeeType === "总价措施" || sheetFeeType === "其他项目";
      const isItem =
        (name.length > 0 || quoteName.length > 0) &&
        (hasNum("quantity") || hasNum("unitPrice") || hasNum("price") ||
          get("unit") !== "" || get("code") !== "" ||
          (sheetFeeType !== null && hasNum("totalPrice")) ||
          (lumpSheet && sheetFeeType !== null));
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
    sheets.push({ type, sheetName, headerRow, columns, rows: parsedRows, headerLabels: headerCells, feeType: sheetFeeType ?? undefined, taxIncluded: insp.taxIncluded, unitProject: insp.unitProject });
  }
  return sheets;
}

/* ---------- write-back: update price cells in the original workbook ---------- */

export interface CellPatch {
  sheetName: string;
  rowIndex: number;
  unitPrice?: string;
  quantity?: string;
  /** 工程量计算式原文：写回时作为工程量单元格批注，复核可查且不改动表格结构 */
  quantityExpr?: string;
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
  try {
    await wb.xlsx.load(original as unknown as ArrayBuffer);
  } catch {
    throw new Error("源文件不是有效的 .xlsx 工作簿，无法保留原格式写回；请使用清单 Excel 导出");
  }

  const bySheet = new Map<string, CellPatch[]>();
  patches.forEach((p) => {
    const arr = bySheet.get(p.sheetName) ?? [];
    arr.push(p);
    bySheet.set(p.sheetName, arr);
  });

  // 单元格原值文本化（公式取计算结果）——写回留痕用
  const cellText = (v: ExcelJS.CellValue): string => {
    if (v === null || v === undefined) return "";
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === "object") {
      const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
      if (o.richText) return o.richText.map((t) => t.text).join("");
      if (o.result !== undefined) return String(o.result);
      if (o.text !== undefined) return String(o.text);
      return String(v);
    }
    return String(v);
  };
  // 原值与新值不同才留痕批注（填空格也记「空→新值」）；同值覆写不打扰。
  // 已有批注（复核签名/上次写回记录）保留在前面——批注就是审计轨迹。
  const write = (cell: ExcelJS.Cell, val: number, extra?: string) => {
    // 脏值纵深防御：NaN/Infinity 落进单元格会把源文件写成坏值且批注记「→ NaN」——宁可中止整个写回
    if (!Number.isFinite(val)) throw new Error(`写回数值无效（${val}），已中止避免污染源文件`);
    const old = cellText(cell.value);
    const oldNum = numVal(old);
    const changed = old === "" || oldNum === null || oldNum !== val;
    if (changed) {
      const prev = typeof cell.note === "string" ? cell.note
        : (cell.note as { texts?: { text: string }[] } | undefined)?.texts?.map((t) => t.text).join("") ?? "";
      const lines = [
        ...(prev ? [prev] : []),
        `造价工具写回：${old === "" ? "（空）" : old} → ${val}`,
        ...(extra ? [extra] : []),
      ];
      cell.note = lines.join("\n");
    }
    cell.value = val;
  };

  for (const [sheetName, ps] of bySheet) {
    const ws = wb.getWorksheet(sheetName);
    if (!ws) throw new Error(`源文件中找不到工作表「${sheetName}」，无法写回`);
    const cols = columnsBySheet[sheetName] ?? {};
    if (!["unitPrice", "quantity", "totalPrice"].some(role => cols[role] !== undefined) && !ps.some(p => p.priceCol !== undefined || p.qtyCol !== undefined || p.totalCol !== undefined))
      throw new Error(`工作表「${sheetName}」没有已确认的工程量或金额列，请先核对映射并重新导入`);
    for (const p of ps) {
      // 复制/补录行没有源表坐标（rowIndex=-1）：getRow(负数) 会抛 Invalid Address
      // 中止整本写回——跳过它，由调用方（excel.write）单独报数
      if (!Number.isInteger(p.rowIndex) || p.rowIndex < 1) continue;
      const row = ws.getRow(p.rowIndex);
      if (p.unitPrice !== undefined && (p.priceCol ?? cols.unitPrice) !== undefined) {
        write(row.getCell((p.priceCol ?? cols.unitPrice)! + 1), Number(p.unitPrice));
      }
      if (p.quantity !== undefined && (p.qtyCol ?? cols.quantity) !== undefined) {
        write(row.getCell((p.qtyCol ?? cols.quantity)! + 1), Number(p.quantity),
          p.quantityExpr ? `工程量计算式：${p.quantityExpr}` : undefined);
      }
      if (p.totalPrice !== undefined && (p.totalCol ?? cols.totalPrice) !== undefined) {
        write(row.getCell((p.totalCol ?? cols.totalPrice)! + 1), Number(p.totalPrice));
      }
      row.commit();
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
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
      /** 未定价行：导出件里整行淡琥珀底色，复核时一眼定位 */
      unpriced?: boolean;
      /** 合计/小计行：整行加粗 */
      bold?: boolean;
      values: Record<string, string>;
    }[];
  }[]
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const names = new Set<string>();
  for (const s of sheets) {
    const base = s.sheetName.replace(/[\\/*?:\[\]]/g, " ").replace(/^'+|'+$/g, "").trim().slice(0, 31) || "清单";
    let name = base;
    for (let n = 2; names.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    names.add(name.toLowerCase());
    const ws = wb.addWorksheet(name);
    const labels = s.headerLabels;
    ws.addRow(labels).font = { bold: true };
    for (const r of s.rows) {
      const row = ws.addRow(labels.map((l) => {
        const v = r.values[l] ?? "";
        const num = numVal(v);
        return num !== null && /单价|合价|工程量|金额|价格|估价/.test(l)
          ? num
          : v;
      }));
      if (r.bold) row.font = { bold: true };
      if (r.unpriced) {
        row.eachCell({ includeEmpty: true }, (c) => {
          c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF7E0" } };
        });
      }
    }
    ws.columns.forEach((c: Partial<ExcelJS.Column>) => (c.width = 18));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const recomputeTotal = (qty: string, price: string) =>
  lineTotal(qty, price).toString();

export const roundPrice = (v: string) => round2(D(v)).toString();
