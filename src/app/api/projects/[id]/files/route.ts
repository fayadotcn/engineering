import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { storage } from "@file/storage";
import { inferFileStage } from "@file/classify";
import { ActiveRunError, findLiveRun, liveRunWhere, startRun } from "@agent/runtime";
import { createHash } from "node:crypto";
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
        ...liveRunWhere(),
        userMessage: { contains: `「${dup.filename}」` },
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
  let record;
  try {
    record = await prisma.projectFile.create({
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
  } catch (e) {
    // 建档失败的存储块是孤儿——不落库的文件拿不到 storageKey 回收点
    await storage.delete(storageKey);
    throw e;
  }

  // ingest goes through the agent runtime so it's fully traced
  try {
    const { runId } = await startRun({
      projectId,
      message: `分析并导入文件「${filename}」`,
      extra: { ingestFileId: record.id },
    });
    return NextResponse.json({ file: record, runId });
  } catch (e) {
    if (e instanceof ActiveRunError) {
      // 并发双上传竞态：同内容兄弟记录已抢到 run——本记录是字节级重复，
      // 留着会在文件列表出现双份且重导会二次入库同字节清单，删记录+回收存储块
      const sibling = await prisma.projectFile.findFirst({
        where: { projectId, contentHash, id: { not: record.id } },
        orderBy: { createdAt: "desc" },
      });
      if (sibling) {
        await prisma.projectFile.delete({ where: { id: record.id } }).catch(() => {});
        await storage.delete(storageKey);
        return NextResponse.json({ file: sibling, runId: e.runId, duplicate: true });
      }
      // 活 run 是别的文件：记录已建，标出让前端能补触发
      return NextResponse.json({ file: record, error: "已有任务在执行或等待确认，完成后在文件列表重导", runId: e.runId }, { status: 409 });
    }
    throw e;
  }
}
