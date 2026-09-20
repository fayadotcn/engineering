import { describe, expect, it } from "vitest";
import { groupKey, inferDiscipline, parseSemanticFeature } from "@cost-engine/semantic";

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
    expect(f.specification).toBe("4x25+1x16".toUpperCase());
  });

  it("normalizes full-width DN and Φ", () => {
    const f = parseSemanticFeature("PPR给水管 ＤＮ５０ 热熔连接");
    expect(f.diameter).toBe("DN50");
    expect(f.connectionMethod).toBe("热熔连接");
    const g = parseSemanticFeature("钢管 Φ108 焊接");
    expect(g.diameter).toBe("DN108");
    expect(g.connectionMethod).toBe("焊接");
  });

  it("different spec => different group key", () => {
    const a = parseSemanticFeature("镀锌钢管 DN100 沟槽");
    const b = parseSemanticFeature("镀锌钢管 DN150 沟槽");
    expect(groupKey("a", "m", a)).not.toBe(groupKey("b", "m", b));
  });

  it("infers discipline", () => {
    expect(inferDiscipline("室内消火栓钢管", "", "")).toBe("FIRE");
    expect(inferDiscipline("电力电缆", "", "电气设备安装工程")).toBe("ELECTRICAL");
  });
});
