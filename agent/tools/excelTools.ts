import { z } from "zod";
import { prisma } from "@database/client";
import { registerTool } from "./registry";
import { listBoq } from "@boq/service";
import { assembleExportSheets } from "@boq/export";
import { storage } from "@file/storage";
import { writeBackPrices, buildExportWorkbook, type ColumnMap, type CellPatch } from "@file/excel";
import { ensureInspection, mappingToView } from "@file/inspection";
import { fromJson } from "@shared/json";
import { projectTotals } from "@cost-engine/aggregate";
import { fmtMoney } from "@cost-engine/money";

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
    const owned = await prisma.projectFile.findUnique({ where: { id: args.fileId } });
    if (!owned || owned.projectId !== ctx.projectId) throw new Error("文件不存在或不属于当前项目");
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
            status: "PARSED",
            boqItems: { some: { isHeader: false } },
            filename: { endsWith: ".xlsx" },
          },
          orderBy: { createdAt: "desc" },
        });
    if (!file || file.projectId !== ctx.projectId) throw new Error("没有属于当前项目的可写回清单源文件");
    if (!/\.xlsx$/i.test(file.filename)) throw new Error("保留源格式写回需要 .xlsx 文件；其他格式请使用清单 Excel 导出");

    const items = await listBoq(ctx.projectId);
    const mine = items.filter((i) => i.fileId === file.id && !i.isHeader);
    if (!mine.length) throw new Error("该源文件没有已导入的清单项，请先完成导入");
    const meta = fromJson<{
      sheets?: { name: string; columns: string[] }[];
      mapping?: Record<string, { columns?: Record<string, number> }>;
    }>(file.meta, {});
    // 列映射优先取 meta.mapping（列映射面板的最新口径），再退回 ingest 时沉淀的 meta.sheets
    const colMaps: Record<string, ColumnMap> = {};
    for (const s of meta.sheets ?? []) {
      const m: ColumnMap = {};
      for (const c of s.columns) {
        const [k, v] = c.split(":");
        m[k] = Number(v) - 1;
      }
      colMaps[s.name] = m;
    }
    for (const [name, s] of Object.entries(meta.mapping ?? {}))
      if (s.columns && Object.keys(s.columns).length) colMaps[name] = { ...s.columns };
    const patches: CellPatch[] = mine.map((i) => ({
      sheetName: i.sheetName,
      rowIndex: i.rowIndex,
      unitPrice: i.unitPrice,
      quantity: i.quantity,
      quantityExpr: i.quantityExpr || undefined,
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
    const assembled = await assembleExportSheets(ctx.projectId);
    if (!assembled) return { observation: { error: "清单为空" } };
    const { items, total } = assembled;
    const out = await buildExportWorkbook(assembled.sheets);
    const filename = args.filename ?? `清单导出_${new Date().toISOString().slice(0, 10)}.xlsx`;
    const artifact = await saveArtifact(ctx, out, filename);
    return {
      observation: { artifactId: artifact.id, rows: items.length, total },
      views: [
        {
          kind: "exportResult",
          id: `view:export:${artifact.id}`,
          title: "导出完成",
          artifactId: artifact.id,
          filename: artifact.label,
          summary: `${items.filter((i) => !i.isHeader).length} 个清单项，合计 ${fmtMoney(total)} 元`,
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
      message: `已导出「${filename}」，合计 ${fmtMoney(total)} 元`,
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
    const { analyzeCostComposition } = await import("@cost-engine/costComposition");
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
    let boqSeq = 0;
    items.forEach((it) => {
      if (it.isHeader) {
        const r = sBoq.addRow(["", "", it.name, "", "", "", "", ""]);
        r.font = bold.font;
        return;
      }
      const r = sBoq.addRow([++boqSeq, it.code, it.name, it.rawFeature, it.unit, Number(it.quantity), Number(it.unitPrice), Number(it.totalPrice)]);
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

    // 人材机成本构成（分量来源：定额组价方案 > 源表分解列 > 主材暂估价）
    const comp = analyzeCostComposition(items);
    const sCost = wb.addWorksheet("成本构成");
    const ch = sCost.addRow(["项目编码", "项目名称", "工程量", "合价", "人工费", "材料费", "机械费", "管利及其他", "毛利率%", "分量来源"]);
    ch.font = bold.font;
    const srcLabel: Record<string, string> = { quotaPlan: "定额组价", imported: "源表分解", partial: "仅主材价", none: "无数据" };
    for (const r of comp.rows) {
      const row = sCost.addRow([
        r.code, r.name, Number(r.quantity), Number(r.revenue),
        r.labor === null ? "—" : Number(r.labor),
        r.material === null ? "—" : Number(r.material),
        r.machine === null ? "—" : Number(r.machine),
        Number(r.other),
        r.marginRate === null ? "—" : Number(r.marginRate),
        srcLabel[r.source],
      ]);
      for (const ci of [4, 5, 6, 7, 8]) {
        const cell = row.getCell(ci);
        if (typeof cell.value === "number") cell.numFmt = moneyFmt;
      }
      if (r.inverted) row.font = { bold: true, color: { argb: "FFC00000" } };
    }
    const tRow = sCost.addRow(["合计", "", "", Number(comp.totals.revenue), Number(comp.totals.labor), Number(comp.totals.material), Number(comp.totals.machine), Number(comp.totals.other), comp.totals.marginRate === null ? "—" : Number(comp.totals.marginRate), ""]);
    tRow.font = bold.font;
    for (const ci of [4, 5, 6, 7, 8]) tRow.getCell(ci).numFmt = moneyFmt;
    sCost.columns = [{ width: 16 }, { width: 30 }, { width: 10 }, { width: 14 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 10 }, { width: 10 }];

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

    for (const s of [s1, s2, s3, sCost, s4, s5]) s.columns.forEach((c) => { if (!c.width) c.width = 22; });

    const out = Buffer.from(await wb.xlsx.writeBuffer());
    const filename = args.filename ?? `造价分析报告_${new Date().toISOString().slice(0, 10)}.xlsx`;
    const artifact = await saveArtifact(ctx, out, filename);
    return {
      observation: { artifactId: artifact.id, sheets: 8, total: totals.totalAmount, grandTotal: fee.grandTotal },
      views: [{
        kind: "exportResult",
        id: `view:report:${artifact.id}`,
        title: "分析报告",
        artifactId: artifact.id,
        filename: artifact.label,
        summary: `汇总/取费/清单/专业/材料/成本构成/台账/异常 8 个 sheet，含税造价 ${fmtMoney(fee.grandTotal)} 元`,
      }],
      receipts: [{
        actionType: "EXPORT",
        summary: `生成分析报告：${filename}`,
        before: {},
        after: { artifactId: artifact.id },
        reversible: false,
      }],
      message: `已生成「${filename}」：费用汇总（含税 ${fmtMoney(fee.grandTotal)} 元）+ 分部分项清单 + 占比/台账/异常`,
    };
  },
});

registerTool({
  name: "report.exportCompare",
  description: "导出两版清单对审报告 Excel：对审结论 + 申报口径对比 + 差异明细（量差>15% 标应调价）",
  implemented: true,
  schema: z.object({
    fileAId: z.string().optional().describe("基准文件；缺省按阶段/期次自动配对取基准侧"),
    fileBId: z.string().optional().describe("对比文件；缺省按阶段/期次自动配对取对比侧"),
    filename: z.string().optional(),
  }),
  handler: async (ctx, args: { fileAId?: string; fileBId?: string; filename?: string }) => {
    const { buildCompareReport } = await import("@file/compareReport");
    const built = await buildCompareReport(ctx.projectId, args);
    if ("error" in built) return { observation: { error: built.error } };
    const artifact = await saveArtifact(ctx, built.out, built.filename);
    return {
      observation: { artifactId: artifact.id, diffRows: built.diffRows, totalDelta: built.totalDelta, declared: built.hasDeclared },
      views: [{
        kind: "exportResult",
        id: `view:export:${artifact.id}`,
        title: "对审报告",
        artifactId: artifact.id,
        filename: artifact.label,
        summary: `差异 ${built.diffRows} 项 · 合价差 ${fmtMoney(built.totalDelta)} 元${built.hasDeclared ? " · 含申报口径对比" : ""}`,
      }],
      receipts: [{
        actionType: "EXPORT",
        summary: `导出对审报告：${built.filename}`,
        before: {},
        after: { artifactId: artifact.id },
        reversible: false,
      }],
      message: `已导出对审报告「${built.filename}」：差异明细 ${built.diffRows} 项${built.hasDeclared ? " + 申报口径对比" : ""}`,
    };
  },
});
