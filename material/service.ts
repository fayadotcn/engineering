import { prisma } from "@database/client";
import type { Prisma } from "@prisma/client";
import { toQuoteDTO } from "@database/serialize";
import { toJson } from "@shared/json";
import { D, round2 } from "@cost-engine/money";
import { parseSemanticFeature } from "@cost-engine/semantic";
import type { ParsedSheet } from "@file/excel";
import type { QuotationItemDTO } from "@shared/types";

export async function importQuotationsFromSheets(
  projectId: string,
  fileId: string,
  sheets: ParsedSheet[]
): Promise<number> {
  let count = 0;
  const data: Prisma.QuotationItemCreateManyInput[] = [];
  for (const sheet of sheets) {
    // MATERIAL_PRICE（信息价/市场价表）与 QUOTATION 同管道进询价行
    if (sheet.type !== "QUOTATION" && sheet.type !== "MATERIAL_PRICE") continue;
    for (const row of sheet.rows) {
      const name = (row.cells.materialName || row.cells.name || "").trim();
      if (!name || !row.isItem) continue;
      const spec = row.cells.spec ?? "";
      const features = parseSemanticFeature(`${name} ${spec}`, "");
      // 询价单元格容错：「面议/暂估/—」等非数值落 0（等价无报价），不能让 Decimal 抛错拖垮整个文件导入
      const priceNum = Number((row.cells.price ?? "").replace(/[,，\s]/g, ""));
      data.push({
        projectId,
        fileId,
        materialName: name,
        spec,
        unit: row.cells.unit ?? "",
        brand: row.cells.brand ?? "",
        price: round2(Number.isFinite(priceNum) ? priceNum : 0),
        sheetName: sheet.sheetName,
        rowIndex: row.rowIndex,
        features: toJson(features),
        raw: toJson(row.cells),
      });
      count++;
    }
  }
  if (data.length) await prisma.quotationItem.createMany({ data });
  return count;
}

export async function listQuotations(projectId: string): Promise<QuotationItemDTO[]> {
  const rows = await prisma.quotationItem.findMany({
    where: { projectId },
    orderBy: { rowIndex: "asc" },
  });
  return rows.map(toQuoteDTO);
}
