import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { parseQuotaWorkbook } from "../dataset/quotaParse";

async function wb(rows: unknown[][]): Promise<Buffer> {
  const w = new ExcelJS.Workbook();
  const s = w.addWorksheet("定额");
  rows.forEach((r) => s.addRow(r as any[]));
  return Buffer.from(await w.xlsx.writeBuffer());
}

describe("parseQuotaWorkbook", () => {
  it("识别定额表头并归一化耗量到每清单单位", async () => {
    const buf = await wb([
      ["定额编号", "项目名称", "单位", "人工费", "材料费", "机械费", "主材耗量"],
      ["C8-1-23", "室内镀锌钢管(沟槽连接) DN100", "10m", 156.2, 42.8, 18.6, 10.2],
      ["C4-8-12", "铜芯电缆敷设 4*35+1*16", "100m", 486, 128, 45, 101],
      ["JA-7-55", "对夹蝶阀 DN100", "个", 38.6, 8.2, 1.5, 1],
    ]);
    const rows = parseQuotaWorkbook(buf);
    expect(rows).toHaveLength(3);
    const pipe = rows[0];
    expect(pipe.unitScale).toBe(10);
    expect(pipe.mainQtyPerUnit).toBeCloseTo(1.02); // 10.2/10 归一化
    expect(pipe.matchKeys.material).toBe("镀锌钢管");
    expect(pipe.matchKeys.diameter).toBe("DN100");
    expect(rows[1].mainQtyPerUnit).toBeCloseTo(1.01); // 101/100
    expect(rows[2].unitScale).toBe(1); // 个 → 不缩放
  });

  it("耗量列已是每单位口径时不重复缩放", async () => {
    const buf = await wb([
      ["定额编号", "子目名称", "计量单位", "人工费", "材料费", "机械费", "含量"],
      ["X-1", "镀锌钢管 DN50", "10m", 100, 30, 5, 1.02],
    ]);
    const rows = parseQuotaWorkbook(buf);
    expect(rows[0].mainQtyPerUnit).toBeCloseTo(1.02);
  });

  it("无定额的表返回空", async () => {
    const buf = await wb([["名称", "单价"], ["水泥", 400]]);
    expect(parseQuotaWorkbook(buf)).toHaveLength(0);
  });

  it("有耗量列但无主材名称列时占位标记，让 expectsMain 生效", async () => {
    const buf = await wb([
      ["定额编号", "子目名称", "单位", "人工费", "材料费", "机械费", "主材耗量"],
      ["C8-1-23", "镀锌钢管 DN100", "10m", 156.2, 42.8, 18.6, 10.2],
      ["C8-9-9", "管道冲洗", "100m", 20, 5, 0, 0], // 耗量 0 不应标主材
    ]);
    const rows = parseQuotaWorkbook(buf);
    expect(rows[0].raw.mainMaterial).toBe("主材");
    expect(rows[1].raw.mainMaterial).toBeUndefined();
  });

  it("显式主材名称列优先于占位；且不被误当耗量列", async () => {
    const buf = await wb([
      ["定额编号", "子目名称", "单位", "人工费", "材料费", "机械费", "主材名称", "主材耗量"],
      ["C8-1-23", "镀锌钢管 DN100", "10m", 156.2, 42.8, 18.6, "内外涂塑钢管 DN100", 10.2],
    ]);
    const rows = parseQuotaWorkbook(buf);
    expect(rows[0].raw.mainMaterial).toBe("内外涂塑钢管 DN100");
    expect(rows[0].mainQtyPerUnit).toBeCloseTo(1.02); // 耗量列仍是 10.2/10
  });
});
