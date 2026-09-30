import { prisma } from "../database/client";

/** 删除一个工程及其全部从属行（schema 未声明级联，必须按依赖顺序手动清理）。 */
async function main() {
  const id = process.argv[2];
  if (!id) throw new Error("用法: tsx scripts/delete-project.ts <projectId>");
  const project = await prisma.project.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!project) { console.log("工程不存在:", id); return; }

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
  console.log(`已删除工程「${project.name}」及其 ${runIds.length} 个 run`);
}

void main().finally(() => prisma.$disconnect());
