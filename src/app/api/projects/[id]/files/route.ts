import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { storage } from "@file/storage";
import { inferFileStage } from "@file/classify";
import { ActiveRunError, findLiveRun, startRun } from "@agent/runtime";
import { createHash } from "crypto";
import path from "path";

// Upload -> store -> create ProjectFile -> agent ingest run (traced).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  if (!await prisma.project.findUnique({ where: { id: projectId } }))
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "file required" }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!buffer.length) return NextResponse.json({ error: "空文件" }, { status: 400 });
  if (buffer.length > 80 * 1024 * 1024)
    return NextResponse.json({ error: "文件过大（限 80MB）" }, { status: 413 });
  // multipart filename can arrive mojibake from non-UTF8 clients; an explicit
  // `filename` field wins when provided
  const filename = (form.get("filename") as string | null)?.trim() || file.name;
  // 与上传控件 accept 口径一致——不支持的类型不必建档起 run 再失败
  const ext = path.extname(filename).toLowerCase();
  if (![".xls", ".xlsx", ".csv", ".pdf"].includes(ext))
    return NextResponse.json({ error: `不支持的文件类型「${ext || "无扩展名"}」——支持 .xls/.xlsx/.csv/.pdf` }, { status: 400 });
  const contentHash = createHash("sha1").update(buffer).digest("hex");

  // 同项目同内容去重：已解析过的文件不再建记录、不起 run；
  // 上次导入失败/中断的同内容文件直接触发重导（deleteByFile 保证幂等），不堆重复记录
  const dup = await prisma.projectFile.findFirst({
    where: { projectId, contentHash },
    orderBy: { createdAt: "desc" },
  });
  if (dup) {
    if (dup.status === "PARSED")
      return NextResponse.json({ file: dup, runId: null, duplicate: true });
    // 已有进行中的导入任务就直接复用，避免同文件并发导入（deleteByFile 竞态）
    const live = await prisma.agentRun.findFirst({
      where: {
        projectId,
        status: { in: ["RUNNING", "AWAITING_CONFIRM"] },
        userMessage: { contains: `「${dup.filename}」` },
        createdAt: { gt: new Date(Date.now() - 15 * 60 * 1000) },
      },
    });
    if (live) return NextResponse.json({ file: dup, runId: live.id, duplicate: true });
    try {
      const { runId } = await startRun({
        projectId,
        message: `重新导入文件「${dup.filename}」`,
        extra: { ingestFileId: dup.id },
      });
      return NextResponse.json({ file: dup, runId, duplicate: true });
    } catch (e) {
      if (e instanceof ActiveRunError)
        return NextResponse.json({ file: dup, error: "已有任务在执行或等待确认，完成后再导入", runId: e.runId }, { status: 409 });
      throw e;
    }
  }

  // 别的任务在跑就先拒——文件建档后 startRun 被拦会留下永不导入的孤儿记录
  const busy = await findLiveRun(projectId);
  if (busy)
    return NextResponse.json({ error: "已有任务在执行或等待确认，完成后再上传", runId: busy.id }, { status: 409 });

  const storageKey = await storage.put(buffer, ext);

  const { stage, period } = inferFileStage(filename);
  const record = await prisma.projectFile.create({
    data: {
      projectId,
      filename,
      mime: file.type || "application/octet-stream",
      storageKey,
      sizeBytes: buffer.length,
      contentHash,
      stage,
      period,
    },
  });

  // ingest goes through the agent runtime so it's fully traced
  try {
    const { runId } = await startRun({
      projectId,
      message: `分析并导入文件「${filename}」`,
      extra: { ingestFileId: record.id },
    });
    return NextResponse.json({ file: record, runId });
  } catch (e) {
    // 检查到建库之间抢到活 run 的窄窗：记录已建，标出文件让前端能补触发
    if (e instanceof ActiveRunError)
      return NextResponse.json({ file: record, error: "已有任务在执行或等待确认，完成后在文件列表重导", runId: e.runId }, { status: 409 });
    throw e;
  }
}
