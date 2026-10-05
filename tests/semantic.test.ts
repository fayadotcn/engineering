import { describe, expect, it } from "vitest";
import { featureCompatible, groupKey, inferDiscipline, parseSemanticFeature } from "@cost-engine/semantic";

describe("parseSemanticFeature", () => {
  it("parses 镀锌钢管 DN100 沟槽连接 室内消防", () => {
    const f = parseSemanticFeature("镀锌钢管", "DN100 沟槽连接 室内消防");
    expect(f.material).toBe("镀锌钢管");
    expect(f.diameter).toBe("DN100");
    expect(f.connectionMethod).toBe("沟槽连接");
    expect(f.location).toBe("室内");
    expect(f.system).toBe("消防");
    expect(f.category).toBe("管道");
  });

  it("parses cable spec YJV-4x25+1x16", () => {
    const f = parseSemanticFeature("电力电缆", "YJV-4x25+1x16 铜芯 桥架内敷设");
    expect(f.category).toBe("电缆");
    expect(f.specification).toBe("4x25+1x16");
    // × / * / X 分隔符归一：同一规格的不同写法不应产生规格冲突
    const g = parseSemanticFeature("电力电缆", "YJV-4*25+1*16");
    expect(g.specification).toBe("4x25+1x16");
    expect(featureCompatible(f, g).conflicts).toHaveLength(0);
  });

  it("parses wall-thickness spec De25*2.3 and flags it in feature conflicts", () => {
    const cold = parseSemanticFeature("塑料管", "PP-R冷水管（含管件）/De25*2.3 热熔连接");
    const hot = parseSemanticFeature("塑料管", "PP-R热水管（含管件）/De25*4.2 热熔连接");
    expect(cold.specification).toBe("25x2.3");
    expect(hot.specification).toBe("25x4.2");
    // 同为 DN25 会同组，但壁厚不同必须写进冲突理由，不能谎报「特征一致」
    expect(featureCompatible(cold, hot).conflicts.join()).toMatch(/specification/);
  });

  it("normalizes full-width DN and Φ", () => {
    const f = parseSemanticFeature("PPR给水管 ＤＮ５０ 热熔连接");
    expect(f.diameter).toBe("DN50");
    expect(f.connectionMethod).toBe("热熔连接");
    const g = parseSemanticFeature("钢管 Φ108 焊接");
    expect(g.diameter).toBe("DN108");
    expect(g.connectionMethod).toBe("焊接");
  });

  it("normalizes diameter-symbol variants ϕ/φ/Ø/∅/￠ to Φ", () => {
    // ϕ(U+03D5)/φ(U+03C6)/Ø/∅/￠ 都是真实图纸里的直径写法
    for (const sym of ["ϕ", "φ", "Ø", "∅", "￠"]) {
      const f = parseSemanticFeature(`钢管 ${sym}108 焊接`);
      expect(f.diameter, `符号 ${sym}`).toBe("DN108");
    }
  });

  it("different spec => different group key", () => {
    const a = parseSemanticFeature("镀锌钢管 DN100 沟槽");
    const b = parseSemanticFeature("镀锌钢管 DN150 沟槽");
    expect(groupKey("a", "m", a)).not.toBe(groupKey("b", "m", b));
  });

  it("extracts equipment power Pe=60kW without mistaking it for PE material", () => {
    const f = parseSemanticFeature("配电箱", "型号规格：Pe=60kW/详见系统图 · 安装方式：挂墙明装");
    expect(f.power).toBe("60kW");
    expect(f.material).toBeUndefined();
    const g = parseSemanticFeature("风机", "功率：7.5kW");
    expect(g.power).toBe("7.5kW");
    const t = parseSemanticFeature("变压器", "容量：315kVA");
    // 315kVA 以「容量」形式出现时归到 specification 的定额式上限分支或功率分支均可
    expect(t.power ?? t.specification).toMatch(/315\s*kVA/i);
  });

  it("extracts pump/fan motor rating N=4.0kW and compound Pe=165+165(备)kW", () => {
    const pump = parseSemanticFeature("离心式泵", "参数：Q=40m³/h/H=15m/N=4.0kW");
    expect(pump.power).toBe("4.0kW");
    const standby = parseSemanticFeature("配电箱", "Pe=165+165(备)kW");
    expect(standby.power).toBe("165kW");
    // PN= 是公称压力不是功率（且无 kW 单位），不得误判
    const notPower = parseSemanticFeature("阀门", "PN=1.6MPa");
    expect(notPower.power).toBeUndefined();
  });

  it("different power => different group key + feature conflict", () => {
    const a = parseSemanticFeature("配电箱", "Pe=5kW");
    const b = parseSemanticFeature("配电箱", "Pe=60kW");
    expect(groupKey("a", "台", a)).not.toBe(groupKey("b", "台", b));
    expect(featureCompatible(a, b).conflicts.join()).toMatch(/power/);
  });

  it("same power + different price group stays grouped", () => {
    const a = parseSemanticFeature("配电箱", "Pe=5kW 挂墙明装");
    const b = parseSemanticFeature("配电箱", "Pe=5kW 挂墙明装");
    expect(groupKey("a", "台", a)).toBe(groupKey("b", "台", b));
  });

  it("infers discipline", () => {
    expect(inferDiscipline("室内消火栓钢管", "", "")).toBe("FIRE");
    expect(inferDiscipline("电力电缆", "", "电气设备安装工程")).toBe("ELECTRICAL");
    // 燃气/采暖在川标 5H 给排水·采暖·燃气册，归 PLUMBING 不丢 OTHER
    expect(inferDiscipline("燃气管道 DN50", "", "")).toBe("PLUMBING");
    expect(inferDiscipline("散热器", "", "采暖工程")).toBe("PLUMBING");
  });
});

describe("normUnit 量纲归一", () => {
  it("同义单位归一到引擎口径", async () => {
    const { normUnit } = await import("@cost-engine/semantic");
    expect(normUnit("米")).toBe("m");
    expect(normUnit("M")).toBe("m");
    expect(normUnit("平米")).toBe("㎡");
    expect(normUnit("m2")).toBe("㎡");
    expect(normUnit("千米")).toBe("km");
    expect(normUnit("立方米")).toBe("m³");
  });
  it("全角字符与空白先规整再归一", async () => {
    const { normUnit } = await import("@cost-engine/semantic");
    expect(normUnit("Ｍ")).toBe("m"); // 全角 M
    expect(normUnit(" m ")).toBe("m");
  });
});
