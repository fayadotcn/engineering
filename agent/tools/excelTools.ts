import { z } from "zod";
import { prisma } from "@database/client";
import { registerTool } from "./registry";
import { listBoq } from "@boq/service";
import { storage } from "@file/storage";
import { parseWorkbook, writeBackPrices, buildExportWorkbook, type ColumnMap, type CellPatch } from "@file/excel";
import { fromJson } from "@shared/json";
import { D } from "@cost-engine/money";

registerTool({
  name: "excel.read",
  description: "读取某个 Excel 文件的结构（sheet、表头、列映射、行数）",
  implemented: true,
  schema: z.object({ fileId: z.string() }),
  handler: async (ctx, args: { fileId: string }) => {
    const file = await prisma.projectFile.findUnique({ where: { id: args.fileId } });
    if (!file || file.projectId !== ctx.projectId) throw new Error("文件不存在");
    const meta = fromJson<{ sheets?: unknown[] }>(file.meta, {});
    return { observation: { filename: file.filename, kind: file.kind, ...(meta as object) } };
  },
});

registerTool({
  name: "excel.mapColumns",
  description: "查看/返回某个 sheet 的列映射（哪一列是编码/名称/特征/单位/工程量/单价/合价）",
  implemented: true,
  schema: z.object({ fileId: z.string(), sheetName: z.string().optional() }),
  handler: async (ctx, args: { fileId: string; sheetName?: string }) => {
    const file = await prisma.projectFile.findUnique({ where: { id: args.fileId } });
    if (!file) throw new Error("文件不存在");
    const meta = fromJson<{ sheets?: { name: string; columns: string[] }[] }>(file.meta, {});
    const sheets = meta.sheets ?? [];
    return {
      observation: args.sheetName
        ? sheets.find((s) => s.name === args.sheetName) ?? sheets[0]
        : sheets,
    };
  },
});

async function saveArtifact(
  ctx: { projectId: string; runId: string },
  buffer: Buffer,
  label: string
) {
  const storageKey = await storage.put(buffer, ".xlsx");
  const artifact = await prisma.artifact.create({
    data: {
      projectId: ctx.projectId,
      kind: "EXPORT_EXCEL",
      label,
      storageKey,
      createdByRunId: ctx.runId,
    },
  });
  return artifact;
}

registerTool({
  name: "excel.write",
  description: "将当前清单的单价/合价写回原始 Excel 文件（保留原格式），生成可下载的新文件",
  implemented: true,
  schema: z.object({
    fileId: z.string().optional().describe("写回到该源文件；缺省取最近导入的清单文件"),
  }),
  handler: async (ctx, args: { fileId?: string }) => {
    const file = args.fileId
      ? await prisma.projectFile.findUnique({ where: { id: args.fileId } })
      : await prisma.projectFile.findFirst({
          where: { projectId: ctx.projectId, kind: { startsWith: "BOQ" } },
          orderBy: { createdAt: "desc" },
        });
    if (!file) return { observation: { error: "没有可写回的清单源文件" } };

    const items = await listBoq(ctx.projectId);
    const mine = items.filter((i) => i.fileId === file.id && !i.isHeader);
    const meta = fromJson<{
      sheets?: { name: string; columns: string[] }[];
    }>(file.meta, {});
    // rebuild ColumnMap from stored "key:idx(1-based)" entries
    const colMaps: Record<string, ColumnMap> = {};
    for (const s of meta.sheets ?? []) {
      const m: ColumnMap = {};
      for (const c of s.columns) {
        const [k, v] = c.split(":");
        m[k] = Number(v) - 1;
      }
      colMaps[s.name] = m;
    }
    const patches: CellPatch[] = mine.map((i) => ({
      sheetName: i.sheetName,
      rowIndex: i.rowIndex,
      unitPrice: i.unitPrice,
      quantity: i.quantity,
      totalPrice: i.totalPrice,
    }));
    const original = await storage.get(file.storageKey);
    const out = await writeBackPrices(original, patches, colMaps);
    const artifact = await saveArtifact(ctx, out, `${file.filename.replace(/\.xlsx?$/i, "")}_已更新.xlsx`);
    return {
      observation: { artifactId: artifact.id, writtenRows: patches.length },
      views: [
        {
          kind: "exportResult",
          id: `view:export:${artifact.id}`,
          title: "已写回源文件",
          artifactId: artifact.id,
          filename: artifact.label,
          summary: `已将 ${patches.length} 行单价/工程量/合价写回「${file.filename}」`,
        },
      ],
      receipts: [
        {
          actionType: "EXPORT",
          summary: `写回源文件：${file.filename}（${patches.length} 行）`,
          before: {},
          after: { artifactId: artifact.id, label: artifact.label },
          reversible: false,
        },
      ],
      message: `已把最新价格写回源文件，生成「${artifact.label}」`,
    };
  },
});

registerTool({
  name: "report.exportExcel",
  description: "导出当前清单为新的 Excel 文件（分部分项表，含最新单价与合价）",
  implemented: true,
  schema: z.object({ filename: z.string().optional() }),
  handler: async (ctx, args: { filename?: string }) => {
    const items = await listBoq(ctx.projectId);
    if (!items.length) return { observation: { error: "清单为空" } };

    // group by source sheet, keep original column layout when known
    const bySheet = new Map<string, typeof items>();
    items.forEach((i) => {
      const arr = bySheet.get(i.sheetName) ?? [];
      arr.push(i);
      bySheet.set(i.sheetName, arr);
    });
    const headerLabels = ["序号", "项目编码", "项目名称", "项目特征", "计量单位", "工程量", "综合单价", "合价"];
    const sheets = [...bySheet.entries()].map(([sheetName, rows]) => ({
      sheetName: sheetName.slice(0, 28) || "清单",
      columns: {},
      headerLabels,
      rows: rows
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((r, idx) => ({
          rowIndex: r.rowIndex,
          isHeader: r.isHeader,
          values: (r.isHeader
            ? { 项目名称: r.name }
            : {
                序号: String(idx + 1),
                项目编码: r.code,
                项目名称: r.name,
                项目特征: r.rawFeature,
                计量单位: r.unit,
                工程量: r.quantity,
                综合单价: r.unitPrice,
                合价: r.totalPrice,
              }) as Record<string, string>,
        })),
    }));
    const out = await buildExportWorkbook(sheets);
    const filename = args.filename ?? `清单导出_${new Date().toISOString().slice(0, 10)}.xlsx`;
    const artifact = await saveArtifact(ctx, out, filename);
    const total = items
      .filter((i) => !i.isHeader)
      .reduce((a, i) => a.plus(D(i.totalPrice)), D(0));
    return {
      observation: { artifactId: artifact.id, rows: items.length, total: total.toFixed(2) },
      views: [
        {
          kind: "exportResult",
          id: `view:export:${artifact.id}`,
          title: "导出完成",
          artifactId: artifact.id,
          filename: artifact.label,
          summary: `${items.filter((i) => !i.isHeader).length} 个清单项，合计 ${total.toFixed(2)} 元`,
        },
      ],
      receipts: [
        {
          actionType: "EXPORT",
          summary: `导出 Excel：${filename}`,
          before: {},
          after: { artifactId: artifact.id, total: total.toFixed(2) },
          reversible: false,
        },
      ],
      message: `已导出「${filename}」，合计 ${total.toFixed(2)} 元`,
    };
  },
});

registerTool({
  name: "report.generate",
  description: "生成造价分析报告（规划中）",
  implemented: false,
  schema: z.object({ kind: z.string().optional() }),
});
