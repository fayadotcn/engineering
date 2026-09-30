import { prisma } from "@database/client";
import type { Prisma } from "@prisma/client";
import { toBoqDTO } from "@database/serialize";
import { toJson } from "@shared/json";
import { D, lineTotal, round2, round3 } from "@cost-engine/money";
import { inferDiscipline, parseSemanticFeature } from "@cost-engine/semantic";
import { rowToBoqInput } from "./mapRow";
import type { ParsedSheet, SheetFeeType } from "@file/excel";
import type { BoqItemDTO } from "@shared/types";

// BOQ domain service: import from parsed sheets, query, update.
// All math via cost-engine; all writes produce before/after snapshots.

export async function importBoqFromSheets(
  projectId: string,
  fileId: string,
  sheets: ParsedSheet[]
): Promise<{
  count: number;
  headers: number;
  nonNumericQty: number;
  derivedUnitPrice: number;
  laborPriceCol: boolean;
}> {
  let count = 0;
  let headers = 0;
  let nonNumericQty = 0;
  let derivedUnitPrice = 0;
  let sortOrder = 0;
  const data: Prisma.BoqItemCreateManyInput[] = [];

  /** 分部标题可能切换费用口径（同一 sheet 内先分部分项后单价措施段） */
  const sectionFeeType = (s: string): SheetFeeType | null =>
    /总价措施/.test(s) ? "总价措施"
    : /单价措施/.test(s) ? "单价措施"
    : /其他项目|暂列|计日工|总承包服务/.test(s) ? "其他项目"
    : /分部分项/.test(s) ? "分部分项"
    : null;

  const laborPriceCol = sheets.some(
    (s) =>
      s.type === "BOQ" &&
      (s.columns.laborPrice !== undefined || s.columns.machinePrice !== undefined)
  );

  for (const sheet of sheets) {
    if (sheet.type !== "BOQ") continue;
    let section = "";
    let curFeeType: SheetFeeType = sheet.feeType ?? "分部分项";
    for (const row of sheet.rows) {
      const name = row.cells.name ?? "";
      if (!name) continue;
      if (row.isHeader && !row.isItem) {
        section = name;
        curFeeType = sectionFeeType(name) ?? curFeeType;
        headers++;
      }
      const { __flags, ...input } = rowToBoqInput(row, sheet, {
        projectId,
        fileId,
        sortOrder: sortOrder++,
        section,
        feeType: curFeeType,
      });
      data.push(input);
      if (__flags.nonNumericQty) nonNumericQty++;
      if (__flags.derivedUnitPrice) derivedUnitPrice++;
      if (row.isItem) count++;
    }
  }
  if (data.length) await prisma.boqItem.createMany({ data });
  return { count, headers, nonNumericQty, derivedUnitPrice, laborPriceCol };
}

export async function listBoq(
  projectId: string,
  opts?: { rawCells?: boolean }
): Promise<BoqItemDTO[]> {
  const items = await prisma.boqItem.findMany({
    where: { projectId },
    orderBy: { sortOrder: "asc" },
    // 列表页不需要整行原文 JSON（大表翻倍 DB 读取量）；服务端工具默认仍带
    ...(opts?.rawCells === false ? { omit: { rawCells: true } } : {}),
  });
  return items.map(toBoqDTO);
}

export interface BoqPatch {
  unitPrice?: string;
  /** 主材暂估价：组价输入，写入不影响 合价=量×综合单价 */
  mainMaterialPrice?: string;
  /** 组价方案（PricingPlanLine[]），组价写回/人工选定定额时更新 */
  pricingPlan?: unknown[];
  quantity?: string;
  name?: string;
  rawFeature?: string;
  /** Receipt restoration and lump-sum amounts; never a material quotation price. */
  totalPrice?: string;
}

export async function updateBoqItems(
  projectId: string,
  patches: { id: string; patch: BoqPatch }[]
): Promise<{ before: BoqItemDTO[]; after: BoqItemDTO[] }> {
  const ids = patches.map((p) => p.id);
  const existing = await prisma.boqItem.findMany({
    where: { projectId, id: { in: ids } },
  });
  const before = existing.map(toBoqDTO);
  if (new Set(ids).size !== ids.length || existing.length !== ids.length)
    throw new Error("清单项重复、不存在或不属于当前项目");
  const updates: Prisma.PrismaPromise<unknown>[] = [];
  for (const { id, patch } of patches) {
    const cur = existing.find((e) => e.id === id)!;
    const qty = patch.quantity !== undefined ? round3(D(patch.quantity)) : cur.quantity;
    const price =
      patch.unitPrice !== undefined ? round2(D(patch.unitPrice)) : cur.unitPrice;
    if (!qty.isFinite() || !price.isFinite() || price.lt(0)) throw new Error("工程量和综合单价必须为有效数字，单价不能为负数");
    if (patch.mainMaterialPrice !== undefined && (!D(patch.mainMaterialPrice).isFinite() || D(patch.mainMaterialPrice).lt(0))) throw new Error("主材暂估价必须为非负有效数字");
    if (patch.name !== undefined && !patch.name.trim()) throw new Error("项目名称不能为空");
    if (patch.totalPrice !== undefined && !D(patch.totalPrice).isFinite()) throw new Error("合价必须为有效数字");
    const features =
      patch.name !== undefined || patch.rawFeature !== undefined
        ? toJson(
            parseSemanticFeature(
              patch.name ?? cur.name,
              patch.rawFeature ?? cur.rawFeature
            )
          )
        : cur.features;
    updates.push(prisma.boqItem.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.rawFeature !== undefined ? { rawFeature: patch.rawFeature } : {}),
        ...(patch.mainMaterialPrice !== undefined
          ? { mainMaterialPrice: round2(D(patch.mainMaterialPrice)) }
          : {}),
        ...(patch.pricingPlan !== undefined
          ? { pricingPlan: toJson(patch.pricingPlan) }
          : {}),
        quantity: qty,
        unitPrice: price,
        // Imported lump-sum/other-fee totals survive material and text edits.
        totalPrice: patch.totalPrice !== undefined ? round2(D(patch.totalPrice)) : patch.quantity !== undefined || patch.unitPrice !== undefined ? lineTotal(qty, price) : cur.totalPrice,
        features,
        ...(patch.name !== undefined || patch.rawFeature !== undefined
          ? {
              discipline: inferDiscipline(
                patch.name ?? cur.name,
                patch.rawFeature ?? cur.rawFeature,
                cur.sectionPath
              ),
            }
          : {}),
      },
    }));
  }
  await prisma.$transaction(updates);
  const after = (await prisma.boqItem.findMany({ where: { projectId, id: { in: ids } } })).map(
    toBoqDTO
  );
  return { before, after };
}

export async function deleteByFile(fileId: string) {
  await prisma.boqItem.deleteMany({ where: { fileId } });
  await prisma.quotationItem.deleteMany({ where: { fileId } });
}
