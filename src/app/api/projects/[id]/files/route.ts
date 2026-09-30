import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { storage } from "@file/storage";
import { startRun } from "@agent/runtime";
import { createHash } from "crypto";
import path from "path";

// Upload -> store -> create ProjectFile -> agent ingest run (traced).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "file required" }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  // multipart filename can arrive mojibake from non-UTF8 clients; an explicit
  // `filename` field wins when provided
  const filename = (form.get("filename") as string | null)?.trim() || file.name;
  const contentHash = createHash("sha1").update(buffer).digest("hex");

  // 同项目同内容去重：已解析过的文件不再建记录、不起 run
  const dup = await prisma.projectFile.findFirst({
    where: { projectId, contentHash, status: "PARSED" },
    orderBy: { createdAt: "desc" },
  });
  if (dup) return NextResponse.json({ file: dup, runId: null, duplicate: true });

  const ext = path.extname(filename) || ".bin";
  const storageKey = await storage.put(buffer, ext);

  const record = await prisma.projectFile.create({
    data: {
      projectId,
      filename,
      mime: file.type || "application/octet-stream",
      storageKey,
      sizeBytes: buffer.length,
      contentHash,
    },
  });

  // ingest goes through the agent runtime so it's fully traced
  const { runId } = await startRun({
    projectId,
    message: `分析并导入文件「${file.name}」`,
    extra: { ingestFileId: record.id },
  });

  return NextResponse.json({ file: record, runId });
}
