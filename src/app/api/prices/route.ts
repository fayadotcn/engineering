import { NextResponse } from "next/server";
import { searchMaterialPrices } from "@dataset/service";

export const dynamic = "force-dynamic";

// 共享价格库检索：所有用户共用的材料/人工价格数据，跨项目只读。
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q") ?? "";
  const take = Math.min(Number(searchParams.get("take") ?? 50) || 50, 200);
  return NextResponse.json({ rows: await searchMaterialPrices(q, take) });
}
