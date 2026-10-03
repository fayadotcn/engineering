import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { updateBoqItems } from "@boq/service";
import { toJson } from "@shared/json";
import { z } from "zod";

const edit = z.object({
  unitPrice: z.string().optional(), quantity: z.string().optional(), quantityExpr: z.string().max(500).optional(),
  mainMaterialPrice: z.string().optional(),
  laborUnitPrice: z.string().optional(), machineUnitPrice: z.string().optional(),
  totalPrice: z.string().optional(),
  name: z.string().trim().min(1).max(500).optional(), rawFeature: z.string().max(10000).optional(),
  code: z.string().max(100).optional(),
  feeType: z.enum(["分部分项", "单价措施", "总价措施", "其他项目"]).optional(),
  unitProject: z.string().max(200).optional(),
}).strict().refine(value => Object.keys(value).length > 0);

// 变更记录与 toast 共用中文字段名：操作记录是给老板看的账，不是给程序看的日志
const FIELD_LABEL: Record<string, string> = {
  unitPrice: "综合单价", quantity: "工程量", quantityExpr: "工程量计算式",
  mainMaterialPrice: "主材暂估价", laborUnitPrice: "人工单价", machineUnitPrice: "机械单价",
  totalPrice: "合价", name: "项目名称", rawFeature: "项目特征", code: "项目编码",
  feeType: "计价表分层", unitProject: "单位工程",
};
const disp = (v: string | null) => (v === null || v === "" ? "空" : v);

// User edits in the workspace land here — recorded as ActionReceipt so the
// agent's context (recentChanges) always knows what the user changed.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const parsed = edit.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "编辑内容无效" }, { status: 400 });
  const body = parsed.data;
  const item = await prisma.boqItem.findUnique({ where: { id } });
  if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (item.isHeader) return NextResponse.json({ error: "分部标题不能编辑金额或工程量" }, { status: 400 });
  const newFeeType = body.feeType ?? item.feeType;
  if (body.totalPrice !== undefined && newFeeType !== "总价措施" && newFeeType !== "其他项目")
    return NextResponse.json({ error: "此项合价由工程量×综合单价自动计算" }, { status: 400 });

  const patch: Record<string, string> = {};
  if (body.unitPrice !== undefined) patch.unitPrice = String(body.unitPrice);
  if (body.quantity !== undefined) patch.quantity = String(body.quantity);
  if (body.quantityExpr !== undefined) patch.quantityExpr = body.quantityExpr;
  if (body.mainMaterialPrice !== undefined) patch.mainMaterialPrice = String(body.mainMaterialPrice);
  if (body.laborUnitPrice !== undefined) patch.laborUnitPrice = String(body.laborUnitPrice);
  if (body.machineUnitPrice !== undefined) patch.machineUnitPrice = String(body.machineUnitPrice);
  if (body.totalPrice !== undefined) patch.totalPrice = body.totalPrice;
  if (body.name !== undefined) patch.name = String(body.name);
  if (body.code !== undefined) patch.code = String(body.code);
  if (body.rawFeature !== undefined) patch.rawFeature = String(body.rawFeature);
  if (body.feeType !== undefined) patch.feeType = body.feeType;
  if (body.unitProject !== undefined) patch.unitProject = body.unitProject;

  // 行更新 + 回执同事务（与 POST/DELETE 同口径）：回执失败不留无审计的修改
  let after: Awaited<ReturnType<typeof updateBoqItems>>["after"] = [];
  let receiptId: string | null = null;
  let changes: { field: string; label: string; from: string | null; to: string | null }[] = [];
  try {
    receiptId = await prisma.$transaction(async (tx) => {
      const { before, after: a2 } = await updateBoqItems(item.projectId, [{ id, patch }], tx);
      after = a2;
      if (!a2.length) return null;
      const b = before[0];
      const a = a2[0];
      changes = (["unitPrice", "quantity", "quantityExpr", "mainMaterialPrice", "laborUnitPrice", "machineUnitPrice", "totalPrice", "name", "code", "rawFeature", "feeType", "unitProject"] as const)
        .filter((f) => b[f] !== a[f])
        .map((f) => ({ field: f, label: FIELD_LABEL[f] ?? f, from: b[f] ?? null, to: a[f] ?? null }));
      if (!changes.length) return null;
      const text = changes
        .map((c) => c.field === "quantityExpr" && c.to ? `工程量计算式: ${c.to}` : `${c.label}: ${disp(c.from)} → ${disp(c.to)}`)
        .join("；");
      const receipt = await tx.actionReceipt.create({
        data: {
          projectId: item.projectId,
          actionType: "USER_EDIT",
          summary: `用户在工作区修改「${a.name}」：${text}`,
          before: toJson(before),
          after: toJson(a2),
          createdBy: "user",
        },
      });
      return receipt.id;
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "修改失败" }, { status: 400 });
  }
  return NextResponse.json({ item: after[0] ?? null, receiptId, changes });
}

// Row delete keeps the full row in the receipt's before snapshot — the revert
// endpoint recreates it verbatim, so a mis-click is recoverable.
export async function DELETE(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const item = await prisma.boqItem.findUnique({ where: { id } });
  if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });
  const [receipt] = await prisma.$transaction([
    prisma.actionReceipt.create({
      data: {
        projectId: item.projectId,
        actionType: "USER_EDIT",
        summary: `用户在工作区删除清单行「${item.name}」（${item.sheetName} 第 ${item.rowIndex + 1} 行）`,
        before: toJson([item]),
        after: toJson([]),
        createdBy: "user",
      },
    }),
    prisma.boqItem.delete({ where: { id } }),
  ]);
  return NextResponse.json({ deleted: id, receiptId: receipt.id });
}
