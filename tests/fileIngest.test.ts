import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SheetMeta } from "@file/inspection";

const state = vi.hoisted(() => ({
  file: { id: "f1", projectId: "p1", filename: "工程清单.xlsx", storageKey: "s", mime: "excel" },
  mapping: {} as Record<string, SheetMeta>,
  tx: { identity: "import transaction" },
}));
vi.mock("@database/client", () => ({
  prisma: {
    projectFile: { findUnique: vi.fn(async () => state.file), update: vi.fn() },
    costFact: { deleteMany: vi.fn() },
    $transaction: vi.fn(async (fn) => fn(state.tx)),
  },
}));
vi.mock("@file/inspection", () => ({
  ensureInspection: vi.fn(async () => ({ file: state.file, mapping: state.mapping, isPdf: false })),
  toSheetMappings: vi.fn((m) => m),
  mergeFileMeta: vi.fn(async (_id, update) => update({ mapping: state.mapping })),
  SHEET_TYPE_LABEL: { BOQ: "工程清单" },
}));
vi.mock("@file/storage", () => ({ storage: { get: vi.fn(async () => Buffer.from("workbook")) } }));
vi.mock("@file/excel", () => ({ parseWorkbook: vi.fn(() => []), colLetter: (n: number) => String.fromCharCode(65 + n) }));
vi.mock("@file/classify", () => ({ classifyFile: () => ({ kind: "BOQ_TENDER", confidence: 1 }) }));
vi.mock("@boq/service", () => ({
  deleteByFile: vi.fn(),
  importBoqFromSheets: vi.fn(async () => ({ count: 2, headers: 0, nonNumericQty: 0, derivedUnitPrice: 0, arithMismatch: 0, laborPriceCol: false })),
}));
vi.mock("@material/service", () => ({ importQuotationsFromSheets: vi.fn(async () => 0) }));
vi.mock("@project/facts", () => ({ setFact: vi.fn() }));

import { prisma } from "@database/client";
import { ensureInspection, mergeFileMeta } from "@file/inspection";
import { storage } from "@file/storage";
import { parseWorkbook } from "@file/excel";
import { deleteByFile, importBoqFromSheets } from "@boq/service";
import { importQuotationsFromSheets } from "@material/service";
import { inspectProjectFile, describeFileImport, ingestProjectFile } from "@file/ingest";

const sheet = (patch: Partial<SheetMeta> = {}): SheetMeta => ({
  sheetName: "清单", type: "BOQ", columns: { name: 0, quantity: 1 },
  confidence: { name: 0.8, quantity: 0.95 }, evidence: {}, minConfidence: 0.8,
  typeConfidence: 1, typeEvidence: "清单", needsConfirm: false, templateHit: false,
  userEdited: false, itemsToImport: 2, fingerprint: "", headerCells: [],
  ...patch,
} as SheetMeta);

beforeEach(() => {
  vi.clearAllMocks();
  state.file.projectId = "p1";
  state.mapping = {};
});

describe("项目文件接入服务", () => {
  it.each([inspectProjectFile, describeFileImport, ingestProjectFile])("跨项目文件在识别/缓存/存储读取前被拒绝", async (operation) => {
    state.file.projectId = "other";
    await expect(operation("p1", "f1")).rejects.toThrow("文件不存在");
    expect(ensureInspection).not.toHaveBeenCalled();
    expect(storage.get).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("模板命中但识别冲突仍要求确认；明确映射自动放行", async () => {
    state.mapping = { 清单: sheet({ templateHit: true, needsConfirm: true }) };
    expect(await describeFileImport("p1", "f1")).toContain("将按识别出的列映射导入");
    state.mapping = { 清单: sheet({ userEdited: true, minConfidence: 0.95 }) };
    expect(await describeFileImport("p1", "f1")).toBeNull();
  });

  it("确认文案指出 0 行，不静默忽略有数据的工作表", async () => {
    state.mapping = { 清单: sheet({ itemsToImport: 0 }) };
    expect(await describeFileImport("p1", "f1")).toContain("将导入 0 行");
    expect(state.mapping.清单.needsConfirm).toBe(true);
  });

  it("批准后的导入重新读取当前映射；删除和两类导入共用事务", async () => {
    state.mapping = { 清单: sheet() };
    await describeFileImport("p1", "f1");
    state.mapping.清单.columns.name = 3;
    const result = await ingestProjectFile("p1", "f1");
    expect(parseWorkbook).toHaveBeenCalledWith(expect.any(Buffer), { mapping: state.mapping });
    expect(deleteByFile).toHaveBeenCalledWith("f1", state.tx);
    expect(importBoqFromSheets).toHaveBeenCalledWith("p1", "f1", [], state.tx);
    expect(importQuotationsFromSheets).toHaveBeenCalledWith("p1", "f1", [], state.tx);
    expect(result.imported).toBe(2);
    expect(result).not.toHaveProperty("views");
    expect(result).not.toHaveProperty("receipts");
  });

  it("新行写入失败向上传播，文件元数据与事实不被标记为导入完成", async () => {
    vi.mocked(importBoqFromSheets).mockRejectedValueOnce(new Error("写入失败"));
    await expect(ingestProjectFile("p1", "f1")).rejects.toThrow("写入失败");
    expect(deleteByFile).toHaveBeenCalledWith("f1", state.tx);
    expect(mergeFileMeta).not.toHaveBeenCalled();
    expect(prisma.costFact.deleteMany).not.toHaveBeenCalled();
  });
});
