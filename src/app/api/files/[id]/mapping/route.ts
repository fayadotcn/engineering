import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { applySheetPatch, ensureInspection, mappingToView } from "@file/inspection";
import type { SheetType } from "@file/excel";
import { fromJson, toJson } from "@shared/json";

// 用户在「列映射」视图手工调整后的保存：一列只能一个角色，null = 取消该角色。
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = (await req.json()) as {
    sheetName?: string;
    columns?: Record<string, number | null>;
    type?: SheetType;
  };
  if (!body.sheetName)
    return NextResponse.json({ error: "sheetName required" }, { status: 400 });
  const sheetName = body.sheetName;

  let inspected: Awaited<ReturnType<typeof ensureInspection>>;
  try {
    inspected = await ensureInspection(id);
  } catch {
    return NextResponse.json({ error: "文件不存在" }, { status: 404 });
  }
  const { file, mapping, isPdf } = inspected;
  if (isPdf || !mapping)
    return NextResponse.json({ error: "PDF 文件没有列映射" }, { status: 400 });
  const sheet = mapping[sheetName];
  if (!sheet)
    return NextResponse.json({ error: "sheet 不存在" }, { status: 404 });

  // 读-改-写竞态：两个并发 PATCH（不同 sheet）或导入写 meta 时，
  // 拿请求开始时的 meta 整写会丢对方改动——事务内重读最新 meta 再打补丁
  const finalMapping = await prisma.$transaction(async (tx) => {
    const fresh = await tx.projectFile.findUnique({ where: { id: file.id }, select: { meta: true } });
    const meta = fromJson<Record<string, unknown>>(fresh?.meta ?? "{}", {});
    const latest = meta.mapping as typeof mapping | undefined;
    const target = latest?.[sheetName];
    if (!target) return null; // 提交间隙 sheet 被重识别改名/删除
    applySheetPatch(target, body);
    meta.mapping = latest;
    await tx.projectFile.update({ where: { id: file.id }, data: { meta: toJson(meta) } });
    return latest;
  });
  if (!finalMapping)
    return NextResponse.json({ error: "sheet 不存在" }, { status: 404 });

  return NextResponse.json({ view: mappingToView(file, finalMapping) });
}
