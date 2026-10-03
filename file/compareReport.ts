import { prisma } from "@database/client";
import { listBoq } from "@boq/service";
import { getFact } from "@project/facts";
import {
  compareBoqSets,
  compareSummary,
  compareDeclaredFees,
  pickComparePair,
  type DeclaredCompare,
} from "@cost-engine/fileCompare";

// 两版清单对审报告 xlsx 构建器：report.exportCompare 工具与
// /api/projects/[id]/export-compare 直链路由共用同一份组装口径（确定性、不走模型）。

export interface CompareReportBuilt {
  out: Buffer;
  filename: string;
  fileAName: string;
  fileBName: string;
  diffRows: number;
  totalDelta: string;
  hasDeclared: boolean;
}

const moneyFmt = "#,##0.00";
const STATUS_LABEL: Record<string, string> = {
  PRICE_DIFF: "价差",
  QTY_DIFF: "量差",
  BOTH_DIFF: "量价差",
  ONLY_A: "仅A",
  ONLY_B: "仅B",
};

async function declaredUnits(projectId: string, filename: string) {
  const f = await getFact(projectId, `文件汇总:${filename}`);
  if (!f) return null;
  try {
    return JSON.parse(f.value) as Record<string, unknown>[];
  } catch {
    return null;
  }
}

/** 构建对审工作簿；返回错误说明或完整的 xlsx buffer + 默认文件名。 */
export async function buildCompareReport(
  projectId: string,
  opts: { fileAId?: string; fileBId?: string; filename?: string }
): Promise<{ error: string } | CompareReportBuilt> {
  const files = await prisma.projectFile.findMany({
    where: { projectId, kind: { startsWith: "BOQ" }, status: "PARSED" },
    orderBy: { createdAt: "asc" },
  });
  if (files.length < 2 && !opts.fileAId && !opts.fileBId)
    return { error: "需要两份清单文件才能对审，请再上传一版" };
  const [autoA, autoB] = files.length >= 2 ? pickComparePair(files) : [files[0], files[0]];
  const fileA = opts.fileAId ? files.find((f) => f.id === opts.fileAId) : autoA;
  let fileB = opts.fileBId ? files.find((f) => f.id === opts.fileBId) : autoB;
  // 只指定了一侧时，另一侧若恰好撞上，自动换一份——用户给了方向就不该报「选择无效」
  if (fileA && fileB && fileA.id === fileB.id && (!opts.fileAId || !opts.fileBId))
    fileB = files.find((f) => f.id !== fileA.id) ?? fileB;
  if (!fileA || !fileB || fileA.id === fileB.id) return { error: "文件选择无效" };

  const items = await listBoq(projectId);
  const rows = compareBoqSets(
    items.filter((i) => i.fileId === fileA.id),
    items.filter((i) => i.fileId === fileB.id)
  );
  const summary = compareSummary(rows);
  const [unitsA, unitsB] = await Promise.all([
    declaredUnits(projectId, fileA.filename),
    declaredUnits(projectId, fileB.filename),
  ]);
  const declared: DeclaredCompare | null = unitsA && unitsB ? compareDeclaredFees(unitsA, unitsB) : null;

  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const bold = { bold: true };
  const tag = (f: { stage: string; period: string }) => [f.stage, f.period].filter(Boolean).join("·");

  // 对审说明
  const s0 = wb.addWorksheet("对审说明");
  s0.addRow(["两版清单对审报告"]).font = { bold: true, size: 14 };
  s0.addRow(["生成时间", new Date().toLocaleString("zh-CN")]);
  s0.addRow([]);
  s0.addRow(["A 版（基准）", `${fileA.filename}${tag(fileA) ? `（${tag(fileA)}）` : ""}`]);
  s0.addRow(["B 版（对比）", `${fileB.filename}${tag(fileB) ? `（${tag(fileB)}）` : ""}`]);
  s0.addRow([]);
  for (const [k, v] of [
    ["对齐清单项", summary.total],
    ["完全一致", summary.same],
    ["价差项", summary.priceDiff],
    ["量差项", summary.qtyDiff],
    ["量差>15%（应调价）", summary.qtyOver15],
    ["五统一不符（名称/单位/特征）", summary.compliance],
    ["仅 A 版有", summary.onlyA],
    ["仅 B 版有", summary.onlyB],
  ] as [string, number][])
    s0.addRow([k, v]);
  const dRow = s0.addRow(["清单合价差额（B−A）", Number(summary.totalDelta)]);
  dRow.font = bold;
  dRow.getCell(2).numFmt = moneyFmt;
  s0.columns = [{ width: 26 }, { width: 60 }];

  // 申报口径对比（两份文件都带单位工程汇总表时）
  if (declared) {
    const s1 = wb.addWorksheet("申报口径对比");
    s1.addRow(["费用口径", "A 申报（元）", "B 申报（元）", "差（B−A）"]).font = bold;
    for (const l of declared.labels) {
      const r = s1.addRow([l.label, l.a, l.b, l.diff]);
      for (const c of [2, 3, 4]) r.getCell(c).numFmt = moneyFmt;
    }
    s1.addRow([]);
    s1.addRow(["单位工程", "A 申报（元）", "B 申报（元）", "差（B−A）", "备注"]).font = bold;
    for (const u of [...declared.units].sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff))) {
      const r = s1.addRow([u.name, u.a, u.b, u.diff, u.side === "a" ? "仅 A" : u.side === "b" ? "仅 B" : ""]);
      for (const c of [2, 3, 4]) r.getCell(c).numFmt = moneyFmt;
    }
    s1.columns = [{ width: 34 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 10 }];
  }

  // 差异明细（全量非一致行 + 量价一致但五统一不符的行）
  const s2 = wb.addWorksheet("差异明细");
  s2.addRow(["项目编码", "项目名称", "状态", "A量", "B量", "量差", "A单价", "B单价", "价差", "A合价", "B合价", "合价差", "调价提示", "五统一符合性"]).font = bold;
  const complianceNote = (r: (typeof rows)[number]) =>
    [
      r.nameMismatch ? "名称异" : "",
      r.unitMismatch ? "单位异" : "",
      r.featureConflict?.length ? `特征异(${r.featureConflict.join("；")})` : "",
    ].filter(Boolean).join("、");
  const diffRows = rows.filter((r) => r.status !== "SAME" || complianceNote(r));
  for (const r of diffRows) {
    const row = s2.addRow([
      r.code,
      r.name,
      STATUS_LABEL[r.status] ?? r.status,
      r.aQty ? Number(r.aQty) : "",
      r.bQty ? Number(r.bQty) : "",
      r.qtyDelta ? Number(r.qtyDelta) : "",
      r.aPrice ? Number(r.aPrice) : "",
      r.bPrice ? Number(r.bPrice) : "",
      r.priceDelta ? Number(r.priceDelta) : "",
      r.aTotal ? Number(r.aTotal) : "",
      r.bTotal ? Number(r.bTotal) : "",
      r.totalDelta ? Number(r.totalDelta) : "",
      r.qtyOver15 ? "量差>15%，应重新组价" : "",
      complianceNote(r),
    ]);
    for (const c of [10, 11, 12]) {
      const cell = row.getCell(c);
      if (typeof cell.value === "number") cell.numFmt = moneyFmt;
    }
    if (r.qtyOver15) row.getCell(13).font = { bold: true, color: { argb: "FFC00000" } };
    if (complianceNote(r)) row.getCell(14).font = { color: { argb: "FFB45300" } };
  }
  s2.columns = [
    { width: 16 }, { width: 32 }, { width: 8 }, { width: 10 }, { width: 10 }, { width: 10 },
    { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 22 }, { width: 30 },
  ];

  const out = Buffer.from(await wb.xlsx.writeBuffer());
  const stem = (n: string) => n.replace(/\.[^.]+$/, "");
  return {
    out,
    filename: opts.filename ?? `对审报告_${stem(fileA.filename)}_vs_${stem(fileB.filename)}.xlsx`,
    fileAName: fileA.filename,
    fileBName: fileB.filename,
    diffRows: diffRows.length,
    totalDelta: summary.totalDelta,
    hasDeclared: !!declared,
  };
}
