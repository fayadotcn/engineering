import { prisma } from "@database/client";
import type { Prisma } from "@prisma/client";
import { toBoqDTO } from "@database/serialize";
import { toJson } from "@shared/json";
import { D, lineTotal, round2, round3 } from "@cost-engine/money";
import { inferDiscipline, parseSemanticFeature } from "@cost-engine/semantic";
import { rowToBoqInput } from "./mapRow";
import { decideRows } from "./ingestRules";
import type { ParsedSheet } from "@file/excel";
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

  const laborPriceCol = sheets.some(
    (s) =>
      (s.type === "BOQ" || s.type === "PENDING_QUOTE") &&
      (s.columns.laborPrice !== undefined || s.columns.machinePrice !== undefined)
  );

  for (const sheet of sheets) {
    if (sheet.type !== "BOQ" && sheet.type !== "PENDING_QUOTE") continue;
    let section = "";
    let unitProject = sheet.unitProject ?? "";
    // 行级决策（纯函数，见 ingestRules）：单价措施尾块识别 + 总价措施父子行去重
    const decisions = decideRows(sheet);
    for (let ri = 0; ri < sheet.rows.length; ri++) {
      const row = sheet.rows[ri];
      const name = row.cells.name ?? "";
      // 表内「单位工程名称：X / 单项工程：X」标记行：切换后续行的单位工程归属
      const upCell = (row.raw ?? []).map((c) => c.match(/(?:单项工程|单位工程)(?:名称)?\s*[:：]\s*(.+)/)?.[1]?.trim()).find(Boolean);
      if (upCell) unitProject = upCell;
      if (!name || decisions[ri].skip) continue;
      if (row.isHeader && !row.isItem) {
        section = name;
        headers++;
      }
      const { __flags, ...input } = rowToBoqInput(row, sheet, {
        projectId,
        fileId,
        sortOrder: sortOrder++,
        section,
        feeType: decisions[ri].feeType,
        unitProject,
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
    include: { file: { select: { createdAt: true } } },
    // 列表页不需要整行原文 JSON（大表翻倍 DB 读取量）；服务端工具默认仍带
    ...(opts?.rawCells === false ? { omit: { rawCells: true } } : {}),
  });
  // sortOrder 只在单次导入内递增——同一文件的分部/措施/其他项目表天然连续，
  // 但历史数据每个文件都从 0 起排，裸按 sortOrder 会让不同文件的行交错。
  // 统一按（文件导入先后 → 表内序号）排：手工补录（无文件）永远在最后。
  const fileRank = new Map<string, number>();
  for (const it of items.filter(i => i.file).sort((a, b) => a.file!.createdAt.getTime() - b.file!.createdAt.getTime())) {
    if (!fileRank.has(it.fileId!)) fileRank.set(it.fileId!, fileRank.size);
  }
  items.sort((a, b) => {
    const ra = a.fileId ? (fileRank.get(a.fileId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    const rb = b.fileId ? (fileRank.get(b.fileId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    return ra - rb || a.sortOrder - b.sortOrder;
  });
  return items.map(toBoqDTO);
}

export interface BoqPatch {
  unitPrice?: string;
  /** 主材暂估价：组价输入，写入不影响 合价=量×综合单价 */
  mainMaterialPrice?: string;
  /** 人材机分解列（成本构成分析输入），非负 */
  laborUnitPrice?: string;
  machineUnitPrice?: string;
  /** 组价方案（PricingPlanLine[]），组价写回/人工选定定额时更新 */
  pricingPlan?: unknown[];
  quantity?: string;
  /** 工程量计算式原文；随 quantity 一起写入留痕，纯数字修改传 "" 清掉旧式 */
  quantityExpr?: string;
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
    const lumpSum = cur.feeType === "总价措施" || cur.feeType === "其他项目";
    if (lumpSum && (patch.quantity !== undefined || patch.unitPrice !== undefined))
      throw new Error("总价措施和其他项目按总额计价，请直接修改合价");
    const qty = patch.quantity !== undefined ? round3(D(patch.quantity)) : cur.quantity;
    const price =
      patch.unitPrice !== undefined ? round2(D(patch.unitPrice)) : cur.unitPrice;
    if (!qty.isFinite() || !price.isFinite() || price.lt(0)) throw new Error("工程量和综合单价必须为有效数字，单价不能为负数");
    if (patch.mainMaterialPrice !== undefined && (!D(patch.mainMaterialPrice).isFinite() || D(patch.mainMaterialPrice).lt(0))) throw new Error("主材暂估价必须为非负有效数字");
    for (const k of ["laborUnitPrice", "machineUnitPrice"] as const)
      if (patch[k] !== undefined && (!D(patch[k]).isFinite() || D(patch[k]).lt(0))) throw new Error("人工/机械单价必须为非负有效数字");
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
        ...(patch.laborUnitPrice !== undefined
          ? { laborUnitPrice: round2(D(patch.laborUnitPrice)) }
          : {}),
        ...(patch.machineUnitPrice !== undefined
          ? { machineUnitPrice: round2(D(patch.machineUnitPrice)) }
          : {}),
        ...(patch.pricingPlan !== undefined
          ? { pricingPlan: toJson(patch.pricingPlan) }
          : {}),
        quantity: qty,
        // 工程量一旦有改动就同步留痕：计算式编辑写原文，纯数字编辑清空旧式（式与值不再对应）
        ...(patch.quantity !== undefined ? { quantityExpr: patch.quantityExpr ?? "" } : {}),
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
