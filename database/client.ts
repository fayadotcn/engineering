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
