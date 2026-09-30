"use client";
import { useCallback, useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Loader2, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { ConfirmDialog, toast } from "../primitives";

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

export function PriceRowsPanel({ datasetId }: { datasetId: string }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState(""); // 防抖后的搜索词
  const [brand, setBrand] = useState("");
  const [region, setRegion] = useState("");
  const [period, setPeriod] = useState("");
  const [priceType, setPriceType] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PriceListDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ id: string; field: EditField } | null>(null);
  const [draft, setDraft] = useState("");
  const [delRow, setDelRow] = useState<PriceRowDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newRow, setNewRow] = useState<Record<EditField, string>>({
    name: "", spec: "", unit: "", brand: "", price: "", priceType: "", region: "", period: "",
  });

  // 搜索防抖 300ms
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(q.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (query) p.set("q", query);
    if (brand) p.set("brand", brand);
    if (region) p.set("region", region);
    if (period) p.set("period", period);
    if (priceType) p.set("priceType", priceType);
    try {
      const res = await fetch(`/api/admin/datasets/${datasetId}/prices?${p}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as PriceListDTO);
    } catch {
      toast.error("价格数据加载失败");
    }
    setLoading(false);
  }, [datasetId, query, brand, region, period, priceType, page]);

  useEffect(() => {
    void load();
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
    setEditing({ id: row.id, field });
    setDraft(String(row[field] ?? ""));
  };

  // Enter/blur 提交；值没变不发请求。失败时行数据未被改动，天然还原。
  const commitEdit = async (row: PriceRowDTO, field: EditField, value: string) => {
    setEditing(null);
    const v = value.trim();
    const old = String(row[field] ?? "");
    if (v === old) return;
    if (field === "price" && (v === "" || isNaN(Number(v)))) {
      toast.error("请输入数字");
      return;
    }
    try {
      const res = await fetch(`/api/admin/datasets/${datasetId}/prices/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [field]: v }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated = (await res.json()) as PriceRowDTO;
      setData((d) =>
        d ? { ...d, rows: d.rows.map((r) => (r.id === row.id ? { ...r, ...updated } : r)) } : d
      );
    } catch {
      toast.error("保存失败，已还原");
    }
  };

  const addRow = async () => {
    if (!newRow.name.trim()) { toast.error("名称必填"); return; }
    const price = Number(newRow.price);
    if (newRow.price.trim() === "" || !Number.isFinite(price) || price < 0) {
      toast.error("单价必须是 ≥0 的数字");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/datasets/${datasetId}/prices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...newRow, price }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success("已新增价格行");
      setAdding(false);
      setNewRow({ name: "", spec: "", unit: "", brand: "", price: "", priceType: "", region: "", period: "" });
      void load();
    } catch {
      toast.error("新增失败，请重试");
    }
    setBusy(false);
  };

  const remove = async () => {
    const row = delRow;
    setDelRow(null);
    if (!row) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/datasets/${datasetId}/prices/${row.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success("已删除该价格行");
      // 删到页尾：退回上一页
      if (data && data.rows.length === 1 && page > 1) setPage((p) => p - 1);
      else void load();
    } catch {
      toast.error("删除失败，请重试");
    }
    setBusy(false);
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

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
      className="h-7 max-w-36 rounded-md border border-neutral-200 bg-white px-1.5 text-[11.5px] text-neutral-600"
      title={label}
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
              value={draft}
              onChange={(e) => void commitEdit(row, field, e.target.value)}
              onBlur={() => setEditing(null)}
              onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
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
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void commitEdit(row, field, draft)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitEdit(row, field, draft);
                if (e.key === "Escape") setEditing(null);
              }}
              className="w-full border-0 bg-transparent px-0 py-0 text-[12.5px] outline-none"
            />
          )
        ) : field === "priceType" ? (
          PRICE_TYPE_LABEL[row.priceType] ?? row.priceType ?? "—"
        ) : (
          String(row[field] ?? "") || "—"
        )}
      </td>
    );
  };

  return (
    <div className="border-t border-neutral-100">
      {/* 筛选条 */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 pt-3">
        <div className="relative">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-neutral-400"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索名称 / 规格 / 品牌…"
            className="h-7 w-52 rounded-md border border-neutral-200 bg-[var(--surface)] pl-7 pr-2 text-[12px] outline-none focus:border-[var(--brand-accent)]"
          />
        </div>
        {facetSelect("品牌", brand, setBrand, data?.facets.brands ?? [])}
        {facetSelect("地区", region, setRegion, data?.facets.regions ?? [])}
        {facetSelect("期次", period, setPeriod, data?.facets.periods ?? [])}
        {facetSelect("类型", priceType, setPriceType, data?.facets.priceTypes ?? [], PRICE_TYPE_LABEL)}
        {filtering && (
          <button
            onClick={reset}
            className="flex h-6 items-center gap-1 rounded-md px-2 text-[11.5px] text-neutral-500 hover:bg-[var(--hover)] hover:text-neutral-700"
          >
            <RotateCcw size={11} /> 重置
          </button>
        )}
        <button
          onClick={() => setAdding((v) => !v)}
          className={cn(
            "ml-auto flex h-6 items-center gap-1 rounded-md px-2 text-[11.5px]",
            adding ? "bg-[var(--brand-accent)] text-white" : "text-neutral-500 hover:bg-[var(--hover)] hover:text-neutral-700"
          )}
        >
          <Plus size={11} /> 新增行
        </button>
      </div>

      {/* 数据表 */}
      <div className="mt-2 max-h-96 overflow-auto border-t border-neutral-100">
        <table className="xl-table text-[12px]">
          <thead>
            <tr>
              <th className="xl-rn">序号</th>
              {EDITABLE.map((c) => (
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
                <td colSpan={10} className="py-8 text-center text-neutral-400">
                  <Loader2 size={14} className="inline animate-spin" />
                </td>
              </tr>
            )}
            {adding && (
              <tr className="bg-blue-50/40">
                <td className="xl-rn text-[var(--brand-accent)]">新</td>
                {EDITABLE.map((c) => (
                  <td key={c.field} className="xl-edit">
                    {c.field === "priceType" ? (
                      <select
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
                        value={newRow[c.field]}
                        placeholder={c.label}
                        onChange={(e) => setNewRow((r) => ({ ...r, [c.field]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void addRow();
                          if (e.key === "Escape") setAdding(false);
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
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-emerald-600 hover:bg-emerald-50 disabled:opacity-40"
                    title="保存"
                  >
                    <Check size={12} />
                  </button>
                  <button
                    onClick={() => setAdding(false)}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 hover:bg-[var(--hover)]"
                    title="取消"
                  >
                    <X size={12} />
                  </button>
                </td>
              </tr>
            )}
            {data?.rows.map((r, i) => (
              <tr key={r.id}>
                <td className="xl-rn">{(page - 1) * PAGE_SIZE + i + 1}</td>
                {cell(r, "name")}
                {cell(r, "spec", "text-neutral-500")}
                {cell(r, "unit")}
                {cell(r, "brand")}
                {cell(r, "price", "mono text-right")}
                {cell(r, "priceType")}
                {cell(r, "region")}
                {cell(r, "period")}
                <td className="text-center">
                  <button
                    onClick={() => setDelRow(r)}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 hover:bg-red-50 hover:text-red-600"
                    title="删除该行"
                  >
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
            {data && !data.rows.length && (
              <tr>
                <td colSpan={10} className="py-8 text-center text-[12px] text-neutral-400">
                  {loading ? (
                    <Loader2 size={14} className="inline animate-spin" />
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
            <Loader2 size={11} className="animate-spin" /> 加载中…
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
            disabled={page <= 1 || loading}
            className="flex h-6 w-6 items-center justify-center rounded-md border border-neutral-200 text-neutral-500 hover:bg-[var(--hover)] disabled:opacity-40"
            title="上一页"
          >
            <ChevronLeft size={12} />
          </button>
          <span className="px-1 text-[11.5px] text-neutral-500">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || loading}
            className="flex h-6 w-6 items-center justify-center rounded-md border border-neutral-200 text-neutral-500 hover:bg-[var(--hover)] disabled:opacity-40"
            title="下一页"
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
