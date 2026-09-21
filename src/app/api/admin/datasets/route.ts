import { NextResponse } from "next/server";
import { createDataset, listDatasets, type DatasetKind } from "@dataset/service";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await listDatasets());
}

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file") as File | null;
  const kind = (form.get("kind") as string | null) ?? "GENERIC";
  if (!file) return NextResponse.json({ error: "file required" }, { status: 400 });
  if (!["MATERIAL_PRICE", "QUOTA", "GENERIC"].includes(kind))
    return NextResponse.json({ error: "invalid kind" }, { status: 400 });

  const filename = (form.get("filename") as string | null)?.trim() || file.name;
  const buffer = Buffer.from(await file.arrayBuffer());
  const ds = await createDataset(kind as DatasetKind, filename, buffer);
  return NextResponse.json(ds);
}
