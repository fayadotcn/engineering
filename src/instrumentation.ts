// Next instrumentation register()：服务进程启动时执行一次（nodejs runtime）。
// 重启后所有 RUNNING/AWAITING_CONFIRM run 都是僵尸——执行器与确认门 resolver
// 死在旧进程里，立即判 FAILED 让「单项目单活 run」守卫放行新任务。
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { markZombieRunsFailed } = await import("@agent/runtime");
  await markZombieRunsFailed().catch(() => {
    // 清尾失败（如 DB 未就绪）不该阻止服务启动——懒清理兜底
  });
}
