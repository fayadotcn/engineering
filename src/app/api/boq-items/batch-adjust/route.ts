import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { toJson } from "@shared/json";
import { updateBoqItems, type BoqPatch } from "@boq/service";
import { findLiveRun } from "@agent/runtime";
import { D, round2, round3 } from "@cost-engine/money";
import { z } from "zod";

const adj = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
  field: z.enum(["unitPrice", "quantity", "mainMaterialPrice"]),
  /** percent: value 是增减百分比（-5 = 下浮 5%）；value: 统一设为该值 */
  mode: z.enum(["percent", "value"]),
  value: z.string().max(40),
}).strict();

const FIELD_LABEL: Record<string, string> = {
  unitPrice: "综合单价",
  quantity: "工程量",
  mainMaterialPrice: "主材暂估价",
};

// 多选行批量调价/调量（对审下浮、统一暂估价的日常操作）。一次事务 + 一条回执：
// before/after 存整行快照，撤销走通用 revert 路径原子回滚全部行。
export async function POST(req: Request) {
  const parsed = adj.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "批量调整参数无效" }, { status: 400 });
  const { ids, field, mode, value } = parsed.data;
  const num = D(value);
  if (!num.isFinite() || (mode === "value" && num.lt(0)))
    return NextResponse.json({ error: "请输入有效数字（设为值不能为负）" }, { status: 400 });
  if (mode === "percent" && num.lte(-100))
    return NextResponse.json({ error: "下浮不能超过 100%" }, { status: 400 });

  const rows = await prisma.boqItem.findMany({
    where: { id: { in: ids } },
    select: { id: true, projectId: true, isHeader: true, feeType: true, unitPrice: true, quantity: true, mainMaterialPrice: true },
  });
  if (rows.length !== ids.length || new Set(rows.map((r) => r.projectId)).size !== 1)
    return NextResponse.json({ error: "清单行不存在或不属于同一工程" }, { status: 404 });
  if (rows.some((r) => r.isHeader))
    return NextResponse.json({ error: "分部标题不能参与批量调整" }, { status: 400 });
  // 总价措施/其他项目是总额计价行：没有单价×量的结构，按比例调量/调价没有意义
  if (field !== "mainMaterialPrice" && rows.some((r) => r.feeType === "总价措施" || r.feeType === "其他项目"))
    return NextResponse.json({ error: "所选行含总额计价行（总价措施/其他项目），请单独改合价" }, { status: 400 });
  if (await findLiveRun(rows[0].projectId))
    return NextResponse.json({ error: "有任务正在执行，完成或取消后再调整" }, { status: 409 });

  const patches = rows.map((r) => {
    const cur = D(String(r[field]));
    const next = mode === "percent" ? cur.mul(num.div(100).plus(1)) : num;
    const str = field === "quantity" ? round3(next).toString() : round2(next).toString();
    return { id: r.id, patch: { [field]: str } as BoqPatch };
  });
  const desc = mode === "percent"
    ? `${FIELD_LABEL[field]}统一${num.lt(0) ? "下浮" : "上浮"} ${num.abs()}%`
    : `${FIELD_LABEL[field]}统一设为 ${round2(num)}`;
  // 更新 + 回执单事务：回执失败不留无审计的批量修改
  try {
    const { changed, receiptId } = await prisma.$transaction(async (tx) => {
      const { before, after } = await updateBoqItems(rows[0].projectId, patches, tx);
      const changed = after.filter((a) => {
        const b = before.find((x) => x.id === a.id);
        return b && String(b[field]) !== String(a[field]);
      });
      if (!changed.length) throw new Error("所选行的值已是目标值，没有变化");
      const receipt = await tx.actionReceipt.create({
        data: {
          projectId: rows[0].projectId,
          actionType: "USER_EDIT",
          summary: `用户在工作区批量调整 ${changed.length} 行清单：${desc}`,
          before: toJson(before),
          after: toJson(after),
          createdBy: "user",
        },
      });
      return { changed, receiptId: receipt.id as string };
    });
    return NextResponse.json({ updated: changed.length, receiptId, affectedIds: changed.map((c) => c.id) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "批量调整失败" }, { status: 400 });
  }
}
