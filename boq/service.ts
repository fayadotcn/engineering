import { prisma } from "@database/client";
import type { Prisma } from "@prisma/client";
import { toBoqDTO } from "@database/serialize";
import { toJson } from "@shared/json";
import { D, lineTotal, round2, round3 } from "@cost-engine/money";
import { inferDiscipline, parseSemanticFeature } from "@cost-engine/semantic";
import type { ParsedSheet } from "@file/excel";
import type { BoqItemDTO } from "@shared/types";

// BOQ domain service: import from parsed sheets, query, update.
// All math via cost-engine; all writes produce before/after snapshots.

export async function importBoqFromSheets(
  projectId: string,
  fileId: string,
  sheets: ParsedSheet[]
): Promise<{ count: number; headers: number }> {
  let count = 0;
  let headers = 0;
  let sortOrder = 0;
  const data: Prisma.BoqItemCreateManyInput[] = [];

  for (const sheet of sheets) {
    if (sheet.type !== "BOQ") continue;
    let section = "";
    for (const row of sheet.rows) {
      const name = row.cells.name ?? "";
      if (!name) continue;
      if (row.isHeader && !row.isItem) {
        section = name;
        headers++;
      }
      const qty = D(row.cells.quantity?.replace(/,/g, "") || 0);
      const price = D(row.cells.unitPrice?.replace(/,/g, "") || 0);
      const total =
        row.cells.totalPrice && row.cells.totalPrice.replace(/,/g, "") !== ""
          ? D(row.cells.totalPrice.replace(/,/g, ""))
          : lineTotal(qty, price);
      const rawFeature = row.cells.feature ?? "";
      const features = parseSemanticFeature(name, rawFeature);
      data.push({
        projectId,
        fileId,
        sheetName: sheet.sheetName,
        rowIndex: row.rowIndex,
        code: row.cells.code ?? "",
        name,
        rawFeature,
        unit: row.cells.unit ?? "",
        quantity: round3(qty),
        unitPrice: round2(price),
        totalPrice: total.toDecimalPlaces(2),
        sectionPath: section,
        isHeader: row.isHeader && !row.isItem,
        sortOrder: sortOrder++,
        discipline: inferDiscipline(name, rawFeature, section),
        features: toJson(features),
      });
      if (row.isItem) count++;
    }
  }
  if (data.length) await prisma.boqItem.createMany({ data });
  return { count, headers };
}

export async function listBoq(projectId: string): Promise<BoqItemDTO[]> {
  const items = await prisma.boqItem.findMany({
    where: { projectId },
    orderBy: { sortOrder: "asc" },
  });
  return items.map(toBoqDTO);
}

export interface BoqPatch {
  unitPrice?: string;
  quantity?: string;
  name?: string;
  rawFeature?: string;
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

  for (const { id, patch } of patches) {
    const cur = existing.find((e) => e.id === id);
    if (!cur) continue;
    const qty = patch.quantity !== undefined ? round3(D(patch.quantity)) : cur.quantity;
    const price =
      patch.unitPrice !== undefined ? round2(D(patch.unitPrice)) : cur.unitPrice;
    const features =
      patch.name !== undefined || patch.rawFeature !== undefined
        ? toJson(
            parseSemanticFeature(
              patch.name ?? cur.name,
              patch.rawFeature ?? cur.rawFeature
            )
          )
        : cur.features;
    await prisma.boqItem.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.rawFeature !== undefined ? { rawFeature: patch.rawFeature } : {}),
        quantity: qty,
        unitPrice: price,
        totalPrice: lineTotal(qty, price),
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
    });
  }
  const after = (await prisma.boqItem.findMany({ where: { id: { in: ids } } })).map(
    toBoqDTO
  );
  return { before, after };
}

export async function deleteByFile(fileId: string) {
  await prisma.boqItem.deleteMany({ where: { fileId } });
  await prisma.quotationItem.deleteMany({ where: { fileId } });
}
