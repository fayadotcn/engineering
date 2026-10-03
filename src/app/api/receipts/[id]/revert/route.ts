import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import type { Prisma } from "@prisma/client";
import { listBoq, updateBoqItems, type BoqPatch } from "@boq/service";
import { fromJson, toJson } from "@shared/json";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const receipt = await prisma.actionReceipt.findUnique({ where: { id } });
  if (!receipt) return NextResponse.json({ error: "记录不存在" }, { status: 404 });
  if (!receipt.reversible) return NextResponse.json({ error: "该操作不可撤销或已撤销" }, { status: 409 });
  type Snapshot = { id: string } & BoqPatch & Record<string, unknown>;
  const before = fromJson<Snapshot[]>(receipt.before, []);
  const after = fromJson<Snapshot[]>(receipt.after, []);
  if (!Array.isArray(before) || !Array.isArray(after)) return NextResponse.json({ error: "记录中没有可还原的清单数据" }, { status: 400 });
  const current = await listBoq(receipt.projectId);
  const fields = ["unitPrice", "quantity", "quantityExpr", "mainMaterialPrice", "laborUnitPrice", "machineUnitPrice", "pricingPlan", "name", "rawFeature", "totalPrice"] as const;
  const patches: { id: string; patch: BoqPatch }[] = [];
  const recreate: Snapshot[] = [];
  const removeIds: string[] = [];
  for (const b of before) {
    const a = after.find(row => row.id === b.id);
    const item = current.find(row => row.id === b.id);
    if (!a) {
      // 删除类记录：回执 before 有该行、after 没有 → 当时被删；当前也没有 → 原样重建
      if (item) return NextResponse.json({ error: "清单数据已变更，无法撤销此记录" }, { status: 409 });
      recreate.push(b);
      continue;
    }
    if (!item) return NextResponse.json({ error: "清单数据已变更，无法撤销此记录" }, { status: 409 });
    const changed = fields.filter(key => b[key] !== undefined && JSON.stringify(b[key]) !== JSON.stringify(a[key]));
    // Only restore affected fields; refuse to overwrite a later edit.
    if (changed.some(key => JSON.stringify(item[key]) !== JSON.stringify(a[key]))) return NextResponse.json({ error: `「${item.name}」已有后续修改，请先撤销后续记录` }, { status: 409 });
    if (changed.length) patches.push({ id: b.id, patch: Object.fromEntries(changed.map(key => [key, b[key]])) as BoqPatch });
  }
  // 新增类记录：回执 after 有该行、before 没有 → 当时被补录；行未被后续改动才可移除
  for (const a of after) {
    if (before.some(row => row.id === a.id)) continue;
    const item = current.find(row => row.id === a.id);
    if (!item) continue;
    if (fields.some(key => a[key] !== undefined && JSON.stringify(item[key]) !== JSON.stringify(a[key])))
      return NextResponse.json({ error: `「${item.name}」已有后续修改，请先撤销后续记录` }, { status: 409 });
    removeIds.push(a.id);
  }
  if (!patches.length && !recreate.length && !removeIds.length) return NextResponse.json({ error: "此记录没有可还原的清单修改" }, { status: 400 });
  const result = patches.length ? await updateBoqItems(receipt.projectId, patches) : { before: [] as never[], after: [] as never[] };
  const txResult = await prisma.$transaction([
    ...(recreate.length
      ? [prisma.boqItem.createMany({
          data: recreate.map((r) => {
            const { createdAt: _c, updatedAt: _u, ...row } = r as Record<string, unknown> & { createdAt?: unknown; updatedAt?: unknown };
            return row as Prisma.BoqItemCreateManyInput;
          }),
        })]
      : []),
    ...(removeIds.length ? [prisma.boqItem.deleteMany({ where: { projectId: receipt.projectId, id: { in: removeIds } } })] : []),
    // toolCallId 复用为「指向被撤销回执」的链接，面板据此把原记录标为已撤销；
    // after 并入重建的行：该回执的 affectedIds 也能指到撤销恢复出来的行
    prisma.actionReceipt.create({ data: { projectId: receipt.projectId, actionType: "REVERT", summary: `撤销：${receipt.summary}`, before: toJson(result.before), after: toJson([...result.after, ...recreate]), reversible: false, createdBy: "user", toolCallId: id } }),
    prisma.actionReceipt.update({ where: { id }, data: { reversible: false } }),
  ]);
  const revert = txResult[txResult.length - 2] as { id: string };
  // 受影响行 id 回给前端：撤销落地的行短暂高亮，用户能看清数据回到了哪里；
  // restored/removedIds 让前端立即合并行数据，不必等后台整表刷新才看到撤销结果
  const affectedIds = [...patches.map((p) => p.id), ...recreate.map((r) => r.id)];
  return NextResponse.json({
    reverted: result.after.length + recreate.length,
    receiptId: revert.id,
    affectedIds,
    restored: [...result.after, ...recreate],
    removedIds: removeIds,
  });
}
