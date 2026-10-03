import { describe, expect, it, vi } from "vitest";

// buildCompareReport 的对审配对逻辑：单侧指定文件撞车时应自动换对侧，
// 不该报「文件选择无效」（R96 回归）。

vi.mock("@database/client", () => ({
  prisma: {
    projectFile: {
      findMany: vi.fn(async () => [
        { id: "fA", filename: "送审版.xlsx", stage: "报审", period: "", createdAt: new Date("2024-01-01"), projectId: "p", kind: "BOQ_TENDER", status: "PARSED" },
        { id: "fB", filename: "审定版.xlsx", stage: "审定", period: "", createdAt: new Date("2024-02-01"), projectId: "p", kind: "BOQ_TENDER", status: "PARSED" },
      ]),
    },
  },
}));
vi.mock("@boq/service", () => ({ listBoq: vi.fn(async () => []) }));
vi.mock("@project/facts", () => ({ getFact: vi.fn(async () => null) }));

describe("buildCompareReport", () => {
  it("单侧指定 a= 撞车自动配对时自动换 B", async () => {
    const { buildCompareReport } = await import("@file/compareReport");
    const r = await buildCompareReport("p", { fileAId: "fB" });
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.fileBName).toBe("送审版.xlsx");
      expect(r.fileAName).toBe("审定版.xlsx");
    }
  });

  it("双侧指定同一文件仍报错", async () => {
    const { buildCompareReport } = await import("@file/compareReport");
    const r = await buildCompareReport("p", { fileAId: "fA", fileBId: "fA" });
    expect("error" in r).toBe(true);
  });

  it("双侧显式指定正常配对", async () => {
    const { buildCompareReport } = await import("@file/compareReport");
    const r = await buildCompareReport("p", { fileAId: "fB", fileBId: "fA" });
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.fileAName).toBe("审定版.xlsx");
      expect(r.fileBName).toBe("送审版.xlsx");
    }
  });
});
