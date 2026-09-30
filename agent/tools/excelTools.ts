import { z } from "zod";
import { prisma } from "@database/client";
import { registerTool } from "./registry";
import { listBoq } from "@boq/service";
import { storage } from "@file/storage";
import { parseWorkbook, writeBackPrices, buildExportWorkbook, type ColumnMap, type CellPatch } from "@file/excel";
import { ensureInspection, mappingToView } from "@file/inspection";
import { fromJson } from "@shared/json";
import { projectTotals } from "@cost-engine/aggregate";

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
    const { file, mapping, isPdf } = await ensureInspection(args.fileId);
    if (isPdf || !mapping) return { observation: { pdf: true, filename: file.filename } };
    const view = mappingToView(file, mapping);
    const sheets = view.kind === "columnMapping" ? view.sheets : [];
    return {
      observation: args.sheetName
        ? sheets.find((s) => s.sheetName === args.sheetName) ?? sheets[0]
        : sheets.map((s) => ({ sheetName: s.sheetName, type: s.type, columns: s.columns })),
      views: [view],
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
          where: {
            projectId: ctx.projectId,
            kind: { startsWith: "BOQ" },
            filename: { endsWith: ".xlsx" },
          },
          orderBy: { createdAt: "desc" },
        }) ?? await prisma.projectFile.findFirst({
          where: {
            projectId: ctx.projectId,
            kind: { startsWith: "BOQ" },
            filename: { endsWith: ".xls" },
          },
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
    const total = projectTotals(items).totalAmount;
    return {
      observation: { artifactId: artifact.id, rows: items.length, total },
      views: [
        {
          kind: "exportResult",
          id: `view:export:${artifact.id}`,
          title: "导出完成",
          artifactId: artifact.id,
          filename: artifact.label,
          summary: `${items.filter((i) => !i.isHeader).length} 个清单项，合计 ${total} 元`,
        },
      ],
      receipts: [
        {
          actionType: "EXPORT",
          summary: `导出 Excel：${filename}`,
          before: {},
          after: { artifactId: artifact.id, total },
          reversible: false,
        },
      ],
      message: `已导出「${filename}」，合计 ${total} 元`,
    };
  },
});

registerTool({
  name: "report.generate",
  description: "生成造价分析报告 Excel：项目汇总、专业/材料占比、事实台账、异常项摘要",
  implemented: true,
  schema: z.object({ filename: z.string().optional() }),
  handler: async (ctx, args: { filename?: string }) => {
    const items = await listBoq(ctx.projectId);
    const leaf = items.filter((i) => !i.isHeader);
    if (!leaf.length) return { observation: { error: "清单为空，无法生成报告" } };

    const { projectTotals, aggregateByDiscipline, aggregateByCategory } = await import("@cost-engine/aggregate");
    const { findSameItemDifferentPrice, findPriceAnomalies } = await import("@cost-engine/compare");
    const { feeSummary } = await import("@cost-engine/fees");
    const { getFacts, loadFeeParams } = await import("@project/facts");
    const ExcelJS = (await import("exceljs")).default;

    const totals = projectTotals(items);
    const facts = await getFacts(ctx.projectId);
    const fee = feeSummary(items, await loadFeeParams(ctx.projectId));
    const wb = new ExcelJS.Workbook();
    const bold = { font: { bold: true } };
    const moneyFmt = "#,##0.00";

    // 汇总
    const s1 = wb.addWorksheet("项目汇总");
    const t = s1.addRow(["造价分析报告"]);
    t.font = { bold: true, size: 14 };
    s1.addRow(["生成时间", new Date().toLocaleString("zh-CN")]);
    s1.addRow([]);
    s1.addRow(["清单项数", totals.itemCount]);
    s1.addRow(["已定价项数", totals.pricedCount]);
    s1.addRow(["合价合计（不含税）", totals.totalAmount]);
    s1.addRow(["含税工程造价", fee.grandTotal]);

    // 费用汇总（取费表）
    const sFee = wb.addWorksheet("费用汇总");
    const fh = sFee.addRow(["序号", "费用名称", "计算基础", "费率", "金额（元）", "备注"]);
    fh.font = bold.font;
    for (const r of fee.rows) {
      const row = sFee.addRow([r.seq, r.name, r.basis, r.rate ?? "", Number(r.amount), r.note ?? ""]);
      row.getCell(5).numFmt = moneyFmt;
      if (r.level !== "leaf") row.font = bold.font;
    }
    sFee.columns = [{ width: 8 }, { width: 26 }, { width: 30 }, { width: 10 }, { width: 16 }, { width: 40 }];

    // 分部分项清单
    const sBoq = wb.addWorksheet("分部分项清单");
    const bh = sBoq.addRow(["序号", "项目编码", "项目名称", "项目特征", "单位", "工程量", "综合单价", "合价"]);
    bh.font = bold.font;
    items.forEach((it, i) => {
      if (it.isHeader) {
        const r = sBoq.addRow(["", "", it.name, "", "", "", "", ""]);
        r.font = bold.font;
        return;
      }
      const r = sBoq.addRow([i + 1, it.code, it.name, it.rawFeature, it.unit, Number(it.quantity), Number(it.unitPrice), Number(it.totalPrice)]);
      r.getCell(7).numFmt = moneyFmt;
      r.getCell(8).numFmt = moneyFmt;
    });
    sBoq.columns = [{ width: 6 }, { width: 16 }, { width: 30 }, { width: 40 }, { width: 8 }, { width: 12 }, { width: 12 }, { width: 14 }];

    // 占比
    const s2 = wb.addWorksheet("专业占比");
    s2.addRow(["专业", "金额", "占比", "项数"]).font = bold.font;
    for (const d of aggregateByDiscipline(items).slices)
      s2.addRow([d.label, Number(d.amount), `${(d.share * 100).toFixed(1)}%`, d.count]);
    const s3 = wb.addWorksheet("材料占比");
    s3.addRow(["材料类别", "金额", "占比", "项数"]).font = bold.font;
    for (const c of aggregateByCategory(items).slices)
      s3.addRow([c.label, Number(c.amount), `${(c.share * 100).toFixed(1)}%`, c.count]);

    // 台账
    const s4 = wb.addWorksheet("项目台账");
    s4.addRow(["类型", "键", "值", "来源", "置信度"]).font = bold.font;
    for (const f of facts) s4.addRow([f.factType, f.key, f.value, f.source, f.confidence]);

    // 异常
    const s5 = wb.addWorksheet("异常摘要");
    s5.addRow(["类型", "组/项", "明细"]).font = bold.font;
    for (const g of findSameItemDifferentPrice(items))
      s5.addRow(["相同项不同价", g.label, g.items.map((i) => `${i.name}@${i.unitPrice}`).join("；")]);
    for (const g of findPriceAnomalies(items))
      s5.addRow(["单价异常", g.label, g.items.map((i) => `${i.name}@${i.unitPrice}`).join("；")]);

    for (const s of [s1, s2, s3, s4, s5]) s.columns.forEach((c) => { if (!c.width) c.width = 22; });

    const out = Buffer.from(await wb.xlsx.writeBuffer());
    const filename = args.filename ?? `造价分析报告_${new Date().toISOString().slice(0, 10)}.xlsx`;
    const artifact = await saveArtifact(ctx, out, filename);
    return {
      observation: { artifactId: artifact.id, sheets: 7, total: totals.totalAmount, grandTotal: fee.grandTotal },
      views: [{
        kind: "exportResult",
        id: `view:report:${artifact.id}`,
        title: "分析报告",
        artifactId: artifact.id,
        filename: artifact.label,
        summary: `汇总/取费/清单/专业/材料/台账/异常 7 个 sheet，含税造价 ${fee.grandTotal} 元`,
      }],
      receipts: [{
        actionType: "EXPORT",
        summary: `生成分析报告：${filename}`,
        before: {},
        after: { artifactId: artifact.id },
        reversible: false,
      }],
      message: `已生成「${filename}」：费用汇总（含税 ${fee.grandTotal} 元）+ 分部分项清单 + 占比/台账/异常`,
    };
  },
});
