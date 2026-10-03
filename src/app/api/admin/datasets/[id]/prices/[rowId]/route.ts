import { NextResponse } from "next/server";
import { deletePriceRow, updatePriceRow } from "@dataset/service";

export const dynamic = "force-dynamic";

// 单行价格维护：PATCH 改字段，DELETE 删行（均校验属于该数据集）
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; rowId: string }> }
) {
  const { id, rowId } = await params;
  const body = (await req.json()) as Parameters<typeof updatePriceRow>[2];
  if (body.price !== undefined && (!Number.isFinite(Number(body.price)) || Number(body.price) < 0))
    return NextResponse.json({ error: "单价必须是 ≥0 的数字" }, { status: 400 });
  if (body.name !== undefined && !body.name.trim())
    return NextResponse.json({ error: "名称不能为空" }, { status: 400 });
  const row = await updatePriceRow(id, rowId, body);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(row);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; rowId: string }> }
) {
  const { id, rowId } = await params;
  const ok = await deletePriceRow(id, rowId);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok });
}
