import { prisma } from "@database/client";

export async function ensureDefaultWorkspace() {
  const ws = await prisma.workspace.findFirst();
  if (ws) return ws;
  return prisma.workspace.create({ data: { name: "默认工作区" } });
}

export async function createProject(name: string) {
  const ws = await ensureDefaultWorkspace();
  return prisma.project.create({
    data: { name, workspaceId: ws.id },
  });
}

export async function listProjects() {
  return prisma.project.findMany({
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { boqItems: true, files: true } } },
  });
}

export async function getProject(id: string) {
  return prisma.project.findUnique({
    where: { id },
    include: {
      files: { orderBy: { createdAt: "desc" } },
      facts: { orderBy: { createdAt: "desc" } },
      artifacts: { orderBy: { createdAt: "desc" } },
    },
  });
}
