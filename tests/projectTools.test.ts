import { describe, expect, it, vi } from "vitest";

// projectTools 工具级测试：file.search 中文类型标签命中 + 项目归属约束。

const db = vi.hoisted(() => ({
  lastWhere: null as Record<string, unknown> | null,
  files: [] as { id: string; filename: string; kind: string; projectId: string }[],
}));

vi.mock("@database/client", () => ({
  prisma: {
    projectFile: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        db.lastWhere = where;
        const or = (where.OR as { filename?: { contains: string }; kind?: unknown }[]) ?? [];
        return db.files.filter((f) =>
          or.some((c) => {
            if (c.filename?.contains && f.filename.includes(c.filename.contains)) return true;
            const k = c.kind as { contains?: string; in?: string[] } | undefined;
            if (k?.in) return k.in.includes(f.kind);
            if (k?.contains) return f.kind.includes(k.contains);
            return false;
          })
        );
      }),
      findUnique: vi.fn(async () => null),
    },
    project: { findUnique: vi.fn(async () => null) },
    actionReceipt: { findMany: vi.fn(async () => []) },
    agentRun: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("@boq/service", () => ({ listBoq: vi.fn(async () => []), importBoqFromSheets: vi.fn(), deleteByFile: vi.fn() }));
vi.mock("@material/service", () => ({ listQuotations: vi.fn(async () => []), importQuotationsFromSheets: vi.fn() }));
vi.mock("@project/facts", () => ({ getFacts: vi.fn(async () => []), setFact: vi.fn(async (_p: string, f: { key: string; value: string }) => f) }));
vi.mock("@file/storage", () => ({ storage: { get: vi.fn(), put: vi.fn() } }));
vi.mock("@file/inspection", () => ({ ensureInspection: vi.fn(), mappingToView: vi.fn(), toSheetMappings: vi.fn(), SHEET_TYPE_LABEL: {} }));

import "../agent/tools/projectTools";
import { getTool } from "../agent/tools/registry";

const ctx = { projectId: "p1", runId: "r1", userId: "u", emit: vi.fn() };

describe("file.search", () => {
  it("中文「询价」命中 MATERIAL_QUOTATION 类文件", async () => {
    db.files = [
      { id: "a", filename: "电线电缆报价.xlsx", kind: "MATERIAL_QUOTATION", projectId: "p1" },
      { id: "b", filename: "分部分项清单.xlsx", kind: "BOQ_TENDER", projectId: "p1" },
    ];
    const r = (await getTool("file.search")!.handler!(ctx as never, { query: "询价" } as never)) as { observation: { id: string }[] };
    const or = db.lastWhere!.OR as { kind?: { in?: string[] } | { contains: string } }[];
    expect(or.some((c) => (c.kind as { in?: string[] } | undefined)?.in?.includes("MATERIAL_QUOTATION"))).toBe(true);
    expect(r.observation.map((f) => f.id)).toEqual(["a"]);
  });
  it("搜索限定在当前项目", async () => {
    db.files = [{ id: "x", filename: "询价单.xlsx", kind: "MATERIAL_QUOTATION", projectId: "p1" }];
    await getTool("file.search")!.handler!(ctx as never, { query: "询价" } as never);
    expect(db.lastWhere!.projectId).toBe("p1");
  });
});
