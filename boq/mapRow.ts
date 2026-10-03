import type { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { D, lineTotal, round2, round3 } from "@cost-engine/money";
import { inferDiscipline, parseSemanticFeature } from "@cost-engine/semantic";
import { toJson } from "@shared/json";
import { colLetter, type ParsedRow, type ParsedSheet, type SheetFeeType } from "@file/excel";

// 纯函数：ParsedRow → BoqItem 落库行。不引 prisma client，便于单测。
// 原始单元格全量保留在 rawCells（键=表头标签，无表头用列字母），
// 非数值/推导列通过 __nonNumeric/__derived 标记，供成本模型与审计回溯。

/** 数值单元格容错：取首行、去千分位/空格；非数值落 "0"（decimal.js 遇 "暂估" 会抛错打断导入） */
const numCell = (v?: string): string => {
  const first = (v ?? "").split("\n")[0].replace(/[,\s]/g, "");
  return first !== "" && Number.isFinite(Number(first)) ? first : "0";
};

const isNonNumeric = (v?: string): boolean => {
  const t = (v ?? "").split("\n")[0].trim();
  return t !== "" && numValIsNaN(t);
};
const numValIsNaN = (t: string) =>
  !Number.isFinite(Number(t.replace(/[,\s]/g, "")));

export function rowToBoqInput(
  row: ParsedRow,
  sheet: ParsedSheet,
  ctx: {
    projectId: string;
    fileId: string;
    sortOrder: number;
    section: string;
    feeType: SheetFeeType;
    /** 行级单位工程覆盖（「单位工程名称：X」标记行），缺省用 sheet 级 */
    unitProject?: string;
  }
): Prisma.BoqItemCreateManyInput & {
  __flags: { nonNumericQty: boolean; derivedUnitPrice: boolean; arithMismatch: boolean };
} {
  const name = row.cells.name ?? "";
  const rawFeature = row.cells.feature ?? "";
  const features = parseSemanticFeature(name, rawFeature);

  const rawCells: Record<string, unknown> = {};
  (row.raw ?? []).forEach((v, ci) => {
    const t = (v ?? "").trim();
    if (!t) return;
    let label = (sheet.headerLabels?.[ci] ?? "").trim() || colLetter(ci);
    // 两列同名表头（或双行合并后重复）不能互相覆盖，后者带列字母区分
    if (label in rawCells) label = `${label}(${colLetter(ci)})`;
    rawCells[label] = v;
  });

  // 工程量/单价/合价非空但非数值 → 落 0 且记录角色名
  const nonNumeric: string[] = [];
  for (const role of ["quantity", "unitPrice", "totalPrice"] as const) {
    if (isNonNumeric(row.cells[role])) nonNumeric.push(role);
  }

  const qty = D(numCell(row.cells.quantity));
  let price = D(numCell(row.cells.unitPrice));
  // 清单表里的「材料单价/主材价」列 → mainMaterialPrice（组价输入，非综合单价）
  const mainMat = D(numCell(row.cells.price));
  // 综合单价分析表自带的人材机分解列（每清单单位）→ 成本构成分析直接消费
  const laborUnit = D(numCell(row.cells.laborPrice));
  const machineUnit = D(numCell(row.cells.machinePrice));
  // 合价单元格非数值（「—」「详见计算式」）时退回 量×价，别落 0 吃掉一行真钱
  const totalCell = (row.cells.totalPrice ?? "").trim();
  const total =
    totalCell !== "" && !isNonNumeric(totalCell)
      ? D(numCell(totalCell))
      : lineTotal(qty, price);

  const derived: string[] = [];
  // 成本表等无综合单价列：合价÷工程量 反推
  if (sheet.columns.unitPrice === undefined && total.gt(0) && qty.gt(0)) {
    price = round2(total.div(qty));
    derived.push("unitPrice");
  }
  if (nonNumeric.length) rawCells.__nonNumeric = nonNumeric;
  if (derived.length) rawCells.__derived = derived;

  // 算术不符早期预警（与 findArithmeticMismatches 同容差）：源表合价是真值、
  // 可计价行且量价均非零时，合价≠量×价 说明源表断链/改量忘改价
  const pricable = ctx.feeType === "分部分项" || ctx.feeType === "单价措施";
  const arithMismatch =
    pricable && !qty.isZero() && !price.isZero() && totalCell !== "" && !isNonNumeric(totalCell)
      ? total.minus(lineTotal(qty, price)).abs().gt(Decimal.max(D(0.02), lineTotal(qty, price).abs().mul(0.001)))
      : false;

  return {
    projectId: ctx.projectId,
    fileId: ctx.fileId,
    sheetName: sheet.sheetName,
    rowIndex: row.rowIndex,
    code: row.cells.code ?? "",
    name,
    rawFeature,
    unit: row.cells.unit ?? "",
    quantity: round3(qty),
    unitPrice: round2(price),
    mainMaterialPrice: round2(mainMat),
    laborUnitPrice: round2(laborUnit),
    machineUnitPrice: round2(machineUnit),
    totalPrice: total.toDecimalPlaces(2),
    feeType: ctx.feeType,
    sectionPath: ctx.section,
    unitProject: ctx.unitProject ?? sheet.unitProject ?? "",
    taxIncluded: sheet.taxIncluded === true,
    isHeader: row.isHeader && !row.isItem,
    sortOrder: ctx.sortOrder,
    discipline: inferDiscipline(name, rawFeature, ctx.section),
    features: toJson(features),
    rawCells: toJson(rawCells),
    __flags: {
      nonNumericQty: nonNumeric.includes("quantity"),
      derivedUnitPrice: derived.includes("unitPrice"),
      arithMismatch,
    },
  };
}
