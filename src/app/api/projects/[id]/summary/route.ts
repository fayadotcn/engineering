import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { listBoq } from "@boq/service";
import { projectTotals, aggregateByDiscipline } from "@cost-engine/aggregate";
import { feeSummary, compareDeclared } from "@cost-engine/fees";
import { getFacts, loadFeeParams } from "@project/facts";

// 申报核对按文件配对：「文件汇总:{filename}」事实只代表那份文件的申报口径，
// 必须用同一文件的清单行算 feeSummary 再对——多文件时逐文件给出，不混池比较。

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!await prisma.project.findUnique({ where: { id } })) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  const [items, facts, fees, files] = await Promise.all([
    // 汇总只要数值字段——rawCells 整行原文（每行 KB 级）不取，响应时间直接腰斩
    listBoq(id, { rawCells: false }), getFacts(id), loadFeeParams(id),
    prisma.projectFile.findMany({ where: { projectId: id }, select: { id: true, filename: true } }),
  ]);
  const totals = projectTotals(items);
  const summary = feeSummary(items, fees);
  const declaredCheck: { file: string; checks: ReturnType<typeof compareDeclared> }[] = [];
  const usum = (units: Record<string, unknown>[], k: string) =>
    units.reduce((a, u) => a + (typeof u[k] === "number" ? (u[k] as number) : 0), 0);
  let declaredReg = false, declaredMeasure = false, declaredOther = false;
  // 参与过申报核对的文件数：让 UI 能区分「已核对无差异」和「没有可核对的申报口径」
  let declaredChecked = 0;
  // 同一文件重导会产生多条「文件汇总:」事实——facts 已倒序，按 key 去重只取最新一版
  const seenSummary = new Set<string>();
  for (const f of facts.filter((x) => x.key.startsWith("文件汇总:") && !seenSummary.has(x.key) && seenSummary.add(x.key))) {
    const filename = f.key.slice("文件汇总:".length);
    const fileId = files.find((x) => x.filename === filename)?.id;
    const fileItems = fileId ? items.filter((i) => i.fileId === fileId) : [];
    if (!fileItems.length) continue;
    try {
      const units = JSON.parse(f.value) as Record<string, unknown>[];
      if (usum(units, "规费") > 0) declaredReg = true;
      if (usum(units, "措施项目费") > 0) declaredMeasure = true;
      if (usum(units, "其他项目费") > 0) declaredOther = true;
      const checks = compareDeclared(feeSummary(fileItems, fees).rows, units);
      declaredChecked++;
      if (checks.length) declaredCheck.push({ file: filename, checks });
    } catch { /* skip malformed fact */ }
  }
  const missing = ["地区", "价格期", "税率"].filter(key => !facts.find(f => f.key === key)?.value.trim());
  // 申报口径里含该项费用、而我们没有取数途径 → 列为缺失设置，
  // 「补计价设置」一步就能指引到真正造成口径差异的费率（规费是税金/合计差异主因）。
  if (declaredReg && !fees.set.regulation) missing.push("规费费率");
  if (declaredMeasure && !fees.set.measure && !fees.coeffMeasureFee.gt(0)
    && !items.some(i => i.feeType === "单价措施" || i.feeType === "总价措施")) missing.push("措施费率");
  if (declaredOther && !fees.set.provisional && !items.some(i => i.feeType === "其他项目")) missing.push("暂列金额率");
  return NextResponse.json({ ...totals, fees: summary, declaredCheck: declaredCheck.length ? declaredCheck : null, declaredChecked, disciplines: aggregateByDiscipline(items).slices, missingSettings: missing });
}
