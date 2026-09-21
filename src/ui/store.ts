"use client";
import { create } from "zustand";
import type {
  AgentEventDTO,
  BoqItemDTO,
  CostFactDTO,
  WorkspaceView,
} from "@shared/types";

export type ConvBlock =
  | { type: "user"; text: string }
  | { type: "agent"; text: string; runId: string }
  | { type: "activity"; text: string; runId: string; live: boolean }
  | { type: "thought"; text: string; runId: string }
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
  files: FileMeta[];
  facts: CostFactDTO[];
  items: BoqItemDTO[];
  blocks: ConvBlock[];
  views: WorkspaceView[];
  activeViewId: string | null;
  running: boolean;
  ready: boolean;
  boqVersion: number;

  init(projectId: string): Promise<void>;
  send(text: string): Promise<void>;
  upload(file: File): Promise<void>;
  patchItem(id: string, patch: Partial<BoqItemDTO>): Promise<boolean>;
  reloadBoq(): Promise<void>;
  refreshMeta(): Promise<void>;
  streamRun(runId: string): Promise<void>;
  setActiveView(id: string): void;
  closeView(id: string): void;
  handleEvent(e: AgentEventDTO, runId: string): void;
}

export const useStore = create<State>((set, get) => ({
  projectId: null,
  projectName: "",
  files: [],
  facts: [],
  items: [],
  blocks: [],
  views: [],
  activeViewId: null,
  running: false,
  ready: false,
  boqVersion: 0,

  async init(projectId) {
    if (get().projectId === projectId) return;
    set({ projectId, blocks: [], views: [], activeViewId: null, ready: false });
    const [p, items, runs] = await Promise.all([
      fetch(`/api/projects/${projectId}`).then((r) => r.json()),
      fetch(`/api/projects/${projectId}/boq`).then((r) => r.json()),
      fetch(`/api/projects/${projectId}/runs`).then((r) => r.json()),
    ]);

    // replay persisted runs into conversation blocks + workspace views
    const blocks: ConvBlock[] = [];
    const views: WorkspaceView[] = [];
    let activeViewId: string | null = null;
    for (const run of runs ?? []) {
      const ingest = run.userMessage.match(/分析并导入文件「(.+)」/);
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
          const idx = views.findIndex((x) => x.id === v.id);
          if (idx >= 0) views[idx] = v; else views.push(v);
          activeViewId = v.id;
        }
      }
    }

    set({
      projectName: p.name,
      files: p.files ?? [],
      facts: p.facts ?? [],
      items: items ?? [],
      blocks,
      views: views.length
        ? views
        : items?.length
          ? [{ kind: "boqTable", id: "view:boq", title: "工程量清单" }]
          : [],
      activeViewId: activeViewId ?? (items?.length ? "view:boq" : null),
      ready: true,
    });
  },

  async send(text) {
    const { projectId, running } = get();
    if (!projectId || running || !text.trim()) return;
    set((s) => ({
      running: true,
      blocks: [...s.blocks, { type: "user", text }],
    }));
    try {
      const res = await fetch(`/api/projects/${projectId}/agent/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { runId } = await res.json();
      if (!runId) throw new Error("no runId");
      void get().streamRun(runId);
    } catch {
      set((s) => ({
        running: false,
        blocks: [...s.blocks, { type: "error", text: "请求失败，请检查网络后重试" }],
      }));
    }
  },

  async streamRun(runId: string) {
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
          try {
            get().handleEvent(JSON.parse(line.slice(5)), runId);
          } catch {}
        }
      }
    } catch {
      set((s) => ({
        blocks: [...s.blocks, { type: "error", text: "事件流中断，结果可能不完整 — 请重试" }],
      }));
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
      const { runId } = await res.json();
      // 上传完成，进入解析阶段（事件流接管反馈）
      set((s) => ({
        blocks: s.blocks.map((b) =>
          b.type === "upload" && b.filename === file.name ? { ...b, uploading: false } : b
        ),
      }));
      if (runId) void get().streamRun(runId);
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
    const res = await fetch(`/api/boq-items/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return false;
    await get().reloadBoq();
    return true;
  },

  async reloadBoq() {
    const { projectId } = get();
    if (!projectId) return;
    const items = await fetch(`/api/projects/${projectId}/boq`).then((r) => r.json());
    set((s) => ({ items, boqVersion: s.boqVersion + 1 }));
  },

  async refreshMeta() {
    const { projectId } = get();
    if (!projectId) return;
    const p = await fetch(`/api/projects/${projectId}`).then((r) => r.json());
    set({ projectName: p.name, files: p.files ?? [], facts: p.facts ?? [] });
  },

  setActiveView(id) {
    set({ activeViewId: id });
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
        case "thought":
          return { blocks: [...s.blocks, { type: "thought", text: p.text, runId }] };
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
          const blocks = s.blocks.map((b) =>
            b.type === "activity" && b.live ? { ...b, live: false } : b
          );
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
          return { views, activeViewId: view.id };
        }
        case "error":
          return { blocks: [...s.blocks, { type: "error", text: p.text, runId }] };
        case "run_finished": {
          const blocks = s.blocks.map((b) =>
            b.type === "activity" && b.live ? { ...b, live: false } : b
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
