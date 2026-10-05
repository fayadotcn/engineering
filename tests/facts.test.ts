import { describe, expect, it, vi } from "vitest";
import { parseRateValue, parseCoefficientValue, parseAmountValue, parseAreaValue, validatePricingFact, setFact } from "../project/facts";

// setFact 封顶测试：mock costFact 表，验证超过 300 条时剪掉最旧行
const db = vi.hoisted(() => ({ rows: [] as { id: string; projectId: string; createdAt: Date }[], seq: 0 }));
vi.mock("@database/client", () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      costFact: {
        create: vi.fn(async ({ data }: { data: { projectId: string } }) => {
          const r = { id: `f${++db.seq}`, ...data, createdAt: new Date(db.seq) };
          db.rows.push(r as never);
          return r;
        }),
        findMany: vi.fn(async (q: { where: { projectId: string }; skip?: number; select?: unknown }) => {
          const rows = db.rows.filter((r) => r.projectId === q.where.projectId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (b.id < a.id ? -1 : 1));
          return (q.skip ? rows.slice(q.skip) : rows).map((r) => ({ id: r.id }));
        }),
        deleteMany: vi.fn(async (q: { where: { id: { in: string[] } } }) => {
          const gone = new Set(q.where.id.in);
          db.rows = db.rows.filter((r) => !gone.has(r.id));
          return { count: gone.size };
        }),
      },
    }),
    costFact: {},
  },
}));
vi.mock("@database/serialize", () => ({ toFactDTO: (r: unknown) => r }));

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

  // 回归钉：人工费调整系数是「调增倍数」，不是 0–100% 费率。
  // 历史坑：「人工费参考国内×4」被写成系数 4 → 按费率解析成 4%，
  // 626,369 元的调差只计了 8,351 元（差 75 倍），报价直接失真。
  it("parseCoefficientValue：裸数字是倍数，带 % 才是百分数", () => {
    expect(parseCoefficientValue("3")).toBe(3);      // 调增 300% = 人工费 4 倍
    expect(parseCoefficientValue("3倍")).toBe(3);
    expect(parseCoefficientValue("×3")).toBe(3);
    expect(parseCoefficientValue("3x")).toBe(3);
    expect(parseCoefficientValue("300%")).toBe(3);
    expect(parseCoefficientValue("0.15")).toBeCloseTo(0.15);
    expect(parseCoefficientValue("15%")).toBeCloseTo(0.15);
    expect(parseCoefficientValue("1")).toBe(1);
    expect(parseCoefficientValue("")).toBeNull();
    expect(parseCoefficientValue("abc")).toBeNull();
    // 同一串文本在两个解析器下的语义差异就是本次修复的核心
    expect(parseRateValue("3")).toBeCloseTo(0.03);
    expect(parseCoefficientValue("3")).toBe(3);
  });

  it("validatePricingFact：调整系数允许倍数（>1），仍拒负数/离谱值/非数字", () => {
    expect(() => validatePricingFact("人工费调整系数", "3")).not.toThrow();
    expect(() => validatePricingFact("人工费调整系数", "300%")).not.toThrow();
    expect(() => validatePricingFact("人工费调整系数", "0.15")).not.toThrow();
    expect(() => validatePricingFact("人工费调整系数", "-1")).toThrow();
    expect(() => validatePricingFact("人工费调整系数", "11")).toThrow(); // 1100% 明显是误填
    expect(() => validatePricingFact("人工费调整系数", "abc")).toThrow();
  });
});

describe("setFact 台账历史封顶", () => {
  it("超过 300 条时剪掉最旧行，最新行保留", async () => {
    db.rows = Array.from({ length: 299 }, (_, i) => ({ id: `old${i}`, projectId: "p1", createdAt: new Date(i) }));
    db.seq = 999;
    await setFact("p1", { factType: "RATE", key: "税率", value: "9%", source: "USER_PROVIDED" });
    expect(db.rows.length).toBe(300); // 299 + 新行 = 300，未越界
    await setFact("p1", { factType: "RATE", key: "税率", value: "10%", source: "USER_PROVIDED" });
    expect(db.rows.length).toBe(300); // 301 → 剪掉最旧的 1 条
    expect(db.rows.some((r) => r.id === "old0")).toBe(false); // 最旧被剪
    expect(db.rows.some((r) => r.id === `f${db.seq}`)).toBe(true); // 最新保留
  });
});
