import { NextResponse } from "next/server";
import { revertReceipt, RevertError } from "@boq/revert";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const result = await revertReceipt(id, { createdBy: "user" });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof RevertError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
