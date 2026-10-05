import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { revertReceipt, RevertError } from "@boq/revert";
import { findLiveRun } from "@agent/runtime";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    // 活 run 期间禁撤销：run 正在写清单时撤销事务会拿旧快照过「后续修改」检查，
    // 把 run 刚写入的值覆盖掉（UI 已拦按钮，这里是服务端兜底口径，
    // 与文件删除/重导路由的活 run 守卫一致）
    const receipt = await prisma.actionReceipt.findUnique({ where: { id }, select: { projectId: true } });
    if (!receipt) return NextResponse.json({ error: "记录不存在" }, { status: 404 });
    if (await findLiveRun(receipt.projectId))
      return NextResponse.json({ error: "有任务正在执行，完成或取消后再撤销" }, { status: 409 });
    const result = await revertReceipt(id, { createdBy: "user" });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof RevertError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
