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
});
