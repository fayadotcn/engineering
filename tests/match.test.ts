import { describe, expect, it } from "vitest";
import { matchQuotations } from "@cost-engine/match";
import { parseSemanticFeature } from "@cost-engine/semantic";
import type { BoqItemDTO, QuotationItemDTO } from "@shared/types";

let n = 0;
const boq = (name: string, feature: string, unit = "m", price = "85"): BoqItemDTO => ({
  id: `b${++n}`, projectId: "p", fileId: null, sheetName: "s", rowIndex: n,
  code: "", name, rawFeature: feature, unit, quantity: "10", unitPrice: price,
  mainMaterialPrice: "0", laborUnitPrice: "0", machineUnitPrice: "0", pricingPlan: [],
  feeType: "分部分项", totalPrice: "850", sectionPath: "", isHeader: false,
  sortOrder: n, discipline: "OTHER", features: parseSemanticFeature(name, feature),
});
const quote = (materialName: string, spec: string, unit = "m", brand = ""): QuotationItemDTO => ({
  id: `q${++n}`, materialName, spec, unit, brand, price: "50", sheetName: "s",
  features: parseSemanticFeature(materialName, spec),
});

describe("matchQuotations 询价↔清单匹配", () => {
  it("规格归一：DN100 ≡ Φ100 ≡ 100，4*25 ≡ 4×25", () => {
    const items = [boq("镀锌钢管", "DN100 沟槽连接")];
    const q = quote("钢管", "Φ100");
    const { rows } = matchQuotations(items, [q]);
    expect(rows[0].status).toBe("MATCHED");
    expect(rows[0].matchedBoqItemIds).toEqual([items[0].id]);
  });

  it("规格冲突直接出局（DN100 材料配不上 DN50 清单）", () => {
    const items = [boq("镀锌钢管", "DN50")];
    const { rows } = matchQuotations(items, [quote("钢管", "DN100")]);
    expect(rows[0].status).toBe("UNMATCHED");
    expect(rows[0].matchedBoqItemIds).toEqual([]);
  });

  it("单位别名同义计分：清单 m 对询价 米 不丢单位分", () => {
    // 同名+同规格+单位别名 → 得分应比单位不同时高
    const b = boq("电力电缆", "YJV-4x35", "m");
    const sameUnit = matchQuotations([b], [quote("电缆", "4x35", "米")]);
    const diffUnit = matchQuotations([b], [quote("电缆", "4x35", "km")]);
    expect(sameUnit.rows[0].confidence).toBeGreaterThan(diffUnit.rows[0].confidence);
  });

  it("完全无信号 → UNMATCHED 进未询到名单", () => {
    const { rows, unmatched } = matchQuotations(
      [boq("配电箱", "800x600")],
      [quote("水泵", "Q=50m³/h")]
    );
    expect(rows[0].status).toBe("UNMATCHED");
    expect(unmatched).toHaveLength(1);
  });

  it("同档分内的多条清单项都进 matchedBoqItemIds", () => {
    const items = [
      boq("镀锌钢管", "DN100", "m", "85"),
      boq("镀锌钢管", "DN100", "米", "85"), // 同语义不同写法也应同组命中
    ];
    const { rows } = matchQuotations(items, [quote("钢管", "DN100")]);
    expect(rows[0].matchedBoqItemIds).toHaveLength(2);
  });
});
