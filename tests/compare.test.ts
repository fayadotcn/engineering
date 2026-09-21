import { describe, expect, it } from "vitest";
import { findFeatureMismatch, findSameItemDifferentPrice } from "@cost-engine/compare";
import { parseSemanticFeature, inferDiscipline } from "@cost-engine/semantic";
import type { BoqItemDTO } from "@shared/types";

let n = 0;
const item = (
  name: string,
  feature: string,
  unit: string,
  qty: string,
  price: string,
  code = ""
): BoqItemDTO => ({
  id: `i${++n}`,
  projectId: "p",
  fileId: null,
  sheetName: "s",
  rowIndex: n,
  code,
  name,
  rawFeature: feature,
  unit,
  quantity: qty,
  unitPrice: price,
  mainMaterialPrice: "0",
  pricingPlan: [],
  feeType: "分部分项",
  totalPrice: (parseFloat(qty) * parseFloat(price)).toFixed(2),
  sectionPath: "",
  isHeader: false,
  sortOrder: n,
  discipline: inferDiscipline(name, feature, ""),
  features: parseSemanticFeature(name, feature),
});

describe("findSameItemDifferentPrice", () => {
  it("flags same semantic item with different prices", () => {
    const items = [
      item("镀锌钢管", "DN100 沟槽连接 室内消防", "m", "120", "85.00"),
      item("镀锌钢管", "DN100 沟槽连接 室内消防给水", "m", "80", "92.50"),
      item("镀锌钢管", "DN150 沟槽连接", "m", "60", "120.00"),
    ];
    const rows = findSameItemDifferentPrice(items);
    expect(rows.length).toBe(1);
    expect(rows[0].items.length).toBe(2);
    expect(rows[0].prices.sort()).toEqual(["85", "92.5"].sort());
  });

  it("ignores zero-quantity items", () => {
    const items = [
      item("镀锌钢管", "DN100 沟槽连接", "m", "120", "85.00"),
      item("镀锌钢管", "DN100 沟槽连接", "m", "0", "999.00"),
    ];
    expect(findSameItemDifferentPrice(items).length).toBe(0);
  });

  it("does not merge different specs", () => {
    const items = [
      item("镀锌钢管", "DN100 沟槽连接", "m", "10", "85"),
      item("镀锌钢管", "DN65 沟槽连接", "m", "10", "55"),
    ];
    expect(findSameItemDifferentPrice(items).length).toBe(0);
  });
});

describe("findFeatureMismatch", () => {
  it("flags same code with conflicting features", () => {
    const items = [
      item("镀锌钢管", "DN100 沟槽连接", "m", "10", "85", "031001001001"),
      item("镀锌钢管", "DN100 螺纹连接", "m", "10", "85", "031001001001"),
    ];
    const rows = findFeatureMismatch(items);
    expect(rows.length).toBe(1);
    expect(rows[0].reason).toContain("connectionMethod");
  });
});
