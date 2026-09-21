import { describe, expect, it } from "vitest";
import { D } from "../cost-engine/money";
import { feeSummary } from "../cost-engine/fees";
import { parseRateValue, parseAmountValue } from "../project/facts";
import type { BoqItemDTO } from "../shared/types";

const item = (totalPrice: string, unitPrice = "1"): BoqItemDTO =>
  ({
    id: Math.random().toString(36).slice(2),
    isHeader: false,
    name: "镀锌钢管",
    unitPrice,
    totalPrice,
    quantity: "10",
    features: {},
  }) as BoqItemDTO;

const params = (o: Partial<Parameters<typeof feeSummary>[1]> = {}) => ({
  measureRate: D(0), regulationRate: D(0), provisionalRate: D(0),
  provisionalAmount: D(0), taxRate: D(0.09),
  set: { measure: false, regulation: false, provisional: false, tax: false },
  ...o,
});

describe("feeSummary 取费汇总", () => {
  it("默认口径：仅分部分项 + 9% 增值税", () => {
    const r = feeSummary([item("10000"), item("20000")], params());
    expect(r.rows.find((x) => x.seq === "一")?.amount).toBe("30000.00");
    expect(r.rows.find((x) => x.seq === "五")?.amount).toBe("30000.00");
    expect(r.rows.find((x) => x.seq === "六")?.amount).toBe("2700.00");
    expect(r.grandTotal).toBe("32700.00");
  });

  it("全费率口径：措施3% + 暂列5% + 规费2% + 税9%", () => {
    const r = feeSummary(
      [item("100000")],
      params({
        measureRate: D(0.03), regulationRate: D(0.02), provisionalRate: D(0.05),
        set: { measure: true, regulation: true, provisional: true, tax: true },
      })
    );
    // 100000 → +3000 +5000 +2000 = 110000 税前 → +9900 税 = 119900
    expect(r.preTax).toBe("110000.00");
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
});

describe("事实值归一化", () => {
  it("parseRateValue 兼容 9% / 9 / 0.09", () => {
    expect(parseRateValue("9%")).toBe(0.09);
    expect(parseRateValue("9")).toBe(0.09);
    expect(parseRateValue("0.09")).toBe(0.09);
    expect(parseRateValue("abc")).toBeNull();
    expect(parseRateValue(null)).toBeNull();
  });
  it("parseAmountValue 兼容 万/元/千分位", () => {
    expect(parseAmountValue("50万")).toBe(500000);
    expect(parseAmountValue("5,000元")).toBe(5000);
    expect(parseAmountValue("abc")).toBeNull();
  });
});
