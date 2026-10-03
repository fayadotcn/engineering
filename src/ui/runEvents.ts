import type { AgentEventDTO, ReceiptDTO, WorkspaceView } from "@shared/types";
import type { RunRecord } from "./api";
import { sectionOf } from "./sections";

export type ConvBlock =
  | { type: "user"; text: string; runId?: string }
  | { type: "agent"; text: string; runId: string }
  | { type: "activity"; text: string; runId: string; live: boolean }
  | { type: "thought"; text: string; runId: string; streamId?: string; live?: boolean }
  | { type: "tool"; tool: string; status: string; ms?: number; runId: string; args?: string; resultMsg?: string }
  | { type: "receipt"; receiptId: string; summary: string; actionType: string; runId: string }
  | { type: "view"; viewId: string; title: string; runId: string }
  | { type: "confirm"; confirmId: string; runId: string; tool: string; description: string; fileId?: string; decided?: "approved" | "rejected" }
  | { type: "upload"; filename: string; uploading?: boolean; runId?: string }
  | { type: "error"; text: string; runId?: string };

/** 事件归约关心的那部分工作台状态。 */
export interface RunState {
  blocks: ConvBlock[];
  views: WorkspaceView[];
  receipts: ReceiptDTO[];
  activeViewId: string | null;
  lastViewEvent: string | null;
  /** 最近一轮是否降级到规则引擎；null=模型正常。值为失败原因，供悬浮提示 */
  modelDown: string | null;
}

/** 流程中间的视图：随任务推送，但不替用户把面板切过去，也不在对话里提示。 */
const WORKING_VIEWS = new Set<WorkspaceView["kind"]>(["columnMapping", "document"]);

const settleLive = (blocks: ConvBlock[]) =>
  blocks.map((b) => ((b.type === "activity" || b.type === "thought") && b.live ? { ...b, live: false } : b));

/**
 * 一条 Agent 事件对工作台状态的影响。实时 SSE 与历史回放共用这一个归约，
 * 回放只是在空状态上依次折叠持久化的事件。
 */
export function reduceEvent(s: RunState, e: AgentEventDTO, runId: string): Partial<RunState> {
  const p = e.payload as Record<string, never>;
  switch (e.type) {
    case "activity": {
      const blocks = [...s.blocks];
      const last = blocks[blocks.length - 1];
      if (last?.type === "activity" && last.runId === runId && last.live) blocks[blocks.length - 1] = { ...last, live: false };
      blocks.push({ type: "activity", text: p.text, runId, live: true });
      return { blocks };
    }
    case "activity_live": {
      const blocks = [...s.blocks];
      const last = blocks[blocks.length - 1];
      if (last?.type === "activity" && last.runId === runId && last.live) blocks[blocks.length - 1] = { ...last, text: p.text };
      else blocks.push({ type: "activity", text: p.text, runId, live: true });
      return { blocks };
    }
    case "thought_delta":
    case "thought": {
      const live = e.type === "thought_delta";
      const sid = (p.streamId as string | undefined) ?? (live ? "s0" : undefined);
      const blocks = [...s.blocks];
      const i = sid ? blocks.findIndex((b) => b.type === "thought" && b.runId === runId && b.streamId === sid) : -1;
      const blk: ConvBlock = { type: "thought", text: p.text, runId, streamId: sid, live };
      if (i >= 0) blocks[i] = blk; else blocks.push(blk);
      // 模型在产出思考 → 解除降级标记
      return { blocks, modelDown: null };
    }
    case "model_fallback":
      return { modelDown: String(p.reason ?? "") };
    case "tool_started":
      return { blocks: [...s.blocks, { type: "tool", tool: p.tool, status: "running", runId, args: p.args }] };
    case "tool_finished": {
      const blocks = [...s.blocks];
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (b.type === "tool" && b.runId === runId && b.tool === p.tool && b.status === "running") {
          blocks[i] = { ...b, status: p.status, ms: p.ms, resultMsg: p.message };
          break;
        }
      }
      return { blocks };
    }
    case "message": {
      // 最终答复到达：流式预览块已无意义
      const blocks = settleLive(s.blocks.filter((b) => !(b.type === "thought" && b.live)));
      return { blocks: [...blocks, { type: "agent", text: p.text, runId }] };
    }
    case "receipt":
      return {
        blocks: [...s.blocks, { type: "receipt", receiptId: p.receiptId, summary: p.summary, actionType: p.actionType, runId }],
        receipts: s.receipts.some((r) => r.id === p.receiptId) ? s.receipts : [
          { id: p.receiptId, actionType: p.actionType, summary: p.summary, reversible: true, createdBy: "agent", createdAt: new Date().toISOString() },
          ...s.receipts,
        ].slice(0, 50),
      };
    case "confirm_request": {
      if (s.blocks.some((b) => b.type === "confirm" && b.confirmId === p.confirmId)) return {};
      return {
        blocks: [...settleLive(s.blocks), {
          type: "confirm", confirmId: p.confirmId, runId, tool: p.tool, description: p.description,
          fileId: (p.args as { fileId?: string } | undefined)?.fileId,
        }],
      };
    }
    case "confirm_resolved":
      return {
        blocks: s.blocks.map((b) => (b.type === "confirm" && b.confirmId === p.confirmId ? { ...b, decided: p.approved ? "approved" : "rejected" } : b)),
      };
    case "workspace_patch": {
      const view = p.view as WorkspaceView | undefined;
      // 回放时被后续同 id 覆盖的 patch 只带 id 占位
      if (!view?.kind) return {};
      const views = [...s.views];
      const idx = views.findIndex((v) => v.id === view.id);
      if (idx >= 0) views[idx] = view; else views.push(view);
      const working = WORKING_VIEWS.has(view.kind);
      const blocks = sectionOf(view.kind) === "results" && !s.blocks.some((b) => b.type === "view" && b.viewId === view.id && b.runId === runId)
        ? [...s.blocks, { type: "view" as const, viewId: view.id, title: view.title, runId }]
        : s.blocks;
      // 看什么是用户的选择：只有当前没有打开任何结果时才补位
      const activeViewId = !working && (!s.activeViewId || s.activeViewId.startsWith("empty:")) ? view.id : s.activeViewId;
      return { views, blocks, activeViewId, lastViewEvent: `${runId}:${e.seq}` };
    }
    case "error":
      return { blocks: [...s.blocks, { type: "error", text: p.text, runId }] };
    case "run_finished":
      return { blocks: settleLive(s.blocks) };
    default:
      return {};
  }
}

const INGEST_RE = /(?:分析并|重新)导入文件「(.+)」/;

/** 把持久化的 run 历史折叠成对话块与工作区视图。 */
export function replayRuns(runs: RunRecord[]): Pick<RunState, "blocks" | "views" | "lastViewEvent" | "modelDown"> {
  let state: RunState = { blocks: [], views: [], receipts: [], activeViewId: "replay", lastViewEvent: null, modelDown: null };
  for (const run of runs) {
    if (run.legacy) {
      // 已下线的旧会话：只保留产出的结果视图
      for (const e of run.events) if (e.type === "workspace_patch") {
        const { views } = reduceEvent(state, e, run.id);
        if (views) state = { ...state, views };
      }
      continue;
    }
    const ingest = run.userMessage.match(INGEST_RE);
    state.blocks = [...state.blocks, ingest ? { type: "upload", filename: ingest[1], runId: run.id } : { type: "user", text: run.userMessage, runId: run.id }];
    for (const e of run.events) state = { ...state, ...reduceEvent(state, e, run.id), activeViewId: "replay" };
    state.blocks = settleLive(state.blocks);
    // 超时或失败的任务不能再显示为可批准
    if (run.status !== "AWAITING_CONFIRM" && run.status !== "RUNNING")
      state.blocks = state.blocks.map((b) => (b.type === "confirm" && b.runId === run.id && !b.decided ? { ...b, decided: "rejected" } : b));
  }
  return { blocks: state.blocks, views: state.views, lastViewEvent: state.lastViewEvent, modelDown: state.modelDown };
}
