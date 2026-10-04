import { NextResponse } from "next/server";
import { loadSummaryPayload } from "@project/payload";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const payload = await loadSummaryPayload(id);
  if (!payload) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  return NextResponse.json(payload);
}
