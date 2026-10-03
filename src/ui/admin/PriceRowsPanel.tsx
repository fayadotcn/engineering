"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Loader2, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { ConfirmDialog, toast } from "../primitives";
import { readResponse } from "../api";

// 数据集价格行面板：筛选 / 分页浏览 / 行内编辑 / 删除。
// facets 为全数据集去重值，不随筛选变化（后端契约）。

const PAGE_SIZE = 50;

type EditField = "name" | "spec" | "unit" | "brand" | "price" | "priceType" | "region" | "period";

interface PriceRowDTO {
  id: string;
  name: string;
  spec: string;
  unit: string;
  brand: string;
  price: string | number;
  priceType: string;
  region: string;
  period: string;
  updatedAt: string;
}

interface PriceListDTO {
  total: number;
  page: number;
  pageSize: number;
  rows: PriceRowDTO[];
  facets: { brands: string[]; regions: string[]; periods: string[]; priceTypes: string[] };
}

const PRICE_TYPE_LABEL: Record<string, string> = {
  INFO: "信息价",
  MARKET: "市场价",
  SUPPLY: "供应商价",
  LABOR: "人工价",
};

const cn = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(" ");

const EDITABLE: { field: EditField; label: string }[] = [
  { field: "name", label: "名称" },
  { field: "spec", label: "规格" },
  { field: "unit", label: "单位" },
  { field: "brand", label: "品牌" },
  { field: "price", label: "单价" },
  { field: "priceType", label: "类型" },
  { field: "region", label: "地区" },
  { field: "period", label: "期次" },
];

export function PriceRowsPanel({ datasetId, onDirtyChange }: { datasetId: string; onDirtyChange?: (dirty: boolean) => void }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState(""); // 防抖后的搜索词
  const [brand, setBrand] = useState("");
  const [region, setRegion] = useState("");
  const [period, setPeriod] = useState("");
  const [priceType, setPriceType] = useState("");
  const [page, setPage] = useState(1);
  const [details, setDetails] = useState(false);
  const [data, setData] = useState<PriceListDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ id: string; field: EditField } | null>(null);
  const [draft, setDraft] = useState("");
  const [delRow, setDelRow] = useState<PriceRowDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const editRef = useRef<typeof editing>(null);
  const [adding, setAdding] = useState(false);
  const [newRow, setNewRow] = useState<Record<EditField, string>>({
    name: "", spec: "", unit: "", brand: "", price: "", priceType: "", region: "", period: "",
  });
  const dirty = !!editing || adding || busy;
  useEffect(() => {
    onDirtyChange?.(dirty);
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    if (dirty) window.addEventListener("beforeunload", warn);
    return () => { window.removeEventListener("beforeunload", warn); onDirtyChange?.(false); };
  }, [dirty, onDirtyChange]);

  // 搜索防抖 300ms
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(q.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    const p = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (query) p.set("q", query);
    if (brand) p.set("brand", brand);
    if (region) p.set("region", region);
    if (period) p.set("period", period);
    if (priceType) p.set("priceType", priceType);
    try {
      const res = await fetch(`/api/admin/datasets/${datasetId}/prices?${p}`, { signal: controller.signal });
      const result = await readResponse<PriceListDTO>(res, "价格数据加载失败");
      if (controller.signal.aborted) return;
      const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
      if (page > lastPage) { setPage(lastPage); return; }
      setData(result);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "价格数据加载失败");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [datasetId, query, brand, region, period, priceType, page]);

  useEffect(() => {
    void load();
    return () => { request.current?.abort(); };
  }, [load]);

  const filtering = Boolean(q.trim() || brand || region || period || priceType);

  const reset = () => {
    setQ("");
    setQuery("");
    setBrand("");
    setRegion("");
    setPeriod("");
    setPriceType("");
    setPage(1);
  };

  const startEdit = (row: PriceRowDTO, field: EditField) => {
    if (busy || loading || adding || error || editRef.current || q.trim() !== query) return;
    editRef.current = { id: row.id, field };
    setEditing({ id: row.id, field });
    setDraft(String(row[field] ?? ""));
  };

  const cancelEdit = () => { if (saving.current) return; editRef.current = null; setEditing(null); };
  const cancelAdd = () => {
    if (saving.current) return;
    setAdding(false);
    setNewRow({ name: "", spec: "", unit: "", brand: "", price: "", priceType: "", region: "", period: "" });
  };

  // 同一次 Enter 和 blur 只提交一次；失败保留草稿供修改或重试。
  const commitEdit = async (row: PriceRowDTO, field: EditField, value: string) => {
    if (saving.current || editRef.current?.id !== row.id || editRef.current.field !== field) return;
    const v = value.trim();
    const old = String(row[field] ?? "");
    if (v === old) { cancelEdit(); return; }
    if (field === "name" && !v) { toast.error("名称必填，草稿已保留"); return; }
    if (field === "price" && (v === "" || !Number.isFinite(Number(v)) || Number(v) < 0)) {
      toast.error("单价必须是 ≥0 的数字，草稿已保留");
      return;
    }
    saving.current = true;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/datasets/${datasetId}/prices/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [field]: v }),
      });
      const updated = await readResponse<PriceRowDTO>(res, "保存失败，请重试");
      setData((d) =>
        d ? { ...d, rows: d.rows.map((r) => (r.id === row.id ? { ...r, ...updated } : r)) } : d
      );
      editRef.current = null;
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(`${err instanceof Error ? err.message : "保存失败"}，草稿已保留`);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  const addRow = async () => {
    if (saving.current || loading) return;
    if (!newRow.name.trim()) { toast.error("名称必填"); return; }
    const price = Number(newRow.price);
    if (newRow.price.trim() === "" || !Number.isFinite(price) || price < 0) {
      toast.error("单价必须是 ≥0 的数字");
      return;
    }
    saving.current = true; setBusy(true);
    try {
      const res = await fetch(`/api/admin/datasets/${datasetId}/prices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...newRow, price }),
      });
      await readResponse(res, "新增失败，请重试");
      toast.success("已新增价格行");
      setAdding(false);
      setNewRow({ name: "", spec: "", unit: "", brand: "", price: "", priceType: "", region: "", period: "" });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "新增失败，请重试");
    } finally {
      saving.current = false; setBusy(false);
    }
  };

  const remove = async () => {
    if (saving.current || loading || editing || adding) return;
    const row = delRow;
    if (!row) return;
    saving.current = true; setBusy(true);
    try {
      const res = await fetch(`/api/admin/datasets/${datasetId}/prices/${row.id}`, {
        method: "DELETE",
      });
      await readResponse(res, "删除失败，请重试");
      setDelRow(null);
      toast.success("已删除该价格行");
      // 删到页尾：退回上一页
      if (data && data.rows.length === 1 && page > 1) setPage((p) => p - 1);
      else await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败，请重试");
    } finally {
      saving.current = false; setBusy(false);
    }
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const visibleColumns = EDITABLE.filter(c => details || ["name", "spec", "unit", "price"].includes(c.field));

  const facetSelect = (
    label: string,
    value: string,
    set: (v: string) => void,
    options: string[],
    labelMap?: Record<string, string>
  ) => (
    <select
      key={label}
      value={value}
      onChange={(e) => {
        set(e.target.value);
        setPage(1);
      }}
      className="cost-input max-w-36"
      title={label}
      aria-label={`筛选${label}`}
      disabled={dirty || busy}
    >
      <option value="">{label}：全部</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {labelMap?.[o] ?? o}
        </option>
      ))}
    </select>
  );

  const cell = (row: PriceRowDTO, field: EditField, cls?: string) => {
    const active = editing?.id === row.id && editing.field === field;
    return (
      <td
        key={field}
        className={cn("xl-edit max-w-48 truncate", cls, active && "xl-active")}
        tabIndex={!active && !busy && !loading && !dirty && !error ? 0 : undefined}
        aria-label={`${row.name}的${EDITABLE.find(c => c.field === field)?.label}，按 Enter 编辑`}
        onKeyDown={e => { if (e.target === e.currentTarget && e.key === "Enter") { e.preventDefault(); startEdit(row, field); } }}
        title={
          active
            ? undefined
            : `${field === "priceType" ? (PRICE_TYPE_LABEL[row.priceType] ?? row.priceType ?? "") : String(row[field] ?? "")} — 点击编辑`
        }
        onClick={() => {
          if (!active) startEdit(row, field);
        }}
      >
        {active ? (
          field === "priceType" ? (
            <select
              autoFocus
              disabled={busy}
              aria-label={`编辑${row.name}的价格类型`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); cancelEdit(); } if (e.key === "Enter") { e.preventDefault(); void commitEdit(row, field, draft); } }}
              className="w-full border-0 bg-transparent px-0 py-0 text-[12.5px] outline-none"
            >
              {!(draft in PRICE_TYPE_LABEL) && (
                <option value={draft}>{draft || "（空）"}</option>
              )}
              {Object.entries(PRICE_TYPE_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          ) : (
            <input
              autoFocus
              disabled={busy}
              aria-label={`编辑${row.name}的${EDITABLE.find(c => c.field === field)?.label}`}
              inputMode={field === "price" ? "decimal" : "text"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") { e.preventDefault(); void commitEdit(row, field, draft); }
                if (e.key === "Escape") cancelEdit();
              }}
              className="w-full border-0 bg-transparent px-0 py-0 text-[12.5px] outline-none"
            />
          )
        ) : field === "priceType" ? (
          PRICE_TYPE_LABEL[row.priceType] ?? row.priceType ?? "—"
        ) : field === "spec" && row.spec === row.name ? (
          // 报价单常无独立规格列（名称即型号），规格与名称相同不再重复展示
          <span className="text-neutral-300">同名称</span>
        ) : (
          String(row[field] ?? "") || "—"
        )}
      </td>
    );
  };

  return (
    <div className="border-t border-neutral-100" aria-busy={loading || busy}>
      {/* 筛选条 */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 pt-3">
        <div className="relative">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-neutral-400"
          />
          <input
            aria-label="搜索价格行"
            disabled={dirty || busy}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索名称 / 规格 / 品牌…"
            className="cost-input w-52 pl-7"
          />
        </div>
        <details className="cost-simple-more"><summary>更多筛选和信息</summary><div className="cost-more-body">
          {facetSelect("品牌", brand, setBrand, data?.facets.brands ?? [])}
          {facetSelect("地区", region, setRegion, data?.facets.regions ?? [])}
          {facetSelect("期次", period, setPeriod, data?.facets.periods ?? [])}
          {facetSelect("类型", priceType, setPriceType, data?.facets.priceTypes ?? [], PRICE_TYPE_LABEL)}
          <label><input type="checkbox" checked={details} disabled={dirty || busy} onChange={e => setDetails(e.target.checked)} />显示品牌、地区、日期和价格类型</label>
        </div></details>
        {filtering && (
          <button onClick={reset} disabled={dirty || busy} className="cost-btn sm ghost">
            <RotateCcw size={11} /> 重置
          </button>
        )}
        <button
          onClick={() => { if (adding) cancelAdd(); else setAdding(true); }}
          disabled={busy || loading || !!editing || !!error || q.trim() !== query}
          aria-pressed={adding}
          className="cost-btn sm ml-auto"
        >
          {adding ? <X size={11} /> : <Plus size={11} />} {adding ? "取消新增" : "新增行"}
        </button>
      </div>
      {editing && <div className="flex flex-wrap items-center gap-2 px-3 pt-2 text-xs text-neutral-500"><span>改好后点击保存。</span><button className="cost-btn primary" disabled={busy} onPointerDown={e => e.preventDefault()} onClick={() => { const row = data?.rows.find(r => r.id === editing.id); if (row) void commitEdit(row, editing.field, draft); }}>保存修改</button><button className="cost-btn" disabled={busy} onPointerDown={e => e.preventDefault()} onClick={cancelEdit}>取消</button></div>}
      {error && <div className="cost-error" role="alert">{error}<button className="cost-btn" onClick={() => void load()} disabled={busy || loading}>重试</button></div>}

      {/* 数据表 */}
      <div className="mt-2 max-h-96 overflow-auto border-t border-neutral-100">
        <table className="xl-table text-[12px]">
          <thead>
            <tr>
              <th className="xl-rn">序号</th>
              {visibleColumns.map((c) => (
                <th key={c.field} className={c.field === "price" ? "text-right" : undefined}>
                  {c.label}
                </th>
              ))}
              <th className="w-12 text-center">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && !data && (
              <tr>
                <td colSpan={visibleColumns.length + 2} className="py-8 text-center text-neutral-400" role="status">
                  <Loader2 size={14} className="mr-2 inline spin" />正在读取价格数据
                </td>
              </tr>
            )}
            {adding && (
              <tr style={{ background: "color-mix(in srgb, var(--brand-soft) 45%, var(--surface))" }}>
                <td className="xl-rn text-[var(--brand-ink)]">新</td>
                {visibleColumns.map((c) => (
                  <td key={c.field} className="xl-edit">
                    {c.field === "priceType" ? (
                      <select
                        aria-label={`新增行${c.label}`}
                        disabled={busy}
                        value={newRow.priceType}
                        onChange={(e) => setNewRow((r) => ({ ...r, priceType: e.target.value }))}
                        className="w-full border-0 bg-transparent px-0 py-0 text-[12.5px] outline-none"
                      >
                        <option value="">市场价(默认)</option>
                        {Object.entries(PRICE_TYPE_LABEL).map(([v, l]) => (
                          <option key={v} value={v}>{l}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        aria-label={`新增行${c.label}`}
                        disabled={busy}
                        inputMode={c.field === "price" ? "decimal" : "text"}
                        value={newRow[c.field]}
                        placeholder={c.label}
                        onChange={(e) => setNewRow((r) => ({ ...r, [c.field]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.nativeEvent.isComposing || busy) return;
                          if (e.key === "Enter") void addRow();
                          if (e.key === "Escape") cancelAdd();
                        }}
                        className={cn("w-full border-0 bg-transparent px-0 py-0 text-[12.5px] outline-none", c.field === "price" && "text-right")}
                      />
                    )}
                  </td>
                ))}
                <td className="whitespace-nowrap text-center">
                  <button
                    onClick={() => void addRow()}
                    disabled={busy}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--success-soft-fg)] hover:bg-[var(--success-soft-bg)] disabled:opacity-40"
                    title="保存"
                    aria-label="保存新增价格行"
                  >
                    <Check size={12} />
                  </button>
                  <button
                    onClick={cancelAdd}
                    disabled={busy}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 hover:bg-[var(--hover)]"
                    title="取消"
                    aria-label="取消新增价格行"
                  >
                    <X size={12} />
                  </button>
                </td>
              </tr>
            )}
            {data?.rows.map((r, i) => (
              <tr key={r.id}>
                <td className="xl-rn">{((data?.page ?? 1) - 1) * PAGE_SIZE + i + 1}</td>
                {visibleColumns.map(c => cell(r, c.field, c.field === "price" ? "mono text-right" : c.field === "spec" ? "text-neutral-500" : undefined))}
                <td className="text-center">
                  <button
                    onClick={() => setDelRow(r)}
                    disabled={busy || loading || dirty || !!error}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-[var(--danger-soft-bg)] hover:text-[var(--danger)]"
                    title="删除该行"
                    aria-label={`删除${r.name}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
            {data && !data.rows.length && (
              <tr>
                <td colSpan={visibleColumns.length + 2} className="py-8 text-center text-[12px] text-neutral-400">
                  {loading ? (
                    <Loader2 size={14} className="inline spin" />
                  ) : filtering ? (
                    "没有符合筛选条件的价格行"
                  ) : (
                    "暂无价格数据"
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {loading && data && data.rows.length > 0 && (
          <div className="flex items-center justify-center gap-1.5 border-t border-neutral-100 py-1.5 text-[11px] text-neutral-400">
            <Loader2 size={11} className="spin" /> 加载中…
          </div>
        )}
      </div>

      {/* 分页 */}
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-[11px] text-neutral-400">
          {data ? `共 ${data.total} 行` : " "}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading || dirty || !!error}
            className="cost-btn sm !px-1.5"
            title="上一页"
            aria-label="上一页"
          >
            <ChevronLeft size={12} />
          </button>
          <span className="px-1 text-[11.5px] text-neutral-500 tabular-nums">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || loading || dirty || !!error}
            className="cost-btn sm !px-1.5"
            title="下一页"
            aria-label="下一页"
          >
            <ChevronRight size={12} />
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={!!delRow}
        danger
        title="删除该价格行？"
        description={delRow ? `「${delRow.name}${delRow.spec ? ` ${delRow.spec}` : ""}」将从价格库中移除，已测算项目不受影响。` : undefined}
        confirmText="删除"
        busy={busy}
        onConfirm={remove}
        onCancel={() => setDelRow(null)}
      />
    </div>
  );
}
