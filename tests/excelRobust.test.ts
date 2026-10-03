import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { parseWorkbook } from "../file/excel";

async function wb(rows: unknown[][]): Promise<Buffer> {
  const w = new ExcelJS.Workbook();
  const s = w.addWorksheet("表-08");
  rows.forEach((r) => s.addRow(r as any[]));
  return Buffer.from(await w.xlsx.writeBuffer());
}

describe("parseWorkbook 真实导出容错", () => {
  it("分页重复表头行被跳过，不变成清单项", async () => {
    const buf = await wb([
      ["序号", "项目编码", "", "项目名称", "项目特征", "", "单位", "工程量", "综合单价", "合价"],
      ["1", "031002001001", "", "抗震支架", "1、侧向", "", "套", "12", "130.25", "1563.00"],
      // 打印分页带来的重复表头
      ["序号", "项目编码", "", "项目名称", "项目特征", "", "单位", "工程量", "金额（元）", ""],
      ["2", "031002001002", "", "镀锌钢管", "1、DN100", "", "m", "80", "45.2", "3616.00"],
    ]);
    const s = parseWorkbook(buf)[0];
    const items = s.rows.filter((r) => r.isItem);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.cells.name)).toEqual(["抗震支架", "镀锌钢管"]);
  });

  it("分部小计/合计行不并入上一条子目、不导入", async () => {
    const buf = await wb([
      ["序号", "项目编码", "", "项目名称", "项目特征", "", "单位", "工程量", "综合单价", "合价"],
      ["1", "031002001001", "", "抗震支架", "1、侧向", "", "套", "12", "130.25", "1563.00"],
      ["", "", "", "分部小计", "", "", "", "", "", "1589.16"],
      ["", "", "", "H02 生产车间风管", "", "", "", "", "", ""],
      ["2", "031002001002", "", "镀锌钢管", "1、DN100", "", "m", "80", "45.2", "3616.00"],
    ]);
    const s = parseWorkbook(buf)[0];
    const item1 = s.rows.find((r) => r.cells.code === "031002001001");
    // 合价不被小计行的金额污染（合并会产生 "1563.00\n1589.16"）
    expect(item1?.cells.totalPrice).toBe("1563.00");
    // 小计行消失
    expect(s.rows.some((r) => /小计/.test(r.cells.name ?? ""))).toBe(false);
    // 分部标题仍保留为表头行
    const hdr = s.rows.find((r) => r.cells.name === "H02 生产车间风管");
    expect(hdr?.isHeader).toBe(true);
    expect(hdr?.isItem).toBe(false);
  });

  it("非数值工程量（暂估/详见附图）不抛错，落 0", async () => {
    const buf = await wb([
      ["序号", "项目编码", "", "项目名称", "项目特征", "", "单位", "工程量", "综合单价", "合价"],
      ["1", "031002001001", "", "抗震支架", "1、侧向", "", "套", "12", "130.25", "1563.00"],
      ["2", "031002001002", "", "临时措施", "1、暂估", "", "项", "暂估", "", ""],
    ]);
    const s = parseWorkbook(buf)[0];
    const tmp = s.rows.find((r) => r.cells.code === "031002001002");
    expect(tmp).toBeDefined();
    // 有名称+编码即可成项；数值由导入层 numCell 容错兜底
    expect(tmp?.isItem).toBe(true);
  });

  it("特征里写「详见图集…第65页」的清单行不是页脚噪声，必须保留", async () => {
    const buf = await wb([
      ["序号", "项目编码", "", "项目名称", "项目特征", "", "单位", "工程量", "综合单价", "合价"],
      ["71", "031003001008", "", "螺纹阀门", "1、名称：止回阀", "", "个", "5", "29.64", "148.20"],
      // 真实案例：减压器子目特征引用图集页码，曾被页脚噪声过滤整行删掉（漏 1281.28 元）
      ["72", "031003006001", "", "减压器", "1、类型：可调式减压阀组\n2、规格：DN50\n4、详见图集01SS105第65页", "", "组", "1", "1281.28", "1281.28"],
      ["73", "031002003001", "", "套管", "1、名称：钢套管", "", "个", "2", "23.84", "47.68"],
    ]);
    const s = parseWorkbook(buf)[0];
    const item = s.rows.find((r) => r.cells.code === "031003006001");
    expect(item?.isItem).toBe(true);
    expect(item?.cells.totalPrice).toBe("1281.28");
    expect(s.rows.filter((r) => r.isItem)).toHaveLength(3);
  });

  it("真页脚（纯页码行 / 工程名称页眉）仍然过滤", async () => {
    const buf = await wb([
      ["工程名称：H01综合楼安装工程 标段： 第1页 共2页"],
      ["序号", "项目编码", "", "项目名称", "项目特征", "", "单位", "工程量", "综合单价", "合价"],
      ["1", "031003001008", "", "螺纹阀门", "1、名称：止回阀", "", "个", "5", "29.64", "148.20"],
      ["第2页 共2页"],
      ["2", "031003006001", "", "减压器", "1、可调式减压阀组", "", "组", "1", "1281.28", "1281.28"],
      ["编制人（造价人员）：", "复核人（造价工程师）："],
    ]);
    const s = parseWorkbook(buf)[0];
    expect(s.rows.filter((r) => r.isItem)).toHaveLength(2);
    expect(s.rows.some((r) => r.raw.join("").includes("工程名称"))).toBe(false);
    expect(s.rows.some((r) => r.raw.join("").includes("第2页"))).toBe(false);
    expect(s.rows.some((r) => r.raw.join("").includes("编制人"))).toBe(false);
  });

  it("带序号锚点的合计行同样跳过——措施表合计不落成清单项", async () => {
    // 表-11 总价措施表：合计行有序号时旧逻辑把它当 lump-sum 条目导入，
    // feeSummary 会把「合计」又加一遍 → 双计
    const w = new ExcelJS.Workbook();
    const s = w.addWorksheet("表-11 总价措施项目清单");
    [
      ["序号", "项目编码", "项目名称", "计算基础", "费率", "金额（元）"],
      ["1", "031301001", "安全文明施工费", "分部分项", "5.8", "23500"],
      ["2", "031302001", "夜间施工增加费", "", "", "3200"],
      ["3", "", "合计", "", "", "26700"],
    ].forEach((r) => s.addRow(r));
    const buf = Buffer.from(await w.xlsx.writeBuffer());
    const sheet = parseWorkbook(buf)[0];
    const items = sheet.rows.filter((r) => r.isItem);
    expect(items.map((r) => r.cells.name)).toEqual(["安全文明施工费", "夜间施工增加费"]);
    expect(sheet.rows.some((r) => /合计/.test(r.cells.name ?? ""))).toBe(false);
  });
});
