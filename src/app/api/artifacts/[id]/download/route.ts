import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { storage } from "@file/storage";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const artifact = await prisma.artifact.findUnique({ where: { id } });
  if (!artifact) return NextResponse.json({ error: "not found" }, { status: 404 });
  // 与 files 下载同口径——存储块丢失/被清理时给明确 410 而不是裸 500
  const buf = await storage.get(artifact.storageKey).catch(() => null);
  if (!buf) return NextResponse.json({ error: "文件已不在存储中" }, { status: 410 });
  return new Response(new Uint8Array(buf), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.label)}`,
    },
  });
}
