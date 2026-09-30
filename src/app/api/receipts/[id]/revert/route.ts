import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { listBoq, updateBoqItems, type BoqPatch } from "@boq/service";
import { fromJson, toJson } from "@shared/json";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const receipt = await prisma.actionReceipt.findUnique({ where: { id } });
  if (!receipt) return NextResponse.json({ error: "记录不存在" }, { status: 404 });
  if (!receipt.reversible) return NextResponse.json({ error: "该操作不可撤销或已撤销" }, { status: 409 });
  type Snapshot = { id: string } & BoqPatch;
  const before = fromJson<Snapshot[]>(receipt.before, []);
  const after = fromJson<Snapshot[]>(receipt.after, []);
  if (!Array.isArray(before) || !Array.isArray(after)) return NextResponse.json({ error: "记录中没有可还原的清单数据" }, { status: 400 });
  const current = await listBoq(receipt.projectId);
  const fields = ["unitPrice", "quantity", "mainMaterialPrice", "pricingPlan", "name", "rawFeature", "totalPrice"] as const;
  const patches: { id: string; patch: BoqPatch }[] = [];
  for (const b of before) {
    const a = after.find(row => row.id === b.id);
    const item = current.find(row => row.id === b.id);
    if (!a || !item) return NextResponse.json({ error: "清单数据已变更，无法撤销此记录" }, { status: 409 });
    const changed = fields.filter(key => b[key] !== undefined && JSON.stringify(b[key]) !== JSON.stringify(a[key]));
    // Only restore affected fields; refuse to overwrite a later edit.
    if (changed.some(key => JSON.stringify(item[key]) !== JSON.stringify(a[key]))) return NextResponse.json({ error: `「${item.name}」已有后续修改，请先撤销后续记录` }, { status: 409 });
    if (changed.length) patches.push({ id: b.id, patch: Object.fromEntries(changed.map(key => [key, b[key]])) as BoqPatch });
  }
  if (!patches.length) return NextResponse.json({ error: "此记录没有可还原的清单修改" }, { status: 400 });
  const result = await updateBoqItems(receipt.projectId, patches);
  const [revert] = await prisma.$transaction([
    prisma.actionReceipt.create({ data: { projectId: receipt.projectId, actionType: "REVERT", summary: `撤销：${receipt.summary}`, before: toJson(result.before), after: toJson(result.after), reversible: false, createdBy: "user" } }),
    prisma.actionReceipt.update({ where: { id }, data: { reversible: false } }),
  ]);
  return NextResponse.json({ reverted: result.after.length, receiptId: revert.id });
}
