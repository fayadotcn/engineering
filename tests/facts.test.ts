import { describe, expect, it } from "vitest";
import { parseRateValue, parseAmountValue, parseAreaValue, validatePricingFact } from "../project/facts";

describe("台账事实数值归一化", () => {
  it("parseRateValue：9% / 9 / 0.09 都归一为 0.09", () => {
    expect(parseRateValue("9%")).toBeCloseTo(0.09);
    expect(parseRateValue("9")).toBeCloseTo(0.09);
    expect(parseRateValue("0.09")).toBeCloseTo(0.09);
    expect(parseRateValue("")).toBeNull();
    expect(parseRateValue("abc")).toBeNull();
  });

  it("parseAmountValue：万/亿/元", () => {
    expect(parseAmountValue("50万")).toBe(500000);
    expect(parseAmountValue("1.2亿")).toBe(120000000);
    expect(parseAmountValue("5,000元")).toBe(5000);
    expect(parseAmountValue("-1.5万")).toBe(-15000);
    expect(parseAmountValue("-2亿")).toBe(-200000000);
    expect(parseAmountValue("abc")).toBeNull();
  });

  it("parseAreaValue：㎡/万平米", () => {
    expect(parseAreaValue("12000㎡")).toBe(12000);
    expect(parseAreaValue("1.2万平米")).toBe(12000);
  });

  it("validatePricingFact：费率越界拒绝，价格期接受季度/年月写法", () => {
    expect(() => validatePricingFact("税率", "120%")).toThrow();
    expect(() => validatePricingFact("税率", "9%")).not.toThrow();
    expect(() => validatePricingFact("价格期", "2024-06")).not.toThrow();
    expect(() => validatePricingFact("价格期", "2024年6月")).not.toThrow();
    expect(() => validatePricingFact("价格期", "2024-Q2")).not.toThrow();
    expect(() => validatePricingFact("价格期", "下期")).toThrow();
    expect(() => validatePricingFact("暂列金额", "50万")).not.toThrow();
    expect(() => validatePricingFact("暂列金额", "-5")).toThrow();
    // 高度类事实允许 m/米 后缀（消费端剥单位取数），拒绝非数字
    expect(() => validatePricingFact("檐口高度", "25米")).not.toThrow();
    expect(() => validatePricingFact("檐口高度", "25m")).not.toThrow();
    expect(() => validatePricingFact("操作物高度", "三层")).toThrow();
    expect(() => validatePricingFact("檐口高度", "-5")).toThrow();
  });
});
