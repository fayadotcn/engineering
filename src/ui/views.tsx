"use client";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "./store";
import type {
  AnomalyRow,
  BoqItemDTO,
  BreakdownSlice,
  DiffRow,
  FileCompareRow,
  QuotaResultRow,
  QuotationMatchRow,
  WorkspaceView,
} from "@shared/types";
import { DISCIPLINE_LABEL, isPricableItem } from "@shared/types";
import { ArrowDown, ArrowUp, ChevronDown, Download, FileSpreadsheet, AlertTriangle, Funnel, X } from "lucide-react";
import { ConfirmDialog, EmptyState, toast } from "./primitives";
import { projectTotals } from "@cost-engine/aggregate";
import { readResponse } from "./http";

const cn = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(" ");

const fmtMoney = (v: string | number) => {
  const n = Number(v);
  if (isNaN(n)) return String(v);
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const FIELD_LABEL: Record<string, string> = {
  unitPrice: "综合单价",
  mainMaterialPrice: "主材暂估价",
  quantity: "工程量",
  totalPrice: "合价",
  name: "项目名称",
  rawFeature: "项目特征",
};

const SOURCE_LABEL: Record<string, string> = {
  USER_PROVIDED: "用户提供",
  FILE_EXTRACTED: "文件提取",
  CONTRACT_DEFINED: "合同定义",
  HISTORICAL: "历史",
  INFERRED: "推断",
  MARKET_REFERENCE: "市场参考",
};

/* ---------------- Excel 列头：排序 + 筛选下拉 ---------------- */

type SortDir = "asc" | "desc";

function ExcelHead({
  label,
  numeric,
  sortDir,
  onSort,
  text,
  onText,
  options,
  selected,
  onToggle,
  onAll,
}: {
  label: string;
  numeric?: boolean;
  sortDir?: SortDir | null;
  onSort?: (dir: SortDir | null) => void;
  text?: string;
  onText?: (v: string) => void;
  options?: { v: string; n: number }[];
  selected?: Set<string>;
  onToggle?: (v: string) => void;
  onAll?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const hasMenu = onSort || onText || options;
  const filtered = Boolean(text) || Boolean(options && selected && selected.size < options.length);
  const Icon = sortDir === "asc" ? ArrowUp : sortDir === "desc" ? ArrowDown : filtered ? Funnel : ChevronDown;

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => { if (event.target instanceof Element && event.target.closest("[data-excel-menu]")) return; setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); btnRef.current?.focus(); } };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const menuW = 208;
      const estH = options ? 300 : onSort && onText ? 180 : onText ? 120 : 90;
      const spaceBelow = window.innerHeight - r.bottom;
      const up = spaceBelow < estH && r.top > spaceBelow;
      setPos({
        left: Math.max(8, Math.min(r.right - menuW, window.innerWidth - menuW - 8)),
        ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
      });
    }
    setOpen(!open);
  };

  return (
    <>
      <div className={cn("flex items-center gap-1", numeric && "flex-row-reverse")}>
        <span className="truncate">{label}</span>
        {hasMenu && (
          <button
            ref={btnRef}
            onClick={toggle}
            className={cn(
              "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] border transition-colors",
              filtered || sortDir
                ? "border-transparent bg-[var(--brand-soft)] text-[var(--brand-accent)]"
                : "border-neutral-300/70 text-neutral-500 hover:border-neutral-400 hover:bg-[var(--active)] hover:text-neutral-700",
              open && "border-[var(--brand-accent)] bg-[var(--brand-soft)] text-[var(--brand-accent)]"
            )}
            title="排序与筛选"
            aria-label={`${label}排序与筛选`}
            aria-expanded={open}
          >
            <Icon size={11} strokeWidth={2.2} />
          </button>
        )}
      </div>
      {open && pos && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            data-excel-menu
            aria-label={`${label}筛选与排序`}
            className="fixed z-40 w-52 overflow-auto rounded-lg border border-neutral-200 bg-[var(--surface)] p-1 text-left font-normal shadow-[var(--shadow-menu)]"
            style={{ left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: 320 }}
            onClick={(e) => e.stopPropagation()}
          >
            {onSort && (
              <>
                {([["asc", "升序", ArrowUp], ["desc", "降序", ArrowDown]] as const).map(([d, l, Icon]) => (
                  <button
                    key={d}
                    onClick={() => { onSort(sortDir === d ? null : d); setOpen(false); btnRef.current?.focus(); }}
                    aria-pressed={sortDir === d}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] hover:bg-[var(--hover)]",
                      sortDir === d && "font-medium text-[var(--brand-accent)]"
                    )}
                  >
                    <Icon size={12} /> {l}
                    {sortDir === d && <span className="ml-auto text-[10px]">✓</span>}
                  </button>
                ))}
                <div className="my-1 h-px bg-neutral-100" />
              </>
            )}
            {onText && (
              <div className="px-1.5 py-1">
                <input
                  aria-label={`筛选${label}`}
                  autoFocus={!options}
                  value={text ?? ""}
                  onChange={(e) => onText(e.target.value)}
                  placeholder="包含文本…"
                  className="h-7 w-full rounded-md border border-neutral-200 px-2 text-[12px] outline-none focus:border-[var(--brand-accent)]"
                />
              </div>
            )}
            {options && (
              <>
                <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px] hover:bg-[var(--hover)]">
                  <input
                    type="checkbox"
                    checked={!selected || selected.size === options.length}
                    onChange={onAll}
                    className="accent-[var(--brand-accent)]"
                  />
                  <span className="text-neutral-600">（全选）</span>
                </label>
                <div className="max-h-48 overflow-auto">
                  {options.map((o) => (
                    <label
                      key={o.v}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[12px] hover:bg-[var(--hover)]"
                    >
                      <input
                        type="checkbox"
                        checked={!selected || selected.has(o.v)}
                        onChange={() => onToggle?.(o.v)}
                        className="accent-[var(--brand-accent)]"
                      />
                      <span className="min-w-0 flex-1 truncate">{o.v || "（空白）"}</span>
                      <span className="text-[10.5px] text-neutral-400">{o.n}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}

/* ---------------- 变更记录 ----------------
   回执聚合面板：每一次数据修改可追溯、可撤销 */

const ACTION_LABEL: Record<string, string> = {
  BOQ_UPDATE: "清单修改", PRICE_APPLY: "价格写回", QUANTITY_ADJUST: "总价调整", PRICE_ADJUST: "总价调整",
  FILE_IMPORT: "文件导入", FILE_DELETE: "文件删除", EXPORT: "导出",
  USER_EDIT: "手动编辑", FACT_SET: "台账写入", REVERT: "撤销", SETTINGS_UPDATE: "计价设置", PROJECT_CREATE: "新建工程",
};

export function ReceiptsView() {
  const { receipts, reloadBoq, running, agentRunning, importRunning } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const revert = async (id: string) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/receipts/${id}/revert`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error ?? "撤销失败，请重试");
      await reloadBoq();
      await useStore.getState().refreshMeta();
      toast.success("已撤销该修改");
    } catch (error) { toast.error(error instanceof Error ? error.message : "撤销失败，请重试"); }
    finally { setBusy(null); }
  };
  return (
    <div className="h-full overflow-auto p-4">
      <div className="xl-sheet overflow-hidden rounded-lg">
        <table className="xl-table">
          <thead>
            <tr>
              <th className="xl-rn"></th>
              <th className="w-32">时间</th>
              <th className="w-24">类型</th>
              <th>内容</th>
              <th className="w-16">来源</th>
              <th className="w-16"></th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((r, i) => (
              <tr key={r.id} className="group">
                <td className="xl-rn">{i + 1}</td>
                <td className="mono text-[11px] text-neutral-400">
                    {new Date(r.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}
                </td>
                <td>
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500">
                    {ACTION_LABEL[r.actionType] ?? r.actionType}
                  </span>
                </td>
                <td className="max-w-96 truncate text-neutral-600" title={r.summary}>{r.summary}</td>
                <td className="text-[11px] text-neutral-400">{r.createdBy === "user" ? "手动" : "Agent"}</td>
                <td className="text-center">
                  {r.reversible && r.actionType !== "REVERT" ? (
                    <button
                      onClick={() => revert(r.id)}
                      disabled={!!busy || running || agentRunning || importRunning}
                      className="rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-[var(--hover)] hover:text-neutral-800 disabled:opacity-40"
                    >
                      {busy === r.id ? "…" : "撤销"}
                    </button>
                  ) : (
                    <span className="text-[10.5px] text-neutral-300">
                      {r.actionType === "REVERT" ? "" : "不可撤销"}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!receipts.length && <EmptyState title="暂无变更记录" hint="所有数据修改都会在这里留痕" />}
    </div>
  );
}

/* ---------------- 清单表 ---------------- */

type BoqSortKey = "code" | "name" | "quantity" | "unitPrice" | "totalPrice";
type BoqEditField = "quantity" | "unitPrice" | "totalPrice";

export function BoqTable({ view }: { view?: Extract<WorkspaceView, { kind: "boqTable" }> }) {
  const { items, patchItem, boqQuery, boqOnlyUnpriced, setBoqQuery, running, agentRunning, importRunning, saving } = useStore();
  const query = boqQuery;
  const [discipline, setDiscipline] = useState<string>(view?.filter?.discipline ?? "");
  const [onlyItems, setOnlyItems] = useState(!!view?.filter?.onlyItems);
  const previousQuery = useRef(view?.filter?.query);
  useEffect(() => {
    if (view?.filter?.query !== undefined || previousQuery.current !== undefined) setBoqQuery(view?.filter?.query ?? "");
    previousQuery.current = view?.filter?.query;
  }, [view?.filter?.query, setBoqQuery]);
  useEffect(() => { setDiscipline(view?.filter?.discipline ?? ""); setOnlyItems(!!view?.filter?.onlyItems); setLimit(300); }, [view?.filter?.discipline, view?.filter?.onlyItems]);
  const [editing, setEditing] = useState<{ id: string; field: BoqEditField } | null>(null);
  const [draft, setDraft] = useState("");
  const [limit, setLimit] = useState(300);
  const [selected, setSelected] = useState<string | null>(null);
  const [colText, setColText] = useState({ code: "", name: "", feature: "" });
  const [unitSel, setUnitSel] = useState<Set<string> | null>(null); // null = 全选
  const [sort, setSort] = useState<{ key: BoqSortKey; dir: SortDir } | null>(null);
  const [details, setDetails] = useState(false);
  const committing = useRef(false);
  const editRef = useRef<typeof editing>(null);
  useEffect(() => {
    useStore.setState({ boqDirty: !!editing && draft !== items.find(i => i.id === editing.id)?.[editing.field] });
    return () => { useStore.setState({ boqDirty: false }); };
  }, [editing, draft, items]);
  const cancelEdit = () => { if (committing.current) return; editRef.current = null; setEditing(null); };
  const beginEdit = (item: BoqItemDTO, field: BoqEditField) => {
    if (running || agentRunning || importRunning || saving || committing.current || editRef.current) return;
    editRef.current = { id: item.id, field };
    setEditing({ id: item.id, field });
    setDraft(item[field]);
  };

  const commit = async (moveTab?: 1 | -1) => {
    if (!editing || !editRef.current || committing.current) return;
    const v = draft.trim();
    if (!v || !Number.isFinite(Number(v))) {
      toast.error("请输入有效数字，零金额请填写 0");
      return;
    }
    const cur = editing;
    committing.current = true;
    setEditing(null);
    const ok = v === items.find(i => i.id === cur.id)?.[cur.field] || await patchItem(cur.id, { [cur.field]: v });
    committing.current = false;
    if (!ok) setEditing(cur);
    else editRef.current = null;
    if (moveTab && ok) {
      const cells = leafIds.flatMap<{ id: string; field: BoqEditField }>(id => isPricableItem(items.find(i => i.id === id)!)
        ? [{ id, field: "quantity" as const }, { id, field: "unitPrice" as const }]
        : [{ id, field: "totalPrice" as const }]);
      const idx = cells.findIndex(cell => cell.id === cur.id && cell.field === cur.field);
      const next = idx >= 0 ? cells[idx + moveTab] : undefined;
      if (next) {
        const it = items.find((x) => x.id === next.id);
        if (it) {
          editRef.current = next;
          setEditing(next);
          setDraft(it[next.field]);
        }
      }
    }
  };

  const units = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((i) => {
      if (!i.isHeader) m.set(i.unit, (m.get(i.unit) ?? 0) + 1);
    });
    return [...m.entries()].map(([v, n]) => ({ v, n })).sort((a, b) => b.n - a.n);
  }, [items]);

  const filtering = Boolean(
    query.trim() || colText.code || colText.name || colText.feature || unitSel || sort || discipline || onlyItems || boqOnlyUnpriced
  );

  const filtered = items.filter((i) => {
    if (i.isHeader) return !filtering;
    if (discipline && i.discipline !== discipline) return false;
    if (boqOnlyUnpriced && (!isPricableItem(i) || Number(i.unitPrice) !== 0)) return false;
    const q = query.trim();
    if (q && !(i.name.includes(q) || i.code.includes(q) || i.rawFeature.includes(q))) return false;
    if (colText.code && !i.code.includes(colText.code)) return false;
    if (colText.name && !i.name.includes(colText.name)) return false;
    if (colText.feature && !i.rawFeature.includes(colText.feature)) return false;
    if (unitSel && !unitSel.has(i.unit)) return false;
    return true;
  });

  const sorted = sort
    ? [...filtered].sort((a, b) => {
        const av = a[sort.key];
        const bv = b[sort.key];
        const cmp =
          sort.key === "code" || sort.key === "name"
            ? String(av).localeCompare(String(bv), "zh")
            : Number(av) - Number(bv);
        return sort.dir === "asc" ? cmp : -cmp;
      })
    : filtered;
  const shown = sorted.slice(0, limit);
  // 有序叶子行（Tab 跳格沿当前排序/筛选顺序走）
  const leafIds = shown.filter((i) => !i.isHeader).map((i) => i.id);
  const dataTotal = items.reduce((n, i) => n + (i.isHeader ? 0 : 1), 0);
  const dataShown = sorted.reduce((n, i) => n + (i.isHeader ? 0 : 1), 0);
  // 造价师视角：合价合计随筛选联动，未定价项计数常显
  const sumShown = projectTotals(sorted).totalAmount;
  const unpriced = items.reduce((n, i) => n + (isPricableItem(i) && Number(i.unitPrice) === 0 ? 1 : 0), 0);

  const toggleUnit = (v: string) => {
    const next = new Set(unitSel ?? units.map((u) => u.v));
    if (next.has(v)) next.delete(v); else next.add(v);
    setUnitSel(next.size === units.length ? null : next);
    setLimit(300);
  };

  const setText = (k: keyof typeof colText) => (v: string) => {
    setColText((c) => ({ ...c, [k]: v }));
    setLimit(300);
  };

  const clearAll = () => {
    setBoqQuery("");
    setColText({ code: "", name: "", feature: "" });
    setUnitSel(null);
    setSort(null);
    setDiscipline(""); setOnlyItems(false); useStore.setState({ boqOnlyUnpriced: false });
    setLimit(300);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="cost-table-toolbar flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-[var(--sidebar)] px-3 py-1.5">
        <Funnel size={12} className="shrink-0 text-neutral-400" />
        <input
          disabled={!!editing || saving}
          value={query}
          onChange={(e) => { setBoqQuery(e.target.value); setLimit(300); }}
          placeholder="查找清单项目"
          aria-label="搜索工程清单"
          className="h-7 w-56 rounded-md border border-neutral-200 bg-[var(--surface)] px-2.5 text-[12px] outline-none focus:border-[var(--brand-accent)]"
        />
        <button className="cost-btn" aria-pressed={!!boqOnlyUnpriced} disabled={!!editing || saving} onClick={() => { useStore.setState({ boqOnlyUnpriced: !boqOnlyUnpriced }); setLimit(300); }}>只看未报价{unpriced ? `（${unpriced}）` : ""}</button>
        <details className="cost-simple-more"><summary>更多筛选</summary><div className="cost-more-body"><select aria-label="筛选清单专业" disabled={!!editing || saving} value={discipline} className="h-7 rounded-md border border-neutral-200 bg-[var(--surface)] px-2 text-xs" onChange={e => { setDiscipline(e.target.value); setLimit(300); }}><option value="">全部专业</option>{Object.entries(DISCIPLINE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><label><input type="checkbox" checked={details} disabled={!!editing || saving} onChange={e => setDetails(e.target.checked)} />显示编码、特征和列筛选</label></div></details>
        {filtering && (
          <button
            onClick={clearAll}
            disabled={!!editing || saving}
            className="flex h-6 items-center gap-1 rounded-md px-2 text-[11.5px] text-neutral-500 hover:bg-[var(--hover)] hover:text-neutral-700"
          >
            <X size={11} /> 清除筛选
          </button>
        )}
        <span className="ml-auto text-[11px] text-neutral-400">
          {dataShown === dataTotal
            ? `${dataTotal} 行`
            : `已筛选 ${dataShown} / ${dataTotal} 行`}
          {sort && " · 已排序"}
        </span>
      </div>
      {editing && <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-neutral-500"><span>改好后点击保存。</span><button className="cost-btn primary" disabled={saving} onPointerDown={e => e.preventDefault()} onClick={() => void commit()}>保存修改</button><button className="cost-btn" disabled={saving} onPointerDown={e => e.preventDefault()} onClick={cancelEdit}>取消</button></div>}
      {!editing && <p className="px-3 py-2 text-[11px] text-neutral-500">点击数量或单价即可修改。总额计价的费用直接改金额。</p>}
      <div className="flex-1 overflow-auto">
      <table className="xl-table">
        <thead inert={!!editing || saving}>
          <tr>
            <th className="xl-rn"></th>
            {details && <th className="group/th relative w-28">
              <ExcelHead label="项目编码" sortDir={sort?.key === "code" ? sort.dir : null} onSort={(d) => setSort(d ? { key: "code", dir: d } : null)} text={colText.code} onText={setText("code")} />
            </th>}
            <th className="group/th relative">
              {details ? <ExcelHead label="项目名称" sortDir={sort?.key === "name" ? sort.dir : null} onSort={(d) => setSort(d ? { key: "name", dir: d } : null)} text={colText.name} onText={setText("name")} /> : "项目"}
            </th>
            {details && <th className="group/th relative">
              <ExcelHead label="项目特征" text={colText.feature} onText={setText("feature")} />
            </th>}
            <th className="group/th relative w-12">
              {details ? <ExcelHead
                label="单位"
                options={units}
                selected={unitSel ?? undefined}
                onToggle={toggleUnit}
                onAll={() => { setUnitSel(null); setLimit(300); }}
              /> : "单位"}
            </th>
            <th className="group/th relative w-20 text-right">
              {details ? <ExcelHead numeric label="工程量" sortDir={sort?.key === "quantity" ? sort.dir : null} onSort={(d) => setSort(d ? { key: "quantity", dir: d } : null)} /> : "数量"}
            </th>
            <th className="group/th relative w-24 text-right">
              {details ? <ExcelHead numeric label="综合单价" sortDir={sort?.key === "unitPrice" ? sort.dir : null} onSort={(d) => setSort(d ? { key: "unitPrice", dir: d } : null)} /> : "单价（元）"}
            </th>
            <th className="group/th relative w-28 text-right">
              {details ? <ExcelHead numeric label="合价" sortDir={sort?.key === "totalPrice" ? sort.dir : null} onSort={(d) => setSort(d ? { key: "totalPrice", dir: d } : null)} /> : "金额（元）"}
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((it, i) =>
            it.isHeader ? (
              <tr key={it.id} className="xl-group">
                <td className="xl-rn">{i + 1}</td>
                <td colSpan={details ? 7 : 5} className="text-[12px]">
                  {it.name}
                </td>
              </tr>
            ) : (
              <tr
                key={it.id}
                className={cn(
                  isPricableItem(it) && Number(it.quantity) === 0 && "opacity-45",
                  selected === it.id && "xl-sel"
                )}
                title={isPricableItem(it) && Number(it.quantity) === 0 ? "工程量为 0" : undefined}
                onClick={() => setSelected(it.id)}
              >
                <td className="xl-rn">{i + 1}</td>
                {details && <td className="mono text-neutral-500">{it.code}</td>}
                <td className="max-w-72 truncate" title={it.name}>
                  {it.name}
                  {!details && it.rawFeature && <div className="max-w-64 truncate text-[11px] text-neutral-500" title={it.rawFeature}>{it.rawFeature}</div>}
                  {it.feeType && it.feeType !== "分部分项" && (
                    <span className="ml-1 rounded bg-neutral-100 px-1 py-px text-[10px] text-neutral-500">
                      {it.feeType}
                    </span>
                  )}
                </td>
                {details && <td className="max-w-56 truncate text-neutral-500" title={it.rawFeature}>
                  {it.rawFeature}
                </td>}
                <td className="text-neutral-500">{it.unit}</td>
                {(["quantity", "unitPrice", "totalPrice"] as const).map((f) => {
                  const editable = isPricableItem(it) ? f !== "totalPrice" : f === "totalPrice";
                  return (
                  <td
                    key={f}
                    className={cn(
                      "mono text-right", editable && "xl-edit",
                      editing?.id === it.id && editing.field === f && "xl-active",
                      f === "unitPrice" && Number(it.unitPrice) === 0 && isPricableItem(it) &&
                        "bg-[var(--warning-soft-bg)] font-medium",
                      f === "unitPrice" && Number(it.unitPrice) === 0 && isPricableItem(it) &&
                        "text-[var(--warning-soft-fg)]"
                    )}
                    title={
                      !editable ? isPricableItem(it) ? "工程量×综合单价自动计算" : "总额计价行，请编辑合价"
                        : f === "unitPrice" && Number(it.unitPrice) === 0 ? "未报价 — 点击填写" : "点击或按 Enter 修改"
                    }
                    tabIndex={editable ? 0 : undefined}
                    onKeyDown={e => { if (editable && e.target === e.currentTarget && e.key === "Enter") { e.preventDefault(); beginEdit(it, f); } }}
                    onClick={e => {
                      if (editable) { e.stopPropagation(); setSelected(it.id); beginEdit(it, f); }
                    }}
                  >
                    {editing?.id === it.id && editing.field === f ? (
                      <input
                        autoFocus
                        aria-label={`${it.name} ${FIELD_LABEL[f]}`}
                        inputMode="decimal"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.nativeEvent.isComposing) return;
                          if (e.key === "Enter") { e.preventDefault(); void commit(); }
                          if (e.key === "Tab") {
                            e.preventDefault();
                            void commit(e.shiftKey ? -1 : 1);
                          }
                          if (e.key === "Escape") cancelEdit();
                        }}
                        className="w-20 border-0 bg-transparent px-0 py-0 text-right text-[12.5px] outline-none"
                      />
                    ) : f === "totalPrice" ? fmtMoney(it.totalPrice) : f === "unitPrice" ? (
                      <>
                        {fmtMoney(it[f])}
                        {details && Number(it.mainMaterialPrice ?? 0) > 0 && (
                          <div
                            className="text-[10px] font-normal text-neutral-400"
                            title="主材暂估价（组价输入）"
                          >
                            材 {fmtMoney(it.mainMaterialPrice)}
                          </div>
                        )}
                        {details && (it.pricingPlan?.filter((l) => !l.suggested).length ?? 0) > 0 && (
                          <div
                            className="text-[10px] font-normal text-[var(--accent,#7a6a4f)]"
                            title={it.pricingPlan!.filter((l) => !l.suggested).map((l) => `${l.quotaCode} ${l.quotaName}`).join("\n")}
                          >
                            组价×{it.pricingPlan!.filter((l) => !l.suggested).length}
                          </div>
                        )}
                      </>
                    ) : (
                      it[f]
                    )}
                  </td>
                ); })}
              </tr>
            )
          )}
        </tbody>
      </table>
      {items.length > 0 && dataShown === 0 && <EmptyState title="没有符合筛选条件的清单项" hint="清除筛选或更换关键词后再查看。" />}
      {sorted.length > shown.length && (
        <button
          onClick={() => setLimit((l) => l + 500)}
          className="mx-auto my-3 block rounded border border-neutral-200 bg-[var(--surface)] px-4 py-1.5 text-[11.5px] text-neutral-500 hover:border-neutral-300"
        >
          加载更多（还有 {sorted.length - shown.length} 行）
        </button>
      )}
      {!items.length && (
        <EmptyState
          icon={<FileSpreadsheet size={22} />}
          title="清单为空"
          hint="使用工作区顶部的「导入资料」上传清单"
        />
      )}
      </div>
      {items.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-t border-neutral-200 bg-[var(--sidebar)] px-3 py-1.5">
          <span className="text-[11.5px] text-neutral-500">
            合价合计
            <b className="mono ml-1.5 text-[12.5px] font-medium text-neutral-800">
              {fmtMoney(sumShown)}
            </b>
            <span className="ml-1">元</span>
            {filtering && <span className="ml-1 text-neutral-400">（筛选口径）</span>}
          </span>
          {unpriced > 0 && (
            <span
              className="rounded px-1.5 py-0.5 text-[11px]"
              style={{ background: "var(--warning-soft-bg)", color: "var(--warning-soft-fg)" }}
            >
              {unpriced} 项未定价
            </span>
          )}
          <span className="ml-auto text-[11px] text-neutral-400">
            {dataShown === dataTotal ? `${dataTotal} 行` : `${dataShown} / ${dataTotal} 行`}
          </span>
        </div>
      )}
    </div>
  );
}

/* ---------------- 异常表 ---------------- */

const ANOMALY_BADGE: Record<string, string> = {
  SAME_ITEM_DIFF_PRICE: "text-red-600 bg-red-50",
  PRICE_ANOMALY: "text-amber-700 bg-amber-50",
  FEATURE_MISMATCH: "text-blue-700 bg-blue-50",
  DUPLICATE: "text-neutral-600 bg-neutral-100",
};

export function AnomalyTable({ view }: { view: Extract<WorkspaceView, { kind: "anomalyTable" }> }) {
  const { gotoBoqItem } = useStore();
  let rn = 0;
  return (
    <div className="h-full overflow-auto p-4">
      <div className="xl-sheet overflow-hidden rounded-lg">
        <table className="xl-table">
          <thead>
            <tr>
              <th className="xl-rn"></th>
              <th className="w-28">项目编码</th>
              <th>项目名称</th>
              <th>项目特征</th>
              <th className="w-12">单位</th>
              <th className="w-20 text-right">工程量</th>
              <th className="w-24 text-right">综合单价</th>
              <th className="w-12"></th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((g: AnomalyRow, gi) => {
              const min = Math.min(...g.items.map((i) => Number(i.unitPrice)));
              const max = Math.max(...g.items.map((i) => Number(i.unitPrice)));
              return (
                <Fragment key={gi}>
                  <tr className="xl-group">
                    <td className="xl-rn"></td>
                    <td colSpan={7}>
                      <div className="flex items-center gap-2">
                        <AlertTriangle size={12} className="text-amber-600" />
                        <span>{g.label}</span>
                        {g.spread && (
                          <span className={cn("rounded px-1.5 py-0.5 text-[11px]", ANOMALY_BADGE[view.anomalyType])}>
                            价差 {fmtMoney(g.spread)}
                          </span>
                        )}
                        <span className="ml-auto pr-1 text-[11px] font-normal text-neutral-400">{g.reason}</span>
                      </div>
                    </td>
                  </tr>
                  {g.items.map((it) => {
                    const p = Number(it.unitPrice);
                    rn += 1;
                    return (
                      <tr key={it.id} className="group">
                        <td className="xl-rn">{rn}</td>
                        <td className="mono text-neutral-500">{it.code || "—"}</td>
                        <td className="max-w-56 truncate" title={it.name}>{it.name}</td>
                        <td className="max-w-48 truncate text-neutral-500" title={it.feature}>
                          {it.feature}
                        </td>
                        <td className="text-neutral-500">{it.unit}</td>
                        <td className="mono text-right">{it.quantity}</td>
                        <td
                          className={cn(
                            "mono text-right font-medium",
                            p === max && max !== min && "text-red-600",
                            p === min && max !== min && "text-green-700"
                          )}
                        >
                          {fmtMoney(it.unitPrice)}
                        </td>
                        <td className="w-12 text-center">
                          <button
                            onClick={() => gotoBoqItem(it.code || it.name)}
                            className="rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-[var(--active)] hover:text-neutral-700"
                            title="在清单中定位"
                          >
                            定位
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {!view.rows.length && <EmptyState title="未发现异常" />}
    </div>
  );
}

/* ---------------- 询价匹配 ---------------- */

const MATCH_STYLE: Record<string, string> = {
  MATCHED: "text-green-700 bg-green-50",
  LOW_CONFIDENCE: "text-amber-700 bg-amber-50",
  UNMATCHED: "text-neutral-500 bg-neutral-100",
};
const MATCH_LABEL: Record<string, string> = {
  MATCHED: "已匹配",
  LOW_CONFIDENCE: "低置信",
  UNMATCHED: "未询到价",
};

export function QuotationMatch({ view }: { view: Extract<WorkspaceView, { kind: "quotationMatch" }> }) {
  const [details, setDetails] = useState(false);
  return (
    <div className="h-full overflow-auto p-4">
      <details className="cost-simple-more mb-3"><summary>更多信息</summary><div className="cost-more-body"><label><input type="checkbox" checked={details} onChange={e => setDetails(e.target.checked)} />显示品牌和匹配评分</label></div></details>
      <div className="xl-sheet overflow-hidden rounded-lg">
      <table className="xl-table">
        <thead>
          <tr>
            <th className="xl-rn"></th>
            <th>询价材料</th>
            {details && <><th>规格</th><th>品牌</th></>}
            <th className="text-right">材料价（元）</th>
            <th>匹配清单项</th>
            {details && <th className="w-20">匹配评分</th>}
            <th className="w-20">状态</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((r: QuotationMatchRow, ri) => (
            <tr key={r.quotationItemId}>
              <td className="xl-rn">{ri + 1}</td>
              <td className="max-w-48 truncate" title={r.materialName}>{r.materialName}{!details && (r.spec || r.brand) && <div className="truncate text-[11px] text-neutral-500" title={[r.spec, r.brand].filter(Boolean).join(" · ")}>{[r.spec, r.brand].filter(Boolean).join(" · ")}</div>}</td>
              {details && <><td className="mono text-neutral-500">{r.spec || "—"}</td><td className="text-neutral-500">{r.brand || "—"}</td></>}
              <td className="mono text-right">{fmtMoney(r.price)}</td>
              <td className="max-w-64 truncate text-neutral-600">
                {r.matchedNames.join("、") || "—"}
              </td>
              {details && <td className="mono text-neutral-500">{r.confidence}</td>}
              <td>
                <span className={cn("rounded px-1.5 py-0.5 text-[11px]", MATCH_STYLE[r.status])}>
                  {MATCH_LABEL[r.status]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {!view.rows.length && <EmptyState title="暂无材料价匹配结果" hint="先上传询价表，或让助手查询材料价格。" />}
    </div>
  );
}

/* ---------------- 占比图 ---------------- */

// 暖纸系 muted 调色板：深松绿为主，递推到浅灰绿，语义色只点缀
const PALETTE = [
  "#465d50", "#6b8577", "#8fa89a", "#b3c4ba", "#cfdad4",
  "#4a6a7a", "#7b96a3", "#a07a45", "#c9a167", "#a44742",
];

export function Breakdown({ view }: { view: Extract<WorkspaceView, { kind: "breakdown" }> }) {
  const total = Number(view.total);
  let acc = 0;
  const R = 52;
  const C = 2 * Math.PI * R;
  return (
    <div className="flex h-full items-start gap-10 overflow-auto p-8">
      <svg width="150" height="150" viewBox="0 0 140 140" className="mt-1 shrink-0 -rotate-90">
        <circle cx="70" cy="70" r={R} fill="none" stroke="#f0f0f0" strokeWidth="20" />
        {view.slices.map((s: BreakdownSlice, i) => {
          const dash = s.share * C;
          const off = -acc * C;
          acc += s.share;
          return (
            <circle
              key={s.key}
              cx="70" cy="70" r={R} fill="none"
              stroke={PALETTE[i % PALETTE.length]}
              strokeWidth="20"
              strokeDasharray={`${dash} ${C - dash}`}
              strokeDashoffset={off}
            />
          );
        })}
      </svg>
      <div className="min-w-0 flex-1">
        <div className="mono mb-4 text-xl font-medium">{fmtMoney(total)} <span className="text-xs font-normal text-neutral-400">元</span></div>
        {view.slices.map((s, i) => (
          <div key={s.key} className="flex items-center gap-3 border-b border-neutral-100 py-1.5 text-[12.5px]">
            <span className="h-2 w-2 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="w-24 shrink-0">{s.label}</span>
            <div className="h-1.5 flex-1 rounded bg-neutral-100">
              <div className="h-1.5 rounded" style={{ width: `${s.share * 100}%`, background: PALETTE[i % PALETTE.length] }} />
            </div>
            <span className="mono w-28 text-right">{fmtMoney(s.amount)}</span>
            <span className="mono w-12 text-right text-neutral-500">{(s.share * 100).toFixed(1)}%</span>
            <span className="w-14 text-right text-[11px] text-neutral-400">{s.count} 项</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Diff ---------------- */

export function DiffView({ view }: { view: Extract<WorkspaceView, { kind: "diff" }> }) {
  return (
    <div className="h-full overflow-auto p-4">
      <div className="xl-sheet overflow-hidden rounded-lg">
        <table className="xl-table">
          <thead>
            <tr>
              <th className="xl-rn"></th>
              <th className="w-28">编码</th>
              <th>名称</th>
              <th className="w-20">字段</th>
              <th className="w-32 text-right">修改前</th>
              <th className="w-32 text-right">修改后</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r, i) => (
              <tr key={i}>
                <td className="xl-rn">{i + 1}</td>
                <td className="mono text-neutral-500">{r.code || "—"}</td>
                <td className="max-w-56 truncate" title={r.name}>{r.name}</td>
                <td className="text-neutral-500">{FIELD_LABEL[r.field] ?? r.field}</td>
                <td className="mono text-right">
                  <span className="rounded bg-red-50 px-1.5 text-red-700 line-through">{r.before}</span>
                </td>
                <td className="mono text-right">
                  <span className="rounded bg-green-50 px-1.5 text-green-700">{r.after}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!view.rows.length && (
        <div className="flex h-40 items-center justify-center text-xs text-neutral-400">无变化</div>
      )}
    </div>
  );
}

/* ---------------- 定额测算 ---------------- */

export function QuotaResult({ view }: { view: Extract<WorkspaceView, { kind: "quotaResult" }> }) {
  const [open, setOpen] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const matched = view.rows.filter((r) => r.quotaCode).length;
  const needMain = view.rows.filter((r) => r.needsMainPrice).length;
  const ambiguous = view.rows.filter((r) => r.ambiguous).length;
  const deviant = view.rows.filter(
    (r) => r.deviation !== null && Math.abs(Number(r.deviation)) > 20
  ).length;
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[11.5px]">
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-500">
          {view.rows.length} 项中，{matched} 项找到定额
        </span>
        {needMain > 0 && (
          <span
            className="rounded px-1.5 py-0.5"
            style={{ background: "var(--warning-soft-bg)", color: "var(--warning-soft-fg)" }}
          >
            {needMain} 项还缺材料价
          </span>
        )}
        {ambiguous > 0 && (
          <span
            className="rounded px-1.5 py-0.5"
            style={{ background: "var(--warning-soft-bg)", color: "var(--warning-soft-fg)" }}
            title="存在得分相近且基价不同的备选子目，点击行可查看备选，或查定额说明核实"
          >
            {ambiguous} 项需要核对定额
          </span>
        )}
        {deviant > 0 && (
          <span
            className="rounded px-1.5 py-0.5"
            style={{ background: "var(--danger-soft-bg)", color: "var(--danger-soft-fg)" }}
          >
            {deviant} 项偏差 &gt;20%
          </span>
        )}
      </div>
      <details className="cost-simple-more mb-3"><summary>查看费用构成和计算方法</summary><div className="cost-more-body"><label><input type="checkbox" checked={details} onChange={e => setDetails(e.target.checked)} />显示人工、材料、机械和取费</label><p className="w-full text-xs text-neutral-500">综合单价 = 人工+辅材+机械 + 主材价×耗量 + (人工+机械)×(管理费{(view.mgmtRate * 100).toFixed(0)}%+利润{(view.profitRate * 100).toFixed(0)}%)</p></div></details>
      <div className="xl-sheet overflow-hidden rounded-lg">
      <table className="xl-table">
        <thead>
          <tr>
            <th className="xl-rn"></th>
            <th>清单项</th>
            <th>状态 / 明细</th>
            {details && <><th className="text-right">人工</th><th className="text-right">辅材</th><th className="text-right">机械</th><th className="text-right">主材</th><th className="text-right">管+利</th></>}
            <th className="text-right">建议单价（元）</th>
            <th className="text-right">原单价（元）</th>
            <th className="text-right">偏差</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((r, ri) => {
            const expanded = open === r.itemId;
            const hasDetail = !!r.quotaCode;
            return (
            <Fragment key={r.itemId}>
            <tr
              key={r.itemId}
              className={cn(hasDetail && "cursor-pointer")}
              onClick={() => hasDetail && setOpen(expanded ? null : r.itemId)}
              title={hasDetail ? "点击查看定额工作内容" : undefined}
            >
              <td className="xl-rn">{ri + 1}</td>
              <td className="max-w-40 truncate" title={r.name}>{r.name}</td>
              <td className="text-neutral-500">
                {r.quotaCode ? (
                  <button disabled={!hasDetail} aria-label={`查看${r.name}的定额工作内容`} aria-expanded={expanded} onClick={e => { e.stopPropagation(); if (hasDetail) setOpen(expanded ? null : r.itemId); }} className="mono inline-flex items-center gap-1 text-[11px]">
                    {hasDetail && <ChevronDown className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")} />}
                    {details ? r.quotaCode : "查看明细"}
                    {r.needsMainPrice && <span className="font-sans text-amber-600">缺材料价</span>}
                    {r.ambiguous && (
                      <span className="rounded bg-amber-100 px-1 py-px text-[9.5px] font-sans font-medium text-amber-700" title={r.altQuota ? `备选：${r.altQuota}` : "存在得分相近的备选子目"}>
                        存疑
                      </span>
                    )}
                  </button>
                ) : "未找到定额"}
              </td>
              {details && <><td className="mono text-right">{r.labor ?? "—"}</td>
              <td className="mono text-right">{r.materialAux ?? "—"}</td>
              <td className="mono text-right">{r.machine ?? "—"}</td>
              <td className="mono text-right">
                {r.needsMainPrice ? <span className="text-amber-600">缺主材价</span> : r.mainMaterial ?? "—"}
              </td>
              <td className="mono text-right">{r.fee ?? "—"}</td></>}
              <td className="mono text-right font-medium">{r.calcPrice ?? "—"}{r.needsMainPrice && <div className="text-[10px] font-sans font-normal text-amber-600">未含缺失材料价</div>}</td>
              <td className="mono text-right text-neutral-500">{fmtMoney(r.listPrice)}</td>
              <td className={cn(
                "mono text-right",
                r.deviation !== null && Math.abs(Number(r.deviation)) > 20 && "font-medium text-red-600"
              )}>
                {r.deviation !== null ? `${Number(r.deviation) > 0 ? "+" : ""}${r.deviation}%` : "—"}
              </td>
            </tr>
            {expanded && (
              <tr>
                <td className="xl-rn"></td>
                <td colSpan={details ? 10 : 5} className="whitespace-normal!" style={{ background: "var(--sidebar)" }}>
                  <div className="space-y-1 py-1.5 text-[11.5px] leading-relaxed">
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                      <span className="font-medium text-neutral-700">{r.quotaCode} {r.quotaName}</span>
                      {r.quotaFb && <span className="text-neutral-500">分册：{r.quotaFb}</span>}
                      {r.quotaChapter && <span className="text-neutral-500">章节：{r.quotaChapter}</span>}
                      {r.quotaBase && <span className="text-neutral-500">基价：<span className="mono">{r.quotaBase}</span> 元/{r.quotaCode ? "定额单位" : ""}</span>}
                      {r.quotaMainName && <span className="text-neutral-500">主材：{r.quotaMainName}</span>}
                      {r.ambiguous && r.altQuota && (
                        <span className="text-amber-600">备选子目：{r.altQuota}（基价不同，请结合定额说明核实）</span>
                      )}
                    </div>
                    {r.quotaGcnr && <div className="text-neutral-500">工作内容：{r.quotaGcnr}</div>}
                    {(r.plan?.length ?? 0) > 1 && (
                      <div className="mt-1 border-t border-neutral-200 pt-1">
                        <div className="mb-0.5 font-medium text-neutral-600">组价方案（{r.plan!.filter((l) => !l.suggested).length} 条已计）</div>
                        {r.plan!.map((l, li) => (
                          <div key={li} className="flex items-baseline gap-2 text-neutral-500">
                            <span className="mono">{l.quotaCode}</span>
                            <span className="truncate">{l.quotaName}</span>
                            {l.suggested ? (
                              <span className="rounded bg-amber-100 px-1 py-px text-[9.5px] text-amber-700" title={l.scope}>建议增列</span>
                            ) : l.manual ? (
                              <span className="rounded bg-neutral-200 px-1 py-px text-[9.5px] text-neutral-600">人工指定</span>
                            ) : null}
                            <span className="ml-auto mono">{l.subtotal}</span>
                          </div>
                        ))}
                        <div className="text-[10.5px] text-neutral-400">
                          建议增列的子目不计入测算价，确认后用「为该项增列定额」写入组价方案
                        </div>
                      </div>
                    )}
                  </div>
                </td>
              </tr>
            )}
            </Fragment>
            );
          })}
        </tbody>
      </table>
      </div>
      {!view.rows.length && (
        <div className="flex h-40 items-center justify-center text-xs text-neutral-400">
          没有可测算的清单项
        </div>
      )}
    </div>
  );
}

/* ---------------- 费用汇总表（取费） ---------------- */

export function FeeSummaryView({ view }: { view: Extract<WorkspaceView, { kind: "feeSummary" }> }) {
  const [details, setDetails] = useState(false);
  return (
    <div className="h-full overflow-auto p-4">
      {view.unpricedCount > 0 && (
        <div
          className="mb-3 rounded-lg px-3 py-2 text-[12px]"
          style={{ background: "var(--warning-soft-bg)", color: "var(--warning-soft-fg)" }}
        >
          还有 {view.unpricedCount} 项未报价，以下总价尚不完整。请先在清单页点击“自动测算”。
        </div>
      )}
      <details className="cost-simple-more mb-3"><summary>更多信息</summary><div className="cost-more-body"><label><input type="checkbox" checked={details} onChange={e => setDetails(e.target.checked)} />显示计算基础和费率</label></div></details>
      <div className="xl-sheet overflow-hidden rounded-lg">
        <table className="xl-table">
          <thead>
            <tr>
              <th className="w-16 text-center">序号</th>
              <th>费用名称</th>
              {details && <><th>计算基础</th><th className="w-20 text-right">费率</th></>}
              <th className="w-32 text-right">金额（元）</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r) => (
              <tr
                key={r.seq}
                style={
                  r.level === "total"
                    ? { background: "color-mix(in srgb, var(--brand-accent) 8%, var(--surface))" }
                    : r.level === "subtotal"
                      ? { background: "var(--sidebar)" }
                      : undefined
                }
              >
                <td className="text-center text-neutral-500">{r.seq}</td>
                <td className={cn(r.level !== "leaf" && "font-medium")}>{r.name}</td>
                {details && <><td className="text-neutral-500">{r.basis}</td><td className="mono text-right">{r.rate ?? "—"}</td></>}
                <td className={cn("mono text-right", r.level === "total" && "text-[13px] font-semibold", r.level === "subtotal" && "font-medium")}>
                  {fmtMoney(r.amount)}
                </td>
                <td className="text-[11.5px] text-neutral-400">{r.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-baseline justify-end gap-2 text-[12px] text-neutral-500">
        含税工程造价
        <span className="mono text-xl font-semibold" style={{ color: "var(--ink-1)" }}>
          {fmtMoney(view.grandTotal)}
        </span>
        元
      </div>
    </div>
  );
}

/* ---------------- 措施费计取（官方系数） ---------------- */

export function MeasureFeeView({ view }: { view: Extract<WorkspaceView, { kind: "measureFee" }> }) {
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-3 text-[12px] text-neutral-500">
        基数为定额测算的分册定额人工费；费率档按檐口/操作物高度自动选档。计取结果已写入台账「系数措施费」，费用汇总表自动采用。
      </div>
      <div className="xl-sheet overflow-hidden rounded-lg">
        <table className="xl-table">
          <thead>
            <tr>
              <th>费用项目</th>
              <th className="w-12 text-center">分册</th>
              <th>档位</th>
              <th>计算基数</th>
              <th className="w-16 text-right">费率</th>
              <th className="w-28 text-right">金额（元）</th>
              <th className="w-40 text-right">其中：人工/材料/机械</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r, i) => (
              <tr key={i}>
                <td>{r.name}</td>
                <td className="text-center">
                  <span className="rounded bg-neutral-100 px-1 text-[11px] text-neutral-600">{r.book}</span>
                </td>
                <td className="text-[11.5px] text-neutral-500">{r.tier}</td>
                <td className="text-[11.5px] text-neutral-500">{r.basis}</td>
                <td className="mono text-right">{r.rate}</td>
                <td className="mono text-right font-medium">{fmtMoney(r.amount)}</td>
                <td className="mono text-right text-[11px] text-neutral-400">
                  {[r.laborPart, r.materialPart, r.machinePart].map((p) => (p ? fmtMoney(p) : "—")).join(" / ")}
                </td>
              </tr>
            ))}
            <tr style={{ background: "color-mix(in srgb, var(--brand-accent) 8%, var(--surface))" }}>
              <td className="font-medium">合计</td>
              <td colSpan={4} />
              <td className="mono text-right font-semibold">{fmtMoney(view.total)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      {view.skipped.length > 0 && (
        <div className="mt-3 rounded-lg px-3 py-2 text-[11.5px]" style={{ background: "var(--warning-soft-bg)", color: "var(--warning-soft-fg)" }}>
          未计取：{view.skipped.slice(0, 8).map((s) => `${s.name}（${s.reason}）`).join("；")}
          {view.skipped.length > 8 ? ` 等 ${view.skipped.length} 项` : ""}
        </div>
      )}
    </div>
  );
}

/* ---------------- 清单对审 ---------------- */

const CMP_LABEL: Record<string, string> = {
  SAME: "一致", PRICE_DIFF: "价差", QTY_DIFF: "量差",
  BOTH_DIFF: "量价均差", ONLY_A: "仅A有", ONLY_B: "仅B有",
};
const CMP_STYLE: Record<string, string> = {
  SAME: "text-neutral-400", PRICE_DIFF: "text-amber-700 bg-amber-50",
  QTY_DIFF: "text-blue-700 bg-blue-50", BOTH_DIFF: "text-red-600 bg-red-50",
  ONLY_A: "text-neutral-600 bg-neutral-100", ONLY_B: "text-green-700 bg-green-50",
};

export function FileCompareView({ view }: { view: Extract<WorkspaceView, { kind: "fileCompare" }> }) {
  const [filter, setFilter] = useState<string>("DIFF");
  const rows = view.rows.filter((r) =>
    filter === "ALL" ? true
    : filter === "DIFF" ? r.status !== "SAME"
    : r.status === filter
  );
  const s = view.summary;
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-[var(--surface)] px-4 py-2 text-[12px]">
        <span className="text-neutral-500">
          差额合计 <b className="mono text-neutral-800">{fmtMoney(s.totalDelta)}</b> 元
        </span>
        {(s as { qtyOver15?: number }).qtyOver15 ? (
          <span
            className="rounded px-1.5 py-0.5 text-[11px]"
            style={{ background: "var(--danger-soft-bg)", color: "var(--danger-soft-fg)" }}
            title="GB50500：工程量偏差超15%应重新组价/调整综合单价"
          >
            {(s as { qtyOver15?: number }).qtyOver15} 项量差&gt;15% 应调价
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-1">
          {[
            ["DIFF", `差异 ${s.total - s.same}`],
            ["ONLY_A", `仅A ${s.onlyA}`],
            ["ONLY_B", `仅B ${s.onlyB}`],
            ["SAME", `一致 ${s.same}`],
            ["ALL", `全部 ${s.total}`],
          ].map(([k, l]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              aria-pressed={filter === k}
              className={cn(
                "rounded px-2 py-1 text-[11.5px]",
                filter === k ? "bg-neutral-900 text-white" : "text-neutral-500 hover:bg-neutral-100"
              )}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <p className="px-4 py-2 text-xs text-neutral-500 break-words">A：{view.labelA} · B：{view.labelB}</p>
      <div className="flex-1 overflow-auto">
        <table className="xl-table text-[12px]">
          <thead>
            <tr>
              <th className="xl-rn"></th>
              <th className="w-24">编码</th>
              <th>名称</th>
              <th className="w-16">状态</th>
              <th className="w-16 text-right" title={view.labelA}>A量</th>
              <th className="w-16 text-right" title={view.labelB}>B量</th>
              <th className="w-20 text-right">A单价</th>
              <th className="w-20 text-right">B单价</th>
              <th className="w-24 text-right">差额</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={r.key}>
                <td className="xl-rn">{ri + 1}</td>
                <td className="mono text-neutral-500">{r.code || "—"}</td>
                <td className="max-w-44 truncate" title={r.name}>{r.name}</td>
                <td>
                  <span className={cn("rounded px-1.5 py-0.5 text-[10.5px]", CMP_STYLE[r.status])}>
                    {CMP_LABEL[r.status]}
                  </span>
                  {r.qtyOver15 && (
                    <span
                      className="ml-1 rounded px-1 py-px text-[9.5px] font-medium"
                      style={{ background: "var(--danger-soft-bg)", color: "var(--danger-soft-fg)" }}
                      title="量差超15%，应重新组价"
                    >
                      &gt;15%
                    </span>
                  )}
                </td>
                <td className="mono text-right">{r.aQty ?? "—"}</td>
                <td className={cn("mono text-right", r.qtyDelta && "font-medium text-blue-700")}>{r.bQty ?? "—"}</td>
                <td className="mono text-right">{r.aPrice ?? "—"}</td>
                <td className={cn("mono text-right", r.priceDelta && "font-medium text-amber-700")}>{r.bPrice ?? "—"}</td>
                <td className={cn("mono text-right", Number(r.totalDelta) !== 0 && "font-medium")}>
                  {r.totalDelta ? fmtMoney(r.totalDelta) : "—"}
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={9} className="py-8 text-center text-neutral-500">{filter === "DIFF" ? "两版清单没有差异" : "该类别没有清单项"}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- PDF 文档 ---------------- */

export function DocumentView({ view }: { view: Extract<WorkspaceView, { kind: "document" }> }) {
  return (
    <div className="h-full space-y-4 overflow-auto p-6">
      {view.pages.map((p, i) => (
        <div key={i} className="rounded-xl border border-neutral-200 bg-[var(--surface)] p-5 shadow-sm">
          <div className="mb-2 text-[10.5px] text-neutral-300">第 {i + 1} 页</div>
          <pre className="whitespace-pre-wrap font-sans text-[12px] leading-relaxed text-neutral-700">{p}</pre>
        </div>
      ))}
      {!view.pages.length && (
        <div className="flex h-40 items-center justify-center text-xs text-neutral-400">无文本内容</div>
      )}
    </div>
  );
}

/* ---------------- 定额说明条文 ---------------- */

export function SpecResultView({ view }: { view: Extract<WorkspaceView, { kind: "specResult" }> }) {
  return (
    <div className="h-full space-y-4 overflow-auto p-6">
      <div className="text-[11px] text-neutral-400">
        检索词「{view.query}」· {view.hits.length} 条相关条文 · 来源：《四川省2020建设工程工程量清单计价定额》说明及计算规则
      </div>
      {!view.hits.length && <EmptyState title="没有找到相关条文" hint="换用材料名称、施工工艺或定额编号，再检索一次。" />}
      {view.hits.map((h, i) => (
        <div key={i} className="rounded-xl border border-neutral-200 bg-[var(--surface)] shadow-sm">
          <div className="flex items-center gap-2 border-b border-neutral-100 px-5 py-3">
            <span className="rounded bg-[var(--accent)]/10 px-2 py-0.5 text-[10.5px] font-medium text-[var(--accent)]">
              {h.book}
            </span>
            <span className="text-[13px] font-semibold text-neutral-800">{h.title}</span>
          </div>
          <pre className="whitespace-pre-wrap px-5 py-4 font-sans text-[12px] leading-relaxed text-neutral-700">
            {h.excerpt}
          </pre>
        </div>
      ))}
    </div>
  );
}

/* ---------------- 事实台账 ---------------- */

export function FactList() {
  const { facts } = useStore();
  return (
    <div className="h-full overflow-auto p-4">
      <div className="xl-sheet overflow-hidden rounded-lg">
      <table className="xl-table">
        <thead>
          <tr>
            <th className="xl-rn"></th>
            <th className="w-32">类型</th>
            <th>键</th>
            <th>值</th>
            <th className="w-24">来源</th>
          </tr>
        </thead>
        <tbody>
          {facts.map((f, fi) => (
            <tr key={f.id}>
              <td className="xl-rn">{fi + 1}</td>
              <td className="text-neutral-500">{f.factType}</td>
              <td>{f.key}</td>
              <td className="max-w-80 truncate" title={f.value}>{f.value}</td>
              <td>
                <span className={cn("rounded px-1.5 py-0.5 text-[11px]", f.source === "INFERRED" ? "bg-amber-50 text-amber-700" : "bg-neutral-100 text-neutral-500")}>
                  {SOURCE_LABEL[f.source] ?? f.source}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {!facts.length && (
        <div className="flex h-40 items-center justify-center text-xs text-neutral-400">
          暂无项目事实
        </div>
      )}
    </div>
  );
}

/* ---------------- 导出结果 / 文件列表 ---------------- */

export function ExportResult({ view }: { view: Extract<WorkspaceView, { kind: "exportResult" }> }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-80 rounded-xl border border-neutral-200 bg-[var(--surface)] p-5 break-words">
        <FileSpreadsheet size={20} className="text-neutral-400" />
        <div className="mt-3 text-[13px] font-medium">{view.filename}</div>
        <div className="mt-1 text-xs text-neutral-500">{view.summary}</div>
        <a
          href={`/api/artifacts/${view.artifactId}/download`}
          download={view.filename}
          aria-label={`下载${view.filename}`}
          className="cost-btn primary mt-4 w-full"
        >
          <Download size={13} /> 下载
        </a>
      </div>
    </div>
  );
}

const FILE_STATUS: Record<string, { label: string; cls: string }> = {
  UPLOADED: { label: "待解析", cls: "bg-neutral-100 text-neutral-500" },
  PARSED: { label: "已解析", cls: "bg-[var(--success-soft-bg)] text-[var(--success-soft-fg)]" },
  FAILED: { label: "解析失败", cls: "bg-[var(--danger-soft-bg)] text-[var(--danger-soft-fg)]" },
  PARSING: { label: "解析中", cls: "bg-[var(--warning-soft-bg)] text-[var(--warning-soft-fg)]" },
};

export function FileList() {
  const { files, views, blocks, closedViewIds, setActiveView, init, projectId, running, agentRunning, importRunning, saving } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingDel, setPendingDel] = useState<{ id: string; name: string } | null>(null);
  const lock = useRef(false);
  const blocked = !!busy || running || agentRunning || importRunning || saving;
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
  return (
    <div className="h-full overflow-auto p-4">
      <p className="cost-file-hint">上传后系统会整理文件；需要你检查的表格会显示“待核对”。</p>
      <div className="xl-sheet overflow-auto rounded-lg">
        <table className="xl-table">
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
                    <FileSpreadsheet size={13} className="shrink-0 text-neutral-400" />
                    <span className="max-w-96 truncate" title={f.filename}>{f.filename}</span>
                  </div>
                </td>
                <td>
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500">{f.kindLabel}</span>
                </td>
                <td>
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[11px]",
                      awaiting ? FILE_STATUS.PARSING.cls : FILE_STATUS[f.status]?.cls ?? "bg-neutral-100 text-neutral-500"
                    )}
                  >
                    {awaiting ? "待核对" : FILE_STATUS[f.status]?.label ?? f.status}
                  </span>
                </td>
                <td className="text-center">
                  {(view || closedId) && <button className="cost-file-action" onClick={() => void openFile(view?.id ?? closedId!)}>{view?.kind === "columnMapping" || closedId?.startsWith("view:mapping:") ? "核对表格" : "查看文档"}</button>}
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
