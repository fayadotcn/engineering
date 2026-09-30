import { NextResponse } from "next/server";
import { listBoq } from "@boq/service";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // 列表接口不带 rawCells（整行原文 JSON，大表会翻倍 payload），DB 层就不读；
  // 服务端工具仍可通过 listBoq/单条接口拿到
  const items = await listBoq(id, { rawCells: false });
  return NextResponse.json(
    items.map(({ rawCells: _rawCells, ...rest }) => rest)
  );
}
