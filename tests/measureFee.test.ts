import { describe, expect, it } from "vitest";
import { D } from "../cost-engine/money";
import { computeMeasureFees, type MeasureFeeRate } from "../cost-engine/measureFee";

// 四川2020 安装措施费系数（节选自 ps_fy+ps_fl 官方表）
const RATES: MeasureFeeRate[] = [
  {
    fyid: 14, name: "脚手架搭拆费(5G分部)", book: "5G", category: "脚手架搭拆费",
    base: "定额人工费WG*费率/100", baseWithMachine: false,
    tiers: [{ tier: "5G分部", rate: 0.05, laborPct: 25, materialPct: 75, machinePct: null }],
  },
  {
    fyid: 27, name: "脚手架搭拆费(5H分部)", book: "5H", category: "脚手架搭拆费",
    base: "定额人工费WH*费率/100", baseWithMachine: false,
    tiers: [{ tier: "5H分部", rate: 0.05, laborPct: 25, materialPct: 75, machinePct: null }],
  },
  {
    fyid: 24, name: "安装工程超高增加费(5G分部)", book: "5G", category: "超高增加费",
    base: "定额人工费WG*费率/100", baseWithMachine: false,
    tiers: [
      { tier: "5m<操作物高度距离楼地面≤8m", rate: 0.10, laborPct: 100, materialPct: null, machinePct: null },
      { tier: "8m<操作物高度距离楼地面≤12m", rate: 0.15, laborPct: 100, materialPct: null, machinePct: null },
      { tier: "12m<操作物高度距离楼地面≤16m", rate: 0.20, laborPct: 100, materialPct: null, machinePct: null },
    ],
  },
  {
    fyid: 19, name: "安装工程高层建筑增加费(5G分部)", book: "5G", category: "高层建筑增加费",
    base: "定额人工费WG*费率/100", baseWithMachine: false,
    tiers: [
      { tier: "檐口高度30m以下", rate: 0.02, laborPct: 100, materialPct: null, machinePct: null },
      { tier: "檐口高度40m以下", rate: 0.03, laborPct: 100, materialPct: null, machinePct: null },
      { tier: "檐口高度50m以下", rate: 0.05, laborPct: 100, materialPct: null, machinePct: null },
    ],
  },
  {
    fyid: 22, name: "采暖工程系统调整费", book: "通用", category: "系统调整费",
    base: "定额人工费*费率/100", baseWithMachine: false,
    tiers: [{ tier: "调增费用", rate: 0.15, laborPct: 20, materialPct: null, machinePct: null }],
  },
];

const labor = (o: Record<string, string>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, D(v)]));

describe("computeMeasureFees 川标措施费系数", () => {
  it("脚手架搭拆费：按册平费率，人工/材料占比拆分", () => {
    const r = computeMeasureFees(RATES, labor({ "5G": "10000", "5H": "20000" }), {});
    const g = r.lines.find((l) => l.name.includes("5G") && l.category === "脚手架搭拆费");
    const h = r.lines.find((l) => l.name.includes("5H") && l.category === "脚手架搭拆费");
    expect(g?.amount).toBe("500.00");   // 10000×5%
    expect(h?.amount).toBe("1000.00");  // 20000×5%
    expect(g?.laborPart).toBe("125.00");   // 500×25%
    expect(g?.materialPart).toBe("375.00"); // 500×75%
    expect(g?.machinePart).toBeNull();
  });

  it("超高增加费：操作物高度自动选档", () => {
    const r = computeMeasureFees(RATES, labor({ "5G": "10000" }), { workHeight: 10 });
    const u = r.lines.find((l) => l.category === "超高增加费");
    expect(u?.tier).toContain("≤12m");
    expect(u?.amount).toBe("1500.00"); // 10000×15%
  });

  it("超高未达起计点(≤5m)不计取", () => {
    const r = computeMeasureFees(RATES, labor({ "5G": "10000" }), { workHeight: 4 });
    expect(r.lines.find((l) => l.category === "超高增加费")).toBeUndefined();
    expect(r.skipped.some((s) => s.name.includes("超高"))).toBe(true);
  });

  it("高层建筑增加费：檐口高度选最小满足档", () => {
    const r = computeMeasureFees(RATES, labor({ "5G": "10000" }), { eaveHeight: 35 });
    const t = r.lines.find((l) => l.category === "高层建筑增加费");
    expect(t?.tier).toBe("檐口高度40m以下"); // 35 → 40以下档，不是50
    expect(t?.amount).toBe("300.00");
  });

  it("未设置高度 → 对应费项跳过并注明原因", () => {
    const r = computeMeasureFees(RATES, labor({ "5G": "10000" }), {});
    expect(r.lines.every((l) => !/超高|高层/.test(l.category))).toBe(true);
    expect(r.skipped.some((s) => s.reason.includes("操作物高度"))).toBe(true);
    expect(r.skipped.some((s) => s.reason.includes("檐口高度"))).toBe(true);
  });

  it("系统调整费默认不计，显式启用后按对应册取基数", () => {
    const off = computeMeasureFees(RATES, labor({ "5H": "20000" }), {});
    expect(off.lines.find((l) => l.category === "系统调整费")).toBeUndefined();

    const on = computeMeasureFees(RATES, labor({ "5H": "20000", "5G": "99999" }), { systemAdjust: ["采暖"] });
    const adj = on.lines.find((l) => l.category === "系统调整费");
    // 采暖→5H册基数 20000×15%=3000（不取5G的99999）
    expect(adj?.amount).toBe("3000.00");
    expect(adj?.book).toBe("5H");
  });

  it("无该册人工费 → 该册费项不产生", () => {
    const r = computeMeasureFees(RATES, labor({ "5G": "10000" }), {});
    expect(r.lines.every((l) => l.book === "5G")).toBe(true);
  });
});
