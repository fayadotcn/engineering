import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@database/client";
import { PRICING_FIELDS } from "@shared/settings";
import { getFacts, validatePricingFact, pricingFactType } from "@project/facts";
import { findLiveRun } from "@agent/runtime";
import { toJson } from "@shared/json";

const schema = z.record(z.string().max(80)).refine(values => Object.keys(values).every(key => PRICING_FIELDS.some(f => f.key === key)), "包含未知设置");

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "计价设置格式无效" }, { status: 400 });
  if (!await prisma.project.findUnique({ where: { id } })) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  // 活 run 会按 loadFeeParams 快照取费率执行测算——run 中途改设置，同一任务
  // 前后两段用的费率口径就不同了（外部写守卫，与清单写路由同口径）
  if (await findLiveRun(id))
    return NextResponse.json({ error: "有任务正在执行，完成或取消后再修改设置" }, { status: 409 });
  const values = Object.fromEntries(Object.entries(parsed.data).map(([key, value]) => [key, value.trim()]));
  try { for (const [key, value] of Object.entries(values)) validatePricingFact(key, value); }
  catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }); }
  const facts = await getFacts(id);
  const changed = Object.entries(values).filter(([key, value]) => (facts.find(f => f.key === key)?.value ?? "") !== value);
  await prisma.$transaction([
    ...changed.map(([key, value]) => prisma.costFact.create({ data: { projectId: id, factType: pricingFactType(key) ?? "CUSTOM", key, value, source: "USER_PROVIDED", createdBy: "user" } })),
    ...(changed.length ? [prisma.actionReceipt.create({ data: { projectId: id, actionType: "SETTINGS_UPDATE", summary: `修改计价设置：${changed.map(([k]) => k).join("、")}`, before: toJson(Object.fromEntries(changed.map(([key]) => [key, facts.find(f => f.key === key)?.value ?? ""]))), after: toJson(Object.fromEntries(changed)), reversible: false, createdBy: "user" } })] : []),
  ]);
  return NextResponse.json({ facts: await getFacts(id) });
}
