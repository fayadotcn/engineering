import { prisma } from "@database/client";
import type { Prisma } from "@prisma/client";
import { listBoq, updateBoqItems, type BoqPatch } from "@boq/service";
import { fromJson, toJson } from "@shared/json";

export class RevertError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface RevertResult {
  reverted: number;
  receiptId: string;
  affectedIds: string[];
  restored: unknown[];
  removedIds: string[];
}

// 回执撤销核心：API 路由与 agent 工具（receipt.undo）共用。
// 按回执 before/after 快照判断三类——字段还原 / 删除重建 / 补录移除；
// 行已被后续修改则 409 拒绝（必须先撤销后续记录）。
export async function revertReceipt(id: string, opts: { createdBy?: string } = {}): Promise<RevertResult> {
  const receipt = await prisma.actionReceipt.findUnique({ where: { id } });
  if (!receipt) throw new RevertError(404, "记录不存在");
  if (!receipt.reversible) throw new RevertError(409, "该操作不可撤销或已撤销");
  type Snapshot = { id: string } & BoqPatch & Record<string, unknown>;
  const before = fromJson<Snapshot[]>(receipt.before, []);
  const after = fromJson<Snapshot[]>(receipt.after, []);
  if (!Array.isArray(before) || !Array.isArray(after)) throw new RevertError(400, "记录中没有可还原的清单数据");
  const current = await listBoq(receipt.projectId);
  const fields = ["unitPrice", "quantity", "quantityExpr", "mainMaterialPrice", "laborUnitPrice", "machineUnitPrice", "pricingPlan", "name", "rawFeature", "totalPrice", "feeType", "unitProject", "code"] as const;
  const patches: { id: string; patch: BoqPatch }[] = [];
  const recreate: Snapshot[] = [];
  const removeIds: string[] = [];
  for (const b of before) {
    const a = after.find(row => row.id === b.id);
    const item = current.find(row => row.id === b.id);
    if (!a) {
      // 删除类记录：回执 before 有该行、after 没有 → 当时被删；当前也没有 → 原样重建
      if (item) throw new RevertError(409, "清单数据已变更，无法撤销此记录");
      recreate.push(b);
      continue;
    }
    if (!item) throw new RevertError(409, "清单数据已变更，无法撤销此记录");
    let changed = fields.filter(key => b[key] !== undefined && JSON.stringify(b[key]) !== JSON.stringify(a[key]));
    // Only restore affected fields; refuse to overwrite a later edit.
    if (changed.some(key => JSON.stringify(item[key]) !== JSON.stringify(a[key]))) throw new RevertError(409, `「${item.name}」已有后续修改，请先撤销后续记录`);
    // 非总额计价行的合价是 量×价 的派生值——随量/价字段一起写会被服务端拒绝；
    // 从补丁里剔除（服务层会按新量价重算出同一合价，差异判定已在 changed 阶段完成）
    const isLump = b.feeType === "总价措施" || b.feeType === "其他项目";
    if (!isLump) changed = changed.filter((k) => k !== "totalPrice");
    if (changed.length) patches.push({ id: b.id, patch: Object.fromEntries(changed.map(key => [key, b[key]])) as BoqPatch });
  }
  // 新增类记录：回执 after 有该行、before 没有 → 当时被补录；行未被后续改动才可移除
  for (const a of after) {
    if (before.some(row => row.id === a.id)) continue;
    const item = current.find(row => row.id === a.id);
    if (!item) continue;
    if (fields.some(key => a[key] !== undefined && JSON.stringify(item[key]) !== JSON.stringify(a[key])))
      throw new RevertError(409, `「${item.name}」已有后续修改，请先撤销后续记录`);
    removeIds.push(a.id);
  }
  if (!patches.length && !recreate.length && !removeIds.length) throw new RevertError(400, "此记录没有可还原的清单修改");
  // 重建行的源文件可能已被删除——fileId 指过去会 FK 报错；置空 fileId 并在摘要里注明，
  // 行本身仍能恢复（fileId 可空，清单数据不丢）
  const recreateFileIds = [...new Set(recreate.map((r) => r.fileId).filter((x): x is string => typeof x === "string" && x.length > 0))];
  const liveFileIds = new Set(
    recreateFileIds.length
      ? (await prisma.projectFile.findMany({ where: { id: { in: recreateFileIds } }, select: { id: true } })).map((f) => f.id)
      : []
  );
  const orphanCount = recreate.filter((r) => r.fileId && !liveFileIds.has(r.fileId as string)).length;
  const result = patches.length ? await updateBoqItems(receipt.projectId, patches) : { before: [] as never[], after: [] as never[] };
  const txResult = await prisma.$transaction([
    ...(recreate.length
      ? [prisma.boqItem.createMany({
          data: recreate.map((r) => {
            const { createdAt: _c, updatedAt: _u, ...row } = r as Record<string, unknown> & { createdAt?: unknown; updatedAt?: unknown };
            if (typeof row.fileId === "string" && row.fileId && !liveFileIds.has(row.fileId)) row.fileId = null;
            return row as Prisma.BoqItemCreateManyInput;
          }),
        })]
      : []),
    ...(removeIds.length ? [prisma.boqItem.deleteMany({ where: { projectId: receipt.projectId, id: { in: removeIds } } })] : []),
    // toolCallId 复用为「指向被撤销回执」的链接，面板据此把原记录标为已撤销；
    // after 并入重建的行：该回执的 affectedIds 也能指到撤销恢复出来的行
    prisma.actionReceipt.create({ data: { projectId: receipt.projectId, actionType: "REVERT", summary: `撤销：${receipt.summary}${orphanCount ? `（${orphanCount} 行源文件已删，恢复为无源文件行）` : ""}`, before: toJson(result.before), after: toJson([...result.after, ...recreate]), reversible: false, createdBy: opts.createdBy ?? "user", toolCallId: id } }),
    prisma.actionReceipt.update({ where: { id }, data: { reversible: false } }),
  ]);
  const revert = txResult[txResult.length - 2] as { id: string };
  // 受影响行 id 回给前端：撤销落地的行短暂高亮，用户能看清数据回到了哪里；
  // restored/removedIds 让前端立即合并行数据，不必等后台整表刷新才看到撤销结果
  const affectedIds = [...patches.map((p) => p.id), ...recreate.map((r) => r.id)];
  return {
    reverted: result.after.length + recreate.length,
    receiptId: revert.id,
    affectedIds,
    restored: [...result.after, ...recreate],
    removedIds: removeIds,
  };
}
