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
  | { type: "tool"; tool: string; status: string; ms?: number; runId: string }
  | { type: "receipt"; receiptId: string; summary: string; actionType: string; runId: string }
  | { type: "upload"; filename: string }
  | { type: "error"; text: string };

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
  boqVersion: number;

  init(projectId: string): Promise<void>;
  send(text: string): Promise<void>;
  upload(file: File): Promise<void>;
  patchItem(id: string, patch: Partial<BoqItemDTO>): Promise<void>;
  reloadBoq(): Promise<void>;
  refreshMeta(): Promise<void>;
  streamRun(runId: string): Promise<void>;
  setActiveView(id: string): void;
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
  boqVersion: 0,

  async init(projectId) {
    if (get().projectId === projectId) return;
    set({ projectId, blocks: [], views: [], activeViewId: null });
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
        else if (e.type === "tool_started")
          blocks.push({ type: "tool", tool: pl.tool, status: "running", runId: run.id });
        else if (e.type === "tool_finished") {
          const b = [...blocks].reverse().find(
            (x) => x.type === "tool" && x.tool === pl.tool && x.status === "running"
          );
          if (b && b.type === "tool") { b.status = pl.status; b.ms = pl.ms; }
        } else if (e.type === "message")
          blocks.push({ type: "agent", text: pl.text, runId: run.id });
        else if (e.type === "receipt")
          blocks.push({
            type: "receipt", receiptId: pl.receiptId, summary: pl.summary,
            actionType: pl.actionType, runId: run.id,
          });
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
    });
  },

  async send(text) {
    const { projectId, running } = get();
    if (!projectId || running || !text.trim()) return;
    set((s) => ({
      running: true,
      blocks: [...s.blocks, { type: "user", text }],
    }));
    const res = await fetch(`/api/projects/${projectId}/agent/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    const { runId } = await res.json();
    get().streamRun(runId);
  },

  async streamRun(runId: string) {
    const res = await fetch(`/api/runs/${runId}/stream`);
    const reader = res.body!.getReader();
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
    set({ running: false });
  },

  async upload(file) {
    const { projectId } = get();
    if (!projectId) return;
    set((s) => ({
      running: true,
      blocks: [...s.blocks, { type: "upload", filename: file.name }],
    }));
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/projects/${projectId}/files`, {
      method: "POST",
      body: fd,
    });
    const { runId } = await res.json();
    if (runId) get().streamRun(runId);
    else set({ running: false });
  },

  async patchItem(id, patch) {
    await fetch(`/api/boq-items/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    await get().reloadBoq();
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
        case "tool_started":
          return {
            blocks: [
              ...s.blocks,
              { type: "tool", tool: p.tool, status: "running", runId },
            ],
          };
        case "tool_finished": {
          const blocks = [...s.blocks];
          for (let i = blocks.length - 1; i >= 0; i--) {
            const b = blocks[i];
            if (b.type === "tool" && b.tool === p.tool && b.status === "running") {
              blocks[i] = { ...b, status: p.status, ms: p.ms };
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
        case "workspace_patch": {
          const view = p.view as WorkspaceView;
          const idx = s.views.findIndex((v) => v.id === view.id);
          const views = [...s.views];
          if (idx >= 0) views[idx] = view;
          else views.push(view);
          return { views, activeViewId: view.id };
        }
        case "error":
          return { blocks: [...s.blocks, { type: "error", text: p.text }] };
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
