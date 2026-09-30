import { prisma } from "@database/client";

export async function ensureDefaultWorkspace() {
  const ws = await prisma.workspace.findFirst();
  if (ws) return ws;
  return prisma.workspace.create({ data: { name: "默认工作区" } });
}

export async function createProject(name: string) {
  name = name.trim();
  if (!name || name.length > 120) throw new Error("工程名称应为 1–120 个字符");
  const ws = await ensureDefaultWorkspace();
  return prisma.$transaction(async tx => {
    const project = await tx.project.create({ data: { name, workspaceId: ws.id } });
    await tx.actionReceipt.create({ data: { projectId: project.id, actionType: "PROJECT_CREATE", summary: `创建工程：${name}`, before: "{}", after: JSON.stringify({ name }), reversible: false, createdBy: "user" } });
    return project;
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
      facts: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] },
      artifacts: { orderBy: { createdAt: "desc" } },
    },
  });
}
