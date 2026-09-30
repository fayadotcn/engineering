import { describe, expect, it } from "vitest";
import { applyTemplateToSheet } from "../file/inspection";
import type { SheetInspection } from "../file/excel";

/** 一份毫无歧义的招标清单表：项目编码 + 项目特征 + 工程量 + 综合单价。 */
function boqSheet(): SheetInspection {
  return {
    sheetName: "分部分项",
    type: "BOQ",
    headerRow: 2,
    headerCells: ["序号", "项目编码", "项目名称", "项目特征", "计量单位", "工程量", "综合单价", "合价"],
    sample: [],
    merged: false,
    colCount: 8,
    rowCount: 22,
    columns: { code: 1, name: 2, spec: 3, unit: 4, quantity: 5, unitPrice: 6, totalPrice: 7 },
    confidence: {},
    evidence: {},
    fingerprint: "abc123",
    templateHit: false,
    minConfidence: 0.95,
    typeConfidence: 0.95,
    typeEvidence: "识别到项目编码与综合单价，判定为清单",
  };
}

const poisonedTemplate = {
  sheetType: "QUOTATION",
  columns: JSON.stringify({ code: 1, name: 2, quantity: 5, price: 6, totalPrice: 7 }),
  useCount: 4,
};

describe("模板套用", () => {
  it("模板类型与本文件证据冲突时不盲从模板，并要求人工核对", () => {
    const { sheet, needsConfirm } = applyTemplateToSheet(boqSheet(), poisonedTemplate);
    expect(sheet.type).toBe("BOQ");
    expect(needsConfirm).toBe(true);
    expect(sheet.templateHit).toBe(true);
    // 这两条一起才拦得住：needsConfirm 让确认门开，minConfidence 兜住其它调用方
    expect(sheet.minConfidence).toBeLessThan(0.9);
    expect(sheet.typeConfidence).toBeGreaterThanOrEqual(0.9);
  });

  it("冲突时单价角色随类型对齐（询价的 price 变成清单的 unitPrice）", () => {
    const { sheet } = applyTemplateToSheet(boqSheet(), poisonedTemplate);
    expect(sheet.columns.unitPrice).toBe(6);
    expect(sheet.columns.price).toBeUndefined();
  });

  it("模板类型与本文件一致时照常自动放行", () => {
    const { sheet, needsConfirm } = applyTemplateToSheet(boqSheet(), {
      sheetType: "BOQ",
      columns: JSON.stringify({ code: 1, name: 2, quantity: 5, unitPrice: 6, totalPrice: 7 }),
      useCount: 2,
    });
    expect(sheet.type).toBe("BOQ");
    expect(needsConfirm).toBe(false);
    expect(sheet.minConfidence).toBe(1);
    expect(sheet.typeConfidence).toBe(1);
  });

  it("本文件自己拿不准时，仍以人确认过的模板为准", () => {
    const ambiguous: SheetInspection = {
      ...boqSheet(),
      typeConfidence: 0.6,
      typeEvidence: "规格型号+量×价=合价，清单与询价存在歧义",
    };
    const { sheet, needsConfirm } = applyTemplateToSheet(ambiguous, {
      sheetType: "QUOTATION",
      columns: JSON.stringify({ name: 2, quantity: 5, price: 6 }),
      useCount: 1,
    });
    expect(sheet.type).toBe("QUOTATION");
    expect(needsConfirm).toBe(false);
    expect(sheet.minConfidence).toBe(1);
  });
});
