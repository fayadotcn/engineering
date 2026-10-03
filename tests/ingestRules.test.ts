import { describe, it, expect } from "vitest";
import { decideRows } from "@boq/ingestRules";
import type { ParsedRow, ParsedSheet } from "@file/excel";

const item = (raw: string[], cells: Record<string, string> = {}): ParsedRow => ({
  rowIndex: 1, raw, cells, isHeader: false, isItem: true,
});
const header = (raw: string[], cells: Record<string, string> = {}): ParsedRow => ({
  rowIndex: 1, raw, cells, isHeader: true, isItem: false,
});

const boqSheet = (sheetName: string, rows: ParsedRow[], feeType?: ParsedSheet["feeType"]): ParsedSheet => ({
  type: "BOQ",
  sheetName,
  headerRow: 0,
  columns: { seq: 0, code: 1, name: 3 },
  rows,
  headerLabels: [],
  ...(feeType ? { feeType } : {}),
});

describe("decideRows — 表-08 混排表尾部的单价措施识别", () => {
  const sheetName = "3.2 表-08 分部分项工程和单价措施项目清单与计价表";

  it("措施编码段（0411xx）→ 单价措施，即使没有分隔行", () => {
    const s = boqSheet(sheetName, [
      header(["", "", "", "雨水管"], { name: "雨水管" }),
      item(["1", "040501004001", "", "塑料管"], { code: "040501004001", name: "塑料管" }),
      item(["2", "040504002001", "", "混凝土井"], { code: "040504002001", name: "混凝土井" }),
      // 序号重启 + 措施编码：无分隔行的单价措施尾块
      item(["1", "041107002001", "", "排水、降水"], { code: "041107002001", name: "排水、降水" }),
      item(["2", "041108002001", "", "新建管道与原井碰通费用"], { code: "041108002001", name: "新建管道与原井碰通费用" }),
    ]);
    const d = decideRows(s);
    expect(d.map((x) => x.feeType)).toEqual([
      "分部分项", "分部分项", "分部分项", "单价措施", "单价措施",
    ]);
    expect(d.every((x) => !x.skip)).toBe(true);
  });

  it("序号重启 + 措施名（无编码）→ 单价措施", () => {
    const s = boqSheet(sheetName, [
      item(["1", "030801001001", "", "钢管"], { code: "030801001001", name: "钢管" }),
      item(["2", "030801001002", "", "阀门"], { code: "030801001002", name: "阀门" }),
      item(["1", "", "", "脚手架搭拆"], { code: "", name: "脚手架搭拆" }),
    ]);
    const d = decideRows(s);
    expect(d[2].feeType).toBe("单价措施");
  });

  it("序号重启但名字不像措施 → 保持分部分项（不误判）", () => {
    const s = boqSheet(sheetName, [
      item(["1", "030801001001", "", "钢管"], { code: "030801001001", name: "钢管" }),
      item(["2", "030801001002", "", "阀门"], { code: "030801001002", name: "阀门" }),
      item(["1", "030801001003", "", "垫片"], { code: "030801001003", name: "垫片" }),
    ]);
    const d = decideRows(s);
    expect(d[2].feeType).toBe("分部分项");
  });

  it("分部分项编码不会被措施段误判（如 0110/0105 房建章节）", () => {
    const s = boqSheet(sheetName, [
      item(["1", "011001001001", "", "保温隔热屋面"], { code: "011001001001", name: "保温隔热屋面" }),
      item(["2", "010512008001", "", "沟盖板"], { code: "010512008001", name: "沟盖板" }),
    ]);
    const d = decideRows(s);
    expect(d.map((x) => x.feeType)).toEqual(["分部分项", "分部分项"]);
  });
});

describe("decideRows — 总价措施父子行去重", () => {
  const sheetName = "3.3 表-11 总价措施项目清单与计价表";

  it("有父行的子行被跳过（安全文明施工费 = Σ 基本费+扬尘…）", () => {
    const s = boqSheet(sheetName, [
      item(["1", "031302001001", "", "安全文明施工费"], { code: "031302001001", name: "安全文明施工费" }),
      item(["1.1", "", "", "基本费"], { name: "基本费" }),
      item(["1.2", "", "", "增加费"], { name: "增加费" }),
      item(["1.3", "", "", "扬尘污染防治增加费"], { name: "扬尘污染防治增加费" }),
      item(["2", "031302002001", "", "夜间施工"], { code: "031302002001", name: "夜间施工" }),
      item(["8", "031302008001", "", "临时设施"], { code: "031302008001", name: "临时设施" }),
    ], "总价措施");
    const d = decideRows(s);
    expect(d.map((x) => x.skip)).toEqual([false, true, true, true, false, false]);
    expect(d.every((x) => x.feeType === "总价措施")).toBe(true);
  });

  it("无父行的子行保留（只有明细没有汇总的导出）", () => {
    const s = boqSheet(sheetName, [
      item(["1.1", "", "", "基本费"], { name: "基本费" }),
      item(["2", "031302002001", "", "夜间施工"], { code: "031302002001", name: "夜间施工" }),
    ], "总价措施");
    const d = decideRows(s);
    expect(d.every((x) => !x.skip)).toBe(true);
  });

  it("序号列不在 A 列（前置专业列）→ 父子行去重仍生效", () => {
    const s: ParsedSheet = {
      type: "BOQ",
      sheetName: "3.3 表-11 总价措施项目清单与计价表",
      headerRow: 0,
      columns: { seq: 1, code: 2, name: 3 },
      headerLabels: [],
      feeType: "总价措施",
      rows: [
        item(["电气", "1", "031302001001", "安全文明施工费"], { seq: "1", code: "031302001001", name: "安全文明施工费" }),
        item(["电气", "1.1", "", "基本费"], { seq: "1.1", name: "基本费" }),
        item(["电气", "1.2", "", "增加费"], { seq: "1.2", name: "增加费" }),
        item(["电气", "2", "031302002001", "夜间施工"], { seq: "2", code: "031302002001", name: "夜间施工" }),
      ],
    };
    const d = decideRows(s);
    expect(d.map((x) => x.skip)).toEqual([false, true, true, false]);
  });

  it("分部分项表不去重（1.1 可能是真实清单项）", () => {
    const s = boqSheet("3.2 表-08 分部分项工程和单价措施项目清单与计价表", [
      item(["1", "040501004001", "", "塑料管"], { code: "040501004001", name: "塑料管" }),
      item(["1.1", "", "", "管件"], { name: "管件" }),
    ]);
    const d = decideRows(s);
    expect(d.every((x) => !x.skip)).toBe(true);
  });
});
