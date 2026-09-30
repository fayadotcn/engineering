import { NextResponse } from "next/server";
import { createPriceRow, listPriceRows } from "@dataset/service";

export const dynamic = "force-dynamic";

// 价格库行分页检索：?q=&brand=&region=&period=&priceType=&page=&pageSize=
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sp = new URL(req.url).searchParams;
  const num = (k: string) => {
    const v = sp.get(k);
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) ? n : undefined;
  };
  const data = await listPriceRows(id, {
    q: sp.get("q") ?? undefined,
    brand: sp.get("brand") ?? undefined,
    region: sp.get("region") ?? undefined,
    period: sp.get("period") ?? undefined,
    priceType: sp.get("priceType") ?? undefined,
    page: num("page"),
    pageSize: num("pageSize"),
  });
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(data);
}

// 手工补录一行：name 必填、price 必须是有限数字（其余字段可选，服务端归一化）
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = (await req.json()) as {
    name?: string;
    spec?: string;
    unit?: string;
    brand?: string;
    price?: number | string;
    priceType?: string;
    region?: string;
    period?: string;
  };
  if (!body.name?.trim())
    return NextResponse.json({ error: "名称必填" }, { status: 400 });
  const price = Number(body.price);
  if (!Number.isFinite(price) || price < 0)
    return NextResponse.json({ error: "单价必须是 ≥0 的数字" }, { status: 400 });
  const row = await createPriceRow(id, { ...body, name: body.name, price });
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(row, { status: 201 });
}
