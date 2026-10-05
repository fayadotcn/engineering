import { describe, expect, it } from "vitest";
import { compareBoqSets, compareSummary, compareDeclaredFees } from "@cost-engine/fileCompare";
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
  mainMaterialPrice: "0", laborUnitPrice: "0", machineUnitPrice: "0",
  pricingPlan: [],
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

  it("总额计价行（总价措施/其他项目）按合价判差——量价是结构常量", () => {
    const lump = (name: string, total: string, fileId: string): BoqItemDTO => ({
      ...item(name, "", "项", "1", "0", "", fileId),
      feeType: "总价措施",
      totalPrice: total,
    });
    const a = [lump("安全文明施工费", "5000", "fA"), lump("夜间施工费", "800", "fA")];
    const b = [lump("安全文明施工费", "6500", "fB"), lump("夜间施工费", "800", "fB")];
    const rows = compareBoqSets(a, b);
    const diff = rows.find((r) => r.name === "安全文明施工费")!;
    const same = rows.find((r) => r.name === "夜间施工费")!;
    expect(diff.status).toBe("PRICE_DIFF");
    expect(diff.priceDelta).toBe("1500");
    expect(diff.totalDelta).toBe("1500");
    // lumpPair 标记透出：视图/导出据此把结构单价 0 留白（与导出综合单价同口径）
    expect(diff.lumpPair).toBe(true);
    expect(same.lumpPair).toBe(true);
    expect(same.status).toBe("SAME");
    const s = compareSummary(rows);
    expect(s.priceDiff).toBe(1);
    expect(s.same).toBe(1);
    expect(s.totalDelta).toBe("1500.00");
  });

  it("aligns by semantic key when code is missing", () => {
    const a = [item("镀锌钢管", "DN100 沟槽连接", "m", "10", "85")];
    const b = [item("镀锌钢管", "DN100 沟槽连接", "m", "10", "85", "", "fB")];
    expect(compareBoqSets(a, b)[0].status).toBe("SAME");
  });

  it("名称全半角/大小写排版差不误报 nameMismatch", () => {
    const a = [item("钢管（热镀锌）", "DN100", "m", "10", "85", "C001")];
    const b = [item("钢管(热镀锌)", "DN100", "m", "10", "85", "C001", "fB")];
    const r = compareBoqSets(a, b)[0];
    expect(r.status).toBe("SAME");
    expect(r.nameMismatch).toBeUndefined();
    // 真改名仍标
    const c = [item("钢管(衬塑)", "DN100", "m", "10", "85", "C001", "fB")];
    expect(compareBoqSets(a, c)[0].nameMismatch).toBe(true);
  });

  it("marks identical sets all SAME", () => {
    const a = [item("桥架", "200x100", "m", "30", "45", "C1")];
    const b = [item("桥架", "200x100", "m", "30", "45", "C1", "fB")];
    const s = compareSummary(compareBoqSets(a, b));
    expect(s.same).toBe(1);
    expect(s.totalDelta).toBe("0.00");
  });

  it("量差超15%标记 qtyOver15（GB50500 调价触发线），≤15% 不标", () => {
    const a = [
      item("镀锌钢管", "DN100", "m", "100", "85", "C001"),
      item("电缆", "YJV-4x25", "m", "100", "60", "C002"),
      item("桥架", "200x100", "m", "100", "45", "C003"),
    ];
    const b = [
      item("镀锌钢管", "DN100", "m", "120", "85", "C001", "fB"), // +20% → 触发
      item("电缆", "YJV-4x25", "m", "110", "60", "C002", "fB"),  // +10% → 不触发
      item("桥架", "200x100", "m", "80", "45", "C003", "fB"),   // -20% → 触发
    ];
    const rows = compareBoqSets(a, b);
    const by = (code: string) => rows.find((r) => r.code === code)!;
    expect(by("C001").qtyOver15).toBe(true);
    expect(by("C002").qtyOver15).toBeUndefined();
    expect(by("C003").qtyOver15).toBe(true);
    expect(compareSummary(rows).qtyOver15).toBe(2);
  });

  it("同编码重复行（多单位工程）按出现序对齐，不静默丢失", () => {
    const a = [
      item("配电箱", "AL1", "台", "2", "3500", "C001"),
      item("配电箱", "AL2", "台", "3", "4200", "C001"), // 同编码第二次出现
    ];
    const b = [
      item("配电箱", "AL1", "台", "2", "3600", "C001", "fB"),
      item("配电箱", "AL2", "台", "3", "4200", "C001", "fB"),
      item("配电箱", "AL3", "台", "1", "5000", "C001", "fB"), // B 第三次出现
    ];
    const rows = compareBoqSets(a, b);
    // 3 条配对行：两条对齐 + 一条 ONLY_B，不能塌成一行
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.status === "ONLY_B")).toHaveLength(1);
    const s = compareSummary(rows);
    expect(s.onlyB).toBe(1);
    // A 第一条 3500→3600 差价（2台×100=+200）；B 多出 1×5000
    expect(s.totalDelta).toBe("5200.00");
  });

  it("同码重复行按单位工程配对——两版文件单位工程排序不同不错配", () => {
    const up = (i: BoqItemDTO, u: string) => ({ ...i, unitProject: u });
    // A：1#楼在前；B：2#楼在前——纯出现序配对会把 1#楼的行拿去和 2#楼比
    const a = [
      up(item("配电箱", "AL1", "台", "2", "3500", "C001"), "1#楼"),
      up(item("配电箱", "AL1", "台", "3", "4200", "C001"), "2#楼"),
    ];
    const b = [
      up(item("配电箱", "AL1", "台", "3", "4200", "C001", "fB"), "2#楼"),
      up(item("配电箱", "AL1", "台", "2", "3500", "C001", "fB"), "1#楼"),
    ];
    const rows = compareBoqSets(a, b);
    // 正确口径：两对都 SAME（同归属同量价）；若按出现序错配会报 2 条 BOTH_DIFF
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "SAME")).toBe(true);
  });

  it("某单位工程独有的同码行标 ONLY_* 而非跨归属错配", () => {
    const up = (i: BoqItemDTO, u: string) => ({ ...i, unitProject: u });
    const a = [
      up(item("配电箱", "AL1", "台", "2", "3500", "C001"), "1#楼"),
      up(item("配电箱", "AL1", "台", "3", "4200", "C001"), "2#楼"), // B 无 2#楼
    ];
    const b = [up(item("配电箱", "AL1", "台", "2", "3500", "C001", "fB"), "1#楼")];
    const rows = compareBoqSets(a, b);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === "SAME")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "ONLY_A")).toHaveLength(1);
  });
});

describe("compareDeclaredFees（文件汇总事实两期对审）", () => {
  const unit = (name: string, total: number, extra: Record<string, number> = {}) =>
    ({ sheet: "s", unit: name, 合计: total, ...extra });

  it("费用口径差 + 单位工程按名对齐（含独有侧）", () => {
    const a = [
      unit("给排水", 500000, { 分部分项工程费: 400000, 规费: 20000, 税金: 45000 }),
      unit("电气", 300000, { 分部分项工程费: 240000, 规费: 12000, 税金: 27000 }),
    ];
    const b = [
      unit("给排水", 560000, { 分部分项工程费: 450000, 规费: 20000, 税金: 50400 }),
      unit("电气", 300000, { 分部分项工程费: 240000, 规费: 12000, 税金: 27000 }),
      unit("暖通", 120000, { 分部分项工程费: 100000, 税金: 10800 }), // B 独有单位工程
    ];
    const r = compareDeclaredFees(a, b);
    const by = (k: string) => r.labels.find(l => l.label === k)!;
    expect(by("分部分项工程费").diff).toBe(150000); // 给排水+5万，暖通独有+10万
    expect(by("合计")).toEqual({ label: "合计", a: 800000, b: 980000, diff: 180000 });
    const u = (n: string) => r.units.find(x => x.name === n)!;
    expect(u("给排水")).toMatchObject({ a: 500000, b: 560000, diff: 60000, side: "both" });
    expect(u("电气").diff).toBe(0);
    expect(u("暖通")).toMatchObject({ side: "b", diff: 120000 });
  });

  it("缺字段与零值行不进入结果", () => {
    const r = compareDeclaredFees(
      [unit("给排水", 100, { 规费: 0 })],
      [unit("给排水", 100)]
    );
    expect(r.labels.map(l => l.label)).toEqual(["合计"]);
    expect(r.labels[0].diff).toBe(0);
  });
});

describe("五统一符合性标记", () => {
  it("同码对齐但单位量纲不同 → unitMismatch；名称不同 → nameMismatch", () => {
    const a = [item("镀锌钢管", "DN100 沟槽", "m", "10", "85", "031001001001")];
    const b = [item("热镀锌钢管", "DN100 沟槽", "km", "10", "85", "031001001001", "fB")];
    const rows = compareBoqSets(a, b);
    expect(rows[0].unitMismatch).toBe(true);
    expect(rows[0].nameMismatch).toBe(true);
    expect(rows[0].status).toBe("SAME"); // 量价一致但符合性不符
    const s = compareSummary(rows);
    expect(s.compliance).toBe(1);
  });

  it("米/m 归一不算单位异；特征冲突列出字段", () => {
    const a = [item("镀锌钢管", "DN100 沟槽连接", "米", "10", "85", "031001001001")];
    const b = [item("镀锌钢管", "DN100 螺纹连接", "m", "10", "85", "031001001001", "fB")];
    const rows = compareBoqSets(a, b);
    expect(rows[0].unitMismatch).toBeUndefined();
    expect(rows[0].nameMismatch).toBeUndefined();
    expect(rows[0].featureConflict?.length).toBeGreaterThan(0);
  });
});

describe("pickComparePair 缺省对审对", () => {
  it("「中标」阶段排在投标与清标之间——不冒充招标当最前配对", async () => {
    const { pickComparePair } = await import("@cost-engine/fileCompare");
    const f = (stage: string, period = "", t = 0) => ({ stage, period, createdAt: new Date(2024, 0, 1 + t) });
    // inferFileStage 会产出「中标」，此前不在 COMPARE_STAGE_ORDER 里 → indexOf -1
    // 被 Math.max 抬成 0 与「招标」同级，三文件时对审方向错乱
    const [a, b] = pickComparePair([f("结算"), f("中标"), f("招标")]);
    expect(a.stage).toBe("招标");
    expect(b.stage).toBe("结算");
  });

  it("空 stage 视为最靠前（原始清单版）", async () => {
    const { pickComparePair } = await import("@cost-engine/fileCompare");
    const f = (stage: string, t = 0) => ({ stage, period: "", createdAt: new Date(2024, 0, 1 + t) });
    const [a, b] = pickComparePair([f("结算"), f("", 1), f("投标")]);
    expect(a.stage).toBe("");
    expect(b.stage).toBe("结算");
  });
});
