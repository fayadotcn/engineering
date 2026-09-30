"use client";
import { create } from "zustand";
import type {
  AgentEventDTO,
  BoqItemDTO,
  CostFactDTO,
  ReceiptDTO,
  WorkspaceView,
} from "@shared/types";
import { toast } from "./primitives";

export type ConvBlock =
  | { type: "user"; text: string }
  | { type: "agent"; text: string; runId: string }
  | { type: "activity"; text: string; runId: string; live: boolean }
  | { type: "thought"; text: string; runId: string; streamId?: string; live?: boolean }
  | { type: "tool"; tool: string; status: string; ms?: number; runId: string; args?: string; resultMsg?: string }
  | { type: "receipt"; receiptId: string; summary: string; actionType: string; runId: string }
  | { type: "confirm"; confirmId: string; runId: string; tool: string; description: string; decided?: "approved" | "rejected" }
  | { type: "upload"; filename: string; uploading?: boolean }
  | { type: "error"; text: string; runId?: string };

interface FileMeta {
  id: string;
  filename: string;
  kindLabel: string;
  status: string;
}

interface State {
  projectId: string | null;
  projectName: string;
  harnessSessionId: string;
  summary: { itemCount: number; pricedCount: number; pricableCount: number; totalAmount: string; fees: { grandTotal: string; preTax: string; unpricedCount: number; rows: { seq: string; name: string; amount: string; note?: string }[] }; disciplines: { key: string; label: string; amount: string; share: number; count: number }[]; missingSettings: string[] } | null;
  loadingError: string | null;
  files: FileMeta[];
  facts: CostFactDTO[];
  receipts: ReceiptDTO[];
  items: BoqItemDTO[];
  blocks: ConvBlock[];
  views: WorkspaceView[];
  activeViewId: string | null;
  lastViewEvent: string | null;
  running: boolean;
  ready: boolean;
  boqVersion: number;
  /** 清单表全局搜索框（异常定位等跨组件联动用） */
  boqQuery: string;

  init(projectId: string, refresh?: boolean): Promise<void>;
  send(text: string): Promise<void>;
  upload(file: File): Promise<void>;
  patchItem(id: string, patch: Partial<BoqItemDTO>): Promise<boolean>;
  reloadBoq(): Promise<void>;
  refreshMeta(): Promise<void>;
  streamRun(runId: string): Promise<void>;
  setActiveView(id: string): void;
  closeView(id: string): void;
  /** 同 id 视图替换（列映射保存后服务端回传的最新视图） */
  replaceView(view: WorkspaceView): void;
  setBoqQuery(q: string): void;
  /** 跳转到清单视图并过滤到目标项（编码或名称） */
  gotoBoqItem(key: string): void;
  handleEvent(e: AgentEventDTO, runId: string): void;
}

export const useStore = create<State>((set, get) => ({
  projectId: null,
  projectName: "",
  harnessSessionId: "",
  summary: null,
  loadingError: null,
  files: [],
  facts: [],
  receipts: [],
  items: [],
  blocks: [],
  views: [],
  activeViewId: null,
  lastViewEvent: null,
  running: false,
  ready: false,
  boqVersion: 0,
  boqQuery: "",

  async init(projectId, refresh = false) {
    const previousView = refresh && get().projectId === projectId ? get().activeViewId : null;
    const localViews = refresh ? get().views.filter(v => ["overview", "fileList", "boqTable", "factList", "receipts"].includes(v.kind)) : [];
    if (!refresh) set({ projectId, projectName: "", items: [], facts: [], files: [], receipts: [], summary: null, blocks: [], views: [], activeViewId: null, lastViewEvent: null, ready: false, running: false, loadingError: null });
    try {
    const [p, items, runs] = await Promise.all([
      fetch(`/api/projects/${projectId}`).then(async r => { if (!r.ok) throw new Error("项目不存在或暂时无法读取"); return r.json(); }),
      fetch(`/api/projects/${projectId}/boq`).then(async r => { if (!r.ok) throw new Error("清单读取失败"); return r.json(); }),
      fetch(`/api/projects/${projectId}/runs`).then(async r => { if (!r.ok) throw new Error("任务记录读取失败"); return r.json(); }),
    ]);
    if (get().projectId !== projectId) return;

    // replay persisted runs into conversation blocks + workspace views
    const blocks: ConvBlock[] = [];
    const views: WorkspaceView[] = [];
    let activeViewId: string | null = null;
    let lastViewEvent: string | null = null;
    for (const run of runs ?? []) {
      const ingest = run.userMessage.match(/(?:分析并|重新)导入文件「(.+)」/);
      blocks.push(
        ingest
          ? { type: "upload", filename: ingest[1] }
          : { type: "user", text: run.userMessage }
      );
      for (const e of run.events as AgentEventDTO[]) {
        const pl = e.payload as Record<string, never>;
        if (e.type === "activity")
          blocks.push({ type: "activity", text: pl.text, runId: run.id, live: false });
        else if (e.type === "thought")
          blocks.push({ type: "thought", text: pl.text, runId: run.id });
        else if (e.type === "tool_started")
          blocks.push({ type: "tool", tool: pl.tool, status: "running", runId: run.id, args: pl.args });
        else if (e.type === "tool_finished") {
          const b = [...blocks].reverse().find(
            (x) => x.type === "tool" && x.tool === pl.tool && x.status === "running"
          );
          if (b && b.type === "tool") { b.status = pl.status; b.ms = pl.ms; b.resultMsg = pl.message; }
        } else if (e.type === "message")
          blocks.push({ type: "agent", text: pl.text, runId: run.id });
        else if (e.type === "receipt")
          blocks.push({
            type: "receipt", receiptId: pl.receiptId, summary: pl.summary,
            actionType: pl.actionType, runId: run.id,
          });
        else if (e.type === "error") blocks.push({ type: "error", text: pl.text, runId: run.id });
        else if (e.type === "confirm_request")
          blocks.push({
            type: "confirm", confirmId: pl.confirmId, runId: run.id,
            tool: pl.tool, description: pl.description,
          });
        else if (e.type === "confirm_resolved") {
          const b = [...blocks].reverse().find(
            (x) => x.type === "confirm" && x.confirmId === pl.confirmId
          );
          if (b && b.type === "confirm")
            b.decided = pl.approved ? "approved" : "rejected";
        }
        else if (e.type === "workspace_patch") {
          const v = pl.view as WorkspaceView;
          if (!v.kind) continue;
          const idx = views.findIndex((x) => x.id === v.id);
          if (idx >= 0) views[idx] = v; else views.push(v);
          activeViewId = v.id;
          lastViewEvent = `${run.id}:${e.seq}`;
        }
      }
    }

    set({
      projectName: p.name,
      harnessSessionId: p.harnessSessionId ?? "",
      files: p.files ?? [],
      facts: p.facts ?? [],
      receipts: p.receipts ?? [],
      items: items ?? [],
      blocks,
      views: [
        { kind: "overview", id: "view:overview", title: "项目总览" },
        ...localViews.filter(v => !["view:overview", "view:receipts"].includes(v.id) && !views.some(x => x.id === v.id)),
        ...(views.length
          ? views
          : items?.length
            ? [{ kind: "boqTable", id: "view:boq", title: "工程量清单" } as WorkspaceView]
            : []),
        { kind: "receipts", id: "view:receipts", title: "变更记录" },
      ],
      activeViewId: refresh && lastViewEvent && lastViewEvent !== get().lastViewEvent ? activeViewId : previousView ?? "view:overview",
      lastViewEvent,
      ready: true,
      loadingError: null,
    });
    await get().reloadBoq();
    } catch (error) {
      if (get().projectId === projectId) set({ ready: true, loadingError: error instanceof Error ? error.message : "加载失败" });
    }
  },

  async send(text) {
    const { projectId, running } = get();
    if (!projectId || running || !text.trim()) return;
    if (window.parent === window) { toast.info("请在 Harness 的造价工作台中发起任务（主入口端口 3210）"); return; }
    const harnessOrigin = sessionStorage.getItem("installation:harnessOrigin");
    if (!harnessOrigin) { toast.error("Harness 会话连接未建立，请从主入口打开工作台"); return; }
    set((s) => ({
      running: true,
      blocks: [...s.blocks, { type: "user", text }],
    }));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { window.removeEventListener("message", receive); reject(new Error("Harness 未响应，请检查主面板连接")); }, 30000);
        const receive = async (event: MessageEvent) => {
          if (event.origin !== harnessOrigin || event.source !== window.parent || event.data?.projectId !== projectId) return;
          if (!["installation:taskFinished", "installation:taskError"].includes(event.data?.type)) return;
          clearTimeout(timer); window.removeEventListener("message", receive);
          if (event.data.type === "installation:taskError") { reject(new Error(event.data.text)); return; }
          resolve();
        };
        window.addEventListener("message", receive);
        window.parent.postMessage({ type: "installation:task", projectId, text }, harnessOrigin);
      });
    } catch (error) {
      set((s) => ({
        blocks: [...s.blocks, { type: "error", text: error instanceof Error ? error.message : "请求失败" }],
      }));
      toast.error(error instanceof Error ? error.message : "请求失败");
    } finally { set({ running: false }); }
  },

  async streamRun(runId: string) {
    // 事件服务端已持久化并支持重放（seq 递增）——断线重连后按 seq 去重
    const seen = new Set<number>();
    let attempts = 0;
    for (;;) {
      try {
        const res = await fetch(`/api/runs/${runId}/stream`);
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let finished = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            try {
              const e = JSON.parse(line.slice(5)) as AgentEventDTO;
              if (e.seq !== undefined && seen.has(e.seq)) continue;
              if (e.seq !== undefined) seen.add(e.seq);
              if (e.type === "run_finished") finished = true;
              get().handleEvent(e, runId);
            } catch {}
          }
        }
        if (finished || ++attempts > 1) break; // 跑完或已重连过一次
      } catch {
        if (++attempts > 1) {
          set((s) => ({
            blocks: [...s.blocks, { type: "error", text: "事件流中断，结果可能不完整 — 请重试" }],
          }));
          break;
        }
        await new Promise((r) => setTimeout(r, 600)); // 静默重连一次
      }
    }
    set({ running: false });
  },

  async upload(file) {
    const { projectId } = get();
    if (!projectId) return;
    set((s) => ({
      running: true,
      blocks: [...s.blocks, { type: "upload", filename: file.name, uploading: true }],
    }));
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/projects/${projectId}/files`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { runId, duplicate, file: existed } = await res.json();
      if (duplicate) {
        // 内容相同的文件已导入过：去掉上传占位块，不占用 run
        set((s) => ({
          running: false,
          blocks: s.blocks.filter(
            (b) => !(b.type === "upload" && b.filename === file.name && b.uploading)
          ),
        }));
        toast.success(`「${existed?.filename ?? file.name}」与已上传文件内容相同，已跳过`);
        return;
      }
      // 上传完成，进入解析阶段（事件流接管反馈）
      set((s) => ({
        blocks: s.blocks.map((b) =>
          b.type === "upload" && b.filename === file.name ? { ...b, uploading: false } : b
        ),
      }));
      await get().refreshMeta();
      if (runId) await get().streamRun(runId);
      else set({ running: false });
    } catch {
      set((s) => ({
        running: false,
        blocks: [
          ...s.blocks.map((b) =>
            b.type === "upload" && b.filename === file.name ? { ...b, uploading: false } : b
          ),
          { type: "error", text: `「${file.name}」上传失败，请重试` },
        ],
      }));
    }
  },

  async patchItem(id, patch) {
    try {
    const res = await fetch(`/api/boq-items/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return false;
    await get().reloadBoq();
    await get().refreshMeta();
    return true;
    } catch { return false; }
  },

  async reloadBoq() {
    const { projectId } = get();
    if (!projectId) return;
    const [items, summary] = await Promise.all([
      fetch(`/api/projects/${projectId}/boq`).then(async r => { if (!r.ok) throw new Error("清单读取失败"); return r.json(); }),
      fetch(`/api/projects/${projectId}/summary`).then(async r => { if (!r.ok) throw new Error("汇总读取失败"); return r.json(); }),
    ]);
    if (get().projectId === projectId) set((s) => ({ items, summary, boqVersion: s.boqVersion + 1 }));
  },

  async refreshMeta() {
    const { projectId } = get();
    if (!projectId) return;
    const p = await fetch(`/api/projects/${projectId}`).then((r) => r.json());
    if (get().projectId !== projectId) return;
    set({
      projectName: p.name,
      harnessSessionId: p.harnessSessionId ?? "",
      files: p.files ?? [],
      facts: p.facts ?? [],
      receipts: p.receipts ?? [],
    });
  },

  setBoqQuery(q) {
    set({ boqQuery: q });
  },

  gotoBoqItem(key) {
    set((s) => {
      const views = s.views.some((v) => v.id === "view:boq")
        ? s.views
        : [...s.views, { kind: "boqTable", id: "view:boq", title: "工程量清单" } as WorkspaceView];
      return { views, activeViewId: "view:boq", boqQuery: key };
    });
  },

  setActiveView(id) {
    set({ activeViewId: id });
  },

  replaceView(view) {
    set((s) => ({
      views: s.views.some(v => v.id === view.id) ? s.views.map((v) => (v.id === view.id ? view : v)) : [...s.views, view],
    }));
  },

  closeView(id) {
    set((s) => {
      const idx = s.views.findIndex((v) => v.id === id);
      if (idx < 0) return {};
      const views = s.views.filter((v) => v.id !== id);
      const activeViewId =
        s.activeViewId === id
          ? (views[Math.max(0, idx - 1)]?.id ?? null)
          : s.activeViewId;
      return { views, activeViewId };
    });
  },

  handleEvent(e, runId) {
    const p = e.payload as Record<string, never>;
    set((s) => {
      switch (e.type) {
        case "activity": {
          // replace last live activity if same run, else append
          const blocks = [...s.blocks];
          const last = blocks[blocks.length - 1];
          if (last?.type === "activity" && last.runId === runId && last.live) {
            blocks[blocks.length - 1] = { ...last, live: false };
          }
          blocks.push({ type: "activity", text: p.text, runId, live: true });
          return { blocks };
        }
        case "activity_live": {
          // 心跳：原地改写当前 live activity 的文案，不产生新时间线行
          const blocks = [...s.blocks];
          const last = blocks[blocks.length - 1];
          if (last?.type === "activity" && last.runId === runId && last.live) {
            blocks[blocks.length - 1] = { ...last, text: p.text };
            return { blocks };
          }
          blocks.push({ type: "activity", text: p.text, runId, live: true });
          return { blocks };
        }
        case "thought_delta": {
          // 模型流式增量：同 streamId 原位更新，呈现打字机效果
          const sid = (p.streamId as string) ?? "s0";
          const blocks = [...s.blocks];
          const i = blocks.findIndex(
            (b) => b.type === "thought" && b.runId === runId && b.streamId === sid
          );
          const blk = { type: "thought" as const, text: p.text, runId, streamId: sid, live: true };
          if (i >= 0) blocks[i] = blk; else blocks.push(blk);
          return { blocks };
        }
        case "thought": {
          // 持久化 thought：同 streamId 的流式预览块落定；否则追加
          const sid = p.streamId as string | undefined;
          if (sid) {
            const blocks = [...s.blocks];
            const i = blocks.findIndex(
              (b) => b.type === "thought" && b.runId === runId && b.streamId === sid
            );
            if (i >= 0) {
              blocks[i] = { type: "thought", text: p.text, runId, streamId: sid, live: false };
              return { blocks };
            }
          }
          return { blocks: [...s.blocks, { type: "thought", text: p.text, runId }] };
        }
        case "tool_started":
          return {
            blocks: [
              ...s.blocks,
              { type: "tool", tool: p.tool, status: "running", runId, args: p.args },
            ],
          };
        case "tool_finished": {
          const blocks = [...s.blocks];
          for (let i = blocks.length - 1; i >= 0; i--) {
            const b = blocks[i];
            if (b.type === "tool" && b.tool === p.tool && b.status === "running") {
              blocks[i] = { ...b, status: p.status, ms: p.ms, resultMsg: p.message };
              break;
            }
          }
          return { blocks };
        }
        case "message": {
          // 最终答复到达：同文本的流式预览块（live thought）移除，避免与消息重复
          const blocks = s.blocks
            .filter((b) => !(b.type === "thought" && b.live))
            .map((b) => (b.type === "activity" && b.live ? { ...b, live: false } : b));
          return { blocks: [...blocks, { type: "agent", text: p.text, runId }] };
        }
        case "receipt":
          return {
            blocks: [
              ...s.blocks,
              {
                type: "receipt",
                receiptId: p.receiptId,
                summary: p.summary,
                actionType: p.actionType,
                runId,
              },
            ],
            receipts: [
              {
                id: p.receiptId,
                actionType: p.actionType,
                summary: p.summary,
                reversible: true,
                createdBy: "agent",
                createdAt: new Date().toISOString(),
              },
              ...s.receipts,
            ].slice(0, 50),
          };
        case "confirm_request": {
          const blocks = s.blocks.map((b) =>
            b.type === "activity" && b.live ? { ...b, live: false } : b
          );
          return {
            blocks: [
              ...blocks,
              {
                type: "confirm",
                confirmId: p.confirmId,
                runId,
                tool: p.tool,
                description: p.description,
              } as ConvBlock,
            ],
          };
        }
        case "confirm_resolved": {
          const blocks = [...s.blocks];
          for (let i = blocks.length - 1; i >= 0; i--) {
            const b = blocks[i];
            if (b.type === "confirm" && b.confirmId === p.confirmId) {
              blocks[i] = { ...b, decided: p.approved ? "approved" : "rejected" };
              break;
            }
          }
          return { blocks };
        }
        case "workspace_patch": {
          const view = p.view as WorkspaceView;
          const idx = s.views.findIndex((v) => v.id === view.id);
          const views = [...s.views];
          if (idx >= 0) views[idx] = view;
          else views.push(view);
          return { views, activeViewId: view.id, lastViewEvent: `${runId}:${e.seq}` };
        }
        case "error":
          return { blocks: [...s.blocks, { type: "error", text: p.text, runId }] };
        case "run_finished": {
          // run 结束：未落定的流式预览块转为普通块（若此前 message 已清理则无残留）
          const blocks = s.blocks.map((b) =>
            (b.type === "activity" || b.type === "thought") && b.live ? { ...b, live: false } : b
          );
          return { blocks, running: false };
        }
        default:
          return {};
      }
    });
    // refresh data after mutations
    if (e.type === "receipt" || (e.type === "tool_finished" && e.payload.tool === "boq.update")) {
      void get().reloadBoq();
      void get().refreshMeta();
    }
  },
}));
