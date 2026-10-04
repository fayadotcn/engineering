import { NextResponse } from "next/server";
import { loadRunsPayload } from "@project/payload";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(await loadRunsPayload(id));
}
