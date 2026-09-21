import { describe, expect, it } from "vitest";
import { compareBoqSets, compareSummary } from "@cost-engine/fileCompare";
import { parseSemanticFeature, inferDiscipline } from "@cost-engine/semantic";
import type { BoqItemDTO } from "@shared/types";

let n = 0;
const item = (
  name: string,
  feature: string,
  unit: string,
  qty: string,
  price: string,
  code = "",
  fileId = "fA"
): BoqItemDTO => ({
  id: `i${++n}`,
  projectId: "p",
  fileId,
  sheetName: "s",
  rowIndex: n,
  code,
  name,
  rawFeature: feature,
  unit,
  quantity: qty,
  unitPrice: price,
  mainMaterialPrice: "0",
  feeType: "分部分项",
  totalPrice: (parseFloat(qty) * parseFloat(price)).toFixed(2),
  sectionPath: "",
  isHeader: false,
  sortOrder: n,
  discipline: inferDiscipline(name, feature, ""),
  features: parseSemanticFeature(name, feature),
});

describe("compareBoqSets", () => {
  it("aligns by code and detects price/qty/unique diffs", () => {
    const a = [
      item("镀锌钢管", "DN100", "m", "100", "85", "C001"),
      item("电缆", "YJV-4x25", "m", "50", "60", "C002"),
      item("桥架", "200x100", "m", "30", "45", "C003"),
    ];
    const b = [
      item("镀锌钢管", "DN100", "m", "100", "92", "C001", "fB"), // price diff
      item("电缆", "YJV-4x25", "m", "80", "60", "C002", "fB"),   // qty diff
      item("阀门", "DN50", "个", "10", "120", "C004", "fB"),    // only B
    ];
    const rows = compareBoqSets(a, b);
    const by = (code: string) => rows.find((r) => r.code === code)!;
    expect(by("C001").status).toBe("PRICE_DIFF");
    expect(by("C001").priceDelta).toBe("7");
    expect(by("C002").status).toBe("QTY_DIFF");
    expect(by("C002").qtyDelta).toBe("30");
    expect(by("C003").status).toBe("ONLY_A");
    expect(by("C004").status).toBe("ONLY_B");
    const s = compareSummary(rows);
    expect(s.total).toBe(4);
    expect(s.priceDiff).toBe(1);
    expect(s.qtyDiff).toBe(1);
    expect(s.onlyA).toBe(1);
    expect(s.onlyB).toBe(1);
    // delta: (100*92-100*85) + (80*60-50*60) + (-30*45) + (10*120) = 700+1800-1350+1200
    expect(s.totalDelta).toBe("2350.00");
  });

  it("aligns by semantic key when code is missing", () => {
    const a = [item("镀锌钢管", "DN100 沟槽连接", "m", "10", "85")];
    const b = [item("镀锌钢管", "DN100 沟槽连接", "m", "10", "85", "", "fB")];
    expect(compareBoqSets(a, b)[0].status).toBe("SAME");
  });

  it("marks identical sets all SAME", () => {
    const a = [item("桥架", "200x100", "m", "30", "45", "C1")];
    const b = [item("桥架", "200x100", "m", "30", "45", "C1", "fB")];
    const s = compareSummary(compareBoqSets(a, b));
    expect(s.same).toBe(1);
    expect(s.totalDelta).toBe("0.00");
  });
});
