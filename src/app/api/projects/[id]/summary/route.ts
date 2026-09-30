import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { listBoq } from "@boq/service";
import { projectTotals, aggregateByDiscipline } from "@cost-engine/aggregate";
import { feeSummary } from "@cost-engine/fees";
import { getFacts, loadFeeParams } from "@project/facts";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!await prisma.project.findUnique({ where: { id } })) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  const [items, facts, fees] = await Promise.all([listBoq(id), getFacts(id), loadFeeParams(id)]);
  const totals = projectTotals(items);
  return NextResponse.json({ ...totals, fees: feeSummary(items, fees), disciplines: aggregateByDiscipline(items).slices, missingSettings: ["地区", "价格期", "税率"].filter(key => !facts.find(f => f.key === key)?.value.trim()) });
}
