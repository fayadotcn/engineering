import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { deleteByFile } from "@boq/service";
import { storage } from "@file/storage";
import { toJson } from "@shared/json";

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const file = await prisma.projectFile.findUnique({ where: { id } });
  if (!file) return NextResponse.json({ error: "not found" }, { status: 404 });
  const removed = await prisma.boqItem.count({ where: { fileId: id } });
  const quotes = await prisma.quotationItem.count({ where: { fileId: id } });
  // 文件级事实（文件汇总/推导税率等 sourceFileId 行）随文件一起删除；
  // 用户手工改写的台账是新行、不带 sourceFileId，不受影响。
  const orphanFacts = await prisma.costFact.deleteMany({ where: { sourceFileId: id } });
  await deleteByFile(id);
  await storage.delete(file.storageKey);
  await prisma.projectFile.delete({ where: { id } });
  await prisma.actionReceipt.create({
    data: {
      projectId: file.projectId,
      actionType: "FILE_DELETE",
      summary: `删除文件「${file.filename}」及其导入数据（清单 ${removed} 行，询价 ${quotes} 条）`,
      before: toJson({ fileId: id, removed, quotes }),
      after: toJson({}),
      reversible: false,
      createdBy: "user",
    },
  });
  return NextResponse.json({ ok: true, removed, quotes });
}
