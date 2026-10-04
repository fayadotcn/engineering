import { describe, expect, it } from "vitest";
import { D } from "@cost-engine/money";
import { lineFromQuota, matchQuota, planPrice, scoreQuota, top2Quota } from "@cost-engine/quota";
import { aggregateByCategory, projectTotals } from "@cost-engine/aggregate";
import type { QuotaEntry } from "@quota/library";
import type { BoqItemDTO } from "@shared/types";

// 定额匹配打分与聚合的零覆盖补测：打分量纲/单位倍数折算/存疑判定是组价正确性的地基。

const item = (patch: Partial<BoqItemDTO>): BoqItemDTO => ({
  id: "i", projectId: "p", fileId: null, sheetName: "s", rowIndex: 0, code: "",
  name: "镀锌钢管", rawFeature: "", unit: "m", quantity: "10", unitPrice: "50",
  mainMaterialPrice: "0", laborUnitPrice: "0", machineUnitPrice: "0", pricingPlan: [],
  totalPrice: "500", feeType: "分部分项", sectionPath: "", isHeader: false,
  sortOrder: 0, discipline: "OTHER", features: {}, ...patch,
});

const quota = (patch: Partial<QuotaEntry>): QuotaEntry => ({
  code: "5H0001", name: "镀锌钢管(螺纹连接) DN100", unit: "10m", unitScale: 10,
  labor: 100, material: 20, machine: 5, mainQtyPerUnit: 1.02,
  match: {}, ...patch,
});

describe("scoreQuota / matchQuota / top2Quota", () => {
  const i = item({ features: { category: "钢管", diameter: "DN100" } });

  it("category/diameter 命中加分，未命中零分", () => {
    const hit = quota({ match: { category: "钢管", diameter: /DN100/ } });
    const miss = quota({ match: { category: "桥架" } });
    expect(scoreQuota(i, hit)).toBe(60); // 40 + 20
    expect(scoreQuota(i, miss)).toBe(0);
    expect(matchQuota(i, 50, [hit]).quota?.code).toBe("5H0001");
    expect(matchQuota(i, 50, [miss]).quota).toBeNull();
  });

  it("系统归属词命中 +12；跨册同名同分但价差>5% 判存疑", () => {
    const sysHit = quota({ code: "5G0001", match: { category: "钢管", system: "消防|喷淋" } });
    const it2 = item({ features: { category: "钢管" }, sectionPath: "消防工程" });
    expect(scoreQuota(it2, sysHit)).toBe(52);
    // 同名不同册、分差小、基价差大 → ambiguous
    const a = quota({ code: "A", labor: 100, material: 0, machine: 0, match: { category: "钢管" } });
    const b = quota({ code: "B", labor: 200, material: 0, machine: 0, match: { category: "钢管" } });
    const r = top2Quota(item({ features: { category: "钢管" } }), [a, b]);
    expect(r.ambiguous).toBe(true);
    // 同分同价不算歧义
    const c = quota({ code: "C", labor: 100, material: 0, machine: 0, match: { category: "钢管" } });
    expect(top2Quota(item({ features: { category: "钢管" } }), [a, c]).ambiguous).toBe(false);
  });
});

describe("lineFromQuota / planPrice", () => {
  it("10m 定额折每清单单位 + 管利取费 + 主材价×耗量", () => {
    const q = quota({ unitScale: 10, labor: 1000, material: 200, machine: 50, mainQtyPerUnit: 1.02 });
    const line = lineFromQuota(item({}), q, { mgmtRate: 0.2, profitRate: 0.1, mainPrice: 30 });
    // labor=100, aux=20, mach=5, fee=(100+5)*0.3=31.5, main=30*1.02=30.6 → 187.10
    expect(Number(line.labor)).toBe(100);
    expect(Number(line.machine)).toBe(5);
    expect(Number(line.fee)).toBe(31.5);
    expect(Number(line.mainPrice)).toBe(30);
    expect(Number(line.subtotal)).toBe(187.1);
  });

  it("suggested 行不计入 planPrice", () => {
    const q = quota({});
    const confirmed = lineFromQuota(item({}), q, { mgmtRate: 0, profitRate: 0 });
    const suggested = lineFromQuota(item({}), q, { mgmtRate: 0, profitRate: 0, suggested: true });
    expect(planPrice([confirmed, suggested]).eq(D(confirmed.subtotal))).toBe(true);
  });
});

describe("aggregateByCategory / projectTotals", () => {
  const rows = [
    item({ id: "1", totalPrice: "3000.00", features: { category: "配电箱" } }),
    item({ id: "2", totalPrice: "5400.00", features: { category: "配电箱" } }),
    item({ id: "3", totalPrice: "1600.00", features: { category: "电缆" } }),
    item({ id: "h", isHeader: true, totalPrice: "99999", name: "分部" }), // 表头不计
  ];

  it("按 category 聚合且 share 合计=1；categories 过滤生效", () => {
    const { slices, total } = aggregateByCategory(rows);
    expect(total.toFixed(2)).toBe("10000.00");
    expect(slices.map((s) => s.key)).toEqual(["配电箱", "电缆"]);
    expect(slices[0].amount).toBe("8400.00");
    expect(slices.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 6);
    const only = aggregateByCategory(rows, ["电缆"]);
    expect(only.slices).toHaveLength(1);
    expect(only.slices[0].key).toBe("电缆");
  });

  it("projectTotals 剔表头 + 可计价项计数", () => {
    const t = projectTotals([...rows, item({ id: "z", totalPrice: "0", unitPrice: "0" })]);
    expect(t.itemCount).toBe(4);
    expect(t.pricableCount).toBe(4);
    expect(t.pricedCount).toBe(3);
    expect(Number(t.totalAmount)).toBe(10000);
  });
});
