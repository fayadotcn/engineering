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
import { D, fmtMoney } from "@cost-engine/money";

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
    // 手工补录/跨文件行没有源表坐标，写回不到该文件——显式报数，别静默丢失
    const outside = items.filter((i) => !i.isHeader && i.fileId !== file.id).length;
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
          summary: `已将 ${patches.length} 行单价/工程量/合价写回「${file.filename}」${outside ? `；另有 ${outside} 行来自其他文件或手工补录，不在该源文件内` : ""}`,
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
      message: `已把最新价格写回源文件，生成「${artifact.label}」` +
        (outside ? `；另有 ${outside} 行（手工补录/其他源文件）不在该文件内，请用「导出清单」取全量` : ""),
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

    const { projectTotals, aggregateByDiscipline, aggregateByCategory, aggregateByUnitProject } = await import("@cost-engine/aggregate");
    const {
      findSameItemDifferentPrice, findPriceAnomalies, findArithmeticMismatches,
      findFeatureMismatch, findDuplicateItems, findUnitInconsistencies, findCodeNameMismatch, findInvalidCodes, findMissingCodes, findDataIssues,
    } = await import("@cost-engine/compare");
    const { analyzeCostComposition } = await import("@cost-engine/costComposition");
    const { feeSummary, feeCompliance } = await import("@cost-engine/fees");
    const { getFacts, loadFeeParams, parseAreaValue, parseAmountValue } = await import("@project/facts");
    const ExcelJS = (await import("exceljs")).default;

    const totals = projectTotals(items);
    const facts = await getFacts(ctx.projectId);
    const feeParams = await loadFeeParams(ctx.projectId);
    const fee = feeSummary(items, feeParams);
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
    const area = parseAreaValue(facts.find((f) => /面积/.test(f.key))?.value);
    if (area !== null && area > 0) {
      s1.addRow(["建筑面积（㎡）", area]);
      s1.addRow(["单方造价（元/㎡，含税）", Number(D(fee.grandTotal).div(area).toFixed(2))]);
    }

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
      // 总额计价行（总价措施/其他项目）没有量×价结构，不进分部分项明细表——
      // 它们的金额在「费用汇总」sheet 已有归属
      if (!it.isHeader && (it.feeType === "总价措施" || it.feeType === "其他项目")) return;
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

    // 总价措施/其他项目明细（表-11/表-12 口径）：总额计价行单列成表，金额是真钱不能只在汇总里出现
    const lumpRows = items.filter((it) => !it.isHeader && (it.feeType === "总价措施" || it.feeType === "其他项目"));
    if (lumpRows.length) {
      const sL = wb.addWorksheet("措施与其他项目");
      sL.addRow(["序号", "项目编码", "项目名称", "费用类别", "金额"]).font = bold.font;
      let lumpSeq = 0;
      for (const it of lumpRows) {
        const r = sL.addRow([++lumpSeq, it.code, it.name, it.feeType, Number(it.totalPrice)]);
        r.getCell(5).numFmt = moneyFmt;
      }
      const lumpTotal = lumpRows.reduce((n, it) => n.plus(D(it.totalPrice || "0")), D(0));
      const tr = sL.addRow(["", "", "合计", "", Number(lumpTotal.toFixed(2))]);
      tr.font = bold.font;
      tr.getCell(5).numFmt = moneyFmt;
      sL.columns = [{ width: 6 }, { width: 16 }, { width: 44 }, { width: 12 }, { width: 14 }];
    }

    // 占比
    const s2 = wb.addWorksheet("专业占比");
    s2.addRow(["专业", "金额", "占比", "项数"]).font = bold.font;
    for (const d of aggregateByDiscipline(items).slices)
      s2.addRow([d.label, Number(d.amount), `${(d.share * 100).toFixed(1)}%`, d.count]);
    const s3 = wb.addWorksheet("材料占比");
    s3.addRow(["材料类别", "金额", "占比", "项数"]).font = bold.font;
    for (const c of aggregateByCategory(items).slices)
      s3.addRow([c.label, Number(c.amount), `${(c.share * 100).toFixed(1)}%`, c.count]);

    // 单位工程汇总（表-04 口径）：多个单位工程才单列
    const byUnit = aggregateByUnitProject(items);
    const hasUnit = byUnit.slices.length > 1 || (byUnit.slices.length === 1 && byUnit.slices[0].key !== "未注明单位工程");
    if (hasUnit) {
      const sU = wb.addWorksheet("单位工程汇总");
      sU.addRow(["序号", "单位工程", "金额", "占比", "项数"]).font = bold.font;
      byUnit.slices.forEach((s, i) => {
        const r = sU.addRow([i + 1, s.label, Number(s.amount), `${(s.share * 100).toFixed(1)}%`, s.count]);
        r.getCell(3).numFmt = moneyFmt;
      });
      const tr = sU.addRow(["", "合计", Number(byUnit.total.toFixed(2)), "100.0%", byUnit.slices.reduce((n, s) => n + s.count, 0)]);
      tr.font = bold.font;
      tr.getCell(3).numFmt = moneyFmt;
      sU.columns = [{ width: 6 }, { width: 36 }, { width: 16 }, { width: 10 }, { width: 8 }];
    }

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

    // 综合单价分析表（表-09 口径）：每个已组价清单项列出定额子目级
    // 人工/辅材/主材/机械/管利分解（均为每清单单位口径）+ 综合单价合计。
    // 建议增列行（suggested）不计入测算价，不进分析表。
    const planned = leaf.filter((it) => (it.pricingPlan ?? []).some((l) => !l.suggested));
    if (planned.length) {
      const sP = wb.addWorksheet("综合单价分析");
      sP.addRow(["项目编码", "项目名称", "定额编号", "定额子目", "单位", "人工费", "辅材费", "主材费", "机械费", "管利费", "子目小计"]).font = bold.font;
      for (const it of planned) {
        for (const l of it.pricingPlan!.filter((x) => !x.suggested)) {
          const main = l.mainPrice !== null && D(l.mainPrice).gt(0) ? D(l.mainPrice).mul(l.mainQty ?? 1) : null;
          const r = sP.addRow([
            it.code, it.name, l.quotaCode, l.quotaName, it.unit,
            Number(D(l.labor ?? 0)), Number(D(l.materialAux ?? 0)),
            main === null ? "—" : Number(main.toFixed(2)),
            Number(D(l.machine ?? 0)), Number(D(l.fee ?? 0)),
            Number(D(l.subtotal ?? 0)),
          ]);
          for (const ci of [6, 7, 8, 9, 10, 11]) { const c = r.getCell(ci); if (typeof c.value === "number") c.numFmt = moneyFmt; }
        }
        const tr = sP.addRow([it.code, `${it.name}（合计）`, "", `综合单价 ${D(it.unitPrice).toFixed(2)} × 工程量 ${it.quantity}`, it.unit, "", "", "", "", "", Number(D(it.totalPrice))]);
        tr.font = bold.font;
        tr.getCell(11).numFmt = moneyFmt;
      }
      sP.columns = [{ width: 14 }, { width: 24 }, { width: 12 }, { width: 26 }, { width: 7 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 12 }];
    }

    // 主要材料表（报告标准交付物）：定额组价主材行 + 主材暂估价两路归集，同名同价合并
    type MatRow = { name: string; spec: string; unit: string; qty: ReturnType<typeof D>; price: ReturnType<typeof D>; source: string };
    const matMap = new Map<string, MatRow>();
    const putMat = (r: MatRow) => {
      const key = `${r.name}|${r.spec}|${r.unit}|${r.price}|${r.source}`;
      const cur = matMap.get(key);
      if (cur) cur.qty = cur.qty.plus(r.qty);
      else matMap.set(key, { ...r });
    };
    for (const it of leaf) {
      const planMains = (it.pricingPlan ?? []).filter(
        (l) => !l.suggested && l.mainPrice !== null && D(l.mainPrice).gt(0)
      );
      if (planMains.length) {
        for (const l of planMains)
          putMat({
            name: l.mainMaterialName || it.name,
            spec: it.features?.diameter ?? it.features?.specification ?? it.rawFeature.slice(0, 40),
            unit: it.unit,
            qty: D(it.quantity).mul(l.mainQty ?? 1),
            price: D(l.mainPrice!),
            source: "定额组价",
          });
      } else if (D(it.mainMaterialPrice ?? "0").gt(0)) {
        putMat({
          name: it.features?.material ?? it.name,
          spec: it.features?.diameter ?? it.features?.specification ?? it.rawFeature.slice(0, 40),
          unit: it.unit,
          qty: D(it.quantity),
          price: D(it.mainMaterialPrice),
          source: "主材暂估价",
        });
      }
    }
    const matRows = [...matMap.values()].sort(
      (a, b) => b.qty.mul(b.price).cmp(a.qty.mul(a.price))
    );
    if (matRows.length) {
      const sM = wb.addWorksheet("主要材料表");
      sM.addRow(["序号", "材料名称", "规格型号", "单位", "数量", "主材单价", "主材合价", "价格口径"]).font = bold.font;
      matRows.forEach((m, i) => {
        const row = sM.addRow([i + 1, m.name, m.spec, m.unit, Number(m.qty.toFixed(3)), Number(m.price.toFixed(2)), Number(m.qty.mul(m.price).toFixed(2)), m.source]);
        for (const ci of [5, 6, 7]) row.getCell(ci).numFmt = ci === 5 ? "#,##0.###" : moneyFmt;
      });
      sM.columns = [{ width: 6 }, { width: 30 }, { width: 30 }, { width: 8 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 12 }];
    }

    // 甲供材表（发包人供货清单，结算对账交付物）：有 OWNER_SUPPLIED 文件导入时才出
    const { listQuotations } = await import("@material/service");
    const ownerFiles = new Set(
      (await prisma.projectFile.findMany({
        where: { projectId: ctx.projectId, kind: "OWNER_SUPPLIED" },
        select: { id: true },
      })).map((f) => f.id)
    );
    const suppliedRows = ownerFiles.size
      ? (await listQuotations(ctx.projectId)).filter((q) => q.fileId && ownerFiles.has(q.fileId))
      : [];
    const ownerConflicts: string[] = [];
    if (suppliedRows.length) {
      // 逐行核对：甲供材对应的清单项若已计主材暂估价 = 重复计价（甲供材不计入承包价）
      const { matchQuotations } = await import("@cost-engine/match");
      const { isPricableItem } = await import("@shared/types");
      const byItem = new Map(items.map((it) => [it.id, it]));
      const checkRows = matchQuotations(items, suppliedRows).rows.map((r) => {
        const hits = r.matchedBoqItemIds.map((id) => byItem.get(id)).filter((it): it is typeof items[number] => !!it && isPricableItem(it));
        const priced = hits.filter((it) => D(it.mainMaterialPrice ?? "0").gt(0));
        if (priced.length)
          ownerConflicts.push(
            `甲供材「${r.materialName}${r.spec ? ` ${r.spec}` : ""}」对应 ${priced.length} 项已计主材价：${priced.map((it) => `${it.name}@${it.mainMaterialPrice}`).join("；")}`
          );
        return {
          status: !hits.length
            ? (r.status === "LOW_CONFIDENCE" ? "疑似相关·低置信" : "未命中清单")
            : priced.length ? `重复计价（${priced.length}项已计主材价）` : "未计价·正常",
          names: hits.slice(0, 3).map((it) => it.name).join("、"),
          risk: priced.length > 0,
        };
      });
      const sO = wb.addWorksheet("甲供材表");
      sO.addRow(["序号", "材料名称", "规格型号", "品牌", "单位", "发包人价格", "计价核对", "对应清单项"]).font = bold.font;
      suppliedRows.forEach((q, i) => {
        const c = checkRows[i];
        const row = sO.addRow([i + 1, q.materialName, q.spec, q.brand, q.unit, Number(D(q.price).toFixed(2)), c?.status ?? "", c?.names ?? ""]);
        row.getCell(6).numFmt = moneyFmt;
        if (c?.risk) row.getCell(7).font = { color: { argb: "FFDC2626" }, bold: true };
      });
      sO.columns = [{ width: 6 }, { width: 30 }, { width: 30 }, { width: 14 }, { width: 8 }, { width: 14 }, { width: 22 }, { width: 36 }];
    }

    // 台账
    const s4 = wb.addWorksheet("项目台账");
    s4.addRow(["类型", "键", "值", "来源", "置信度"]).font = bold.font;
    for (const f of facts) s4.addRow([f.factType, f.key, f.value, f.source, f.confidence]);

    // 异常 + 费用符合性（报告交付口径：全部检查维度和清单页/费用页一致）
    const s5 = wb.addWorksheet("异常摘要");
    s5.addRow(["类型", "组/项", "明细"]).font = bold.font;
    const anomalyGroups: [string, ReturnType<typeof findSameItemDifferentPrice>][] = [
      ["合价算术不符", findArithmeticMismatches(items)],
      ["相同项不同价", findSameItemDifferentPrice(items)],
      ["单价异常", findPriceAnomalies(items)],
      ["特征不一致", findFeatureMismatch(items)],
      ["重复项", findDuplicateItems(items)],
      ["单位不一致", findUnitInconsistencies(items)],
      ["一码多名", findCodeNameMismatch(items)],
      ["非标编码", findInvalidCodes(items)],
      ["缺编码", findMissingCodes(items)],
      ["数据质量", findDataIssues(items)],
    ];
    for (const [label, groups] of anomalyGroups)
      for (const g of groups)
        s5.addRow([label, g.label, `${g.reason}：${g.items.map((i) => `${i.name}@${i.unitPrice}`).join("；")}`]);
    const ceilingFact = facts.find((x) => /最高限价|招标控制价|控制价|限价/.test(x.key));
    const ceilingNum = ceilingFact ? parseAmountValue(ceilingFact.value) : null;
    for (const i of feeCompliance(items, feeParams, { ceiling: ceilingNum !== null ? D(ceilingNum) : null, summary: fee }))
      s5.addRow([i.level === "error" ? "符合性错误" : "符合性提示", i.label, i.detail]);
    for (const c of ownerConflicts) s5.addRow(["甲供材重复计价", "甲供材表", c]);

    for (const s of wb.worksheets) s.columns.forEach((c) => { if (!c.width) c.width = 22; });

    const out = Buffer.from(await wb.xlsx.writeBuffer());
    const filename = args.filename ?? `造价分析报告_${new Date().toISOString().slice(0, 10)}.xlsx`;
    const artifact = await saveArtifact(ctx, out, filename);
    return {
      observation: { artifactId: artifact.id, sheets: wb.worksheets.length, total: totals.totalAmount, grandTotal: fee.grandTotal },
      views: [{
        kind: "exportResult",
        id: `view:report:${artifact.id}`,
        title: "分析报告",
        artifactId: artifact.id,
        filename: artifact.label,
        summary: `汇总/取费/清单${lumpRows.length ? "/措施与其他项目" : ""}/专业/材料/成本构成${planned.length ? "/综合单价分析" : ""}${matRows.length ? "/主要材料表" : ""}${suppliedRows.length ? "/甲供材表" : ""}/台账/异常 ${wb.worksheets.length} 个 sheet，含税造价 ${fmtMoney(fee.grandTotal)} 元`,
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
