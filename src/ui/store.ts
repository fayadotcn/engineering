"use client";
import { create } from "zustand";
import type { AgentEventDTO, BoqItemDTO, CostFactDTO, ReceiptDTO, WorkspaceView } from "@shared/types";
import { toast } from "./primitives";
import { api, type AdjustSpec, type FileMeta, type NewItemPayload, type PastePatch, type ProjectSummary, type WorkbenchInit } from "./api";
import { INGEST_RE, reduceEvent, replayRuns, type ConvBlock } from "./runEvents";
import { FIXED_VIEWS, seedViews } from "./sections";
import { isBusy, isDirty } from "./busy";

export type { ConvBlock } from "./runEvents";
export { FIXED_VIEWS } from "./sections";
/** 关闭视图浮层的待确认哨兵：pendingViewId === 此值表示「关闭面板」而非切换视图 */
export const CLOSE_VIEW_ID = "__close__";

/** 首页直达任务的交接袋：File 对象过不了 URL，挂在模块级 Map 上随 SPA 导航存活，
 *  工作台 init 就绪后由 Workbench 取出消费（先补传文件，再发出第一句话）。 */
const pendingStarts = new Map<string, { message: string; files: File[] }>();
export function armPendingStart(projectId: string, start: { message: string; files: File[] }) {
  pendingStarts.set(projectId, start);
}
export function takePendingStart(projectId: string) {
  const start = pendingStarts.get(projectId);
  pendingStarts.delete(projectId);
  return start ?? null;
}

interface State {
  projectId: string | null;
  projectName: string;
  summary: ProjectSummary | null;
  loadingError: string | null;
  files: FileMeta[];
  facts: CostFactDTO[];
  receipts: ReceiptDTO[];
  items: BoqItemDTO[];
  blocks: ConvBlock[];
  views: WorkspaceView[];
  activeViewId: string | null;
  /** 视图浮层是否展开。对话是主界面，视图按需浮出。 */
  viewOpen: boolean;
  lastViewEvent: string | null;
  /** 有请求在途（上传、确认、事件流） */
  running: boolean;
  /** 助手正在执行一条指令 */
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
  /** 需要短暂高亮的清单行 id（补录/撤销/修改落点提示） */
  flashIds: string[];
  flashSeq: number;
  /** 最近一轮降级到规则引擎的失败原因；null=模型正常或未配置 */
  modelDown: string | null;

  init(projectId: string, refresh?: boolean, prefetched?: WorkbenchInit): Promise<void>;
  renameProject(name: string): Promise<boolean>;
  send(text: string, extra?: Record<string, unknown>): Promise<void>;
  upload(file: File): Promise<void>;
  patchItem(id: string, patch: Partial<BoqItemDTO>): Promise<boolean>;
  /** 删除清单行；成功返回回执 id（供「撤销」直接撤销），失败返回 null */
  deleteItem(id: string): Promise<string | null>;
  /** 批量删除清单行；一条回执原子撤销，成功返回回执 id */
  deleteItems(ids: string[]): Promise<string | null>;
  /** 多选行批量调价/调量（percent=增减百分比，value=统一设为）。 */
  adjustItems(ids: string[], spec: AdjustSpec): Promise<{ receiptId: string | null; updated: number; desc: string } | null>;
  /** Excel 粘回：把每行的工程量/综合单价/主材暂估价写回对应清单行，一条回执原子撤销。 */
  pasteItems(patches: PastePatch[]): Promise<string | null>;
  revertReceipt(receiptId: string): Promise<boolean>;
  /** Ctrl+Z：撤销最近一条可撤销的修改 */
  undoLast(): Promise<void>;
  /** 从操作记录等定位清单行：切到清单视图并闪烁高亮目标行 */
  focusBoqRows(ids: string[]): void;
  createItem(payload: NewItemPayload): Promise<string | null>;
  reloadBoq(): Promise<void>;
  refreshMeta(): Promise<void>;
  streamRun(runId: string, skipSeqs?: Set<number>): Promise<void>;
  confirmImport(runId: string, approve: boolean): Promise<void>;
  setActiveView(id: string): void;
  /** 关闭视图浮层；有未保存修改时先走 pendingViewId 确认门（哨兵 CLOSE_VIEW_ID）。 */
  closeOverlay(): void;
  closeView(id: string, fallbackId?: string): void;
  /** 同 id 视图替换（列映射保存后服务端回传的最新视图） */
  replaceView(view: WorkspaceView): void;
  setBoqQuery(q: string): void;
  /** 跳转到清单视图并过滤到目标项（编码或名称） */
  gotoBoqItem(key: string): void;
  handleEvent(e: AgentEventDTO, runId: string): void;
}

type Get = () => State;

let loadVersion = 0;
/** 后台刷新竞态护栏：只允许最后发出的响应落地，否则先发的旧快照晚到会把刚撤销/删除的行"复活"。 */
let boqSeq = 0;
let metaSeq = 0;
/** 撤销串行：快速连按 Ctrl+Z 时等前一次落地再挑下一条 */
let undoing = false;

const dispV = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? "空" : v);
const errText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** 让清单表里指定行短暂高亮：补录/撤销/修改落地后用户能看清数据回到了哪里 */
function flashRows(ids: string[]) {
  if (!ids.length) return;
  useStore.setState((s) => ({ flashIds: ids, flashSeq: s.flashSeq + 1 }));
  const seq = useStore.getState().flashSeq;
  setTimeout(() => { if (useStore.getState().flashSeq === seq) useStore.setState({ flashIds: [] }); }, 2600);
}

/** 本地写入成功后把回执预塞进列表：Ctrl+Z 不必等 refreshMeta 一圈才有撤销目标。 */
function noteReceipt(id: string | null | undefined, summary: string, affectedIds?: string[]) {
  if (!id) return;
  useStore.setState((s) => s.receipts.some((r) => r.id === id) ? s : {
    receipts: [{ id, actionType: "USER_EDIT", summary, reversible: true, reverted: false, affectedIds, createdBy: "user", createdAt: new Date().toISOString() }, ...s.receipts],
  });
}

/** 写入落地后后台刷新清单、汇总与操作记录；刷新失败单独提示，不影响已保存的结果。 */
function refreshAfterWrite(get: Get, projectId: string, what: string) {
  void (async () => {
    await get().reloadBoq();
    if (get().projectId !== projectId) return;
    await get().refreshMeta();
  })().catch(() => {
    if (get().projectId !== projectId) return;
    // 常驻提示真实状态：已经写进去了，只是界面没跟上——避免用户以为没保存而重复操作
    useStore.setState({ loadingError: `${what}，刷新失败。请重新加载以查看最新数据。` });
    toast.error(`${what}，数据刷新失败`, { label: "重新加载", onClick: () => void get().init(projectId, true) });
  });
}

/**
 * 工作区写操作的统一外壳：忙碌互斥 → 请求 → 落地回调 → 后台刷新；失败给出可重试的提示。
 * 返回 write 的结果，失败或被互斥挡住时返回 null。
 */
async function userWrite<T>(get: Get, opts: { write: () => Promise<T>; done: string; onSaved: (data: T) => void; retry: () => void; fallback: string }): Promise<T | null> {
  const projectId = get().projectId;
  if (!projectId || isBusy(get())) return null;
  useStore.setState({ saving: true });
  try {
    const data = await opts.write();
    if (get().projectId !== projectId) return data;
    opts.onSaved(data);
    refreshAfterWrite(get, projectId, opts.done);
    return data;
  } catch (error) {
    if (get().projectId === projectId) toast.error(errText(error, opts.fallback), { label: "重试", onClick: opts.retry });
    return null;
  } finally {
    if (get().projectId === projectId) useStore.setState({ saving: false });
  }
}

const INITIAL = {
  projectName: "", items: [], facts: [], files: [], receipts: [], summary: null, blocks: [], views: [],
  activeViewId: null, viewOpen: false, lastViewEvent: null, ready: false, running: false, agentRunning: false, importRunning: false,
  mappingDirty: false, settingsDirty: false, boqDirty: false, saving: false, pendingViewId: null, closedViewIds: [],
  loadingError: null, boqQuery: "", boqOnlyUnpriced: false, boqFocusVersion: 0, flashIds: [], flashSeq: 0, modelDown: null,
} satisfies Partial<State>;

export const useStore = create<State>((set, get) => ({
  projectId: null,
  ...INITIAL,
  boqVersion: 0,

  async init(projectId, refresh = false, prefetched) {
    const version = ++loadVersion;
    if (!refresh) set({ projectId, ...INITIAL });
    try {
      // 任何一路请求挂死都不能让工作台停在"正在读取"：20s 超时 → loadingError + 重试
      const t = AbortSignal.timeout(20000);
      const [p, items, runs, summary] = prefetched
        ? [prefetched.p, prefetched.items, prefetched.runs, prefetched.summary]
        : await Promise.all([api.project(projectId, t), api.boq(projectId, t), api.runs(projectId, t), api.summary(projectId, t)]);
      if (get().projectId !== projectId || version !== loadVersion) return;
      const replay = replayRuns(runs);
      const previous = get().views;
      const views = [...seedViews(p.facts ?? []).filter((v) => !replay.views.some((x) => x.id === v.id)), ...replay.views]
        // 用户在清单视图上加的筛选是操作现场，后台刷新重建视图时带回来
        .map((v) => {
          const prev = previous.find((x) => x.id === v.id);
          return v.kind === "boqTable" && prev?.kind === "boqTable" && prev.filter ? { ...v, filter: prev.filter } : v;
        })
        .filter((v) => !get().closedViewIds.includes(v.id) || FIXED_VIEWS.has(v.id));
      const opening = get().activeViewId ?? "view:overview";
      set({
        projectName: p.name, files: p.files ?? [], facts: p.facts ?? [], receipts: p.receipts ?? [], items: items ?? [], summary,
        // 后台刷新时保留进行中的实时块（流式预览、上传占位），否则正在跑的任务会闪回
        blocks: refresh && get().agentRunning ? get().blocks : replay.blocks,
        views, lastViewEvent: replay.lastViewEvent, modelDown: replay.modelDown, ready: true, loadingError: null,
        activeViewId: opening.startsWith("empty:") || views.some((v) => v.id === opening) ? opening : "view:overview",
      });
      // 接管正在执行的任务，只消费增量。待确认任务已回放出确认卡片，
      // 此时需保留编辑和批准入口，用户批准后由 confirmImport 重新接流。
      const live = [...runs].reverse().find((r) => !r.legacy && r.status === "RUNNING");
      if (live) {
        const importRun = INGEST_RE.test(live.userMessage);
        set({ running: true, agentRunning: !importRun, importRunning: importRun });
        void (async () => {
          try {
            await get().streamRun(live.id, new Set(live.events.map((e) => e.seq)));
            if (get().projectId !== projectId) return;
            await Promise.all([get().refreshMeta(), get().reloadBoq()]);
          } finally {
            if (get().projectId === projectId) set({ running: false, agentRunning: false, importRunning: false });
          }
        })();
      }
    } catch (error) {
      if (get().projectId === projectId && version === loadVersion) set({ ready: true, loadingError: errText(error, "加载失败") });
    }
  },

  async renameProject(name) {
    const projectId = get().projectId;
    if (!projectId || !name.trim()) return false;
    try {
      await api.renameProject(projectId, name.trim());
      if (get().projectId === projectId) set({ projectName: name.trim() });
      return true;
    } catch (error) {
      toast.error(errText(error, "改名失败"));
      return false;
    }
  },

  async send(text, extra) {
    const { projectId } = get();
    if (!projectId || isBusy(get()) || !get().ready || !text.trim()) return;
    if (isDirty(get())) { toast.info("请先保存或取消当前编辑，再发起任务"); return; }
    set((s) => ({ running: true, agentRunning: true, blocks: [...s.blocks, { type: "user", text }] }));
    try {
      const { runId } = await api.startRun(projectId, text, extra);
      if (get().projectId !== projectId) return;
      set((s) => ({ blocks: s.blocks.map((b, i) => (i === s.blocks.length - 1 && b.type === "user" ? { ...b, runId } : b)) }));
      await get().streamRun(runId);
      if (get().projectId !== projectId) return;
      await Promise.all([get().refreshMeta(), get().reloadBoq()]);
    } catch (error) {
      if (get().projectId !== projectId) return;
      set((s) => ({ blocks: [...s.blocks, { type: "error", text: errText(error, "请求失败") }] }));
    } finally {
      if (get().projectId === projectId) set({ running: false, agentRunning: false });
    }
  },

  async streamRun(runId, skipSeqs) {
    const projectId = get().projectId;
    // 事件服务端已持久化并支持重放（seq 递增）——断线重连后按 seq 去重；
    // init 接管存活任务时传入已回放事件的 seq，避免历史块翻倍
    const seen = skipSeqs ?? new Set<number>();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(api.streamUrl(runId));
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
            // 停在确认门或任务结束：交还控制权，确认后由 confirmImport 重新接流
            const awaiting = e.type === "confirm_request" && get().blocks.some((b) => b.type === "confirm" && b.confirmId === e.payload.confirmId && !b.decided);
            if (awaiting || e.type === "run_finished") {
              if (get().projectId === projectId) set({ running: false });
              // 确认门仍保持服务端运行；传输层取消可能等到该任务结束，不能挡住核对和批准。
              void reader.cancel().catch(() => {});
              return;
            }
          }
        }
        throw new Error("事件流提前结束");
      } catch {
        if (get().projectId !== projectId) return;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 600)); // 静默重连一次
      }
    }
    if (get().projectId === projectId)
      set((s) => ({ running: false, blocks: [...s.blocks, { type: "error", text: "与任务的连接中断，刷新页面可查看最新进度", runId }] }));
  },

  async confirmImport(runId, approve) {
    const projectId = get().projectId;
    if (!projectId || isBusy(get()) || isDirty(get())) return;
    set({ running: true, agentRunning: true });
    try {
      await api.confirmRun(runId, approve);
      if (get().projectId !== projectId) return;
      set((s) => ({ blocks: s.blocks.map((b) => (b.type === "confirm" && b.runId === runId ? { ...b, decided: approve ? "approved" : "rejected" } : b)) }));
      await get().streamRun(runId);
      if (get().projectId !== projectId) return;
      // 续流会回放识别时的旧映射，重新装配当前已保存的文件状态。
      await get().init(projectId, true);
    } catch (error) {
      if (get().projectId === projectId) toast.error(errText(error, "确认失败"));
    } finally {
      if (get().projectId === projectId) set({ running: false, agentRunning: false });
    }
  },

  async upload(file) {
    const { projectId } = get();
    if (!projectId || isBusy(get()) || !get().ready) return;
    if (isDirty(get())) { toast.info("请先保存或取消当前编辑，再导入资料"); return; }
    const mark = (runId?: string) => set((s) => ({
      blocks: s.blocks.map((b) => (b.type === "upload" && b.filename === file.name && b.uploading ? { ...b, uploading: false, runId } : b)),
    }));
    set((s) => ({ running: true, importRunning: true, blocks: [...s.blocks, { type: "upload", filename: file.name, uploading: true }] }));
    try {
      const { runId, duplicate, file: existed } = await api.upload(projectId, file);
      if (get().projectId !== projectId) return;
      if (duplicate) {
        set((s) => ({ blocks: s.blocks.filter((b) => !(b.type === "upload" && b.filename === file.name && b.uploading)) }));
        toast.success(`「${existed?.filename ?? file.name}」与已上传文件内容相同，已跳过`);
        return;
      }
      mark(runId ?? undefined);
      await get().refreshMeta();
      if (runId) await get().streamRun(runId);
      if (get().projectId !== projectId) return;
      await Promise.all([get().refreshMeta(), get().reloadBoq()]);
    } catch (error) {
      if (get().projectId !== projectId) return;
      mark();
      set((s) => ({ blocks: [...s.blocks, { type: "error", text: `「${file.name}」：${errText(error, "上传失败，请重试")}` }] }));
    } finally {
      if (get().projectId === projectId) set({ running: false, importRunning: false });
    }
  },

  async patchItem(id, patch) {
    const data = await userWrite(get, {
      write: () => api.patchItem(id, patch),
      done: "清单修改已保存",
      fallback: "保存失败，请重试",
      retry: () => void get().patchItem(id, patch),
      onSaved: (data) => {
        // 乐观合并服务端结果（含换算的合价等），后台刷新兜底
        set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...patch, ...(data?.item ?? {}) } : i)) }));
        flashRows([id]);
        if (!data?.receiptId) return;
        const rid = data.receiptId;
        const name = data.item?.name ?? "清单行";
        noteReceipt(rid, `用户在工作区修改清单行「${name}」`, [id]);
        const [first, ...extras] = data.changes ?? [];
        const detail = first
          ? `：${first.label} ${dispV(first.from)} → ${dispV(first.to)}${extras.length ? (extras.every((c) => c.field === "totalPrice") ? "，合价已联动" : ` 等${extras.length + 1}处`) : ""}`
          : "";
        toast.success(`已修改「${name}」${detail}`, { label: "撤销", onClick: () => void get().revertReceipt(rid).then((ok) => { if (ok) toast.success("已撤销该修改"); }) });
      },
    });
    return data !== null;
  },

  async deleteItem(id) {
    const name = get().items.find((i) => i.id === id)?.name ?? "";
    const data = await userWrite(get, {
      write: () => api.deleteItem(id),
      done: "已删除",
      fallback: "删除失败，请重试",
      retry: () => void get().deleteItem(id),
      onSaved: ({ receiptId }) => {
        noteReceipt(receiptId, `用户在工作区删除清单行「${name}」`, [id]);
        set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
      },
    });
    return data?.receiptId ?? null;
  },

  async deleteItems(ids) {
    if (!ids.length) return null;
    const data = await userWrite(get, {
      write: () => api.deleteItems(ids),
      done: "已删除",
      fallback: "删除失败，请重试",
      retry: () => void get().deleteItems(ids),
      onSaved: ({ receiptId }) => {
        noteReceipt(receiptId, `用户在工作区批量删除 ${ids.length} 行清单`, ids);
        const gone = new Set(ids);
        set((s) => ({ items: s.items.filter((i) => !gone.has(i.id)) }));
      },
    });
    return data?.receiptId ?? null;
  },

  async adjustItems(ids, spec) {
    if (!ids.length) return null;
    const FL = { unitPrice: "综合单价", quantity: "工程量", mainMaterialPrice: "主材暂估价" } as const;
    const desc = spec.mode === "percent"
      ? `${FL[spec.field]}统一${Number(spec.value) < 0 ? "下浮" : "上浮"} ${Math.abs(Number(spec.value))}%`
      : `${FL[spec.field]}统一设为 ${spec.value}`;
    const data = await userWrite(get, {
      write: () => api.adjustItems(ids, spec),
      done: "已调整",
      fallback: "调整失败，请重试",
      retry: () => void get().adjustItems(ids, spec),
      onSaved: (d) => {
        noteReceipt(d.receiptId, `用户在工作区批量调整 ${d.updated ?? ids.length} 行清单：${desc}`, d.affectedIds);
        flashRows(d.affectedIds ?? []);
      },
    });
    return data ? { receiptId: data.receiptId ?? null, updated: data.updated ?? ids.length, desc } : null;
  },

  async pasteItems(patches) {
    if (!patches.length) return null;
    const data = await userWrite(get, {
      write: () => api.pasteItems(patches),
      done: "已粘贴",
      fallback: "粘贴失败，请重试",
      retry: () => void get().pasteItems(patches),
      onSaved: (d) => {
        noteReceipt(d.receiptId, `用户在工作区粘贴更新 ${d.updated ?? patches.length} 行清单（工程量/综合单价）`, d.affectedIds);
        flashRows(d.affectedIds ?? []);
      },
    });
    return data?.receiptId ?? null;
  },

  async createItem(payload) {
    const projectId = get().projectId;
    if (!projectId) return null;
    const data = await userWrite(get, {
      write: () => api.createItem(projectId, payload),
      done: "已补录",
      fallback: "添加失败，请重试",
      retry: () => void get().createItem(payload),
      onSaved: ({ item, receiptId }) => {
        noteReceipt(receiptId, `用户在工作区${payload.insertAfter ? "复制" : "补录"}清单行「${payload.name}」`, item?.id ? [item.id] : undefined);
        if (item?.id) flashRows([item.id]);
      },
    });
    return data?.receiptId ?? null;
  },

  async revertReceipt(receiptId) {
    const projectId = get().projectId;
    if (!projectId) return false;
    try {
      const { affectedIds, restored, removedIds } = await api.revertReceipt(receiptId);
      if (get().projectId !== projectId) return true;
      // 立即合并撤销结果：改回的行原地恢复，补录行移除，被删行重挂（位置由后台刷新校正）
      const rm = new Set(removedIds ?? []);
      const byId = new Map((restored ?? []).map((r) => [r.id, r]));
      if (rm.size || byId.size) set((s) => ({
        items: [
          ...s.items.filter((i) => !rm.has(i.id)).map((i) => byId.get(i.id) ?? i),
          ...[...byId.values()].filter((r) => !s.items.some((i) => i.id === r.id)),
        ],
      }));
      flashRows(affectedIds ?? []);
      refreshAfterWrite(get, projectId, "已撤销");
      return true;
    } catch (error) {
      if (get().projectId === projectId) toast.error(errText(error, "撤销失败，请重试"));
      return false;
    }
  },

  async undoLast() {
    const projectId = get().projectId;
    if (!projectId || undoing || isBusy(get())) return;
    undoing = true;
    try {
      // 先按当前列表挑；后台 refreshMeta 最多等 300ms，可能同步到助手刚写的更新回执
      const meta = get().refreshMeta().catch(() => {});
      const pick = () => get().receipts.find((r) => r.reversible && !r.reverted && r.actionType !== "REVERT");
      let target = pick();
      if (!target) await meta;
      else await Promise.race([meta, new Promise((r) => setTimeout(r, 300))]);
      if (get().projectId !== projectId) return;
      target = pick() ?? target;
      if (!target) { toast.info("没有可以撤销的修改"); return; }
      if (await get().revertReceipt(target.id)) toast.success(`已撤销：${target.summary.replace(/^用户在工作区/, "")}`);
    } finally { undoing = false; }
  },

  focusBoqRows(ids) {
    if (!ids.length) return;
    if (get().saving || isDirty(get())) { toast.info("请先保存或取消当前编辑，再定位清单项"); return; }
    get().setActiveView("view:boq");
    flashRows(ids);
  },

  async reloadBoq() {
    const { projectId } = get();
    if (!projectId) return;
    const seq = ++boqSeq;
    const [items, summary] = await Promise.all([api.boq(projectId), api.summary(projectId)]);
    if (get().projectId === projectId && seq === boqSeq) set((s) => ({ items, summary, boqVersion: s.boqVersion + 1 }));
  },

  async refreshMeta() {
    const { projectId } = get();
    if (!projectId) return;
    const seq = ++metaSeq;
    const p = await api.project(projectId);
    if (get().projectId !== projectId || seq !== metaSeq) return;
    set({ projectName: p.name, files: p.files ?? [], facts: p.facts ?? [], receipts: p.receipts ?? [] });
  },

  setBoqQuery(q) {
    set({ boqQuery: q });
  },

  gotoBoqItem(key) {
    if (get().saving || isDirty(get())) { toast.info("请先保存或取消当前编辑，再定位清单项"); return; }
    set((s) => ({
      views: s.views.map((v) => (v.id === "view:boq" && v.kind === "boqTable" ? { ...v, filter: undefined } : v)),
      boqQuery: key, boqOnlyUnpriced: false, boqFocusVersion: s.boqFocusVersion + 1,
    }));
    get().setActiveView("view:boq");
  },

  setActiveView(id) {
    if (id === get().activeViewId && get().viewOpen) return;
    if (get().saving) { toast.info("正在保存，请稍候再切换页面"); return; }
    if (isDirty(get())) { set({ pendingViewId: id }); return; }
    set((s) => ({ activeViewId: id, viewOpen: true, closedViewIds: s.closedViewIds.filter((v) => v !== id) }));
  },

  closeOverlay() {
    if (get().saving) { toast.info("正在保存，请稍候"); return; }
    if (isDirty(get())) { set({ pendingViewId: CLOSE_VIEW_ID }); return; }
    set({ viewOpen: false });
  },

  replaceView(view) {
    set((s) => ({ views: s.views.some((v) => v.id === view.id) ? s.views.map((v) => (v.id === view.id ? view : v)) : [...s.views, view] }));
  },

  closeView(id, fallbackId) {
    if (FIXED_VIEWS.has(id)) return;
    if (get().activeViewId === id && (isDirty(get()) || get().saving)) return;
    set((s) => {
      if (!s.views.some((v) => v.id === id)) return {};
      const views = s.views.filter((v) => v.id !== id);
      const activeViewId = s.activeViewId !== id
        ? s.activeViewId
        : fallbackId && (views.some((v) => v.id === fallbackId) || fallbackId.startsWith("empty:")) ? fallbackId : "view:overview";
      return { views, activeViewId, closedViewIds: [...s.closedViewIds, id] };
    });
  },

  handleEvent(e, runId) {
    set((s) => ({ ...reduceEvent(s, e, runId), ...(e.type === "run_finished" ? { running: false } : {}) }));
    // 助手改了数据：同步清单与汇总
    if (e.type === "receipt" || (e.type === "tool_finished" && e.payload.tool === "boq.update"))
      void Promise.all([get().reloadBoq(), get().refreshMeta()]).catch(() => toast.error("变更已执行，数据刷新失败，请重新加载"));
  },
}));

// 调试钩子：浏览器里 `__cost.getState()` 直读工作台状态
if (typeof window !== "undefined") (window as unknown as { __cost?: typeof useStore }).__cost = useStore;
