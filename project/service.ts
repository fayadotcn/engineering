import { prisma } from "@database/client";

export async function ensureDefaultWorkspace() {
  const ws = await prisma.workspace.findFirst();
  if (ws) return ws;
  // 固定 id upsert：两个并发首建请求都过了 findFirst 时，
  // upsert 保证只落一行（后到的走 update 分支返回同一工作区）
  return prisma.workspace.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default", name: "默认工作区" },
  });
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
    include: { _count: { select: { boqItems: { where: { isHeader: false } }, files: true } } },
  });
}

export async function getProject(id: string) {
  return prisma.project.findUnique({
    where: { id },
    include: {
      files: { orderBy: { createdAt: "desc" } },
      facts: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 300 },
      artifacts: { orderBy: { createdAt: "desc" } },
    },
  });
}
