import { NextResponse } from "next/server";
import { getDatasetMapping, saveDatasetMapping } from "@dataset/service";

export const dynamic = "force-dynamic";

// 数据集列映射：材料价格库上传后管理员在这里核对/修正映射，再触发 ingest 导行。
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const data = await getDatasetMapping(id);
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(data);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = (await req.json()) as {
    sheetName?: string;
    columns?: Record<string, number | null>;
    type?: "BOQ" | "QUOTATION" | "GENERIC";
  };
  if (!body.sheetName)
    return NextResponse.json({ error: "sheetName required" }, { status: 400 });
  const data = await saveDatasetMapping(id, body.sheetName, body.columns, body.type);
  if (!data)
    return NextResponse.json({ error: "sheet 不存在" }, { status: 404 });
  return NextResponse.json(data);
}
