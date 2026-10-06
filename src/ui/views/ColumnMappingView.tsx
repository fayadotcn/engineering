"use client";
import { useEffect, useRef, useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { useStore } from "../store";
import { COLUMN_ROLE_LABEL, COLUMN_ROLES, type WorkspaceView } from "@shared/types";
import { reconcilePriceRole } from "@shared/mapping";
import { ConfirmDialog, toast } from "../primitives";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { readResponse } from "../api";
import { FILE_TYPE_LABEL, FILE_TYPE_OPTIONS } from "../terms";
import { FileSpreadsheet, Save, RefreshCw } from "lucide-react";
import { Tip, TipEl } from "./shared";

type MappingView = Extract<WorkspaceView, { kind: "columnMapping" }>;
type Sheet = MappingView["sheets"][number];

const cn = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(" ");
/** 会往清单/价格库里导行的类型：这些表的 itemsToImport=0 必须红标，
 *  COMPARE/APPROVAL/FACTS/GENERIC 本来就不导行，标了反而吓人 */
const IMPORTABLE_TYPES = new Set<Sheet["type"]>(["BOQ", "PENDING_QUOTE", "QUOTATION", "MATERIAL_PRICE"]);

const colLetter = (i: number): string => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** Radix Select 的空值即 placeholder 语义（不能当选项值），「忽略该列」用哨兵值再映射回空串。 */
const ROLE_NONE = "__none__";

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
    <div className="view-content">
      <div className="mb-3 flex flex-wrap items-center gap-2 break-words">
        <FileSpreadsheet size={15} className="text-muted-foreground" />
        <span className="text-sm font-medium">{view.filename}</span>
        <span className="text-2xs text-muted-foreground">
          {store.blocks.some(b => b.type === "confirm" && !b.decided) ? "检查表格类型和各列名称；有错误就改一下，再保存。" : "修改后保存修改，再重新导入更新已有数据。"}
        </span>
      </div>

      <fieldset disabled={blocked} className="min-w-0" aria-busy={busy}>{baseline.sheets.map((s) => {
        const d = drafts[s.sheetName] ?? toDraft(s);
        return (
          <div key={s.sheetName} className="xl-sheet mb-4 overflow-hidden rounded-lg">
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-[var(--muted)] px-3 py-2">
              <span className="text-xs font-medium">{s.sheetName}</span>
              {/* 表格类型是页面级控件（非单元格内联编辑）→ shadcn <Select>，高度 32px 与 <Input> 一致；
                  自动判定没把握时保持琥珀底，理由走 Tooltip */}
              <Tip tip={s.typeEvidence} className="shrink-0">
                <Select
                  value={d.type}
                  onValueChange={(v) => setType(s.sheetName, v as Sheet["type"])}
                >
                  <SelectTrigger
                    size="sm"
                    aria-label={`${s.sheetName}的表格类型`}
                    className="w-fit text-2xs"
                    style={
                      s.typeConfidence < 0.9
                        ? {
                            borderColor: "var(--warning-soft-fg)",
                            background: "var(--warning-soft)",
                          }
                        : undefined
                    }
                  >
                    <SelectValue>{FILE_TYPE_LABEL[d.type]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {FILE_TYPE_OPTIONS.map((t) => (
                      <SelectItem key={t} value={t}>
                        {FILE_TYPE_LABEL[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Tip>
              {s.templateHit && <Badge variant="success" >已识别</Badge>}
              {s.userEdited && <Badge variant="warning" >已修改</Badge>}
              {IMPORTABLE_TYPES.has(s.type) && s.itemsToImport === 0 && (
                <TipEl tip="表里有数据，但按当前映射认不出任何清单行（名称列为空最常见）——请指认名称列，必要时指认工程量/单价列，再保存并确认导入">
                  <Badge variant="danger">
                    将导入 0 行
                  </Badge>
                </TipEl>
              )}
              <span className="ml-auto text-2xs text-muted-foreground">
                {s.minConfidence < 0.9 ? "需要核对" : "已识别"}
                {s.typeConfidence < 0.9 && " · 请核对表格类型"}
                {" · "}
                {IMPORTABLE_TYPES.has(s.type) && s.itemsToImport !== undefined
                  ? `将导入 ${s.itemsToImport} 行（表内 ${s.rowCount} 行）`
                  : `${s.rowCount} 行`}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="xl-table mapping-table">
                <thead>
                  <tr>
                    <th className="xl-rn"></th>
                    {Array.from({ length: s.colCount }, (_, i) => (
                      <th key={i} className="text-center text-muted-foreground">
                        {colLetter(i)}
                      </th>
                    ))}
                  </tr>
                  <tr>
                    <th className="xl-rn"></th>
                    {Array.from({ length: s.colCount }, (_, i) => (
                      <th key={i} className="p-0.5">
                        {/* 每列一个角色下拉：网格内联编辑走 xs 档（28px，尺寸由 size prop 表达）——
                            全站统一的 32px 会把表头撑胖，手搓的原生 select 又和组件不同族。
                            面板整体在 <fieldset disabled> 里，Radix 的 button 不继承 fieldset 禁用，
                            所以 disabled 必须显式传 blocked。 */}
                        <Select
                          value={d.byCol[i] ?? ROLE_NONE}
                          onValueChange={(v) => setRole(s.sheetName, i, v === ROLE_NONE ? "" : v)}
                          disabled={blocked}
                        >
                          <SelectTrigger
                            size="xs"
                            aria-label={`${s.sheetName}的${colLetter(i)}列角色`}
                            className={cn("w-full min-w-16", d.byCol[i] && "font-medium")}
                          >
                            <SelectValue>
                              {d.byCol[i]
                                ? (COLUMN_ROLE_LABEL as Record<string, string>)[d.byCol[i]] ?? d.byCol[i]
                                : "— 忽略 —"}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={ROLE_NONE}>— 忽略 —</SelectItem>
                            {COLUMN_ROLES.map((r) => (
                              <SelectItem key={r} value={r}>
                                {COLUMN_ROLE_LABEL[r]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
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
                          className="max-w-40 truncate text-2xs font-normal"
                          style={
                            role && conf < 0.9
                              ? { background: "var(--warning-soft)" }
                              : undefined
                          }
                        >
                          <Tip tip={ev}>{s.headerCells[i] ?? ""}</Tip>
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
                        <td key={i} className="max-w-48 truncate text-muted-foreground"><Tip tip={r[i]}>{r[i]}</Tip></td>
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
        <Button
          onClick={save}
          disabled={!dirty || blocked}
        >
          <Save size={13} /> 保存修改
        </Button>
        <TipEl tip={dirty ? "请先保存修改" : undefined} focusable>
          <Button
            variant="outline"
            onClick={() => {
              if (view.fileStatus === "PARSED") setConfirmReingest(true);
              else void reingest();
            }}
            disabled={blocked || dirty || store.blocks.some(b => b.type === "confirm" && !b.decided)}
          >
            <RefreshCw size={13} /> 重新导入
          </Button>
        </TipEl>
        <Button variant="outline" disabled={!dirty || blocked} onClick={() => setDrafts(Object.fromEntries(baseline.sheets.map(s => [s.sheetName, toDraft(s)])))}>取消修改</Button>
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
