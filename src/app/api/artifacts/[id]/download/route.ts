import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { storage } from "@file/storage";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const artifact = await prisma.artifact.findUnique({ where: { id } });
  if (!artifact) return NextResponse.json({ error: "not found" }, { status: 404 });
  const buf = await storage.get(artifact.storageKey);
  return new Response(new Uint8Array(buf), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.label)}`,
    },
  });
}
