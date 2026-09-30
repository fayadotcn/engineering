import { NextResponse } from "next/server";
import { ingestDataset } from "@dataset/service";

export const dynamic = "force-dynamic";

// 按当前（可能已被管理员修正的）列映射导入/重导数据集，幂等。
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const r = await ingestDataset(id);
  if (!r) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(r);
}
