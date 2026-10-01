"use client";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { COLUMN_ROLE_LABEL, COLUMN_ROLES, type WorkspaceView } from "@shared/types";
import { reconcilePriceRole } from "@shared/mapping";
import { ConfirmDialog, toast } from "../primitives";
import { readResponse } from "../http";
import { FileSpreadsheet, Save, RefreshCw } from "lucide-react";

type MappingView = Extract<WorkspaceView, { kind: "columnMapping" }>;
type Sheet = MappingView["sheets"][number];

const cn = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(" ");
const TYPE_LABEL: Record<Sheet["type"], string> = {
  BOQ: "清单",
  QUOTATION: "询价表",
  GENERIC: "忽略",
};

const colLetter = (i: number): string => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

interface Draft {
  type: Sheet["type"];
  /** col index → role */
  byCol: Record<number, string>;
}

const toDraft = (s: Sheet): Draft => ({
  type: s.type,
  byCol: Object.fromEntries(Object.entries(s.columns).map(([r, c]) => [c, r])),
});

const draftEquals = (d: Draft, s: Sheet) =>
  d.type === s.type &&
  JSON.stringify(d.byCol) ===
    JSON.stringify(Object.fromEntries(Object.entries(s.columns).map(([r, c]) => [c, r])));

const draftToColumns = (d: Draft): Record<string, number> =>
  Object.fromEntries(Object.entries(d.byCol).map(([c, r]) => [r, Number(c)]));

export function ColumnMappingView({ view }: { view: MappingView }) {
  const store = useStore();
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(view.sheets.map((s) => [s.sheetName, toDraft(s)]))
  );
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const blocked = busy || store.running || store.agentRunning || store.importRunning;
  const [confirmReingest, setConfirmReingest] = useState(false);

  const [baseline, setBaseline] = useState(view);
  const dirty = baseline.sheets.some(s => drafts[s.sheetName] && !draftEquals(drafts[s.sheetName], s));
  useEffect(() => {
    useStore.setState({ mappingDirty: dirty });
    return () => { useStore.setState({ mappingDirty: false }); };
  }, [dirty]);
  // 刷新不能覆盖人工草稿；干净状态才接收新映射。
  if (view !== baseline && !dirty) {
    setBaseline(view);
    setDrafts(Object.fromEntries(view.sheets.map(s => [s.sheetName, toDraft(s)])));
  }


  const setRole = (sheetName: string, col: number, role: string) =>
    setDrafts((prev) => {
      const d = { ...prev[sheetName], byCol: { ...prev[sheetName].byCol } };
      if (!role) delete d.byCol[col];
      else {
        // 一个角色只能占一列：从原列移走
        for (const [c, r] of Object.entries(d.byCol))
          if (r === role) delete d.byCol[Number(c)];
        d.byCol[col] = role;
      }
      return { ...prev, [sheetName]: d };
    });

  const setType = (sheetName: string, type: Sheet["type"]) =>
    setDrafts((prev) => {
      const d = { ...prev[sheetName], type };
      // 类型切换时单价角色随动（裸「单价」↔ 综合单价），用户当场看到变化
      const s = baseline.sheets.find((x) => x.sheetName === sheetName);
      const { columns } = reconcilePriceRole(
        type,
        draftToColumns(d),
        s?.headerCells ?? []
      );
      d.byCol = Object.fromEntries(
        Object.entries(columns).map(([r, c]) => [c, r])
      );
      return { ...prev, [sheetName]: d };
    });

  const save = async () => {
    if (lock.current || blocked || !dirty) return;
    lock.current = true; setBusy(true); useStore.setState({ saving: true });
    const projectId = store.projectId;
    try {
      let lastView: MappingView | null = null;
      for (const s of baseline.sheets) {
        const d = drafts[s.sheetName];
        if (!d || draftEquals(d, s)) continue;
        const columns: Record<string, number | null> = {};
        // 被删掉的角色传 null，其余传新列号
        for (const r of Object.keys(s.columns)) columns[r] = null;
        for (const [r, c] of Object.entries(draftToColumns(d))) columns[r] = c;
        const res = await fetch(`/api/files/${view.fileId}/mapping`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sheetName: s.sheetName, columns, type: d.type }),
        });
        lastView = (await readResponse<{ view: MappingView }>(res, "保存失败，请重试")).view;
      }
      if (useStore.getState().projectId !== projectId) return;
      if (lastView) {
        setBaseline(lastView);
        store.replaceView(lastView);
        setDrafts(
          Object.fromEntries(lastView.sheets.map((s) => [s.sheetName, toDraft(s)]))
        );
      }
      toast.success("列映射已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败，请重试");
    } finally {
      lock.current = false; setBusy(false); if (useStore.getState().projectId === projectId) useStore.setState({ saving: false });
    }
  };

  const reingest = async () => {
    if (lock.current || blocked || dirty) return;
    lock.current = true; setBusy(true); useStore.setState({ saving: true });
    const projectId = store.projectId;
    try {
      const res = await fetch(`/api/files/${view.fileId}/reingest`, { method: "POST" });
      const { runId } = await readResponse<{ runId?: string }>(res, "重新导入失败，请重试");
      if (useStore.getState().projectId !== projectId) return;
      setConfirmReingest(false);
      useStore.setState((s) => ({
        blocks: [...s.blocks, { type: "upload", filename: view.filename }],
      }));
      if (runId) {
        useStore.setState({ running: true });
        await store.streamRun(runId);
        await Promise.all([store.refreshMeta(), store.reloadBoq()]);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重新导入失败，请重试");
    } finally {
      lock.current = false; setBusy(false); if (useStore.getState().projectId === projectId) useStore.setState({ saving: false });
    }
  };

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2 break-words">
        <FileSpreadsheet size={15} className="text-neutral-400" />
        <span className="text-[13px] font-medium">{view.filename}</span>
        <span className="text-[11px] text-neutral-400">
          {store.blocks.some(b => b.type === "confirm" && !b.decided) ? "检查表格类型和各列名称；有错误就改一下，再保存。" : "修改后保存修改，再重新导入更新已有数据。"}
        </span>
      </div>

      <fieldset disabled={blocked} className="min-w-0" aria-busy={busy}>{baseline.sheets.map((s) => {
        const d = drafts[s.sheetName] ?? toDraft(s);
        return (
          <div key={s.sheetName} className="xl-sheet mb-4 overflow-hidden rounded-lg">
            <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-2">
              <span className="text-[12.5px] font-medium">{s.sheetName}</span>
              <select
                value={d.type}
                title={s.typeEvidence}
                aria-label={`${s.sheetName}的表格类型`}
                onChange={(e) => setType(s.sheetName, e.target.value as Sheet["type"])}
                className="h-6 rounded border border-neutral-200 bg-white px-1 text-[11px]"
                style={
                  s.typeConfidence < 0.9
                    ? {
                        borderColor: "var(--warning-soft-fg)",
                        background: "var(--warning-soft-bg)",
                      }
                    : undefined
                }
              >
                {(["BOQ", "QUOTATION", "GENERIC"] as const).map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
              {s.templateHit && (
                <span className="rounded bg-[var(--success-soft-bg)] px-1.5 py-0.5 text-[10.5px] text-[var(--success-soft-fg)]">
                  已识别
                </span>
              )}
              {s.userEdited && (
                <span className="rounded bg-[var(--warning-soft-bg)] px-1.5 py-0.5 text-[10.5px] text-[var(--warning-soft-fg)]">
                  已修改
                </span>
              )}
              <span className="ml-auto text-[11px] text-neutral-400">
                {s.minConfidence < 0.9 ? "需要核对" : "已识别"}
                {s.typeConfidence < 0.9 && " · 请核对表格类型"}
                {" · "}{s.rowCount} 行
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="xl-table mapping-table">
                <thead>
                  <tr>
                    <th className="xl-rn"></th>
                    {Array.from({ length: s.colCount }, (_, i) => (
                      <th key={i} className="text-center text-neutral-400">
                        {colLetter(i)}
                      </th>
                    ))}
                  </tr>
                  <tr>
                    <th className="xl-rn"></th>
                    {Array.from({ length: s.colCount }, (_, i) => (
                      <th key={i} className="p-0.5">
                        <select
                          aria-label={`${s.sheetName}的${colLetter(i)}列角色`}
                          value={d.byCol[i] ?? ""}
                          onChange={(e) => setRole(s.sheetName, i, e.target.value)}
                          className={cn(
                            "w-full min-w-16 rounded border border-neutral-200 bg-white px-0.5 py-0.5 text-[10.5px]",
                            d.byCol[i] && "border-neutral-400 font-medium"
                          )}
                        >
                          <option value="">— 忽略 —</option>
                          {COLUMN_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {COLUMN_ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                      </th>
                    ))}
                  </tr>
                  <tr>
                    <th className="xl-rn"></th>
                    {Array.from({ length: s.colCount }, (_, i) => {
                      const role = d.byCol[i];
                      const conf = role ? (s.confidence[role] ?? 1) : 1;
                      const ev = role ? s.evidence[role] : undefined;
                      return (
                        <th
                          key={i}
                          title={ev}
                          className="max-w-40 truncate text-[10.5px] font-normal"
                          style={
                            role && conf < 0.9
                              ? { background: "var(--warning-soft-bg)" }
                              : undefined
                          }
                        >
                          {s.headerCells[i] ?? ""}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {s.sample.slice(0, 6).map((r, ri) => (
                    <tr key={ri}>
                      <td className="xl-rn">{ri + 1}</td>
                      {Array.from({ length: s.colCount }, (_, i) => (
                        <td key={i} className="max-w-48 truncate text-neutral-600" title={r[i]}>
                          {r[i]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}</fieldset>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={save}
          disabled={!dirty || blocked}
          className="cost-btn primary"
        >
          <Save size={13} /> 保存修改
        </button>
        <button
          onClick={() => {
            if (view.fileStatus === "PARSED") setConfirmReingest(true);
            else void reingest();
          }}
          disabled={blocked || dirty || store.blocks.some(b => b.type === "confirm" && !b.decided)}
          title={dirty ? "请先保存修改" : undefined}
          className="flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 px-3.5 text-[12.5px] text-neutral-600 hover:bg-[var(--hover)] disabled:opacity-40"
        >
          <RefreshCw size={13} /> 重新导入
        </button>
        <button className="cost-btn" disabled={!dirty || blocked} onClick={() => setDrafts(Object.fromEntries(baseline.sheets.map(s => [s.sheetName, toDraft(s)])))}>取消修改</button>
      </div>

      <ConfirmDialog
        open={confirmReingest}
        title={`重新导入「${view.filename}」？`}
        description="将删除该文件已导入数据并按当前映射重新导入。"
        confirmText="重新导入"
        busy={blocked}
        onConfirm={reingest}
        onCancel={() => setConfirmReingest(false)}
      />
    </div>
  );
}
