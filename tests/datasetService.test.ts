import { describe, expect, it, vi, beforeEach } from "vitest";
import ExcelJS from "exceljs";

// R229 回归：数据集服务层的两条真实缺陷
// ① createDataset 先 put 存储再建档——建档失败时存储块成孤儿（项目文件上传已回收）
// ② ingestDataset/getDatasetMapping 用入口快照整写 meta——ingest/识别期间的
//   并发 mapping PATCH 被静默覆盖（与文件 PATCH /mapping 的读-改-写竞态同类）

const state = vi.hoisted(() => ({
  entryMeta: "",
  mergeMeta: "", // mergeDatasetMeta 事务内 fresh 读到的 meta（模拟并发 PATCH 后的库内态）
  writtenMeta: "",
  writtenData: {} as Record<string, unknown>,
  deletedKeys: [] as string[],
  createShouldFail: false,
  ds: {
    id: "d1",
    kind: "MATERIAL_PRICE",
    filename: "报价.xlsx",
    storageKey: "k1",
    meta: "",
    rowCount: 0,
    status: "PENDING",
  },
}));

vi.mock("@database/client", () => {
  const dataset = {
    findUnique: vi.fn(async (args: { select?: { meta?: boolean } }) =>
      args?.select?.meta
        ? { meta: state.mergeMeta }
        : { ...state.ds, meta: state.entryMeta }
    ),
    findFirst: vi.fn(async () => null),
    create: vi.fn(async () => {
      if (state.createShouldFail) throw new Error("db down");
      return { ...state.ds, id: "new-ds", createdAt: new Date() };
    }),
    update: vi.fn(async (args: { data: { meta?: string } & Record<string, unknown> }) => {
      state.writtenMeta = args.data.meta ?? "";
      state.writtenData = args.data;
      return state.ds;
    }),
    delete: vi.fn(async () => ({})),
  };
  const prisma = {
    dataset,
    projectFile: {
      findUnique: vi.fn(async (args: { select?: { meta?: boolean } }) =>
        args?.select?.meta ? { meta: state.mergeMeta } : null
      ),
      update: vi.fn(async (args: { data: { meta?: string } & Record<string, unknown> }) => {
        state.writtenMeta = args.data.meta ?? "";
        state.writtenData = args.data;
        return {};
      }),
    },
    materialPrice: {
      deleteMany: vi.fn(async () => ({})),
      createMany: vi.fn(async () => ({ count: 1 })),
    },
    importTemplate: {
      updateMany: vi.fn(async () => ({})),
      upsert: vi.fn(async () => ({})),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma)),
  };
  return { prisma };
});

const wbBuf = vi.hoisted(() => ({ buf: null as Buffer | null }));
vi.mock("@file/storage", () => ({
  storage: {
    put: vi.fn(async () => "k-orphan"),
    get: vi.fn(async () => wbBuf.buf!),
    delete: vi.fn(async (key: string) => {
      state.deletedKeys.push(key);
    }),
  },
}));

import { createDataset, ingestDataset } from "../dataset/service";
import { mergeFileMeta } from "../file/inspection";

const sheetMeta = {
  sheetName: "报价",
  type: "QUOTATION",
  headerRow: 0,
  merged: false,
  columns: { name: 0, spec: 1, unit: 2, price: 3 },
  headerCells: ["材料名称", "规格型号", "单位", "单价"],
  sample: [],
  colCount: 4,
  rowCount: 1,
  confidence: {},
  evidence: {},
  fingerprint: null,
  templateHit: false,
  minConfidence: 1,
  typeConfidence: 1,
  typeEvidence: "人工指定",
  userEdited: false,
  needsConfirm: false,
};

beforeEach(async () => {
  state.entryMeta = "";
  state.mergeMeta = "";
  state.writtenMeta = "";
  state.writtenData = {};
  state.deletedKeys = [];
  state.createShouldFail = false;
  const w = new ExcelJS.Workbook();
  const s = w.addWorksheet("报价");
  s.addRow(["材料名称", "规格型号", "单位", "单价"]);
  s.addRow(["电力电缆", "YJV-4x25", "m", 12.5]);
  wbBuf.buf = Buffer.from(await w.xlsx.writeBuffer());
});

describe("createDataset 孤儿存储回收", () => {
  it("建档失败时回收已上传的存储块", async () => {
    state.createShouldFail = true;
    await expect(
      createDataset("GENERIC", "a.xlsx", Buffer.from("x"))
    ).rejects.toThrow("db down");
    expect(state.deletedKeys).toEqual(["k-orphan"]);
  });
});

describe("ingestDataset meta 合并写", () => {
  it("ingest 期间的并发 mapping PATCH 不被整写覆盖", async () => {
    // 入口快照：原始识别结果
    state.entryMeta = JSON.stringify({
      mapping: { 报价: { ...sheetMeta } },
      defaults: {},
    });
    // 并发 PATCH 后的库内态：管理员改了列映射 + 加了默认值
    state.mergeMeta = JSON.stringify({
      mapping: {
        报价: { ...sheetMeta, userEdited: true, columns: { name: 0, spec: 1, unit: 2, price: 3 } },
      },
      defaults: { region: "四川" },
      note: "patched-note",
    });
    const r = await ingestDataset("d1");
    expect(r?.status).toBe("PARSED");
    expect(r?.rowCount).toBe(1);
    const written = JSON.parse(state.writtenMeta);
    // PATCH 的改动还在（defaults.region / userEdited），没有被入口快照覆盖
    expect(written.defaults.region).toBe("四川");
    expect(written.mapping["报价"].userEdited).toBe(true);
    // ingest 自己的产出也合上去了
    expect(written.sheets).toBeDefined();
    expect(state.writtenData.status).toBe("PARSED");
  });
});

describe("mergeFileMeta 文件侧同口径", () => {
  it("在事务内 fresh meta 上打补丁，不丢并发改动", async () => {
    state.mergeMeta = JSON.stringify({
      mapping: { 清单: { needsConfirm: true, userEdited: true } },
      note: "并发写入",
    });
    await mergeFileMeta("f1", (m) => {
      if (m.mapping?.["清单"]) m.mapping["清单"].needsConfirm = false;
    }, { kind: "BOQ", status: "PARSED" });
    const written = JSON.parse(state.writtenMeta);
    expect(written.note).toBe("并发写入");
    expect(written.mapping["清单"].userEdited).toBe(true);
    expect(written.mapping["清单"].needsConfirm).toBe(false);
    expect(state.writtenData.kind).toBe("BOQ");
  });
});
