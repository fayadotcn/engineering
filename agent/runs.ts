import { prisma } from "@database/client";

export class ActiveRunError extends Error {
  constructor(public runId: string) {
    super("已有任务在执行或等待确认");
  }
}

// 活 run 判定窗口与文件删除/reingest 守卫同口径：超窗视为僵尸 run 不再拦截
export const LIVE_WINDOW_MS = 15 * 60 * 1000;

/**
 * 活 run 查询条件：RUNNING 按创建窗口判（超窗=僵尸，懒清理）；
 * AWAITING_CONFIRM 不按窗判——本进程里它必然配对一个活 resolver
 * （确认门 10 分钟超时即收口），创建超窗只是「跑了很久才到确认门」，
 * 按 createdAt 判死会放行第二个 run 并发写清单（真实竞态）。
 */
export const liveRunWhere = () => ({
  status: { in: ["RUNNING", "AWAITING_CONFIRM"] },
  OR: [
    { status: "AWAITING_CONFIRM" },
    { createdAt: { gt: new Date(Date.now() - LIVE_WINDOW_MS) } },
  ],
});

/**
 * 进程启动时清尾：RUNNING/AWAITING_CONFIRM 的执行器与确认门 resolver 只活在
 * 旧进程内存里，重启后这些 run 永远不可能结束——立即判 FAILED，释放
 * 「单项目单活 run」守卫，用户不必等 15 分钟懒清理窗口。
 */
export function markZombieRunsFailed() {
  return prisma.agentRun.updateMany({
    where: { status: { in: ["RUNNING", "AWAITING_CONFIRM"] } },
    data: {
      status: "FAILED",
      summary: "服务重启，任务中断，请重新发送",
      finishedAt: new Date(),
    },
  });
}

/** 外部写路由的活 run 守卫：RUNNING/AWAITING_CONFIRM 期间一律 409——run 写盘
 *  中途插入的用户写会拿入口快照过校验再覆盖 run 的新值（丢失更新）。UI 已拦
 *  按钮，这是服务端兜底；文件映射 PATCH 不能用——待确认导入本就要求用户改映射。 */
export function findLiveRun(projectId: string) {
  return prisma.agentRun.findFirst({
    where: { projectId, ...liveRunWhere() },
    select: { id: true },
  });
}

// Concurrent first requests must await the same startup sweep before creating any run.
const state = globalThis as typeof globalThis & { __runInitialization?: Promise<void> };
function initializeRuns(): Promise<void> {
  return state.__runInitialization ??= markZombieRunsFailed().then(() => {}, (error) => {
    delete state.__runInitialization;
    throw error;
  });
}

export async function createAgentRun(input: { projectId: string; message: string; planner: string }) {
  await initializeRuns();
  return prisma.$transaction(async (tx) => {
    const live = await tx.agentRun.findFirst({
      where: { projectId: input.projectId, ...liveRunWhere() },
      select: { id: true },
    });
    if (live) throw new ActiveRunError(live.id);
    return tx.agentRun.create({
      data: { projectId: input.projectId, userMessage: input.message, planner: input.planner },
    });
  });
}

export function finishAgentRun(runId: string, status: "DONE" | "CANCELLED" | "FAILED", summary?: string) {
  return prisma.agentRun.update({
    where: { id: runId },
    data: { status, pendingAction: "{}", ...(summary !== undefined ? { summary } : {}), finishedAt: new Date() },
  });
}
