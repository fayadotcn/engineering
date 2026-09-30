import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { updateBoqItems } from "@boq/service";
import { toJson } from "@shared/json";
import { z } from "zod";

const edit = z.object({
  unitPrice: z.string().optional(), quantity: z.string().optional(), mainMaterialPrice: z.string().optional(),
  name: z.string().trim().min(1).max(500).optional(), rawFeature: z.string().max(10000).optional(),
}).strict().refine(value => Object.keys(value).length > 0);

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

  const patch: Record<string, string> = {};
  if (body.unitPrice !== undefined) patch.unitPrice = String(body.unitPrice);
  if (body.quantity !== undefined) patch.quantity = String(body.quantity);
  if (body.mainMaterialPrice !== undefined) patch.mainMaterialPrice = String(body.mainMaterialPrice);
  if (body.name !== undefined) patch.name = String(body.name);
  if (body.rawFeature !== undefined) patch.rawFeature = String(body.rawFeature);

  let result;
  try { result = await updateBoqItems(item.projectId, [
    { id, patch },
  ]); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "修改失败" }, { status: 400 }); }
  const { before, after } = result;
  if (after.length) {
    const b = before[0];
    const a = after[0];
    const changes = (["unitPrice", "quantity", "mainMaterialPrice", "totalPrice", "name", "rawFeature"] as const)
      .filter((f) => b[f] !== a[f])
      .map((f) => `${f}: ${b[f]} → ${a[f]}`)
      .join("；");
    if (changes) await prisma.actionReceipt.create({
      data: {
        projectId: item.projectId,
        actionType: "USER_EDIT",
        summary: `用户在工作区修改「${a.name}」：${changes}`,
        before: toJson(before),
        after: toJson(after),
        createdBy: "user",
      },
    });
  }
  return NextResponse.json(after[0] ?? null);
}
