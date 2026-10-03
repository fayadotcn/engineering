import { describe, expect, it } from "vitest";
import { classifyFile, inferFileStage } from "../file/classify";
import type { ParsedSheet, ParsedRow } from "../file/excel";

const row = (isItem = true): ParsedRow => ({ isItem }) as ParsedRow;
const sheet = (type: ParsedSheet["type"], isItem = true): ParsedSheet => ({
  type, sheetName: "s", headerRow: 0, columns: {}, rows: [row(isItem)], headerLabels: [],
});

describe("classifyFile", () => {
  it("内容信号优先：BOQ 表 → BOQ_TENDER，文件名再细分招标/中标/结算", () => {
    expect(classifyFile("某工程清单.xls", [sheet("BOQ")], "").kind).toBe("BOQ_TENDER");
    expect(classifyFile("中标清单.xlsx", [sheet("BOQ")], "").kind).toBe("BOQ_WINNING");
    expect(classifyFile("结算清单.xlsx", [sheet("BOQ")], "").kind).toBe("BOQ_SETTLEMENT");
  });

  it("纯询价表 → MATERIAL_QUOTATION，即使文件名带「清单」", () => {
    expect(classifyFile("材料清单.xlsx", [sheet("QUOTATION")], "").kind).toBe("MATERIAL_QUOTATION");
  });

  it("BOQ+询价混合 → BOQ_TENDER 低置信", () => {
    const r = classifyFile("含价清单.xlsx", [sheet("BOQ"), sheet("QUOTATION")], "");
    expect(r).toEqual({ kind: "BOQ_TENDER", confidence: 0.6 });
  });

  it("无 sheet 时回退文件名规则；PDF mime → CONTRACT；全不命中 → UNKNOWN", () => {
    expect(classifyFile("合同.pdf", null, "application/pdf").kind).toBe("CONTRACT");
    expect(classifyFile("随便.txt", null, "text/plain")).toEqual({ kind: "UNKNOWN", confidence: 0 });
  });

  it("措施表（PENDING_QUOTE 也算 BOQ 侧）", () => {
    expect(classifyFile("待报价清单.xlsx", [sheet("PENDING_QUOTE")], "").kind).toBe("BOQ_TENDER");
  });
});

describe("inferFileStage", () => {
  it("造价流转阶段：招标→投标→清标→进度→变更→报审→结算→财评", () => {
    expect(inferFileStage("招标清单.xls").stage).toBe("招标");
    expect(inferFileStage("投标报价.xlsx").stage).toBe("投标");
    expect(inferFileStage("中标通知书.xls").stage).toBe("中标");
    expect(inferFileStage("清标对比.xlsx").stage).toBe("清标");
    expect(inferFileStage("3月进度款申报.xlsx").stage).toBe("进度");
    expect(inferFileStage("设计变更单.xlsx").stage).toBe("变更");
    expect(inferFileStage("结算送审.xls").stage).toBe("结算"); // 结算版文件，送审只是流转动作
    expect(inferFileStage("预算报审.xls").stage).toBe("报审");
    expect(inferFileStage("竣工结算.xlsx").stage).toBe("结算");
    expect(inferFileStage("财政评审表.xlsx").stage).toBe("财评");
    expect(inferFileStage("清单.xls").stage).toBe("招标");
    expect(inferFileStage("随便.xls").stage).toBe("");
  });

  it("期次 YYYY-MM：兼容「2024年6月」「2024-06」「2024.6」", () => {
    expect(inferFileStage("进度款2024年6月申报.xlsx").period).toBe("2024-06");
    expect(inferFileStage("结算-2024-11.xlsx").period).toBe("2024-11");
    expect(inferFileStage("报审2024.3月.xls").period).toBe("2024-03");
    expect(inferFileStage("清单.xls").period).toBe("");
  });
});
