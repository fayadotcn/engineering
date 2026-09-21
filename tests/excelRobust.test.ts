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
});
