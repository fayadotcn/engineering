import { describe, expect, it } from "vitest";
import { detectBoqLines } from "../file/pdf";

describe("detectBoqLines（PDF 清单行识别）", () => {
  it("识别编码+名称+特征+单位+量+价+合价的标准行", () => {
    const rows = detectBoqLines([
      "分部分项工程量清单与计价表",
      "1 031001001001 镀锌钢管 DN100 沟槽连接 m 120.5 85.00 10242.50",
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      code: "031001001001", name: "镀锌钢管", feature: "DN100 沟槽连接",
      unit: "m", quantity: "120.5", unitPrice: "85.00", totalPrice: "10242.50",
    });
  });

  it("特征列为空的行也要识别（招标 PDF 常见）", () => {
    const rows = detectBoqLines([
      "3 030404017001 配电箱 台 2 8500.00 17000.00",
      "4 031001001003 给水管 m 10 50.00 500.00",
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "配电箱", feature: "", unit: "台", quantity: "2" });
    expect(rows[1]).toMatchObject({ name: "给水管", unit: "m" });
  });

  it("千分位金额去逗号", () => {
    const rows = detectBoqLines([
      "2 031001001002 电力电缆 YJV-4x35 米 1,234.56 120.00 148,147.20",
    ]);
    expect(rows[0].quantity).toBe("1234.56");
    expect(rows[0].totalPrice).toBe("148147.20");
  });

  it("表头/合计/说明行不误报", () => {
    const rows = detectBoqLines([
      "序号 项目编码 项目名称 计量单位 工程量 综合单价 合价",
      "合计 1,000,000.00",
      "备注：以上报价均含税",
      "2024年6月 第 3 次 进度款",
    ]);
    expect(rows).toHaveLength(0);
  });

  it("行号跨页连续累计", () => {
    const rows = detectBoqLines([
      "表头\n1 031001001001 镀锌钢管 DN100 m 10 85.00 850.00", // 第1页：表头+1行
      "2 031001001002 电缆 YJV m 20 60.00 1200.00",          // 第2页：1行
    ]);
    expect(rows[0].line).toBe(2);   // 全局第2行
    expect(rows[1].line).toBe(3);   // 跨页连续编号
    expect(rows.map((r) => r.code)).toEqual(["031001001001", "031001001002"]);
  });
});
