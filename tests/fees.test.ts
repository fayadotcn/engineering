import { describe, expect, it } from "vitest";
import { D } from "../cost-engine/money";
import { feeSummary } from "../cost-engine/fees";
import { parseRateValue, parseAmountValue } from "../project/facts";
import type { BoqItemDTO } from "../shared/types";

const item = (totalPrice: string, unitPrice = "1", feeType: BoqItemDTO["feeType"] = "分部分项"): BoqItemDTO =>
  ({
    id: Math.random().toString(36).slice(2),
    isHeader: false,
    name: "镀锌钢管",
    unitPrice,
    totalPrice,
    quantity: "10",
    feeType,
    features: {},
  }) as BoqItemDTO;

const params = (o: Partial<Parameters<typeof feeSummary>[1]> = {}) => ({
  measureRate: D(0), regulationRate: D(0), provisionalRate: D(0),
  provisionalAmount: D(0), taxRate: D(0), addonRate: D(0), laborBase: null, coeffMeasureFee: D(0),
  set: { measure: false, regulation: false, provisional: false, tax: false },
  ...o,
});

describe("feeSummary 取费汇总", () => {
  it("未确认税率暂不计税，显式提示缺项", () => {
    const r = feeSummary([item("10000"), item("20000")], params());
    expect(r.rows.find((x) => x.seq === "一")?.amount).toBe("30000.00");
    expect(r.rows.find((x) => x.seq === "五")?.amount).toBe("30000.00");
    expect(r.rows.find((x) => x.seq === "六")?.amount).toBe("0.00");
    expect(r.rows.find((x) => x.seq === "六")?.note).toContain("税率未确认");
    expect(r.grandTotal).toBe("30000.00");
  });

  it("全费率口径：措施3% + 暂列5% + 规费2% + 税9%", () => {
    const r = feeSummary(
      [item("100000")],
      params({
        measureRate: D(0.03), regulationRate: D(0.02), provisionalRate: D(0.05), taxRate: D(0.09),
        set: { measure: true, regulation: true, provisional: true, tax: true },
      })
    );
    // 100000 → +3000 +5000 +2000 = 110000 税前 → +9900 税 = 119900
    expect(r.preTax).toBe("110000.00");
    expect(r.grandTotal).toBe("119900.00");
  });

  it("含税单价项不重复计税：合价在税后并入，行内注明口径", () => {
    const taxIncl = item("10900");
    taxIncl.taxIncluded = true;
    const r = feeSummary(
      [item("100000"), taxIncl],
      params({ taxRate: D(0.09), set: { measure: false, regulation: false, provisional: false, tax: true } })
    );
    // 税前基数只含非含税项 100000；税 9000；含税价清单 10900 税后并入
    expect(r.rows.find((x) => x.seq === "一")?.amount).toBe("100000.00");
    expect(r.rows.find((x) => x.seq === "一")?.note).toContain("含税单价");
    expect(r.rows.find((x) => x.seq === "六")?.amount).toBe("9000.00");
    expect(r.rows.find((x) => x.seq === "六·补")?.amount).toBe("10900.00");
    expect(r.rows.find((x) => x.seq === "七")?.basis).toContain("含税价清单");
    expect(r.grandTotal).toBe("119900.00");
  });

  it("固定暂列金额优先于费率", () => {
    const r = feeSummary(
      [item("100000")],
      params({ provisionalRate: D(0.05), provisionalAmount: D(8000), set: { measure: false, regulation: false, provisional: true, tax: true } })
    );
    expect(r.rows.find((x) => x.seq === "三")?.amount).toBe("8000.00");
  });

  it("统计未定价项并标注", () => {
    const r = feeSummary([item("100"), item("0", "0")], params());
    expect(r.unpricedCount).toBe(1);
    expect(r.rows[0].note).toContain("未定价");
  });

  it("导入措施表时措施费用真值而非费率估算", () => {
    const r = feeSummary(
      [item("100000"), item("14295.78", "0", "总价措施"), item("3000", "0", "其他项目")],
      params({ measureRate: D(0.03), regulationRate: D(0), provisionalRate: D(0.05),
        set: { measure: true, regulation: false, provisional: true, tax: true } })
    );
    // 措施费=导入真值 14295.78，其他项目费=导入真值 3000（而非 5% 暂列估算）
    expect(r.rows.find((x) => x.seq === "二")?.amount).toBe("14295.78");
    expect(r.rows.find((x) => x.seq === "二")?.basis).toContain("措施清单");
    expect(r.rows.find((x) => x.seq === "三")?.amount).toBe("3000.00");
  });

  it("规费基数：有定额人工费用真基数，否则退回简化口径并标注", () => {
    const items = [item("100000")];
    const withLabor = feeSummary(items, params({
      regulationRate: D(0.28), laborBase: D(12000),
      set: { measure: false, regulation: true, provisional: false, tax: true },
    }));
    // 12000×28% = 3360（四川安装口径：定额人工费基数）
    expect(withLabor.rows.find((x) => x.seq === "四")?.amount).toBe("3360.00");
    expect(withLabor.rows.find((x) => x.seq === "四")?.basis).toContain("定额人工费");

    const noLabor = feeSummary(items, params({
      regulationRate: D(0.02),
      set: { measure: false, regulation: true, provisional: false, tax: true },
    }));
    expect(noLabor.rows.find((x) => x.seq === "四")?.amount).toBe("2000.00");
    expect(noLabor.rows.find((x) => x.seq === "四")?.basis).toContain("简化基数");
  });

  it("系数措施费与导入措施清单叠加", () => {
    const r = feeSummary(
      [item("100000"), item("14295.78", "0", "总价措施")],
      params({ coeffMeasureFee: D(2500) })
    );
    // 措施费 = 导入真值 14295.78 + 系数措施费 2500
    expect(r.rows.find((x) => x.seq === "二")?.amount).toBe("16795.78");
    expect(r.rows.find((x) => x.seq === "二")?.basis).toContain("系数措施费");
  });

  it("总价措施/其他项目行不计入未定价数", () => {
    const r = feeSummary(
      [item("100"), item("0", "0", "总价措施"), item("0", "0", "其他项目")],
      params()
    );
    expect(r.unpricedCount).toBe(0);
  });

  it("导入的零措施费、零其他项目费不被费率估算覆盖", () => {
    const r = feeSummary([item("10000"), item("0", "0", "总价措施"), item("0", "0", "其他项目")], params({ measureRate: D(.03), provisionalRate: D(.05) }));
    expect(r.rows.find(x => x.seq === "二")?.amount).toBe("0.00");
    expect(r.rows.find(x => x.seq === "三")?.amount).toBe("0.00");
  });

  it("附加税率设置后：增值税×附加税率出附加税行，计入含税造价", () => {
    const r = feeSummary(
      [item("100000")],
      params({ taxRate: D(0.09), addonRate: D(0.12), set: { measure: false, regulation: false, provisional: false, tax: true } })
    );
    // 增值税 9000，附加税 9000×12% = 1080，含税 = 100000+9000+1080 = 110080
    expect(r.rows.find((x) => x.seq === "六·附")?.amount).toBe("1080.00");
    expect(r.rows.find((x) => x.seq === "六·附")?.name).toBe("附加税");
    expect(r.grandTotal).toBe("110080.00");
    // 未设置附加税率时不产生附加税行
    const none = feeSummary([item("100000")], params({ taxRate: D(0.09) }));
    expect(none.rows.find((x) => x.seq === "六·附")).toBeUndefined();
  });

  it("各费用先取分，展示的小计与总计能逐行相加复核", () => {
    const r = feeSummary([item("0.10")], params({ measureRate: D(.025), provisionalRate: D(.05), regulationRate: D(.025), taxRate: D(.09) }));
    expect(r.rows.find(x => x.seq === "二")?.rate).toBe("2.5%");
    expect(r.preTax).toBe(D(r.rows[0].amount).plus(r.rows[1].amount).plus(r.rows[2].amount).plus(r.rows[3].amount).toFixed(2));
    expect(r.grandTotal).toBe(D(r.preTax).plus(r.rows[5].amount).toFixed(2));
  });
});

describe("事实值归一化", () => {
  it("parseRateValue 兼容 9% / 9 / 0.09", () => {
    expect(parseRateValue("9%")).toBe(0.09);
    expect(parseRateValue("9")).toBe(0.09);
    expect(parseRateValue("0.09")).toBe(0.09);
    expect(parseRateValue("abc")).toBeNull();
    expect(parseRateValue(null)).toBeNull();
    expect(parseRateValue("0.5%")).toBe(0.005);
    expect(parseRateValue("1％")).toBe(0.01);
    expect(parseRateValue("   ")).toBeNull();
  });
  it("parseAmountValue 兼容 万/元/千分位", () => {
    expect(parseAmountValue("50万")).toBe(500000);
    expect(parseAmountValue("5,000元")).toBe(5000);
    expect(parseAmountValue("abc")).toBeNull();
  });
});
