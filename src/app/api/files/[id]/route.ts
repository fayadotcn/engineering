import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { storage } from "@file/storage";
import { toJson } from "@shared/json";

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const file = await prisma.projectFile.findUnique({ where: { id } });
  if (!file) return NextResponse.json({ error: "not found" }, { status: 404 });
  const removed = await prisma.boqItem.count({ where: { fileId: id } });
  const quotes = await prisma.quotationItem.count({ where: { fileId: id } });
  // 数据行+文件记录+回执一个事务：任何一步失败不留半成品删除；
  // 盘文件最后删——失败只留孤儿文件（无引用），不会让 DB 记录指向已消失的存储。
  // 文件级事实（文件汇总/推导税率等 sourceFileId 行）随文件一起删除；
  // 用户手工改写的台账是新行、不带 sourceFileId，不受影响。
  await prisma.$transaction([
    prisma.costFact.deleteMany({ where: { sourceFileId: id } }),
    prisma.boqItem.deleteMany({ where: { fileId: id } }),
    prisma.quotationItem.deleteMany({ where: { fileId: id } }),
    prisma.projectFile.delete({ where: { id } }),
    prisma.actionReceipt.create({
      data: {
        projectId: file.projectId,
        actionType: "FILE_DELETE",
        summary: `删除文件「${file.filename}」及其导入数据（清单 ${removed} 行，询价 ${quotes} 条）`,
        before: toJson({ fileId: id, removed, quotes }),
        after: toJson({}),
        reversible: false,
        createdBy: "user",
      },
    }),
  ]);
  await storage.delete(file.storageKey).catch(() => {});
  return NextResponse.json({ ok: true, removed, quotes });
}
