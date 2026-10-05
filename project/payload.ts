import { prisma } from "@database/client";
import { getProject } from "@project/service";
import { listBoq } from "@boq/service";
import { toFactDTO } from "@database/serialize";
import { FILE_KIND_LABEL, type FileKind } from "@shared/types";
import { fromJson } from "@shared/json";
import { projectTotals, aggregateByDiscipline } from "@cost-engine/aggregate";
import { feeSummary, compareDeclared } from "@cost-engine/fees";
import { getFacts, loadFeeParams } from "@project/facts";
import { mappingToView, type SheetMeta } from "@file/inspection";
import type { WorkbenchInit } from "@/ui/api";

/* 工作台初始载荷的装配与序列化：/api/projects/[id] 四个 GET 路由和服务端
   预载（p/[id] 页面）共用同一套取数逻辑，保证两种入口吐出的数据逐字节同构。 */

// 回执的 before/after 快照里都带行 id，提出来让清单表能把「这行被改过」标在行号上
const rowIdsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((r) => (r as { id?: unknown })?.id).filter((x): x is string => typeof x === "string") : [];

export async function loadProjectPayload(id: string) {
  const p = await getProject(id);
  if (!p) return null;
  const receipts = await prisma.actionReceipt.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  // REVERT 回执把被撤销的那条 id 记在 toolCallId 上，面板据此显示「已撤销」而非「不可撤销」
  const revertedIds = new Set(receipts.filter((r) => r.actionType === "REVERT" && r.toolCallId).map((r) => r.toolCallId as string));
  return {
    id: p.id,
    name: p.name,
    files: p.files.map((f) => ({
      id: f.id,
      filename: f.filename,
      kind: f.kind,
      kindLabel: FILE_KIND_LABEL[f.kind as FileKind] ?? f.kind,
      status: f.status,
      stage: f.stage,
      period: f.period,
      sizeBytes: f.sizeBytes,
      createdAt: f.createdAt,
    })),
    facts: p.facts.map(toFactDTO),
    artifacts: p.artifacts.map((a) => ({
      id: a.id,
      label: a.label,
      kind: a.kind,
      createdAt: a.createdAt,
    })),
    receipts: receipts.map((r) => ({
      id: r.id,
      actionType: r.actionType,
      summary: r.summary,
      reversible: r.reversible,
      reverted: revertedIds.has(r.id),
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      affectedIds: [...new Set([...rowIdsOf(fromJson(r.before, [])), ...rowIdsOf(fromJson(r.after, []))])],
    })),
  };
}

export async function loadBoqPayload(id: string) {
  // 列表接口不带 rawCells（整行原文 JSON，大表会翻倍 payload），DB 层就不读；
  // 服务端工具仍可通过 listBoq/单条接口拿到
  const items = await listBoq(id, { rawCells: false });
  return items.map(({ rawCells: _rawCells, ...rest }) => rest);
}

// 申报核对按文件配对：「文件汇总:{filename}」事实只代表那份文件的申报口径，
// 必须用同一文件的清单行算 feeSummary 再对——多文件时逐文件给出，不混池比较。
export async function loadSummaryPayload(id: string) {
  if (!await prisma.project.findUnique({ where: { id } })) return null;
  const [items, facts, fees, files] = await Promise.all([
    // 汇总只要数值字段——rawCells 整行原文（每行 KB 级）不取，响应时间直接腰斩
    listBoq(id, { rawCells: false }), getFacts(id), loadFeeParams(id),
    prisma.projectFile.findMany({ where: { projectId: id }, select: { id: true, filename: true } }),
  ]);
  const totals = projectTotals(items);
  const summary = feeSummary(items, fees);
  const declaredCheck: { file: string; checks: ReturnType<typeof compareDeclared> }[] = [];
  const usum = (units: Record<string, unknown>[], k: string) =>
    units.reduce((a, u) => a + (typeof u[k] === "number" ? (u[k] as number) : 0), 0);
  let declaredReg = false, declaredMeasure = false, declaredOther = false;
  // 参与过申报核对的文件数：让 UI 能区分「已核对无差异」和「没有可核对的申报口径」
  let declaredChecked = 0;
  // 同一文件重导会产生多条「文件汇总:」事实——facts 已倒序，按 key 去重只取最新一版
  const seenSummary = new Set<string>();
  for (const f of facts.filter((x) => x.key.startsWith("文件汇总:") && !seenSummary.has(x.key) && seenSummary.add(x.key))) {
    const filename = f.key.slice("文件汇总:".length);
    const fileId = files.find((x) => x.filename === filename)?.id;
    const fileItems = fileId ? items.filter((i) => i.fileId === fileId) : [];
    if (!fileItems.length) continue;
    try {
      const units = JSON.parse(f.value) as Record<string, unknown>[];
      if (usum(units, "规费") > 0) declaredReg = true;
      if (usum(units, "措施项目费") > 0) declaredMeasure = true;
      if (usum(units, "其他项目费") > 0) declaredOther = true;
      const checks = compareDeclared(feeSummary(fileItems, fees).rows, units);
      declaredChecked++;
      if (checks.length) declaredCheck.push({ file: filename, checks });
    } catch { /* skip malformed fact */ }
  }
  const missing = ["地区", "价格期", "税率"].filter(key => !facts.find(f => f.key === key)?.value.trim());
  // 申报口径里含该项费用、而我们没有取数途径 → 列为缺失设置，
  // 「补计价设置」一步就能指引到真正造成口径差异的费率（规费是税金/合计差异主因）。
  if (declaredReg && !fees.set.regulation) missing.push("规费费率");
  if (declaredMeasure && !fees.set.measure && !fees.coeffMeasureFee.gt(0)
    && !items.some(i => i.feeType === "单价措施" || i.feeType === "总价措施")) missing.push("措施费率");
  if (declaredOther && !fees.set.provisional && !items.some(i => i.feeType === "其他项目")) missing.push("暂列金额率");
  return { ...totals, fees: summary, declaredCheck: declaredCheck.length ? declaredCheck : null, declaredChecked, disciplines: aggregateByDiscipline(items).slices, missingSettings: missing };
}

// Conversation history: reconstruct blocks from persisted runs + events.
export async function loadRunsPayload(id: string) {
  // 服务重启后残留的活 run 永远不会结束——懒清理为 FAILED。
  // 口径与 liveRunWhere 互补：AWAITING_CONFIRM 不算僵尸——本进程内它必配对
  // 活 resolver（确认门 10 分钟超时收口），按 createdAt 判死会杀掉仍待确认的 run；
  // 进程重启由 startRun 前的 markZombieRunsFailed 全量清尾兜底。
  await prisma.agentRun.updateMany({
    where: {
      projectId: id,
      status: "RUNNING",
      createdAt: { lt: new Date(Date.now() - 15 * 60 * 1000) },
    },
    data: {
      status: "FAILED",
      summary: "服务重启，任务中断，请重新发送",
      finishedAt: new Date(),
    },
  });
  // 取最近 50 条 run（desc 再反转为时间序）——asc+take 会在 run 数>50 时丢掉最新记录
  const desc = await prisma.agentRun.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { events: { orderBy: { seq: "asc" } } },
  });
  const runs = desc.reverse();
  // 同一 view 的 workspace_patch 只保留最后一次（重放时旧 patch 会被覆盖，白传流量）
  const parsed = runs.map((r) => ({
    run: r,
    events: r.events.map((e) => ({
      seq: e.seq,
      type: e.type,
      payload: fromJson(e.payload, {}) as { view?: { id?: string; kind?: string; fileId?: string } },
    })),
  }));
  const lastPatch = new Map<string, { seq: number; payload: { view?: { id?: string } } }>();
  for (const { events } of parsed)
    for (const e of events)
      if (e.type === "workspace_patch" && e.payload.view?.id)
        lastPatch.set(e.payload.view.id, e);
  // 列映射是可编辑的文件状态，历史识别快照不能覆盖用户已保存的映射。
  const files = await prisma.projectFile.findMany({ where: { projectId: id } });
  for (const file of files) {
    const patch = lastPatch.get(`view:mapping:${file.id}`);
    const mapping = fromJson<{ mapping?: Record<string, SheetMeta> }>(file.meta, {}).mapping;
    if (patch && mapping) patch.payload.view = mappingToView(file, mapping);
  }
  // 被覆盖的 patch 只回传 view.id 占位（重放时随即被后续同 id 的完整 patch 替换），省流量
  return parsed.map(({ run: r, events }) => ({
    id: r.id,
    userMessage: r.userMessage,
    // 已下线的 Harness 会话按工具粒度建 run，只保留其产出的结果视图，不再回放成对话
    legacy: r.planner === "harness",
    status: r.status,
    createdAt: r.createdAt,
    events: events.map((e) =>
      e.type === "workspace_patch" && e.payload.view?.id && lastPatch.get(e.payload.view.id) !== e
        ? { ...e, payload: { view: { id: e.payload.view.id } } }
        : e
    ),
  }));
}

/**
 * 工作台首屏所需的四份数据一次取齐。p/[id] 页面服务端预载（塞进 initial prop，
 * 客户端免去一整段 API 瀑布）；JSON 归一化把 Date/Decimal 等折成与 HTTP 响应
 * 完全相同的纯数据形态。工程不存在返回 null。
 */
export async function loadWorkbenchInit(projectId: string): Promise<WorkbenchInit | null> {
  const [p, items, runs, summary] = await Promise.all([
    loadProjectPayload(projectId),
    loadBoqPayload(projectId),
    loadRunsPayload(projectId),
    loadSummaryPayload(projectId),
  ]);
  if (!p || !summary) return null;
  return JSON.parse(JSON.stringify({ p, items, runs, summary })) as WorkbenchInit;
}
