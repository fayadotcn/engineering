import { prisma } from "../database/client";
import { storage } from "../file/storage";

/** 删除一个工程及其全部从属行（schema 未声明级联，必须按依赖顺序手动清理）。
 *  物理文件（源文件 storageKey + 导出工件）同步清除，不留孤儿。 */
async function main() {
  const id = process.argv[2];
  if (!id) throw new Error("用法: tsx scripts/delete-project.ts <projectId>");
  const project = await prisma.project.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!project) { console.log("工程不存在:", id); return; }

  // 先收集物理文件键，DB 删除后再清盘
  const fileKeys = (await prisma.projectFile.findMany({ where: { projectId: id }, select: { storageKey: true } })).map((f) => f.storageKey);
  const artifactKeys = (await prisma.artifact.findMany({ where: { projectId: id }, select: { storageKey: true } })).map((a) => a.storageKey);
  const runs = await prisma.agentRun.findMany({ where: { projectId: id }, select: { id: true } });
  const runIds = runs.map((r) => r.id);
  await prisma.agentEvent.deleteMany({ where: { runId: { in: runIds } } });
  await prisma.toolCall.deleteMany({ where: { projectId: id } });
  await prisma.actionReceipt.deleteMany({ where: { projectId: id } });
  await prisma.agentRun.deleteMany({ where: { projectId: id } });
  await prisma.boqItem.deleteMany({ where: { projectId: id } });
  await prisma.quotationItem.deleteMany({ where: { projectId: id } });
  await prisma.costFact.deleteMany({ where: { projectId: id } });
  await prisma.artifact.deleteMany({ where: { projectId: id } });
  await prisma.projectFile.deleteMany({ where: { projectId: id } });
  await prisma.project.delete({ where: { id } });
  // DB 清完再删物理文件（与文件删除路由同口径：先 DB 后 storage，避免 FK 问题）
  let filesDeleted = 0;
  for (const key of [...fileKeys, ...artifactKeys])
    await storage.delete(key).then(() => filesDeleted++).catch(() => {});
  console.log(`已删除工程「${project.name}」及其 ${runIds.length} 个 run、${filesDeleted} 个物理文件`);
}

void main().finally(() => prisma.$disconnect());
