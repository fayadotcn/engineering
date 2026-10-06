import { describe, expect, it } from "vitest";
import { normUsageName, usageItemKey, usageEffectiveName, usageSpecTags } from "../cost-engine/usageKey";
import { buildUsageStats, type UsageItemRecord } from "../quota/usage";

// 经验库键规则与聚合分档回归：键规则一变，线上就查不到线下沉淀的桶

describe("usageKey 名称归一化", () => {
  it("规格数值归一为模式", () => {
    expect(normUsageName("刚性防水套管 DN150")).toBe(normUsageName("刚性防水套管DN100"));
    expect(normUsageName("镀锌钢管 SC20")).not.toBe(normUsageName("镀锌钢管DNφ"));
  });
  it("操作标签行用特征里的真名", () => {
    const spec = "1.名称：消声器\n2.规格：1000*400*1000";
    expect(usageEffectiveName("替换材料", spec)).toBe("消声器");
    expect(usageItemKey("替换材料", "个", spec)).toContain("消声器");
  });
  it("无可救药的操作标签不出键", () => {
    expect(usageItemKey("替换材料", "个", "")).toBe("");
  });
  it("规格标签抽取", () => {
    const tags = usageSpecTags("柔性防水套管制作安装 DN350", "1.规格：DN350\n2.材质：Q235");
    expect(tags).toContain("DN350");
  });
});

describe("buildUsageStats 聚合与分档", () => {
  const item = (file: string, name: string, quotas: { applied?: string; code: string; name: string; unit?: string; conv?: boolean }[]): UsageItemRecord => ({
    file, name, unit: "个", spec: "", quotas: quotas.map((q) => ({ unit: "个", conv: false, materials: [], ...q })),
  });
  it("多项目共识=common，孤例=suspect", () => {
    const { stats } = buildUsageStats([
      item("f1", "刚性防水套管 DN100", [{ code: "A1", name: "制作" }, { code: "A2", name: "安装" }]),
      item("f2", "刚性防水套管 DN150", [{ code: "A1", name: "制作" }, { code: "A2", name: "安装" }]),
      item("f3", "刚性防水套管 DN200", [{ code: "A1", name: "制作" }, { code: "A2", name: "安装" }]),
      item("f3", "刚性防水套管 DN250", [{ code: "A3", name: "错套子目" }]),
    ]);
    const a1 = stats.find((s) => s.quotaCode === "A1")!;
    const a3 = stats.find((s) => s.quotaCode === "A3")!;
    expect(a1.flag).toBe("common");
    expect(a1.projects).toBe(3);
    expect(a3.flag).toBe("suspect"); // 孤例且桶内有共识
  });
  it("组合套用整体保留（制作+安装）", () => {
    const { combos } = buildUsageStats([
      item("f1", "防水套管", [{ code: "A1", name: "制作", applied: "C1" }, { code: "A2", name: "安装", applied: "C2", conv: true }]),
      item("f2", "防水套管", [{ code: "A1", name: "制作", applied: "C1" }, { code: "A2", name: "安装", applied: "C2", conv: true }]),
    ]);
    const c = combos[0];
    expect(c.lines.map((l) => l.applied)).toEqual(["C1", "C2"]);
    expect(c.lines[1].conv).toBe(true);
    expect(c.projects).toBe(2);
    expect(c.flag).toBe("common");
  });
  it("名称带规格的清单聚进同一桶", () => {
    const { stats, buckets } = buildUsageStats([
      item("f1", "蝶阀 DN100", [{ code: "A1", name: "法兰阀门安装" }]),
      item("f2", "蝶阀 DN150", [{ code: "A1", name: "法兰阀门安装" }]),
    ]);
    expect(buckets).toBe(1);
    expect(stats[0].projects).toBe(2);
  });
});
