import { describe, expect, it } from "vitest";
import { calcQuota, planPrice, quotaLaborTotals, scoreQuota } from "../cost-engine/quota";
import type { QuotaEntry } from "../quota/library";
import type { BoqItemDTO } from "../shared/types";

// 专业语义回归：主材暂估价是组价输入；缺主材价时测算不完整、不算偏差。

const lib: QuotaEntry[] = [
  {
    code: "T-1", name: "镀锌钢管安装 DN100", unit: "10m", unitScale: 10,
    labor: 100, material: 20, machine: 5, mainQtyPerUnit: 1.02,
    match: { category: "管道" },
  },
];

const item = (o: Partial<BoqItemDTO> = {}): BoqItemDTO =>
  ({
    id: "i1", projectId: "p", fileId: null, sheetName: "s", rowIndex: 1,
    code: "", name: "镀锌钢管", rawFeature: "", unit: "m",
    quantity: "10", unitPrice: "50", mainMaterialPrice: "0",
    totalPrice: "500", feeType: "分部分项", sectionPath: "",
    isHeader: false, sortOrder: 0, discipline: "OTHER",
    features: { category: "管道" },
    ...o,
  }) as BoqItemDTO;

describe("calcQuota 组价语义", () => {
  it("人工费按清单工程量归集到分册，不计入未匹配项", () => {
    const rows = calcQuota([item(), item({ id: "i2", quantity: "2.5" })], { lib: [{ ...lib[0], code: "5H1" }], threshold: 0 });
    expect(quotaLaborTotals([...rows, { ...rows[0], quotaCode: null, labor: "999" }])).toEqual({ total: "125.00", byBook: { "5H": "125.00" } });
  });
  it("未确认的管理费率、利润率不套用隐藏默认值", () => {
    const [r] = calcQuota([item({ mainMaterialPrice: "30" })], { lib, threshold: 0 });
    expect(r.fee).toBe("0");
    expect(r.calcPrice).toBe("43.1");
  });
  it("清单项上的主材暂估价优先参与组价（询价/材料库之外的第一来源）", () => {
    const [r] = calcQuota([item({ mainMaterialPrice: "30" })], {
      lib, threshold: 0, mgmtRate: 0.16, profitRate: 0.09,
    });
    // 人工10 + 辅材2 + 机械0.5 + 主材30×1.02 + 费(10.5×0.25) = 10+2+0.5+30.6+2.625 = 45.725
    expect(r.needsMainPrice).toBe(false);
    expect(r.mainMaterial).toBe("30.6");
    expect(r.calcPrice).toBe("45.73");
    expect(r.deviation).not.toBeNull();
  });

  it("缺主材价：测算为不完整单价，不算偏差（缺主材的比价必然失真）", () => {
    const [r] = calcQuota([item()], { lib, threshold: 0 });
    expect(r.needsMainPrice).toBe(true);
    expect(r.deviation).toBeNull();
    expect(r.calcPrice).not.toBeNull(); // 人材机管利部分仍可看
  });

  it("主材暂估价优先于询价映射", () => {
    const [r] = calcQuota([item({ mainMaterialPrice: "99" })], {
      lib, threshold: 0, mainPrices: { "镀锌钢管|": 1 },
    });
    expect(r.mainMaterial).toBe("100.98"); // 99×1.02，而非 1×1.02
  });

  it("询价命中价为 0（作废/占位列）按缺主材价处理", () => {
    const [r] = calcQuota([item()], {
      lib, threshold: 0, mainPrices: { "镀锌钢管|": 0 },
    });
    expect(r.needsMainPrice).toBe(true);
    expect(r.deviation).toBeNull();
  });

  it("定额名用 ϕ 直径写法也参与贴档：ϕ100以内 覆盖 DN100、拒绝 DN150", () => {
    // ϕ(U+03D5) 是图纸常见直径符号——quotaDiaBand 只认 Φ 会丢档，DN150 清单免罚错档
    const q: QuotaEntry = {
      code: "T-2", name: "镀锌钢管安装 ϕ100mm以内", unit: "10m", unitScale: 10,
      labor: 1, material: 1, machine: 0, mainQtyPerUnit: 1,
      match: { category: "管道", diameter: /DN50/ }, // 贴档路径：直径正则未命中时回退定额名档位
    };
    const d100 = item({ features: { category: "管道", diameter: "DN100" } });
    const d150 = item({ features: { category: "管道", diameter: "DN150" } });
    expect(scoreQuota(d100, q)).toBeGreaterThan(scoreQuota(d150, q));
  });
});

describe("组价方案：工作内容缺口的配套子目建议", () => {
  const pipeLib: QuotaEntry[] = [
    {
      code: "5H0001", name: "给水管道安装 DN100", unit: "10m", unitScale: 10,
      labor: 150, material: 30, machine: 5, mainQtyPerUnit: 1.015,
      detail: { gcnr: "切管、套丝、管道安装、水压试验。", mainMaterial: "镀锌钢管" }, // 含试压，不含冲洗/支架
      match: { category: "管道" },
    },
    {
      code: "5H0332", name: "管道消毒、冲洗 公称直径100mm以内", unit: "100m", unitScale: 100,
      labor: 50, material: 10, machine: 2, mainQtyPerUnit: 1, match: {},
    },
    {
      code: "5G0131", name: "管道支吊架制作、安装", unit: "100kg", unitScale: 100,
      labor: 300, material: 50, machine: 20, mainQtyPerUnit: 1, match: {},
    },
  ];
  const pipeItem = () =>
    item({
      name: "给水镀锌钢管", features: { category: "管道", material: "镀锌钢管", diameter: "DN100" },
      mainMaterialPrice: "52",
    });

  it("gcnr 未含的工序（冲洗/支吊架）生成建议增列行，已含的（试压）不建议", () => {
    const [r] = calcQuota([pipeItem()], { lib: pipeLib, threshold: 0, mgmtRate: 0.16, profitRate: 0.09 });
    const plan = r.plan ?? [];
    const suggested = plan.filter((l) => l.suggested);
    expect(plan[0].quotaCode).toBe("5H0001");
    expect(suggested.map((l) => l.quotaCode)).toEqual(
      expect.arrayContaining(["5H0332", "5G0131"])
    );
    // 试压已在主定额工作内容里，不建议
    expect(suggested.every((l) => !/试压|水压/.test(l.quotaName))).toBe(true);
    // 连接方式非沟槽/法兰 → 不建议管件
    expect(suggested.every((l) => !/管件/.test(l.quotaName))).toBe(true);
  });

  it("建议行不计入测算价，planPrice 只合计已确认行", () => {
    const [r] = calcQuota([pipeItem()], { lib: pipeLib, threshold: 0, mgmtRate: 0.16, profitRate: 0.09 });
    const plan = r.plan ?? [];
    // 测算价 = 仅主项：15 + 3 + 0.5 + 52×1.015 + (15.5×0.25) = 15+3+0.5+52.78+3.875 = 75.155
    expect(r.calcPrice).toBe("75.16");
    expect(planPrice(plan).toFixed(2)).toBe("75.16");
    expect(planPrice(plan.filter((l) => !l.suggested)).toFixed(2)).toBe(planPrice(plan).toFixed(2));
  });

  it("沟槽连接清单借套螺纹子目：「上零件」gcnr 不能吞掉沟槽管件材料另计建议", () => {
    const threadQ: QuotaEntry = {
      code: "5G0071", name: "管道安装 镀锌钢管 螺纹连接 公称直径 70mm以内", unit: "10m", unitScale: 10,
      labor: 49.8, material: 16.27, machine: 8.31, mainQtyPerUnit: 1.02,
      detail: { gcnr: "切管、套丝、调直、上零件、管道安装、水压试验。", mainMaterial: "镀锌钢管" },
      materials: [
        { name: "镀锌钢管", unit: "m", qtyPerUnit: 1.02 },
        { name: "镀锌钢管接头零件", unit: "个", qtyPerUnit: 0.891 },
      ],
      match: { category: "管道", material: /镀锌钢管/, diameter: /^DN65$/ },
    };
    const grooveItem = item({
      name: "镀锌钢管(沟槽连接)",
      features: { category: "管道", material: "镀锌钢管", diameter: "DN65", connectionMethod: "沟槽连接" },
    });
    const [r] = calcQuota([grooveItem], {
      lib: [threadQ], threshold: 0,
      // C.J.1 条文：其他沟槽管件另行执行相关项目
      specTexts: { "": "管道安装（沟槽连接）已包括直接卡箍件安装，其他沟槽管件另行执行相关项目" },
    });
    const suggested = (r.plan ?? []).filter((l) => l.suggested);
    const note = suggested.find((l) => /沟槽管件/.test(l.quotaName));
    expect(note, "沟槽清单必须提示沟槽管件另计").toBeTruthy();
    expect(note!.quotaName).toContain("材料另计");
  });

  it("定额 materials[] 已列沟槽管件时不再重复提示", () => {
    const grooveQ: QuotaEntry = {
      code: "5G0901", name: "水喷淋钢管 沟槽连接 公称直径 65mm以内", unit: "10m", unitScale: 10,
      labor: 60, material: 20, machine: 8, mainQtyPerUnit: 1.02,
      detail: { gcnr: "管道安装、卡箍件安装、水压试验。", mainMaterial: "镀锌钢管" },
      materials: [
        { name: "镀锌钢管", unit: "m", qtyPerUnit: 1.02 },
        { name: "沟槽管件", unit: "套", qtyPerUnit: 0.35 },
      ],
      match: { category: "管道", material: /镀锌钢管/, diameter: /^DN65$/, connection: /沟槽/ },
    };
    const grooveItem = item({
      name: "镀锌钢管(沟槽连接)",
      features: { category: "管道", material: "镀锌钢管", diameter: "DN65", connectionMethod: "沟槽连接" },
    });
    const [r] = calcQuota([grooveItem], { lib: [grooveQ], threshold: 0 });
    const suggested = (r.plan ?? []).filter((l) => l.suggested);
    expect(suggested.every((l) => !/沟槽管件/.test(l.quotaName))).toBe(true);
  });
});
