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

describe("extractFileFacts — 散文式口径行取数", () => {
  it("「地区=马来西亚；税率6%；管理费率5%；利润率20%；人工费调整系数=300%」全抽出", () => {
    // 真实回归：亿伟三期「口径与汇总」表——这类口径行原先落 GENERIC 被整表丢掉
    const sheets = [
      factsSheet("口径与汇总", [
        ["项目", "亿伟三期项目"],
        ["分部分项合价(元)", "404676.52"],
        ["计价口径", "地区=马来西亚；税率6%；管理费率5%；利润率20%；人工费调整系数=300%（人工费调增至定额人工费的4倍）；定额=四川2020安装"],
      ]),
    ];
    const facts = extractFileFacts(sheets, "yw.xlsx");
    const byKey = new Map(facts.map((f) => [f.key, f]));
    expect(byKey.get("税率")?.value).toBe("6%");
    expect(byKey.get("管理费率")?.value).toBe("5%");
    expect(byKey.get("利润率")?.value).toBe("20%");
    expect(byKey.get("人工费调整系数")?.value).toBe("300%");
    expect(byKey.get("地区")?.value).toBe("马来西亚");
    for (const f of facts) expect(f.factType).toBe("FILE_EXTRACTED");
  });

  it("「增值税率13%」不污染「税率」——材料发票税率不是工程税率", () => {
    const sheets = [
      factsSheet("编制说明", [
        ["说明", "本工程税率9%，材料增值税率13%不适用于造价汇总"],
      ]),
    ];
    const byKey = new Map(extractFileFacts(sheets, "t.xlsx").map((f) => [f.key, f]));
    expect(byKey.get("税率")?.value).toBe("9%");
  });

  it("「增值税率/销项增值税率/征收率」归一化为税率——工程口径的增值税写法", () => {
    for (const [text, want] of [
      ["增值税率9%", "9%"],
      ["销项增值税率为9%", "9%"],
      ["本工程增值税率：9%", "9%"],
      ["征收率3%", "3%"],
      ["简易计税征收率3%", "3%"],
    ] as const) {
      const sheets = [factsSheet("编制说明", [["说明", text]])];
      const byKey = new Map(extractFileFacts(sheets, "t.xlsx").map((f) => [f.key, f]));
      expect(byKey.get("税率")?.value, text).toBe(want);
    }
  });

  it("材料/土地增值税率与城建/所得税率不入「税率」", () => {
    for (const text of [
      "材料增值税率13%",
      "土地增值税率5%",
      "城建税率7%",
      "城市维护建设税率7%",
      "所得税率25%",
      "印花税率0.05%",
      "土地增值税征收率5%",
    ]) {
      const sheets = [factsSheet("编制说明", [["说明", text]])];
      const byKey = new Map(extractFileFacts(sheets, "t.xlsx").map((f) => [f.key, f]));
      expect(byKey.has("税率"), text).toBe(false);
    }
  });

  it("散文值原样留痕、消费端归一化；结构化取数优先于散文", () => {
    const sheets = [
      factsSheet("1.1 表-13 规费税金计价表", [
        ["1", "税金", "税前造价", "9", "90000"],
      ]),
      factsSheet("编制说明", [["说明", "税率：6%（后调整）"]]),
    ];
    const byKey = new Map(extractFileFacts(sheets, "t.xlsx").map((f) => [f.key, f]));
    expect(byKey.get("税率")?.value).toBe("9.00"); // 表-13 明示赢过散文
    expect(byKey.get("税率")?.note).toContain("表-13");
  });

  it("非 FACTS 表不做散文取数——清单行文本里的「税率」字不进台账", () => {
    const sheets = [
      { ...factsSheet("分部分项", [["名称", "地砖 税率见说明9%"]]), type: "BOQ" as const },
    ];
    const byKey = new Map(extractFileFacts(sheets, "t.xlsx").map((f) => [f.key, f]));
    expect(byKey.has("税率")).toBe(false);
  });
});

describe("extractFileFacts — 通用键值汇总页兜底（口径与汇总/编制说明）", () => {
  it("「标签|金额」键值行合成文件汇总事实，别名归一到表-04口径键", () => {
    const sheets = [
      factsSheet("口径与汇总", [
        ["项目", "亿伟三期项目"],
        ["清单行数", "204"],
        ["分部分项合价(元)", "404676.52"],
        ["措施项目费(元)", "2967.36"],
        ["人工费调整(元)", "626369.64"],
        ["税前工程造价(元)", "1034013.52"],
        ["含税工程造价(元)", "1096054.33"],
        ["计价口径", "地区=马来西亚；税率6%"],
      ]),
    ];
    const facts = extractFileFacts(sheets, "询价清单.xlsx");
    const sum = facts.find((f) => f.key === "文件汇总:询价清单.xlsx");
    expect(sum).toBeTruthy();
    const units = JSON.parse(sum!.value) as Record<string, unknown>[];
    expect(units).toHaveLength(1);
    expect(units[0]["分部分项工程费"]).toBe(404676.52);
    expect(units[0]["措施项目费"]).toBe(2967.36);
    expect(units[0]["人工费调整"]).toBe(626369.64);
    expect(units[0]["税前造价"]).toBe(1034013.52);
    expect(units[0]["合计"]).toBe(1096054.33);
    expect(units[0].unit).toBe("口径与汇总");
    // 散文费率照常提取，不与汇总行冲突
    expect(facts.find((f) => f.key === "税率")?.value).toBe("6%");
  });

  it("费率/系数标签行不当金额行——规费费率不会变规费金额", () => {
    const sheets = [
      factsSheet("编制说明", [
        ["规费费率", "18.75"],
        ["税率", "9%"],
        ["人工费调整系数", "3"],
        ["分部分项合价(元)", "1000"],
        ["含税工程造价(元)", "1200"],
      ]),
    ];
    const facts = extractFileFacts(sheets, "a.xlsx");
    const sum = facts.find((f) => f.key === "文件汇总:a.xlsx");
    const units = JSON.parse(sum!.value) as Record<string, unknown>[];
    expect(units[0]["规费"]).toBeUndefined();
    expect(units[0]["税金"]).toBeUndefined();
    expect(units[0]["人工费调整"]).toBeUndefined();
    expect(units[0]["合计"]).toBe(1200);
  });

  it("表-04 已产出时键值页不叠加，防 compareDeclared 翻倍", () => {
    const sheets = [
      factsSheet("表-04 单位工程费汇总表", [
        ["序号", "项目名称", "金额（元）"],
        ["1", "分部分项工程费", "1000"],
        ["2", "税金", "90"],
        ["3", "合计", "1090"],
      ]),
      factsSheet("口径与汇总", [
        ["分部分项合价(元)", "1000"],
        ["含税工程造价(元)", "1090"],
      ]),
    ];
    const sum = extractFileFacts(sheets, "a.xlsx").find((f) => f.key === "文件汇总:a.xlsx");
    const units = JSON.parse(sum!.value) as Record<string, unknown>[];
    expect(units).toHaveLength(1);
    expect(units[0].unit).not.toBe("口径与汇总");
    expect(units[0]["合计"]).toBe(1090);
  });

  it("两页重复同口径汇总 → 按值签名去重只留一条", () => {
    const kv = [["分部分项合价(元)", "500"], ["含税工程造价(元)", "600"]];
    const sheets = [factsSheet("汇总页", kv), factsSheet("说明页", kv)];
    const sum = extractFileFacts(sheets, "a.xlsx").find((f) => f.key === "文件汇总:a.xlsx");
    expect(JSON.parse(sum!.value)).toHaveLength(1);
  });

  it("孤行税金（无合计键）不合成汇总页", () => {
    const sheets = [factsSheet("说明", [["税金", "3000"], ["备注", "含税"]])];
    const facts = extractFileFacts(sheets, "a.xlsx");
    expect(facts.find((f) => f.key.startsWith("文件汇总"))).toBeUndefined();
  });
});
