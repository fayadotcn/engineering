import { describe, it, expect } from "vitest";
import { extractFileFacts } from "@file/factsExtract";
import type { ParsedSheet } from "@file/excel";

const row = (raw: string[]) => ({
  rowIndex: 1,
  raw,
  cells: {},
  isHeader: false,
  isItem: false,
});

const factsSheet = (sheetName: string, raws: string[][]): ParsedSheet => ({
  type: "FACTS",
  sheetName,
  headerRow: 0,
  columns: { name: 1 },
  rows: raws.map(row),
  headerLabels: [],
});

describe("extractFileFacts — 表-13 规费税金计价表取数", () => {
  it("规费行带费率+金额 → 规费费率 + 定额人工费反推；销项增值税 → 税率", () => {
    const sheets = [
      factsSheet("2.1 表-13 规费、税金项目计价表", [
        ["序号", "项目名称", "计算基础", "费率（%）", "金额（元）"],
        ["1", "规费", "分部分项定额人工费+单价措施定额人工费", "18.75", "251709.49"],
        ["2", "税金（销项增值税额）", "分部分项+措施+其他+规费", "9", "855967.25"],
        ["3", "附加税", "增值税额", "12", "102716.07"],
      ]),
    ];
    const facts = extractFileFacts(sheets, "test.xlsx");
    const byKey = new Map(facts.map((f) => [f.key, f]));
    expect(byKey.get("规费费率")?.value).toBe("18.75");
    expect(byKey.get("规费费率")?.note).toContain("分部分项定额人工费");
    expect(byKey.get("税率")?.value).toBe("9.00");
    expect(byKey.get("税率")?.note).toContain("表-13");
    expect(byKey.get("附加税率")?.value).toBe("12.00");
    // 定额人工费 = 251709.49 / 0.1875 ≈ 1342450.61
    expect(Number(byKey.get("定额人工费")?.value)).toBeCloseTo(1342450.61, 0);
  });

  it("规费父行费率空 → 按社会保险/公积金等子项费率求和", () => {
    const sheets = [
      factsSheet("表-13 规费税金项目清单与计价表", [
        ["1", "规费", "", "", "200000"],
        ["1.1", "社会保险费", "定额人工费", "16", "170666.67"],
        ["1.2", "住房公积金", "定额人工费", "2.75", "29333.33"],
        ["2", "税金", "税前造价", "9", "90000"],
      ]),
    ];
    const facts = extractFileFacts(sheets, "test.xlsx");
    const byKey = new Map(facts.map((f) => [f.key, f]));
    expect(byKey.get("规费费率")?.value).toBe("18.75");
    // 定额人工费 = 200000 / 0.1875 ≈ 1066666.67
    expect(Number(byKey.get("定额人工费")?.value)).toBeCloseTo(1066666.67, 0);
  });

  it("无表-13 时税率仍由表-04 税金÷税前推得", () => {
    const sheets = [
      factsSheet("3.1 表-04 单位工程投标报价汇总表", [
        ["1", "分部分项工程费", "", "", "9259037.76"],
        ["2", "措施项目费", "", "", "276884.77"],
        ["3", "其他项目费", "", "", "0"],
        ["4", "规费", "", "", "251709.49"],
        ["5", "税金", "", "", "855967.25"],
        ["6", "合计", "", "", "10366714.50"],
      ]),
    ];
    const facts = extractFileFacts(sheets, "a.xls");
    const byKey = new Map(facts.map((f) => [f.key, f]));
    expect(byKey.get("税率")?.value).toBe("8.75");
    expect(byKey.get("税率")?.note).toContain("推得");
    expect(byKey.get("规费费率")).toBeUndefined();
    expect(byKey.get("定额人工费")).toBeUndefined();
    expect(byKey.get("文件汇总:a.xls")).toBeTruthy();
  });

  it("多张表-13（多单位工程）→ 费率取中位数", () => {
    const sheets = [
      factsSheet("1.1 表-13 规费税金计价表", [
        ["1", "规费", "定额人工费", "18.75", "200000"],
        ["2", "税金", "税前造价", "9", "90000"],
      ]),
      factsSheet("2.1 表-13 规费税金计价表", [
        ["1", "规费", "定额人工费", "20", "100000"],
        ["2", "税金", "税前造价", "9", "50000"],
      ]),
      factsSheet("3.1 表-13 规费税金计价表", [
        ["1", "规费", "定额人工费", "19", "150000"],
        ["2", "税金", "税前造价", "9", "80000"],
      ]),
    ];
    const facts = extractFileFacts(sheets, "m.xlsx");
    const byKey = new Map(facts.map((f) => [f.key, f]));
    expect(byKey.get("规费费率")?.value).toBe("19.00");
    // 定额人工费取各表反推值中位数：1066667 / 500000 / 789474 → 789473.68
    expect(Number(byKey.get("定额人工费")?.value)).toBeCloseTo(789473.68, 0);
  });
});
