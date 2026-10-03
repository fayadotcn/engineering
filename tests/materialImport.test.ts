import { describe, expect, it, vi } from "vitest";

// 询价导入容错：价格列出现「面议/暂估/—」等非数值时按 0（无报价）导入，
// 不能让 Decimal 抛错拖垮整个文件导入。

const { createMany } = vi.hoisted(() => ({
  createMany: vi.fn(async (_args: { data: { price: unknown }[] }) => ({ count: 0 })),
}));
vi.mock("@database/client", () => ({ prisma: { quotationItem: { createMany } } }));

import { importQuotationsFromSheets } from "../material/service";
import type { ParsedRow, ParsedSheet } from "../file/excel";

const row = (cells: Record<string, string>): ParsedRow => ({
  rowIndex: 1, raw: [], cells, isHeader: false, isItem: true,
});
const sheet = (rows: ParsedRow[]): ParsedSheet => ({
  type: "QUOTATION", sheetName: "询价表", headerRow: 0,
  columns: {}, rows, headerLabels: [],
});

describe("importQuotationsFromSheets 价格容错", () => {
  it("非数值价格 → 0，整批导入不抛错", async () => {
    const n = await importQuotationsFromSheets("p1", "f1", [
      sheet([
        row({ materialName: "电力电缆", spec: "YJV-4x25", price: "面议" }),
        row({ materialName: "镀锌钢管", spec: "DN100", price: "12,345.60" }),
        row({ materialName: "阀门", spec: "DN50", price: "暂估" }),
      ]),
    ]);
    expect(n).toBe(3);
    const data = createMany.mock.calls[0][0].data;
    expect(Number(String(data[0].price))).toBe(0);
    expect(Number(String(data[1].price))).toBe(12345.6);
    expect(Number(String(data[2].price))).toBe(0);
  });
});
