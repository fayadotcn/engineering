import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { storage } from "@file/storage";

// 上传源文件取回：交付留档/核对原始表需要下载原件。

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const file = await prisma.projectFile.findUnique({ where: { id } });
  if (!file) return NextResponse.json({ error: "not found" }, { status: 404 });
  const buf = await storage.get(file.storageKey).catch(() => null);
  if (!buf) return NextResponse.json({ error: "原文件已不在存储中" }, { status: 410 });
  const ext = (file.filename.match(/\.(\w+)$/)?.[1] ?? "").toLowerCase();
  const ct =
    ext === "pdf"
      ? "application/pdf"
      : ext === "xls"
        ? "application/vnd.ms-excel"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return new Response(new Uint8Array(buf), {
    headers: {
      "content-type": ct,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    },
  });
}
