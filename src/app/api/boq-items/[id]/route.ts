import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { updateBoqItems } from "@boq/service";
import { toJson } from "@shared/json";

// User edits in the workspace land here — recorded as ActionReceipt so the
// agent's context (recentChanges) always knows what the user changed.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const item = await prisma.boqItem.findUnique({ where: { id } });
  if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });

  const patch: Record<string, string> = {};
  if (body.unitPrice !== undefined) patch.unitPrice = String(body.unitPrice);
  if (body.quantity !== undefined) patch.quantity = String(body.quantity);
  if (body.name !== undefined) patch.name = String(body.name);
  if (body.rawFeature !== undefined) patch.rawFeature = String(body.rawFeature);

  const { before, after } = await updateBoqItems(item.projectId, [
    { id, patch },
  ]);
  if (after.length) {
    const b = before[0];
    const a = after[0];
    const changes = (["unitPrice", "quantity", "totalPrice", "name", "rawFeature"] as const)
      .filter((f) => b[f] !== a[f])
      .map((f) => `${f}: ${b[f]} → ${a[f]}`)
      .join("；");
    await prisma.actionReceipt.create({
      data: {
        projectId: item.projectId,
        actionType: "USER_EDIT",
        summary: `用户在工作区修改「${a.name}」：${changes}`,
        before: toJson(before[0]),
        after: toJson(after[0]),
        createdBy: "user",
      },
    });
  }
  return NextResponse.json(after[0] ?? null);
}
