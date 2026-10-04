import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

// 生产也挂 globalThis：Next 每个路由独立 module graph，不共享的话
// 同进程会持有多个 PrismaClient——SQLite 上就是多余的文件句柄/锁竞争
globalForPrisma.prisma = prisma;

// WAL 模式：默认 delete journal 下任何写事务都排他锁库——导入/Agent 写回期间
// 清单拉取、SSE 回放、summary 全部排队。WAL 让读不被写堵（单写多读并发）。
// 幂等（写进 db 文件持久生效），失败不致命。
void prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL").catch(() => {});
void prisma.$queryRawUnsafe("PRAGMA synchronous=NORMAL").catch(() => {});
