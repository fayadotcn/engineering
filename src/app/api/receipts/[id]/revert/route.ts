import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { updateBoqItems, type BoqPatch } from "@boq/service";
import { fromJson, toJson } from "@shared/json";

// Revert an action receipt: restore before-snapshots, write a REVERT receipt.
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const receipt = await prisma.actionReceipt.findUnique({ where: { id } });
  if (!receipt) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!receipt.reversible)
    return NextResponse.json({ error: "该操作不可撤销" }, { status: 400 });

  const before = fromJson<
    { id?: string; unitPrice?: string; quantity?: string; mainMaterialPrice?: string; name?: string; rawFeature?: string }[]
  >(receipt.before, []);
  const patches = before
    .filter((b) => b.id && (b.unitPrice !== undefined || b.quantity !== undefined || b.mainMaterialPrice !== undefined || b.name !== undefined || b.rawFeature !== undefined))
    .map((b) => {
      const patch: BoqPatch = {};
      if (b.unitPrice !== undefined) patch.unitPrice = String(b.unitPrice);
      if (b.quantity !== undefined) patch.quantity = String(b.quantity);
      if (b.mainMaterialPrice !== undefined) patch.mainMaterialPrice = String(b.mainMaterialPrice);
      if (b.name !== undefined) patch.name = String(b.name);
      if (b.rawFeature !== undefined) patch.rawFeature = String(b.rawFeature);
      return { id: b.id!, patch };
    });
  if (!patches.length)
    return NextResponse.json({ error: "回执中没有可还原的清单数据" }, { status: 400 });

  const { before: now, after } = await updateBoqItems(receipt.projectId, patches);

  const revert = await prisma.actionReceipt.create({
    data: {
      projectId: receipt.projectId,
      actionType: "REVERT",
      summary: `撤销：${receipt.summary}`,
      before: toJson(now),
      after: toJson(after),
      createdBy: "user",
    },
  });
  // mark original as consumed (still traceable)
  await prisma.actionReceipt.update({
    where: { id: receipt.id },
    data: { reversible: false },
  });
  return NextResponse.json({ reverted: after.length, receiptId: revert.id });
}
