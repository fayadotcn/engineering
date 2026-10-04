import { describe, expect, it } from "vitest";
import { D } from "@cost-engine/money";
import { calcQuota, lineFromQuota, matchQuota, planPrice, scoreQuota, scoreQuotaDetail, hasMatchEvidence, top2Quota } from "@cost-engine/quota";
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
    expect(scoreQuota(i, hit)).toBe(91); // 40 + 20 + 31(3 个名称 bigram 分级)
    expect(scoreQuota(i, miss)).toBe(11); // 31(名称命中) - 20(类别冲突：钢管 vs 桥架)
    expect(matchQuota(i, 50, [hit]).quota?.code).toBe("5H0001");
    expect(matchQuota(i, 50, [miss]).quota).toBeNull();
  });

  it("系统归属词命中 +12；跨册同名同分但价差>5% 判存疑", () => {
    const sysHit = quota({ code: "5G0001", match: { category: "钢管", system: "消防|喷淋" } });
    const it2 = item({ features: { category: "钢管" }, sectionPath: "消防工程" });
    expect(scoreQuota(it2, sysHit)).toBe(83); // 40 + 12 + 31(3 个名称 bigram 分级)
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

describe("档位制/材料冲突/分册域治理（错配漏配根因）", () => {
  it("DN75 地漏错档：公称直径50mm 子目扣分，80mm 档子目胜出", () => {
    const i = item({ name: "地漏安装 DN75", unit: "个", features: { category: "卫生器具", diameter: "DN75" } });
    const d50 = quota({ code: "5H0500", name: "地漏安装 公称直径50mm", unit: "个", match: { category: "卫生器具", diameter: /DN50/ } });
    const d80 = quota({ code: "5H0501", name: "地漏安装 公称直径80mm", unit: "个", match: { category: "卫生器具", diameter: /DN80/ } });
    expect(scoreQuota(i, d80)).toBeGreaterThan(scoreQuota(i, d50));
    expect(top2Quota(i, [d50, d80]).best.q?.code).toBe("5H0501");
  });

  it("同材料组异材=错配铁证：YJV 电缆清单不套铝芯电缆子目", () => {
    const i = item({ name: "电力电缆 YJV-4x35+1x16", features: { category: "电缆", material: "YJV电缆", specification: "4x35+1x16" } });
    const al = quota({ code: "5B0001", name: "铝芯电力电缆敷设 截面35mm²以内", unit: "100m", match: { category: "电缆", material: /铝芯/, materialLabel: "铝芯电缆" } });
    const cu = quota({ code: "5B0002", name: "铜芯电力电缆敷设 截面35mm²以内", unit: "100m", match: { category: "电缆", material: /铜|YJV/, materialLabel: "铜" } });
    const d = scoreQuotaDetail(i, al);
    expect(d.materialConflict).toBe(true);
    expect(hasMatchEvidence(d)).toBe(false);
    expect(top2Quota(i, [al, cu]).best.q?.code).toBe("5B0002");
  });

  it("泛称定额材兼容组内具体材：「塑料管」子目能装 PPR 清单", () => {
    const i = item({ name: "塑料排水管 PPR", features: { category: "管道", material: "PPR" } });
    const g = quota({ code: "5H0100", name: "塑料排水管安装 公称直径110mm以内", match: { category: "管道", material: /塑料/, materialLabel: "塑料管" } });
    const d = scoreQuotaDetail(i, g);
    expect(d.materialConflict).toBeFalsy();
    expect(d.score).toBeGreaterThan(50);
  });

  it("分册域治理：电气配管清单不撞市政册同名子目", () => {
    const i = item({ name: "电气配管 JDG20", features: { category: "电线管", material: "镀锌钢管", diameter: "DN20" } });
    const muni = quota({ code: "3H0123", name: "电线管敷设 公称口径20mm以内", match: { category: "电线管", diameter: /DN20/ } });
    const inst = quota({ code: "5B1234", name: "电线管敷设 公称口径20mm以内", match: { category: "电线管", diameter: /DN20/ } });
    expect(scoreQuota(i, inst)).toBeGreaterThan(scoreQuota(i, muni));
    expect(top2Quota(i, [muni, inst]).best.q?.code).toBe("5B1234");
  });

  it("限定词不对称：普通套管清单不套「柔性防水套管」特化子目", () => {
    const i = item({ name: "穿墙套管", features: { category: "套管" } });
    const flex = quota({ code: "5H9001", name: "柔性防水套管制作安装", match: { category: "套管" } });
    const plain = quota({ code: "5H9002", name: "一般套管安装", match: { category: "套管" } });
    expect(scoreQuota(i, plain)).toBeGreaterThan(scoreQuota(i, flex));
  });

  it("截面档泛化：4x35 清单落「35mm²以内」档，超 240 档判错档", () => {
    const i = item({ name: "电力电缆 4x35", features: { category: "电缆", specification: "4x35" } });
    const b35 = quota({ code: "5B2001", name: "铜芯电力电缆敷设 截面35mm²以内", match: { category: "电缆", spec: /35/ } });
    const b240 = quota({ code: "5B2002", name: "铜芯电力电缆敷设 截面240mm²以内", match: { category: "电缆", spec: /240/ } });
    expect(scoreQuota(i, b35)).toBeGreaterThan(scoreQuota(i, b240));
    const iBig = item({ name: "电力电缆 4x300", features: { category: "电缆", specification: "4x300" } });
    expect(scoreQuotaDetail(iBig, b35).bandMiss).toBe(true);
  });
});

describe("多主材组价（管件/法兰/配件全量计价）", () => {
  const multiQ = (): QuotaEntry => ({
    code: "5H0525", name: "大便器安装 坐式", unit: "10套", unitScale: 10,
    labor: 300, material: 40, machine: 0, mainQtyPerUnit: 1.01,
    detail: { gcnr: "安装、试水", mainMaterial: "低水箱坐便器" },
    materials: [
      { name: "低水箱坐便器", unit: "套", qtyPerUnit: 1.01 },
      { name: "低水箱配件", unit: "套", qtyPerUnit: 1.01 },
      { name: "座便器桶盖", unit: "套", qtyPerUnit: 1.01 },
    ],
    match: { category: "卫生器具" },
  });

  it("materials[] 全量进方案行：首主材走 mainPrice，辅材走 matPrices", () => {
    const line = lineFromQuota(item({}), multiQ(), {
      mgmtRate: 0, profitRate: 0, mainPrice: 800,
      matPrices: { "低水箱配件": 60, "座便器桶盖": 45 },
    });
    expect(line.materials).toHaveLength(3);
    expect(line.materials?.find((m) => m.primary)?.amount).toBe("808"); // 800×1.01
    expect(line.materials?.find((m) => m.name === "低水箱配件")?.amount).toBe("60.6");
    // 小计 = 30(人工) + 4(辅材) + 0 + 808 + 60.6 + 45.45
    expect(line.subtotal).toBe("948.05");
  });

  it("辅材缺价：进入 missingMaterials，amount 为 null", () => {
    const line = lineFromQuota(item({}), multiQ(), { mgmtRate: 0, profitRate: 0, mainPrice: 800 });
    expect(line.materials?.find((m) => m.name === "低水箱配件")?.price).toBeNull();
    const [r] = calcQuota(
      [item({ name: "坐便器", features: { category: "卫生器具" }, mainMaterialPrice: "800" })],
      { lib: [multiQ()], threshold: 0 }
    );
    expect(r.needsMainPrice).toBe(true);
    expect(r.missingMaterials).toEqual(expect.arrayContaining(["低水箱配件", "座便器桶盖"]));
    expect(r.deviation).toBeNull(); // 不完整测算不出偏差
  });

  it("全部材料有价：多材料费入测算总价", () => {
    const [r] = calcQuota(
      [item({ name: "坐便器", features: { category: "卫生器具" }, mainMaterialPrice: "800" })],
      { lib: [multiQ()], threshold: 0, matPrices: { "低水箱配件": 60, "座便器桶盖": 45 } }
    );
    expect(r.needsMainPrice).toBe(false);
    // (300+40)/10=34 + 800×1.01+60×1.01+45×1.01=914.05 → 948.05
    expect(r.calcPrice).toBe("948.05");
  });
});

describe("定额说明参与组价缺口判定", () => {
  const specLib: QuotaEntry[] = [
    {
      code: "5H0010", name: "给水管道安装 DN50", unit: "10m", unitScale: 10,
      labor: 80, material: 12, machine: 3, mainQtyPerUnit: 1.02,
      detail: { gcnr: "切管、套丝、管道安装。", fb: "H.给排水", chapter: "管道安装", mainMaterial: "PPR管" },
      match: { category: "管道" },
    },
    { code: "5H9001", name: "管道水压试验 公称直径50mm以内", unit: "100m", unitScale: 100, labor: 20, material: 3, machine: 1, mainQtyPerUnit: 1, match: {} },
    { code: "5K0001", name: "管道刷油 防锈漆第一遍", unit: "10m²", unitScale: 10, labor: 8, material: 5, machine: 0, mainQtyPerUnit: 1, match: {} },
  ];
  const pipe = () => item({ name: "给水PPR管 DN50", features: { category: "管道", material: "PPR", diameter: "DN50" }, mainMaterialPrice: "12" });

  it("说明「已含水压试验」→ 不建议；「防腐刷漆另行计算」→ 建议增列", () => {
    const specTexts = { "H.给排水|管道安装": "管道安装均包括水压试验及水冲洗。管道防腐刷漆另行计算。" };
    const [r] = calcQuota([pipe()], { lib: specLib, threshold: 0, specTexts });
    const sug = (r.plan ?? []).filter((l) => l.suggested);
    expect(sug.every((l) => !/水压|试压/.test(l.quotaName))).toBe(true);
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
