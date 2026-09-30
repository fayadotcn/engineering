import type { BoqItem, CostFact, QuotationItem } from "@prisma/client";
import { fromJson } from "@shared/json";
import type {
  BoqItemDTO,
  BoqSemanticFeature,
  PricingPlanLine,
  CostFactDTO,
  Discipline,
  QuotationItemDTO,
} from "@shared/types";

export function toBoqDTO(it: Omit<BoqItem, "rawCells"> & { rawCells?: string }): BoqItemDTO {
  return {
    id: it.id,
    projectId: it.projectId,
    fileId: it.fileId,
    sheetName: it.sheetName,
    rowIndex: it.rowIndex,
    code: it.code,
    name: it.name,
    rawFeature: it.rawFeature,
    unit: it.unit,
    quantity: it.quantity.toString(),
    unitPrice: it.unitPrice.toString(),
    mainMaterialPrice: it.mainMaterialPrice.toString(),
    pricingPlan: fromJson<PricingPlanLine[]>(it.pricingPlan, []),
    totalPrice: it.totalPrice.toString(),
    rawCells: fromJson<Record<string, unknown>>(it.rawCells ?? "{}", {}),
    feeType: it.feeType as BoqItemDTO["feeType"],
    sectionPath: it.sectionPath,
    isHeader: it.isHeader,
    sortOrder: it.sortOrder,
    discipline: it.discipline as Discipline,
    features: fromJson<BoqSemanticFeature>(it.features, {}),
  };
}

export function toQuoteDTO(q: QuotationItem): QuotationItemDTO {
  return {
    id: q.id,
    fileId: q.fileId,
    materialName: q.materialName,
    spec: q.spec,
    unit: q.unit,
    brand: q.brand,
    price: q.price.toString(),
    sheetName: q.sheetName,
    features: fromJson<BoqSemanticFeature>(q.features, {}),
    createdAt: q.createdAt.toISOString(),
  };
}

export function toFactDTO(f: CostFact): CostFactDTO {
  return {
    id: f.id,
    factType: f.factType,
    key: f.key,
    value: f.value,
    source: f.source as CostFactDTO["source"],
    confidence: f.confidence,
    createdBy: f.createdBy,
    createdAt: f.createdAt.toISOString(),
  };
}
