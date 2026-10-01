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
  | { type: "confirm"; confirmId: string; runId: string; tool: string; description: string; fileId?: string; decided?: "approved" | "rejected" }
  | { type: "upload"; filename: string; uploading?: boolean }
  | { type: "error"; text: string; runId?: string };

/** 流程中间的视图：会随任务推送，但不该替用户把面板切过去（映射页绝大多数时候不该被看到）。 */
const WORKING_VIEWS = new Set<WorkspaceView["kind"]>(["columnMapping", "document"]);
const FIXED_VIEWS = new Set(["view:overview", "view:files", "view:boq", "view:facts", "view:receipts"]);
let loadVersion = 0;

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
  agentRunning: boolean;
  importRunning: boolean;
  mappingDirty: boolean;
  settingsDirty: boolean;
  boqDirty: boolean;
  saving: boolean;
  pendingViewId: string | null;
  closedViewIds: string[];
  ready: boolean;
  boqVersion: number;
  /** 清单表全局搜索框（异常定位等跨组件联动用） */
  boqQuery: string;
  boqOnlyUnpriced: boolean;
  boqFocusVersion: number;

  init(projectId: string, refresh?: boolean): Promise<void>;
  send(text: string): Promise<void>;
  upload(file: File): Promise<void>;
  patchItem(id: string, patch: Partial<BoqItemDTO>): Promise<boolean>;
  reloadBoq(): Promise<void>;
  refreshMeta(): Promise<void>;
  streamRun(runId: string): Promise<void>;
  confirmImport(runId: string, approve: boolean): Promise<void>;
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
  agentRunning: false,
  importRunning: false,
  mappingDirty: false,
  settingsDirty: false,
  boqDirty: false,
  saving: false,
  pendingViewId: null,
  closedViewIds: [],
  ready: false,
  boqVersion: 0,
  boqQuery: "",
  boqOnlyUnpriced: false,
  boqFocusVersion: 0,

  async init(projectId, refresh = false) {
    const version = ++loadVersion;
    if (!refresh) set({ projectId, projectName: "", items: [], facts: [], files: [], receipts: [], summary: null, blocks: [], views: [], activeViewId: null, lastViewEvent: null, ready: false, running: false, agentRunning: false, importRunning: false, mappingDirty: false, settingsDirty: false, boqDirty: false, saving: false, pendingViewId: null, closedViewIds: [], loadingError: null, boqQuery: "", boqOnlyUnpriced: false, boqFocusVersion: 0 });
    try {
    const [p, items, runs, summary] = await Promise.all([
      fetch(`/api/projects/${projectId}`).then(async r => { if (!r.ok) throw new Error("项目不存在或暂时无法读取"); return r.json(); }),
      fetch(`/api/projects/${projectId}/boq`).then(async r => { if (!r.ok) throw new Error("清单读取失败"); return r.json(); }),
      fetch(`/api/projects/${projectId}/runs`).then(async r => { if (!r.ok) throw new Error("任务记录读取失败"); return r.json(); }),
      fetch(`/api/projects/${projectId}/summary`).then(async r => { if (!r.ok) throw new Error("汇总读取失败"); return r.json(); }),
    ]);
    if (get().projectId !== projectId || version !== loadVersion) return;

    // replay persisted runs into conversation blocks + workspace views
    const blocks: ConvBlock[] = [];
    const views: WorkspaceView[] = [];
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
            fileId: (pl.args as { fileId?: string } | undefined)?.fileId,
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
          // 重放只把视图挂回所属对象，不决定用户当前看什么
          lastViewEvent = `${run.id}:${e.seq}`;
        }
      }
      // 超时或失败的任务不能再显示为可批准的导入。
      if (run.status && run.status !== "AWAITING_CONFIRM" && run.status !== "RUNNING") {
        for (const b of blocks) if (b.type === "confirm" && b.runId === run.id && !b.decided) b.decided = "rejected";
      }
    }

    // 常驻对象视图与 Agent 推送的视图共用同一套 id（view:boq / view:files / view:facts），
    // 因此重复时不会出现同一对象两个标签。
    const seedViews: WorkspaceView[] = [
      { kind: "overview", id: "view:overview", title: "项目总览" },
      { kind: "fileList", id: "view:files", title: "项目资料" },
      { kind: "boqTable", id: "view:boq", title: "工程清单" },
      { kind: "factList", id: "view:facts", title: "计价条件", facts: p.facts ?? [] },
      { kind: "receipts", id: "view:receipts", title: "变更记录" },
    ];
    const projectViews: WorkspaceView[] = [
      ...seedViews.filter(v => !views.some(x => x.id === v.id)),
      ...views,
    ].filter(v => !get().closedViewIds.includes(v.id) || FIXED_VIEWS.has(v.id));
    // 看什么是用户的选择：Agent 推来的视图只入列，不切换当前打开的结果
    const opening = get().activeViewId ?? "view:boq";
    set({
      projectName: p.name,
      harnessSessionId: p.harnessSessionId ?? "",
      files: p.files ?? [],
      facts: p.facts ?? [],
      receipts: p.receipts ?? [],
      items: items ?? [],
      summary,
      blocks,
      views: projectViews,
      activeViewId: opening.startsWith("empty:") || projectViews.some(v => v.id === opening) ? opening : "view:boq",
      lastViewEvent,
      ready: true,
      loadingError: null,
    });
    } catch (error) {
      if (get().projectId === projectId && version === loadVersion) set({ ready: true, loadingError: error instanceof Error ? error.message : "加载失败" });
    }
  },

  async send(text) {
    const { projectId, running, agentRunning, importRunning, saving, mappingDirty, settingsDirty, boqDirty } = get();
    if (!projectId || running || agentRunning || importRunning || saving || !get().ready || !text.trim()) return;
    if (mappingDirty || settingsDirty || boqDirty) { toast.info("请先保存或取消当前编辑，再发起任务"); return; }
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
      if (get().projectId !== projectId) return;
      set((s) => ({
        blocks: [...s.blocks, { type: "error", text: error instanceof Error ? error.message : "请求失败" }],
      }));
      toast.error(error instanceof Error ? error.message : "请求失败");
    } finally { if (get().projectId === projectId) set({ running: false }); }
  },

  async streamRun(runId: string) {
    const projectId = get().projectId;
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
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            let e: AgentEventDTO;
            try { e = JSON.parse(line.slice(5)) as AgentEventDTO; } catch { continue; }
            if (get().projectId !== projectId) { await reader.cancel(); return; }
            if (e.seq !== undefined && seen.has(e.seq)) continue;
            if (e.seq !== undefined) seen.add(e.seq);
            get().handleEvent(e, runId);
            const awaiting = e.type === "confirm_request" && get().blocks.some(b => b.type === "confirm" && b.confirmId === e.payload.confirmId && !b.decided);
            if (awaiting || e.type === "run_finished") {
              await reader.cancel();
              if (get().projectId === projectId) set({ running: false });
              return;
            }
          }
        }
        throw new Error("事件流提前结束");
      } catch {
        if (get().projectId !== projectId) return;
        if (++attempts > 1) {
          if (get().projectId === projectId) set((s) => ({
            blocks: [...s.blocks, { type: "error", text: "导入进度连接中断，请检查项目资料状态", runId }],
          }));
          break;
        }
        await new Promise((r) => setTimeout(r, 600)); // 静默重连一次
      }
    }
    if (get().projectId === projectId) set({ running: false });
  },

  async confirmImport(runId, approve) {
    const projectId = get().projectId;
    if (!projectId || get().running || get().agentRunning || get().importRunning || get().saving || get().boqDirty || get().settingsDirty || get().mappingDirty) return;
    set({ running: true });
    try {
      const res = await fetch(`/api/runs/${runId}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approve }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "确认失败");
      if (get().projectId !== projectId) return;
      set(s => ({ blocks: s.blocks.map(b => b.type === "confirm" && b.runId === runId ? { ...b, decided: approve ? "approved" : "rejected" } : b) }));
      if (approve) await get().streamRun(runId);
      if (get().projectId !== projectId) return;
      await Promise.all([get().refreshMeta(), get().reloadBoq()]);
      if (get().projectId !== projectId) return;
      if (!get().blocks.some(b => b.type === "error" && b.runId === runId)) toast.success(approve ? "导入完成，请查看工程清单与项目资料" : "已取消本次导入");
    } catch (error) { if (get().projectId === projectId) toast.error(error instanceof Error ? error.message : "确认失败"); }
    finally { if (get().projectId === projectId) set({ running: false }); }
  },

  async upload(file) {
    const { projectId } = get();
    if (!projectId || get().running || get().agentRunning || get().importRunning || get().saving || !get().ready) return;
    if (get().mappingDirty || get().settingsDirty || get().boqDirty) { toast.info("请先保存或取消当前编辑，再导入资料"); return; }
    set((s) => ({
      running: true,
      blocks: [...s.blocks, { type: "upload", filename: file.name, uploading: true }],
    }));
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("filename", file.name);
      const res = await fetch(`/api/projects/${projectId}/files`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `上传失败（${res.status}）`);
      const { runId, duplicate, file: existed } = await res.json();
      if (get().projectId !== projectId) return;
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
      if (get().projectId !== projectId) return;
      await Promise.all([get().refreshMeta(), get().reloadBoq()]);
    } catch (error) {
      if (get().projectId !== projectId) return;
      set((s) => ({
        running: false,
        blocks: [
          ...s.blocks.map((b) =>
            b.type === "upload" && b.filename === file.name ? { ...b, uploading: false } : b
          ),
          { type: "error", text: `「${file.name}」：${error instanceof Error ? error.message : "上传失败，请重试"}` },
        ],
      }));
    }
  },

  async patchItem(id, patch) {
    const projectId = get().projectId;
    if (!projectId || get().saving || get().running || get().agentRunning || get().importRunning) return false;
    set({ saving: true });
    let saved = false;
    try {
    const res = await fetch(`/api/boq-items/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? "保存失败，请重试");
    saved = true;
    if (get().projectId !== projectId) return true;
    await get().reloadBoq();
    if (get().projectId !== projectId) return true;
    await get().refreshMeta();
    return true;
    } catch (error) {
      if (get().projectId === projectId) {
        if (saved) set({ loadingError: "清单修改已保存，刷新失败。请重新加载以查看最新数据。" });
        toast.error(saved ? "修改已保存，数据刷新失败，请重新加载" : error instanceof Error ? error.message : "保存失败，请重试");
      }
      return saved;
    }
    finally { if (get().projectId === projectId) set({ saving: false }); }
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
    const p = await fetch(`/api/projects/${projectId}`).then(async r => { if (!r.ok) throw new Error("项目资料读取失败"); return r.json(); });
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
    if (get().saving || get().boqDirty || get().mappingDirty || get().settingsDirty) { toast.info("请先保存或取消当前编辑，再定位清单项"); return; }
    set((s) => {
      const views = s.views.some((v) => v.id === "view:boq")
        ? s.views.map(v => v.id === "view:boq" && v.kind === "boqTable" ? { ...v, filter: undefined } : v)
        : [...s.views, { kind: "boqTable", id: "view:boq", title: "工程量清单" } as WorkspaceView];
      return { views, boqQuery: key, boqOnlyUnpriced: false, boqFocusVersion: s.boqFocusVersion + 1 };
    });
    get().setActiveView("view:boq");
  },

  setActiveView(id) {
    if (id !== get().activeViewId && get().saving) { toast.info("正在保存，请稍候再切换页面"); return; }
    if (id !== get().activeViewId && (get().mappingDirty || get().settingsDirty || get().boqDirty)) { set({ pendingViewId: id }); return; }
    set(s => ({ activeViewId: id, closedViewIds: s.closedViewIds.filter(v => v !== id) }));
  },

  replaceView(view) {
    set((s) => ({
      views: s.views.some(v => v.id === view.id) ? s.views.map((v) => (v.id === view.id ? view : v)) : [...s.views, view],
    }));
  },

  closeView(id) {
    if (FIXED_VIEWS.has(id)) return;
    if (get().activeViewId === id && (get().mappingDirty || get().settingsDirty || get().boqDirty || get().saving)) return;
    set((s) => {
      const idx = s.views.findIndex((v) => v.id === id);
      if (idx < 0) return {};
      const views = s.views.filter((v) => v.id !== id);
      const activeViewId =
        s.activeViewId === id
          ? "view:boq"
          : s.activeViewId;
      return { views, activeViewId, closedViewIds: [...s.closedViewIds, id] };
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
          if (s.blocks.some(b => b.type === "confirm" && b.confirmId === p.confirmId)) return {};
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
                fileId: (p.args as { fileId?: string } | undefined)?.fileId,
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
          if (!view?.kind) return {};
          const idx = s.views.findIndex((v) => v.id === view.id);
          const views = [...s.views];
          if (idx >= 0) views[idx] = view;
          else views.push(view);
          // 不抢焦点：仅当当前没有任何打开的结果时补位，且工作视图（列映射/文档）永不自动弹出
          const activeViewId = WORKING_VIEWS.has(view.kind) ? s.activeViewId : s.activeViewId ?? view.id;
          return { views, activeViewId, lastViewEvent: `${runId}:${e.seq}` };
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
      void Promise.all([get().reloadBoq(), get().refreshMeta()]).catch(() => toast.error("变更已执行，数据刷新失败，请重新加载"));
    }
  },
}));
