"use client";
import { useRef, useState } from "react";
import { useStore } from "../store";
import { FileSpreadsheet, FileText } from "lucide-react";
import { ConfirmDialog, EmptyState, toast } from "../primitives";
import { readResponse } from "../api";
import { cn } from "./shared";

const FILE_STATUS: Record<string, { label: string; cls: string }> = {
  UPLOADED: { label: "待解析", cls: "" },
  PARSED: { label: "已解析", cls: "ok" },
  FAILED: { label: "解析失败", cls: "danger" },
  PARSING: { label: "解析中", cls: "warn" },
};

const fmtBytes = (n?: number) => {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

const CMP_STAGE_ORDER = ["招标", "投标", "清标", "进度", "变更", "报审", "结算", "财评"];

export function FileList() {
  const { files, views, blocks, closedViewIds, setActiveView, init, projectId, running, agentRunning, importRunning, saving, send } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingDel, setPendingDel] = useState<{ id: string; name: string } | null>(null);
  const lock = useRef(false);
  const blocked = !!busy || running || agentRunning || importRunning || saving;
  // 对审默认对：与服务端 pickComparePair 同序（阶段→期次→上传时间取首末）
  const cmpPair = (() => {
    const boqs = files.filter(f => f.kind?.startsWith("BOQ") && f.status === "PARSED");
    if (boqs.length < 2) return null;
    const rank = (s?: string) => (!s ? -1 : Math.max(0, CMP_STAGE_ORDER.indexOf(s))); // 无阶段词=原始清单，作基准侧
    const sorted = [...boqs].sort((x, y) =>
      rank(x.stage) - rank(y.stage) || (x.period ?? "").localeCompare(y.period ?? "") || (x.createdAt ?? "").localeCompare(y.createdAt ?? ""));
    return [sorted[0], sorted[sorted.length - 1]] as const;
  })();
  const openFile = async (id: string) => {
    setActiveView(id);
    if (!views.some(v => v.id === id) && projectId) await init(projectId, true);
  };
  const remove = async () => {
    if (!pendingDel || lock.current || blocked) return;
    lock.current = true;
    setBusy(pendingDel.id);
    useStore.setState({ saving: true });
    try {
      const res = await fetch(`/api/files/${pendingDel.id}`, { method: "DELETE" });
      await readResponse(res, "删除失败，请重试");
      toast.success(`已删除「${pendingDel.name}」及其导入数据`);
      setPendingDel(null);
      if (projectId) await init(projectId, true);
    } catch (error) { toast.error(error instanceof Error ? error.message : "删除失败，请重试"); }
    finally { lock.current = false; setBusy(null); if (useStore.getState().projectId === projectId) useStore.setState({ saving: false }); }
  };
  // UPLOADED/FAILED 文件的重跑入口：和列映射视图的“重新导入”同一条 run 链路
  const parseFile = async (id: string, name: string) => {
    if (lock.current || blocked || !projectId) return;
    lock.current = true;
    setBusy(id);
    useStore.setState({ saving: true });
    try {
      const res = await fetch(`/api/files/${id}/reingest`, { method: "POST" });
      const { runId } = await readResponse<{ runId?: string }>(res, "解析失败，请重试");
      if (useStore.getState().projectId !== projectId) return;
      useStore.setState((s) => ({ blocks: [...s.blocks, { type: "upload", filename: name }] }));
      if (runId) {
        useStore.setState({ running: true });
        await useStore.getState().streamRun(runId);
        await Promise.all([useStore.getState().refreshMeta(), useStore.getState().reloadBoq()]);
      }
    } catch (error) { toast.error(error instanceof Error ? error.message : "解析失败，请重试"); }
    finally { lock.current = false; setBusy(null); if (useStore.getState().projectId === projectId) useStore.setState({ saving: false }); }
  };
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="cost-file-hint !mb-0">上传后系统会整理文件；需要你检查的表格会显示“待核对”。</p>
        {cmpPair && (
          <button
            className="cost-btn shrink-0"
            disabled={blocked}
            title={`对审「${cmpPair[0].filename}」与「${cmpPair[1].filename}」——价差/量差/独有项与申报口径对比`}
            onClick={() => void send(`对审「${cmpPair[0].filename}」与「${cmpPair[1].filename}」两版清单`)}
          >
            两版对审
          </button>
        )}
      </div>
      <div className="xl-sheet overflow-auto rounded-lg">
        <table className="xl-table xl-pin-last">
          <thead>
            <tr>
              <th className="xl-rn"></th>
              <th>文件名</th>
              <th className="w-28">类型</th>
              <th className="w-24">状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f, fi) => { const view = views.find(v => v.kind === "columnMapping" && v.fileId === f.id || v.kind === "document" && v.id === `view:doc:${f.id}`); const closedId = closedViewIds.find(id => id === `view:mapping:${f.id}` || id === `view:doc:${f.id}`); const awaiting = blocks.some(b => b.type === "confirm" && !b.decided && (b.fileId === f.id || b.description.includes(f.filename))); return (
              <tr key={f.id} className="group">
                <td className="xl-rn">{fi + 1}</td>
                <td>
                  <div className="flex items-center gap-2">
                    {f.filename.toLowerCase().endsWith(".pdf")
                      ? <FileText size={13} className="shrink-0 text-neutral-400" />
                      : <FileSpreadsheet size={13} className="shrink-0 text-neutral-400" />}
                    <div className="min-w-0">
                      <div className="flex max-w-96 items-center gap-1.5">
                        <span className="truncate" title={f.filename}>{f.filename}</span>
                        {f.stage && <span className="chip info !py-px !text-[10px] shrink-0">{f.stage}</span>}
                        {f.period && <span className="chip !py-px !text-[10px] shrink-0">{f.period}</span>}
                      </div>
                      {(f.sizeBytes || f.createdAt) && (
                        <div className="text-[10.5px] text-neutral-400">
                          {[fmtBytes(f.sizeBytes), f.createdAt && new Date(f.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </div>
                  </div>
                </td>
                <td><span className="chip">{f.kindLabel}</span></td>
                <td>
                  <span className={cn("chip", awaiting ? "warn" : FILE_STATUS[f.status]?.cls)}>
                    {awaiting ? "待核对" : FILE_STATUS[f.status]?.label ?? f.status}
                  </span>
                </td>
                <td className="text-center">
                  {(f.status === "UPLOADED" || f.status === "FAILED") && !awaiting && (
                    <button className="cost-file-action" disabled={blocked} onClick={() => void parseFile(f.id, f.filename)}>
                      {busy === f.id ? "解析中…" : f.status === "FAILED" ? "重新解析" : "开始解析"}
                    </button>
                  )}
                  {(view || closedId) && <button className="cost-file-action" onClick={() => void openFile(view?.id ?? closedId!)}>{view?.kind === "columnMapping" || closedId?.startsWith("view:mapping:") ? "核对表格" : "查看文档"}</button>}
                  <a className="cost-file-action" href={`/api/files/${f.id}/download`} download title="下载上传的原文件">下载</a>
                  <button
                    onClick={() => setPendingDel({ id: f.id, name: f.filename })}
                    disabled={blocked}
                    className="cost-file-action danger"
                  >
                    删除
                  </button>
                </td>
              </tr>
            ); })}
          </tbody>
        </table>
      </div>
      {!files.length && <EmptyState icon={<FileSpreadsheet size={22} />} title="还没有文件" />}
      <ConfirmDialog
        open={!!pendingDel}
        danger
        title={`删除「${pendingDel?.name ?? ""}」？`}
        description="将同时删除该文件导入的全部清单/询价数据，此操作不可撤销（会记录删除回执）。"
        confirmText="删除"
        busy={blocked}
        onConfirm={remove}
        onCancel={() => setPendingDel(null)}
      />
    </div>
  );
}
