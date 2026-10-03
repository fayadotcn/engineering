import { prisma } from "@database/client";
import { buildExportWorkbook } from "@file/excel";
import { projectTotals } from "@cost-engine/aggregate";
import { isPricableItem } from "@shared/types";
import { D } from "@cost-engine/money";
import { listBoq } from "./service";

const HEADER_LABELS = ["序号", "项目编码", "项目名称", "项目特征", "计量单位", "工程量", "工程量计算式", "综合单价", "合价", "定价状态", "费用类别", "源文件", "源工作表"];

/**
 * 导出工作簿组装（一键导出与 report.exportExcel 同一份口径）：
 * 清单按（源文件→源工作表）分表，同名表不合并，避免把招标版和结算版混成一张表；
 * 手工补录行单独成「手工补录」表。
 */
export async function assembleExportSheets(projectId: string) {
  const [items, files] = await Promise.all([
    listBoq(projectId),
    prisma.projectFile.findMany({ where: { projectId }, select: { id: true, filename: true } }),
  ]);
  if (!items.length) return null;

  const filenames = new Map(files.map(f => [f.id, f.filename]));
  const bySheet = new Map<string, typeof items>();
  items.forEach((i) => {
    const key = JSON.stringify([i.fileId, i.sheetName]);
    const arr = bySheet.get(key) ?? [];
    arr.push(i);
    bySheet.set(key, arr);
  });
  const sheets = [...bySheet.values()].map(rows => {
    let seq = 0;
    // 复核口径：表尾一行本表合价合计，粗体标出，和清单明细在同一页里能对上账
    const subtotal = rows.reduce((n, r) => r.isHeader ? n : n.plus(D(r.totalPrice || "0")), D(0));
    return {
      sheetName: rows[0].sheetName,
      columns: {},
      headerLabels: HEADER_LABELS,
      rows: [
        ...rows
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((r) => {
            const unpriced = !r.isHeader && isPricableItem(r) && D(r.unitPrice).isZero();
            return {
              rowIndex: r.rowIndex,
              isHeader: r.isHeader,
              unpriced,
              values: (r.isHeader
                ? { 项目名称: r.name }
                : {
                    序号: String(++seq),
                    项目编码: r.code,
                    项目名称: r.name,
                    项目特征: r.rawFeature,
                    计量单位: r.unit,
                    工程量: r.quantity,
                    工程量计算式: r.quantityExpr ?? "",
                    综合单价: r.unitPrice,
                    合价: r.totalPrice,
                    // 复核口径：可计价行单价为 0 必须显式标出，不能和已定价行一样留白
                    定价状态: isPricableItem(r) ? (unpriced ? "未定价" : "已定价") : "",
                    费用类别: r.feeType,
                    源文件: r.fileId ? filenames.get(r.fileId) ?? "" : "手工录入",
                    源工作表: r.sheetName,
                  }) as Record<string, string>,
            };
          }),
        { rowIndex: 0, isHeader: false, bold: true, values: { 项目名称: "合价合计", 合价: subtotal.toFixed(2) } },
      ],
    };
  });
  return { sheets, items, total: projectTotals(items).totalAmount };
}

export async function buildProjectExport(projectId: string) {
  const assembled = await assembleExportSheets(projectId);
  if (!assembled) return null;
  const out = await buildExportWorkbook(assembled.sheets);
  return { ...assembled, out };
}
