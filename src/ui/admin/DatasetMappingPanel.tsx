"use client";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { COLUMN_ROLE_LABEL, COLUMN_ROLES } from "@shared/types";
import { reconcilePriceRole } from "@shared/mapping";
import { ConfirmDialog, EmptyState, toast } from "../primitives";
import { cn } from "../views/shared";
import { FILE_TYPE_LABEL, FILE_TYPE_OPTIONS, type FileType } from "../terms";
import { readResponse } from "../api";
import { AlertTriangle, FileSpreadsheet, Loader2, RefreshCw, Save, X } from "lucide-react";

// 数据集列映射面板：展示后端自动识别结果（含置信度/证据），管理员可改列角色
// 与 sheet 类型，保存后确认导入价格库。交互照搬 ColumnMappingView。

interface MappingSheetDTO {
  sheetName: string;
  type: FileType;
  headerRow: number;
  merged: boolean;
  headerCells: string[];
  sample: string[][];
  colCount: number;
  rowCount: number;
  columns: Record<string, number>;
  confidence: Record<string, number>;
  evidence: Record<string, string>;
  minConfidence: number;
  typeConfidence: number;
  typeEvidence: string;
  templateHit: boolean;
  userEdited: boolean;
  needsConfirm: boolean;
}

interface DatasetMappingDTO {
  id: string;
  filename: string;
  name: string;
  kind: string;
  status: string;
  defaults: { brand?: string; region?: string; period?: string; priceType?: string };
  sheets: MappingSheetDTO[];
}

/** Radix Select 的空值即 placeholder 语义（不能当选项值），「忽略该列」用哨兵值再映射回空串。 */
const ROLE_NONE = "__none__";

const colLetter = (i: number): string => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

interface Draft {
  type: FileType;
  /** col index → role */
  byCol: Record<number, string>;
}

const toDraft = (s: MappingSheetDTO): Draft => ({
  type: s.type,
  byCol: Object.fromEntries(Object.entries(s.columns).map(([r, c]) => [c, r])),
});

const draftEquals = (d: Draft, s: MappingSheetDTO) =>
  d.type === s.type &&
  JSON.stringify(d.byCol) ===
    JSON.stringify(Object.fromEntries(Object.entries(s.columns).map(([r, c]) => [c, r])));

const draftToColumns = (d: Draft): Record<string, number> =>
  Object.fromEntries(Object.entries(d.byCol).map(([c, r]) => [r, Number(c)]));

export function DatasetMappingPanel({
  datasetId,
  filename,
  kind,
  onClose,
  onIngested,
  onDirtyChange,
}: {
  datasetId: string;
  filename: string;
  kind: string;
  onClose: () => void;
  onIngested: () => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [mapping, setMapping] = useState<DatasetMappingDTO | null>(null);
  const [failed, setFailed] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [confirmIngest, setConfirmIngest] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [reload, setReload] = useState(0);
  const lock = useRef(false);

  useEffect(() => {
    let dead = false;
    setMapping(null);
    setFailed(false);
    void (async () => {
      try {
        const res = await fetch(`/api/admin/datasets/${datasetId}/mapping`);
        const m = await readResponse<DatasetMappingDTO>(res, "映射信息加载失败");
        if (!dead) setMapping(m);
      } catch {
        if (!dead) setFailed(true);
      }
    })();
    return () => {
      dead = true;
    };
  }, [datasetId, reload]);

  // 保存后返回完整映射对象：草稿随最新识别结果重置
  useEffect(() => {
    if (mapping)
      setDrafts(
        Object.fromEntries(mapping.sheets.map((s) => [s.sheetName, toDraft(s)]))
      );
  }, [mapping]);

  const dirty =
    !!mapping &&
    mapping.sheets.some((s) => {
      const d = drafts[s.sheetName];
      return d && !draftEquals(d, s);
    });
  useEffect(() => {
    onDirtyChange?.(dirty || busy);
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    if (dirty || busy) window.addEventListener("beforeunload", warn);
    return () => { window.removeEventListener("beforeunload", warn); onDirtyChange?.(false); };
  }, [dirty, busy, onDirtyChange]);

  const setRole = (sheetName: string, col: number, role: string) => {
    const s = mapping?.sheets.find((x) => x.sheetName === sheetName);
    if (!s) return;
    setDrafts((prev) => {
      const cur = prev[sheetName] ?? toDraft(s);
      const d = { ...cur, byCol: { ...cur.byCol } };
      if (!role) delete d.byCol[col];
      else {
        // 一个角色只能占一列：从原列移走
        for (const [c, r] of Object.entries(d.byCol))
          if (r === role) delete d.byCol[Number(c)];
        d.byCol[col] = role;
      }
      return { ...prev, [sheetName]: d };
    });
  };

  const setType = (sheetName: string, type: FileType) => {
    const s = mapping?.sheets.find((x) => x.sheetName === sheetName);
    if (!s) return;
    setDrafts((prev) => {
      const cur = prev[sheetName] ?? toDraft(s);
      const d = { ...cur, type };
      // 类型切换时单价角色随动（裸「单价」↔ 综合单价），用户当场看到变化
      const { columns } = reconcilePriceRole(
        type,
        draftToColumns(d),
        s.headerCells
      );
      d.byCol = Object.fromEntries(
        Object.entries(columns).map(([r, c]) => [c, r])
      );
      return { ...prev, [sheetName]: d };
    });
  };

  const save = async () => {
    if (!mapping || lock.current || !dirty) return;
    lock.current = true; setBusy(true);
    try {
      let last: DatasetMappingDTO | null = null;
      for (const s of mapping.sheets) {
        const d = drafts[s.sheetName];
        if (!d || draftEquals(d, s)) continue;
        const columns: Record<string, number | null> = {};
        // 被删掉的角色传 null，其余传新列号
        for (const r of Object.keys(s.columns)) columns[r] = null;
        for (const [r, c] of Object.entries(draftToColumns(d))) columns[r] = c;
        const res = await fetch(`/api/admin/datasets/${datasetId}/mapping`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sheetName: s.sheetName, columns, type: d.type }),
        });
        last = await readResponse<DatasetMappingDTO>(res, "保存失败，请重试");
      }
      if (last) setMapping(last);
      toast.success("列映射已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败，请重试");
    } finally {
      lock.current = false; setBusy(false);
    }
  };

  const ingest = async () => {
    if (lock.current || dirty || !mapping?.sheets.length) return;
    lock.current = true; setBusy(true);
    try {
      const res = await fetch(`/api/admin/datasets/${datasetId}/ingest`, {
        method: "POST",
      });
      const { rowCount } = await readResponse<{ rowCount: number }>(res, "导入失败，请重试");
      setConfirmIngest(false);
      toast.success(`已导入 ${rowCount} 行`);
      await onIngested();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导入失败，请重试");
    } finally {
      lock.current = false; setBusy(false);
    }
  };

  if (failed)
    return (
      <Alert variant="destructive" className="m-4">
        <AlertTriangle />
        <AlertTitle className="line-clamp-none">映射信息加载失败</AlertTitle>
        <AlertDescription>
          <Button variant="outline" size="sm" onClick={() => setReload(n => n + 1)}>重试</Button>
        </AlertDescription>
      </Alert>
    );

  if (!mapping)
    return (
      <div className="flex h-28 items-center justify-center gap-2 border-t border-border text-xs text-muted-foreground" role="status">
        <Loader2 size={15} className="spin" />正在读取列映射
      </div>
    );

  return (
    <div className="border-t border-border px-4 py-3">
      <div className="mb-3 flex flex-wrap items-center gap-2 break-words">
        <FileSpreadsheet size={15} className="text-muted-foreground" />
        <span className="text-sm font-medium">{mapping.filename || filename}</span>
        <span className="text-2xs text-muted-foreground">
          检查每列是否识别正确；有错误就改一下，再保存。
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => { if (dirty) setConfirmClose(true); else onClose(); }}
          disabled={busy}
          aria-label="收起列映射"
          title="收起"
          className="ml-auto"
        >
          <X size={13} />
        </Button>
      </div>

      {!mapping.sheets.length && (
        <EmptyState icon={<FileSpreadsheet size={22} />} title="未识别到工作表" />
      )}

      <fieldset disabled={busy} className="min-w-0" aria-busy={busy}>{mapping.sheets.map((s) => {
        const d = drafts[s.sheetName] ?? toDraft(s);
        return (
          <div key={s.sheetName} className="xl-sheet mb-3 overflow-hidden rounded-lg">
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-[var(--muted)] px-3 py-2">
              <span className="text-xs font-medium">{s.sheetName}</span>
              <div className="flex flex-col gap-0.5">
                {/* 控件高度走 size="sm"（32px，组件 prop 表达）；类型拿不准时用琥珀软色提示。
                    面板整体在 <fieldset disabled> 里，Radix 的 button 不继承 fieldset 禁用，
                    所以 disabled 必须显式传。 */}
                <Select
                  value={d.type}
                  onValueChange={(v) => setType(s.sheetName, v as FileType)}
                  disabled={busy}
                >
                  <SelectTrigger
                    size="sm"
                    title={s.typeEvidence}
                    aria-label={`${s.sheetName}的表格类型`}
                    className={cn(
                      "w-fit",
                      s.typeConfidence < 0.9 && "border-warning-soft-fg bg-warning-soft text-warning-soft-fg"
                    )}
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
                {kind === "MATERIAL_PRICE" && (
                  <span className="text-2xs leading-tight text-muted-foreground">
                    只有「询价表/材料价格表」类型的工作表会导入价格库
                  </span>
                )}
              </div>
              {/* 状态一律走 <Badge>：模板/人工改动是来源，识别结果单列一档。
                  模板命中原先也叫「已识别」，与识别结果同词不同义，这里改成「模板命中」。 */}
              {s.templateHit && <Badge variant="success">模板命中</Badge>}
              {s.userEdited && <Badge variant="warning">已修改</Badge>}
              <Badge variant={s.minConfidence < 0.9 || s.typeConfidence < 0.9 ? "warning" : "secondary"}>
                {s.minConfidence < 0.9 ? "需要核对" : s.typeConfidence < 0.9 ? "类型待核对" : "已识别"}
              </Badge>
              <span className="ml-auto text-2xs text-muted-foreground">
                {s.rowCount} 行
              </span>
            </div>
            {kind === "MATERIAL_PRICE" && mapping.status === "PARSED" && d.type === "BOQ" && (
              <div className="border-b border-border px-3 py-1.5 text-2xs text-muted-foreground">
                该表按清单识别，未导入价格库
              </div>
            )}
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
                            全站统一的 32px 会把表头撑胖。fieldset 禁用不覆盖 button，故显式 disabled。 */}
                        <Select
                          value={d.byCol[i] ?? ROLE_NONE}
                          onValueChange={(v) => setRole(s.sheetName, i, v === ROLE_NONE ? "" : v)}
                          disabled={busy}
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
                          title={ev}
                          className="max-w-40 truncate text-2xs font-normal"
                          style={
                            role && conf < 0.9
                              ? { background: "var(--warning-soft)" }
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
                        <td key={i} className="max-w-48 truncate text-muted-foreground" title={r[i]}>
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
        <Button
          onClick={save}
          disabled={!dirty || busy}
        >
          <Save size={13} /> 保存修改
        </Button>
        <Button
          variant={mapping.status === "PENDING" ? "default" : "outline"}
          onClick={() => {
            if (mapping.status === "PARSED") setConfirmIngest(true);
            else void ingest();
          }}
          disabled={busy || dirty || !mapping.sheets.length}
          title={dirty ? "请先保存修改" : undefined}
        >
          {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
          {mapping.status === "PENDING" ? "确认导入" : "重新导入"}
        </Button>
        <Button variant="outline" disabled={busy || !dirty} onClick={() => setDrafts(Object.fromEntries(mapping.sheets.map(s => [s.sheetName, toDraft(s)])))}>取消修改</Button>
      </div>
      <ConfirmDialog open={confirmClose} title="放弃未保存的映射？" confirmText="放弃并收起" onCancel={() => setConfirmClose(false)} onConfirm={onClose} />

      <ConfirmDialog
        open={confirmIngest}
        title={`重新导入「${mapping.filename || filename}」？`}
        description="将删除已导入的价格行并按当前映射重新导入。"
        confirmText="重新导入"
        busy={busy}
        onConfirm={ingest}
        onCancel={() => setConfirmIngest(false)}
      />
    </div>
  );
}
