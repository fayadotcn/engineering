import { NextResponse } from "next/server";
import { prisma } from "@database/client";
import { fromJson } from "@shared/json";
import type { WorkspaceView } from "@shared/types";

// 对话侧卡片需要的全部项目状态：最近导入、待确认导入、最近一次 Agent 结果。
// 这些数据本来只在专业面板里可见，卡片要在面板关闭时也能说话，所以单开一条轻量接口。
// 只读 run 与事件，不加载清单：卡片要说的是"发生了什么"，"现在什么状况"沿用 /summary。
type EventRow = { type: string; payload: string };

type ResultView = { id: string; kind: string; title: string; rows?: number };

type ColumnMappingView = Extract<WorkspaceView, { kind: "columnMapping" }>;

function viewOf(payload: string): WorkspaceView | undefined {
  const view = fromJson<{ view?: WorkspaceView }>(payload, {}).view;
  return view?.id && view.kind ? view : undefined;
}

function viewsOf(events: readonly EventRow[]): ResultView[] {
  const seen = new Map<string, ResultView>();
  for (const e of events) {
    if (e.type !== "workspace_patch") continue;
    const view = viewOf(e.payload);
    if (!view) continue;
    const rows = (view as { rows?: unknown[] }).rows;
    seen.set(view.id, {
      id: view.id,
      kind: view.kind,
      title: view.title,
      ...(Array.isArray(rows) ? { rows: rows.length } : {}),
    });
  }
  return [...seen.values()];
}

function mappingOf(events: readonly EventRow[]): ColumnMappingView | undefined {
  for (const e of events) {
    if (e.type !== "workspace_patch") continue;
    const view = viewOf(e.payload);
    if (view?.kind === "columnMapping") return view;
  }
  return undefined;
}

/** 导入 run 的历史命名不只一种（确定性链路 planner=import，早期 LLM 链路靠 userMessage），两种都认。 */
function isImport(run: { planner: string | null; userMessage: string | null }): boolean {
  return run.planner === "import" || /导入文件「/.test(run.userMessage ?? "");
}

/** userMessage 里的文件名是两条链路都有的稳定来源。 */
function filenameOf(run: { userMessage: string | null }): string {
  return run.userMessage?.match(/导入文件「(.+?)」/)?.[1] ?? "";
}

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  if (!(await prisma.project.findUnique({ where: { id: projectId } })))
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  const [waiting, recent] = await Promise.all([
    prisma.agentRun.findFirst({
      where: { projectId, status: "AWAITING_CONFIRM" },
      orderBy: { createdAt: "desc" },
    }),
    // 先只取轻量字段：事件里可能带整张表样本，不能对每个 run 都拉
    prisma.agentRun.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: { id: true, planner: true, status: true, summary: true, userMessage: true, createdAt: true },
    }),
  ]);

  const eventsOf = async (runId: string) =>
    (await prisma.agentEvent.findMany({ where: { runId }, orderBy: { seq: "asc" } })) as readonly EventRow[];

  // 待确认文件可能早于最近一次成功导入；入口必须指向这次确认自己的映射。
  const importRun = waiting && isImport(waiting) ? waiting : recent.find(isImport);
  const importEvents = importRun ? await eventsOf(importRun.id) : [];
  const mapping = mappingOf(importEvents);
  // 计价计数直接取导入时 project.summary 的观测结果，比为了两个数字重算整张清单便宜得多
  const summaryCall = importRun
    ? await prisma.toolCall.findFirst({ where: { runId: importRun.id, tool: "project.summary" } })
    : null;
  const totals = summaryCall
    ? fromJson<{ itemCount?: number; pricedCount?: number; pricableCount?: number; totalAmount?: string }>(
        summaryCall.result,
        {}
      )
    : null;

  // 结果 run 由数据决定而不是由 planner 决定：没有产出视图的 run 没有卡片可说
  let result: {
    runId: string;
    status: string;
    at: Date;
    summary: string;
    views: ResultView[];
  } | null = null;
  for (const run of recent.filter((r) => !isImport(r)).slice(0, 5)) {
    const views = viewsOf(await eventsOf(run.id));
    if (!views.length) continue;
    result = { runId: run.id, status: run.status, at: run.createdAt, summary: run.summary ?? "", views };
    break;
  }

  const pendingAction = waiting
    ? fromJson<{ confirmId?: string; tool?: string; description?: string }>(waiting.pendingAction, {})
    : null;
  const confirm = waiting && pendingAction?.confirmId
    ? {
        runId: waiting.id,
        confirmId: pendingAction.confirmId,
        tool: pendingAction.tool ?? "",
        description: pendingAction.description ?? "",
      }
    : null;

  return NextResponse.json({
    confirm,
    import: importRun
      ? {
          runId: importRun.id,
          status: importRun.status,
          at: importRun.createdAt,
          filename: filenameOf(importRun) || (mapping?.filename ?? ""),
          // 「检查映射」要直接落到那张表自己的映射视图上，而不是让用户再去资料里找
          mappingViewId: mapping?.id ?? null,
          summary: importRun.summary ?? "",
          totals: totals
            ? {
                items: totals.itemCount ?? 0,
                priced: totals.pricedCount ?? 0,
                pricable: totals.pricableCount ?? 0,
                amount: totals.totalAmount ?? "0",
              }
            : null,
          // 只回传对话里要说的：每张表的规模，以及"还需不需要人看一眼"
          sheets: (mapping?.sheets ?? []).map((s) => ({
            sheetName: s.sheetName,
            type: s.type,
            rowCount: s.rowCount,
            minConfidence: s.minConfidence,
            templateHit: s.templateHit,
            userEdited: s.userEdited,
            lowColumns: Object.entries(s.confidence).filter(([, c]) => c < 0.9).length,
          })),
        }
      : null,
    result,
  });
}
