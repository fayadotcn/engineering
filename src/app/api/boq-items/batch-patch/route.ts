import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { toJson } from "@shared/json";
import { updateBoqItems, type BoqPatch } from "@boq/service";
import { D } from "@cost-engine/money";
import { z } from "zod";

const patch = z.object({
  id: z.string().min(1),
  quantity: z.string().max(80).optional(),
  unitPrice: z.string().max(40).optional(),
  mainMaterialPrice: z.string().max(40).optional(),
}).strict();
const body = z.object({ patches: z.array(patch).min(1).max(500) }).strict();

/**
 * Excel 粘回管道：把剪贴板里的工程量/综合单价按行写回所选清单行。
 * 一次事务 + 一条回执（before/after 整行快照），撤销走通用 revert 原子回滚。
 */
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "粘贴更新参数无效" }, { status: 400 });
  const { patches } = parsed.data;
  const ids = patches.map((p) => p.id);

  const rows = await prisma.boqItem.findMany({
    where: { id: { in: ids } },
    select: { id: true, projectId: true, isHeader: true, feeType: true },
  });
  if (rows.length !== new Set(ids).size || new Set(rows.map((r) => r.projectId)).size !== 1)
    return NextResponse.json({ error: "清单行不存在或不属于同一工程" }, { status: 404 });
  if (rows.some((r) => r.isHeader))
    return NextResponse.json({ error: "分部标题不能粘贴数值" }, { status: 400 });
  const lumpSum = new Set(rows.filter((r) => r.feeType === "总价措施" || r.feeType === "其他项目").map((r) => r.id));

  const clean: { id: string; patch: BoqPatch }[] = [];
  for (const p of patches) {
    const out: BoqPatch = {};
    if (lumpSum.has(p.id)) {
      // 总额计价行没有量×价结构，只允许主材暂估价
      if (p.quantity !== undefined || p.unitPrice !== undefined)
        return NextResponse.json({ error: "所选行含总额计价行（总价措施/其他项目），只能粘贴金额" }, { status: 400 });
    }
    for (const f of ["quantity", "unitPrice", "mainMaterialPrice"] as const) {
      const v = p[f];
      if (v === undefined) continue;
      const num = D(v.replace(/,/g, ""));
      if (!num.isFinite() || num.lt(0)) return NextResponse.json({ error: "粘贴内容含无效数字" }, { status: 400 });
      out[f] = num.toString();
    }
    if (Object.keys(out).length) clean.push({ id: p.id, patch: out });
  }
  if (!clean.length)
    return NextResponse.json({ error: "剪贴板内容没有可写入的工程量/综合单价" }, { status: 400 });

  const { before, after } = await updateBoqItems(rows[0].projectId, clean);
  const changed = after.filter((a) => {
    const b = before.find((x) => x.id === a.id);
    const p = clean.find((x) => x.id === a.id)!;
    return b && Object.keys(p.patch).some((f) => String(b[f as keyof typeof b]) !== String(a[f as keyof typeof a]));
  });
  if (!changed.length)
    return NextResponse.json({ error: "粘贴的值与现有值一致，没有变化" }, { status: 400 });

  const receipt = await prisma.actionReceipt.create({
    data: {
      projectId: rows[0].projectId,
      actionType: "USER_EDIT",
      summary: `用户在工作区粘贴更新 ${changed.length} 行清单（工程量/综合单价）`,
      before: toJson(before),
      after: toJson(after),
      createdBy: "user",
    },
  });
  return NextResponse.json({ updated: changed.length, receiptId: receipt.id, affectedIds: changed.map((c) => c.id) });
}
