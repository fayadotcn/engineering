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
  // 价格库/定额库只认表格——非表格类型建了档也解析不出列映射（GENERIC 参考资料不限）
  if (kind !== "GENERIC") {
    const ext = filename.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? "";
    if (![".xls", ".xlsx", ".csv"].includes(ext))
      return NextResponse.json({ error: `数据集只支持表格文件（.xls/.xlsx/.csv），收到「${ext || "无扩展名"}」` }, { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  if (!buffer.length) return NextResponse.json({ error: "空文件" }, { status: 400 });
  if (buffer.length > 80 * 1024 * 1024)
    return NextResponse.json({ error: "文件过大（限 80MB）" }, { status: 413 });
  // 上传时可选带的行级默认值（材料价格库：地区/期次/价格类型/品牌）
  const text = (k: string) => (form.get(k) as string | null)?.trim() || undefined;
  const ds = await createDataset(kind as DatasetKind, filename, buffer, {
    brand: text("brand"),
    region: text("region"),
    period: text("period"),
    priceType: text("priceType"),
  });
  return NextResponse.json(ds);
}
