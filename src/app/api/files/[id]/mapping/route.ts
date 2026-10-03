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

  const { file, mapping, isPdf } = await ensureInspection(id);
  if (isPdf || !mapping)
    return NextResponse.json({ error: "PDF 文件没有列映射" }, { status: 400 });
  const sheet = mapping[body.sheetName];
  if (!sheet)
    return NextResponse.json({ error: "sheet 不存在" }, { status: 404 });

  applySheetPatch(sheet, body);

  const meta = fromJson<Record<string, unknown>>(file.meta, {});
  meta.mapping = mapping;
  await prisma.projectFile.update({
    where: { id: file.id },
    data: { meta: toJson(meta) },
  });

  return NextResponse.json({ view: mappingToView(file, mapping) });
}
