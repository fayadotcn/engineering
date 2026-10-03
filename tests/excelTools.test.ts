import { describe, expect, it, vi } from "vitest";
import { parseSemanticFeature } from "@cost-engine/semantic";
import type { BoqItemDTO } from "@shared/types";

// excelTools 工具级测试：mock prisma/storage/导出底层，验证
// 归属校验、格式门槛、映射优先级、回执与视图产出。

const db = vi.hoisted(() => ({
  files: [] as {
    id: string; projectId: string; filename: string; kind: string;
    status: string; meta: string; storageKey: string; createdAt: Date;
  }[],
  items: [] as BoqItemDTO[],
  writeBackArgs: null as { patches: unknown[]; colMaps: Record<string, Record<string, number>> } | null,
}));

vi.mock("@database/client", () => ({
  prisma: {
    projectFile: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => db.files.find((f) => f.id === where.id) ?? null),
      findFirst: vi.fn(async () => db.files.filter((f) => f.status === "PARSED" && f.filename.endsWith(".xlsx")).at(-1) ?? null),
    },
    artifact: { create: vi.fn(async ({ data }: { data: { label: string } }) => ({ id: `art-${data.label}`, label: data.label })) },
  },
}));
vi.mock("@boq/service", () => ({ listBoq: vi.fn(async () => db.items) }));
vi.mock("@boq/export", () => ({ assembleExportSheets: vi.fn(async () => null) }));
vi.mock("@file/storage", () => ({
  storage: { put: vi.fn(async () => "k/x.xlsx"), get: vi.fn(async () => Buffer.from("src")) },
}));
vi.mock("@file/excel", () => ({
  writeBackPrices: vi.fn(async (_buf: Buffer, patches: unknown[], colMaps: Record<string, Record<string, number>>) => {
    db.writeBackArgs = { patches, colMaps };
    return Buffer.from("out");
  }),
  buildExportWorkbook: vi.fn(async () => Buffer.from("wb")),
}));
vi.mock("@file/inspection", () => ({
  ensureInspection: vi.fn(async (fileId: string) => ({
    file: db.files.find((f) => f.id === fileId),
    mapping: { sheets: [] },
    isPdf: false,
  })),
  mappingToView: vi.fn(() => ({ kind: "columnMapping", id: "v", sheets: [{ sheetName: "s1", type: "BOQ", columns: [] }] })),
}));

import "../agent/tools/excelTools";
import { getTool } from "../agent/tools/registry";

const ctx = { projectId: "p1", runId: "r1", userId: "u", emit: vi.fn() };
const call = (tool: string, args: unknown = {}) =>
  getTool(tool)!.handler!(ctx as never, args as never) as Promise<{
    observation: Record<string, unknown>;
    views?: { kind: string; summary?: string }[];
    receipts?: { actionType: string; reversible: boolean }[];
    message?: string;
  }>;

let n = 0;
const boq = (fileId: string): BoqItemDTO => ({
  id: `b${++n}`, projectId: "p1", fileId, sheetName: "s1", rowIndex: 5,
  code: "", name: "镀锌钢管", rawFeature: "DN100", unit: "m", quantity: "10", unitPrice: "85",
  mainMaterialPrice: "0", laborUnitPrice: "0", machineUnitPrice: "0", pricingPlan: [],
  feeType: "分部分项", totalPrice: "850", sectionPath: "", isHeader: false,
  sortOrder: n, discipline: "OTHER", features: parseSemanticFeature("镀锌钢管", "DN100"),
});
const file = (id: string, filename: string, projectId = "p1", meta = "{}") => ({
  id, projectId, filename, kind: "BOQ", status: "PARSED", meta, storageKey: `k/${filename}`, createdAt: new Date(),
});

describe("excel.read", () => {
  it("跨项目文件抛错", async () => {
    db.files = [file("f1", "a.xlsx", "OTHER_PROJECT")];
    await expect(call("excel.read", { fileId: "f1" })).rejects.toThrow("文件不存在");
  });
  it("本项目的文件返回 meta", async () => {
    db.files = [file("f1", "a.xlsx", "p1", '{"sheets":[1]}')];
    const r = await call("excel.read", { fileId: "f1" });
    expect(r.observation.filename).toBe("a.xlsx");
    expect(r.observation.sheets).toEqual([1]);
  });
});

describe("excel.write 写回源文件", () => {
  it("非 xlsx 源文件拒绝（保住源格式红线）", async () => {
    db.files = [file("f1", "清单.xls")];
    await expect(call("excel.write", { fileId: "f1" })).rejects.toThrow(".xlsx");
  });
  it("源文件没有清单项时拒绝", async () => {
    db.files = [file("f1", "a.xlsx")];
    db.items = [];
    await expect(call("excel.write", { fileId: "f1" })).rejects.toThrow("没有已导入的清单项");
  });
  it("列映射优先取 meta.mapping，回执标记 EXPORT/不可逆", async () => {
    db.files = [file("f1", "a.xlsx", "p1", JSON.stringify({
      sheets: [{ name: "s1", columns: ["code:1", "unitPrice:9"] }],
      mapping: { s1: { columns: { code: 0, unitPrice: 6 } } },
    }))];
    db.items = [boq("f1")];
    const r = await call("excel.write", { fileId: "f1" });
    expect(db.writeBackArgs!.colMaps.s1.unitPrice).toBe(6); // meta.mapping 覆盖 meta.sheets
    expect(db.writeBackArgs!.patches.length).toBe(1);
    expect(r.views?.[0].kind).toBe("exportResult");
    expect(r.receipts?.[0]).toMatchObject({ actionType: "EXPORT", reversible: false });
  });
});
