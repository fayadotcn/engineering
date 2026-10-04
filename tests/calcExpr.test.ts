import { describe, expect, it } from "vitest";
import { evalExpr } from "@cost-engine/calcExpr";

describe("evalExpr", () => {
  it("evaluates basic arithmetic", () => {
    expect(evalExpr("3*12+15")).toBe(51);
    expect(evalExpr("12.5*(2+3)")).toBe(62.5);
    expect(evalExpr("100/4")).toBe(25);
  });
  it("handles Chinese operators and unit words", () => {
    expect(evalExpr("3层×12个+15米")).toBe(51);
    expect(evalExpr("（2+3）×4")).toBe(20);
  });
  it("handles percent and negatives", () => {
    expect(evalExpr("200*5%")).toBe(10);
    expect(evalExpr("-5+10")).toBe(5);
  });
  it("rejects invalid input", () => {
    expect(() => evalExpr("abc")).toThrow();
    expect(() => evalExpr("1/0")).toThrow();
    expect(() => evalExpr("")).toThrow();
  });
  it("rejects malformed numbers instead of silent truncation", () => {
    expect(() => evalExpr("1.2.3")).toThrow();
    expect(() => evalExpr("3.5.2+1")).toThrow();
    expect(() => evalExpr(".")).toThrow();
    expect(evalExpr("1.5+2")).toBe(3.5);
  });
  it("深括号嵌套抛明确错误而非栈溢出", () => {
    expect(() => evalExpr("(".repeat(500) + "1" + ")".repeat(500))).toThrow("嵌套过深");
    expect(evalExpr("((2+3)×4)")).toBe(20);
  });
  it("数字间的 x 视为乘号（3x12=36），不被当字母剥掉拼数", () => {
    expect(evalExpr("3x12")).toBe(36);
    expect(evalExpr("4X35")).toBe(140);
    expect(evalExpr("3 x 12")).toBe(36);
  });
  it("科学计数法 e 不被当单位字母剥掉", () => {
    expect(evalExpr("1e3")).toBe(1000);
    expect(evalExpr("2.5e3")).toBe(2500);
    expect(evalExpr("1e-3")).toBe(0.001);
    expect(evalExpr("2e+2*3")).toBe(600);
  });
  it("数字间夹文字缺运算符报错而非静默拼数", () => {
    expect(() => evalExpr("3米2米")).toThrow("缺运算符");
    expect(() => evalExpr("12abc34")).toThrow("缺运算符");
    expect(() => evalExpr("3m2")).toThrow("缺运算符");
    // 行尾/行首单位词仍是合法用法
    expect(evalExpr("15米")).toBe(15);
    expect(evalExpr("（3+5）米×2")).toBe(16);
  });
  it("超长与畸形输入快速失败", () => {
    expect(() => evalExpr("a".repeat(5000))).toThrow();
    expect(evalExpr("1+".repeat(2000) + "1")).toBe(2001);
    expect(() => evalExpr(" ".repeat(1000))).toThrow();
  });
});
