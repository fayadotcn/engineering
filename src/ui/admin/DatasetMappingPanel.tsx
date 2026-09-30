"use client";
import { useEffect, useState } from "react";
import { COLUMN_ROLE_LABEL, COLUMN_ROLES } from "@shared/types";
import { reconcilePriceRole } from "@shared/mapping";
import { ConfirmDialog, toast } from "../primitives";
import { FileSpreadsheet, Loader2, RefreshCw, Save, X } from "lucide-react";

// 数据集列映射面板：展示后端自动识别结果（含置信度/证据），管理员可改列角色
// 与 sheet 类型，保存后确认导入价格库。交互照搬 ColumnMappingView。

type SheetType = "BOQ" | "QUOTATION" | "GENERIC";

interface MappingSheetDTO {
  sheetName: string;
  type: SheetType;
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

const cn = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(" ");

const TYPE_LABEL: Record<SheetType, string> = {
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
  type: SheetType;
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
}: {
  datasetId: string;
  filename: string;
  kind: string;
  onClose: () => void;
  onIngested: () => void;
}) {
  const [mapping, setMapping] = useState<DatasetMappingDTO | null>(null);
  const [failed, setFailed] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [confirmIngest, setConfirmIngest] = useState(false);

  useEffect(() => {
    let dead = false;
    setMapping(null);
    setFailed(false);
    void (async () => {
      try {
        const res = await fetch(`/api/admin/datasets/${datasetId}/mapping`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const m = (await res.json()) as DatasetMappingDTO;
        if (!dead) setMapping(m);
      } catch {
        if (!dead) setFailed(true);
      }
    })();
    return () => {
      dead = true;
    };
  }, [datasetId]);

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

  const setType = (sheetName: string, type: SheetType) => {
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
    if (!mapping) return;
    setBusy(true);
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
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        last = (await res.json()) as DatasetMappingDTO;
      }
      if (last) setMapping(last);
      toast.success("列映射已保存");
    } catch {
      toast.error("保存失败，请重试");
    }
    setBusy(false);
  };

  const ingest = async () => {
    setConfirmIngest(false);
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/datasets/${datasetId}/ingest`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { rowCount } = (await res.json()) as { rowCount: number; status: string };
      toast.success(`已导入 ${rowCount} 行`);
      onIngested();
      onClose();
    } catch {
      toast.error("导入失败，请重试");
    }
    setBusy(false);
  };

  if (failed)
    return (
      <div className="border-t border-neutral-100 px-4 py-6 text-center text-[12px] text-neutral-400">
        映射信息加载失败
        <button
          onClick={() => {
            setFailed(false);
            void fetch(`/api/admin/datasets/${datasetId}/mapping`)
              .then((r) => (r.ok ? r.json() : Promise.reject()))
              .then((m) => setMapping(m as DatasetMappingDTO))
              .catch(() => setFailed(true));
          }}
          className="ml-2 rounded-md border border-neutral-200 px-2 py-0.5 text-[11.5px] text-neutral-500 hover:bg-[var(--hover)]"
        >
          重试
        </button>
      </div>
    );

  if (!mapping)
    return (
      <div className="flex h-28 items-center justify-center border-t border-neutral-100 text-neutral-400">
        <Loader2 size={15} className="animate-spin" />
      </div>
    );

  return (
    <div className="border-t border-neutral-100 px-4 py-3">
      <div className="mb-3 flex items-center gap-2">
        <FileSpreadsheet size={15} className="text-neutral-400" />
        <span className="text-[13px] font-medium">{mapping.filename || filename}</span>
        <span className="text-[11px] text-neutral-400">
          调整列角色后保存，确认后按映射导入
        </span>
        <button
          onClick={onClose}
          title="收起"
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 hover:bg-[var(--hover)] hover:text-neutral-600"
        >
          <X size={13} />
        </button>
      </div>

      {!mapping.sheets.length && (
        <div className="rounded-lg border border-dashed border-neutral-300 px-4 py-6 text-center text-[12px] text-neutral-400">
          未识别到工作表
        </div>
      )}

      {mapping.sheets.map((s) => {
        const d = drafts[s.sheetName] ?? toDraft(s);
        return (
          <div key={s.sheetName} className="xl-sheet mb-3 overflow-hidden rounded-lg">
            <div className="flex items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-2">
              <span className="text-[12.5px] font-medium">{s.sheetName}</span>
              <div className="flex flex-col gap-0.5">
                <select
                  value={d.type}
                  title={s.typeEvidence}
                  onChange={(e) => setType(s.sheetName, e.target.value as SheetType)}
                  className="h-6 w-fit rounded border border-neutral-200 bg-white px-1 text-[11px]"
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
                {kind === "MATERIAL_PRICE" && (
                  <span className="text-[10px] leading-tight text-neutral-400">
                    只有「询价表」类型的 sheet 会导入价格库
                  </span>
                )}
              </div>
              {s.templateHit && (
                <span className="rounded bg-[var(--success-soft-bg)] px-1.5 py-0.5 text-[10.5px] text-[var(--success-soft-fg)]">
                  模板命中
                </span>
              )}
              {s.userEdited && (
                <span className="rounded bg-[var(--warning-soft-bg)] px-1.5 py-0.5 text-[10.5px] text-[var(--warning-soft-fg)]">
                  用户已调整
                </span>
              )}
              <span className="ml-auto text-[11px] text-neutral-400">
                置信 {Math.round(s.minConfidence * 100)}%
                {s.typeConfidence < 0.9 && ` · 类型 ${Math.round(s.typeConfidence * 100)}%`}
                {" · "}
                {s.rowCount} 行
              </span>
            </div>
            {kind === "MATERIAL_PRICE" && mapping.status === "PARSED" && d.type === "BOQ" && (
              <div className="border-b border-neutral-100 px-3 py-1.5 text-[11px] text-neutral-400">
                该表按清单识别，未导入价格库
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="xl-table">
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
      })}

      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={!dirty || busy}
          className="flex h-8 items-center gap-1.5 rounded-md bg-neutral-900 px-3.5 text-[12.5px] text-white hover:bg-neutral-700 disabled:opacity-40"
        >
          <Save size={13} /> 保存映射
        </button>
        <button
          onClick={() => {
            if (mapping.status === "PARSED") setConfirmIngest(true);
            else void ingest();
          }}
          disabled={busy || dirty}
          title={dirty ? "请先保存映射" : undefined}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-md px-3.5 text-[12.5px] disabled:opacity-40",
            mapping.status === "PENDING"
              ? "font-medium text-white"
              : "border border-neutral-200 text-neutral-600 hover:bg-[var(--hover)]"
          )}
          style={
            mapping.status === "PENDING"
              ? { background: "var(--brand-accent)" }
              : undefined
          }
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          {mapping.status === "PENDING" ? "确认导入" : "重新导入"}
        </button>
      </div>

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
