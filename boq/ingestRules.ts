import type { ParsedSheet, SheetFeeType } from "@file/excel";

// Reglas deterministas de clasificación de filas al importar BOQ.
// Extraído de importBoqFromSheets para probarlo sin tocar la base de datos.

/** 分部标题可能切换费用口径（同一 sheet 内先分部分项后单价措施段） */
export const sectionFeeType = (s: string): SheetFeeType | null =>
  /总价措施/.test(s) ? "总价措施"
    : /单价措施/.test(s) ? "单价措施"
      : /其他项目|暂列|计日工|总承包服务/.test(s) ? "其他项目"
        : /分部分项/.test(s) ? "分部分项"
          : null;

/** GB 措施项目编码段（措施附录章；分部分项编码绝不会用这些前缀）：
 *  0117 房建/装饰 · 0212 仿古 · 0313 安装 · 0411 市政 · 0511 园林 · 0611 矿山。
 *  表-08 标题虽写「和单价措施」，很多导出把措施行放表尾、序号重启、无分隔行——按编码段识别。 */
export const MEASURE_CODE_RE = /^(0117|0212|0313|0411|0511|0611)/;

/** 序号重启 + 措施名的兜底信号（措施行缺编码或非 GB 段时）。
 *  不写裸「排水」——排水管/排水立管是分部分项实体，措施行只会写「施工排水/降排水」。 */
export const MEASURE_NAME_RE = /施工排水|基坑排水|降排水|降水|脚手架|围堰|便道|便桥|大型机械|进出场|碰通|垂直运输|超高施工|洞内施工/;

export interface RowDecision {
  feeType: SheetFeeType;
  /** true = 不导入（父子行去重：子行金额已含在父行里） */
  skip: boolean;
}

/**
 * 每行的费用口径与去重决策：
 * - 「单价措施」块：表-08 混排表把措施行放表尾（序号重启/措施编码段），
 *   其后到 sheet 结束都是单价措施；无分隔行的导出靠本规则识别。
 * - 「总价措施/其他项目」父子行：序号「1」父行金额 = Σ 子行(1.x)。
 *   只留父行——子行金额已含在内，两个都导会重复计费（安全文明施工费=基本费+扬尘…）。
 */
export function decideRows(sheet: ParsedSheet): RowDecision[] {
  let cur: SheetFeeType = sheet.feeType ?? "分部分项";
  let measureBlock = cur === "单价措施";
  let prevSeq: number | null = null;
  const mixedSheet = cur === "分部分项" && /单价措施/.test(sheet.sheetName);
  // 序号优先取已映射的 seq 列；空值/未映射回退第一列（序号居 A 列的惯例）
  const seqOf = (r: (typeof sheet.rows)[number]) =>
    String(r.cells.seq?.trim() || r.raw?.[0] || "").trim();
  const lumpParentSeqs = new Set(
    sheet.rows
      .filter((r) => r.isItem && /^\d+$/.test(seqOf(r)))
      .map((r) => seqOf(r))
  );

  return sheet.rows.map((row) => {
    const seqCell = seqOf(row);
    const name = row.cells.name ?? "";
    if (row.isHeader && !row.isItem) {
      const ft = sectionFeeType(name);
      if (ft === "单价措施") measureBlock = true;
      if (!measureBlock && ft) cur = ft;
      return { feeType: measureBlock ? "单价措施" : cur, skip: false };
    }
    if (row.isItem) {
      const lump = cur === "总价措施" || cur === "其他项目";
      const childBase = /^\d+\.\d+$/.test(seqCell) ? seqCell.split(".")[0] : null;
      if (lump && childBase !== null && lumpParentSeqs.has(childBase))
        return { feeType: cur, skip: true };
      const seqNum = /^\d+$/.test(seqCell) ? Number(seqCell) : NaN;
      const restart =
        Number.isFinite(seqNum) && prevSeq !== null && seqNum > 0 && seqNum < prevSeq;
      if (
        cur === "分部分项" && !measureBlock &&
        (MEASURE_CODE_RE.test(row.cells.code ?? "") ||
          (restart && mixedSheet && MEASURE_NAME_RE.test(name)))
      )
        measureBlock = true;
      if (Number.isFinite(seqNum) && seqNum > 0) prevSeq = seqNum;
      return { feeType: measureBlock ? "单价措施" : cur, skip: false };
    }
    return { feeType: cur, skip: false };
  });
}
