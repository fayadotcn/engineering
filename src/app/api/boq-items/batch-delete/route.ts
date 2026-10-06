import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { toJson } from "@shared/json";
import { findLiveRun } from "@agent/runs";
import { z } from "zod";

const body = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) }).strict();

// 批量删除只记一条回执：撤销时一次恢复全部，操作记录里也只有一行账。
// before 快照带全字段，revert 走 recreate 路径原样重建。
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "请求内容无效" }, { status: 400 });
  const ids = [...new Set(parsed.data.ids)];
  const items = await prisma.boqItem.findMany({ where: { id: { in: ids } } });
  if (items.length !== ids.length) return NextResponse.json({ error: "部分清单行不存在或已被删除，请刷新后重试" }, { status: 409 });
  const projectIds = new Set(items.map((i) => i.projectId));
  if (projectIds.size !== 1) return NextResponse.json({ error: "只能删除同一项目内的清单行" }, { status: 400 });
  const projectId = items[0].projectId;
  if (await findLiveRun(projectId))
    return NextResponse.json({ error: "有任务正在执行，完成或取消后再删除" }, { status: 409 });
  const [receipt] = await prisma.$transaction([
    prisma.actionReceipt.create({
      data: {
        projectId,
        actionType: "USER_EDIT",
        summary: `用户在工作区批量删除 ${items.length} 行清单`,
        before: toJson(items),
        after: toJson([]),
        createdBy: "user",
      },
    }),
    prisma.boqItem.deleteMany({ where: { id: { in: ids } } }),
  ]);
  return NextResponse.json({ deleted: items.length, receiptId: receipt.id });
}
