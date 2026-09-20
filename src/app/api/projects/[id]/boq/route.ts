import { NextResponse } from "next/server";
import { listBoq } from "@boq/service";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(await listBoq(id));
}
