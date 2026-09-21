import * as XLSX from "xlsx";
import ExcelJS from "exceljs";
import { D, lineTotal, round2 } from "@cost-engine/money";

// Excel reading: SheetJS (xls + xlsx). Write-back: exceljs (preserves styles).
// Handles real-world 广联达-style exports: two-row headers, merged cells,
// page-break noise rows, headerless data sheets, and embedded
// "1、名称：X  2、型号规格：Y" feature text.

export interface ParsedRow {
  rowIndex: number; // 1-based excel row
  cells: Record<string, string>;
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
  seq: /^序号$|^序$|^编号$/,
  code: /项目编码|清单编码|编码|项目编号/,
  name: /项目名称.*特征|项目名称|分部分项名称|工程名称|^名称$|项目$/,
  feature: /项目特征|特征描述|特征/,
  unit: /计量单位|^单位$/,
  quantity: /工程数量|工程量|数量|计算式/,
  unitPrice: /综合单价|除税单价|含税单价/,
  totalPrice: /综合合价|合价|金额|总价/,
  materialName: /材料名称|设备名称|主材|物料名称|品名/,
  spec: /规格型号|型号规格|规格|型号|规格参数/,
  brand: /品牌|厂家|厂商|制造商/,
  price: /询价|报价|材料单价|主材价|价格|单价/,
};

const BOQ_COLS: (keyof ColumnMap)[] = [
  "seq", "code", "feature", "unit", "quantity", "unitPrice", "totalPrice", "name",
];
const QUOTE_COLS: (keyof ColumnMap)[] = [
  "seq", "spec", "brand", "unit", "price", "materialName",
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

function detectColumns(headerCells: string[], kinds: (keyof ColumnMap)[]): ColumnMap {
  const map: ColumnMap = {};
  headerCells.forEach((h, idx) => {
    const text = h.replace(/\s+/g, "");
    if (!text) return;
    for (const col of kinds) {
      if (map[col] !== undefined) continue;
      const re = COLUMN_SYNONYMS[col];
      if (re.test(text)) {
        if (col === "name" && /材料名称|设备名称|物料|品名/.test(text)) continue;
        if (col === "unitPrice" && /材料|主材/.test(text)) continue;
        if (col === "price" && /综合单价/.test(text)) continue;
        map[col] = idx;
        break;
      }
    }
  });
  return map;
}

function headerScore(cells: string[], kinds: (keyof ColumnMap)[]): number {
  const map = detectColumns(cells, kinds);
  return kinds.filter((k) => map[k] !== undefined).length;
}

/** Merge two header rows cell-wise (merged-cell exports split titles). */
const mergeRows = (a: string[], b: string[]) => {
  const n = Math.max(a.length, b.length);
  return Array.from({ length: n }, (_, i) => `${a[i] ?? ""}${b[i] ?? ""}`.trim());
};

/** Headerless sheets: infer columns from data-content profiles. */
function profileColumns(rows: string[][]): ColumnMap {
  const width = Math.max(...rows.map((r) => r.length), 0);
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

export interface ParsedSheet {
  type: SheetType;
  sheetName: string;
  headerRow: number;
  columns: ColumnMap;
  rows: ParsedRow[];
}

export function parseWorkbook(buffer: Buffer): ParsedSheet[] {
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
    const rows = raw
      .map((r) => r.map(cellText))
      .filter((r) => !NOISE_ROW.test(r.join(" ")));

    // best header: single row OR merged pair, first 15 rows
    let best: { row: number; score: number; merged: boolean; boqish: boolean } = {
      row: -1, score: 0, merged: false, boqish: true,
    };
    for (let i = 0; i < Math.min(15, rows.length); i++) {
      for (const merged of [false, true]) {
        if (merged && i + 1 >= rows.length) continue;
        const cells = merged ? mergeRows(rows[i], rows[i + 1]) : rows[i];
        const bq = headerScore(cells, BOQ_COLS);
        const qt = headerScore(cells, QUOTE_COLS);
        const joined = cells.join();
        const boqish = bq >= 3 && /编码|名称|特征|工程量|单位|单价|合价/.test(joined);
        const quoteish = qt >= 3 && /材料|规格|单价|品牌|名称/.test(joined);
        const score = Math.max(boqish ? bq : 0, quoteish ? qt : 0);
        if (score > best.score) {
          best = { row: i, score, merged, boqish: boqish && bq >= qt };
        }
      }
    }

    let headerRow = best.row;
    let columns: ColumnMap = {};
    let type: SheetType = "GENERIC";
    let dataStart = 0;
    if (best.score >= 3 && headerRow >= 0) {
      const cells = best.merged ? mergeRows(rows[headerRow], rows[headerRow + 1]) : rows[headerRow];
      // unified detection: BOQ keys first, then QUOTATION keys fill the gaps
      columns = {
        ...detectColumns(cells, QUOTE_COLS),
        ...detectColumns(cells, BOQ_COLS),
      };
      dataStart = headerRow + (best.merged ? 2 : 1);
    }
    if (best.score < 3) {
      const dataRows = rows.filter((r) => r.some((c) => c.trim()));
      columns = profileColumns(dataRows);
      headerRow = -1;
      dataStart = 0;
    }
    // usability decides type, not just header hits.
    // A real BOQ has 综合单价 or 工程量; a price list has 单价 but no 综合单价.
    const boqUsable = (columns.name !== undefined || columns.code !== undefined) &&
      (columns.quantity !== undefined || columns.unitPrice !== undefined || columns.unit !== undefined);
    const quoteUsable =
      (columns.materialName !== undefined || columns.spec !== undefined || columns.name !== undefined) &&
      columns.price !== undefined;
    if (columns.unitPrice !== undefined || !quoteUsable) {
      type = boqUsable ? "BOQ" : "GENERIC";
    } else {
      type = "QUOTATION";
    }

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
      const isItem =
        (name.length > 0 || quoteName.length > 0) &&
        (hasNum("quantity") || hasNum("unitPrice") || hasNum("price") ||
          get("unit") !== "" || get("code") !== "");
      const isHeader =
        name.length > 0 && !isItem && !hasNum("quantity") && !hasNum("unitPrice") && !hasNum("price");
      const anyText = cells.some((c) => c.trim().length > 0);
      if (!anyText) continue;
      parsedRows.push({
        rowIndex: origIndex + 1,
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
    sheets.push({ type, sheetName, headerRow, columns, rows: parsedRows });
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
