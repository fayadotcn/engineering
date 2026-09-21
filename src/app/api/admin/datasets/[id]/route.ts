import { NextResponse } from "next/server";
import { deleteDataset, getDatasetRows, setDatasetActive } from "@dataset/service";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const data = await getDatasetRows(id);
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(data);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  if (typeof body.active !== "boolean")
    return NextResponse.json({ error: "active required" }, { status: 400 });
  return NextResponse.json(await setDatasetActive(id, body.active));
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ok = await deleteDataset(id);
  return NextResponse.json({ ok });
}
