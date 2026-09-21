"use client";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "./store";
import type {
  AnomalyRow,
  BreakdownSlice,
  DiffRow,
  FileCompareRow,
  QuotaResultRow,
  QuotationMatchRow,
  WorkspaceView,
} from "@shared/types";
import { DISCIPLINE_LABEL } from "@shared/types";
import { ArrowDown, ArrowUp, ChevronDown, Download, FileSpreadsheet, AlertTriangle, Funnel, X } from "lucide-react";

const cn = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(" ");

const fmtMoney = (v: string | number) => {
  const n = Number(v);
  if (isNaN(n)) return String(v);
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const FIELD_LABEL: Record<string, string> = {
  unitPrice: "综合单价",
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
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
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
          >
            <Icon size={11} strokeWidth={2.2} />
          </button>
        )}
      </div>
      {open && pos && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            className="fixed z-40 w-52 overflow-auto rounded-lg border border-neutral-200 bg-[var(--surface)] p-1 text-left font-normal shadow-[var(--shadow-menu)]"
            style={{ left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: 320 }}
            onClick={(e) => e.stopPropagation()}
          >
            {onSort && (
              <>
                {([["asc", "升序", ArrowUp], ["desc", "降序", ArrowDown]] as const).map(([d, l, Icon]) => (
                  <button
                    key={d}
                    onClick={() => { onSort(sortDir === d ? null : d); setOpen(false); }}
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
                    className="accent-[#465d50]"
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
                        className="accent-[#465d50]"
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

/* ---------------- 清单表 ---------------- */

type BoqSortKey = "code" | "name" | "quantity" | "unitPrice" | "totalPrice";

export function BoqTable() {
  const { items, patchItem } = useStore();
  const [editing, setEditing] = useState<{ id: string; field: "unitPrice" | "quantity" } | null>(null);
  const [draft, setDraft] = useState("");
  const [limit, setLimit] = useState(300);
  const [query, setQuery] = useState("");
  const [colText, setColText] = useState({ code: "", name: "", feature: "" });
  const [unitSel, setUnitSel] = useState<Set<string> | null>(null); // null = 全选
  const [sort, setSort] = useState<{ key: BoqSortKey; dir: SortDir } | null>(null);

  const commit = async () => {
    if (!editing) return;
    await patchItem(editing.id, { [editing.field]: draft });
    setEditing(null);
  };

  const units = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((i) => {
      if (!i.isHeader) m.set(i.unit, (m.get(i.unit) ?? 0) + 1);
    });
    return [...m.entries()].map(([v, n]) => ({ v, n })).sort((a, b) => b.n - a.n);
  }, [items]);

  const filtering = Boolean(
    query.trim() || colText.code || colText.name || colText.feature || unitSel || sort
  );

  const filtered = items.filter((i) => {
    if (i.isHeader) return !filtering;
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
  const dataTotal = items.reduce((n, i) => n + (i.isHeader ? 0 : 1), 0);
  const dataShown = sorted.reduce((n, i) => n + (i.isHeader ? 0 : 1), 0);

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
    setQuery("");
    setColText({ code: "", name: "", feature: "" });
    setUnitSel(null);
    setSort(null);
    setLimit(300);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-200 bg-[var(--sidebar)] px-3 py-1.5">
        <Funnel size={12} className="shrink-0 text-neutral-400" />
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setLimit(300); }}
          placeholder="搜索名称 / 编码 / 特征…"
          className="h-7 w-56 rounded-md border border-neutral-200 bg-[var(--surface)] px-2.5 text-[12px] outline-none focus:border-[var(--brand-accent)]"
        />
        {filtering && (
          <button
            onClick={clearAll}
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
      <div className="flex-1 overflow-auto">
      <table className="xl-table">
        <thead>
          <tr>
            <th className="xl-rn"></th>
            <th className="group/th relative w-28">
              <ExcelHead label="项目编码" sortDir={sort?.key === "code" ? sort.dir : null} onSort={(d) => setSort(d ? { key: "code", dir: d } : null)} text={colText.code} onText={setText("code")} />
            </th>
            <th className="group/th relative">
              <ExcelHead label="项目名称" sortDir={sort?.key === "name" ? sort.dir : null} onSort={(d) => setSort(d ? { key: "name", dir: d } : null)} text={colText.name} onText={setText("name")} />
            </th>
            <th className="group/th relative">
              <ExcelHead label="项目特征" text={colText.feature} onText={setText("feature")} />
            </th>
            <th className="group/th relative w-12">
              <ExcelHead
                label="单位"
                options={units}
                selected={unitSel ?? undefined}
                onToggle={toggleUnit}
                onAll={() => { setUnitSel(null); setLimit(300); }}
              />
            </th>
            <th className="group/th relative w-20 text-right">
              <ExcelHead numeric label="工程量" sortDir={sort?.key === "quantity" ? sort.dir : null} onSort={(d) => setSort(d ? { key: "quantity", dir: d } : null)} />
            </th>
            <th className="group/th relative w-24 text-right">
              <ExcelHead numeric label="综合单价" sortDir={sort?.key === "unitPrice" ? sort.dir : null} onSort={(d) => setSort(d ? { key: "unitPrice", dir: d } : null)} />
            </th>
            <th className="group/th relative w-28 text-right">
              <ExcelHead numeric label="合价" sortDir={sort?.key === "totalPrice" ? sort.dir : null} onSort={(d) => setSort(d ? { key: "totalPrice", dir: d } : null)} />
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((it, i) =>
            it.isHeader ? (
              <tr key={it.id} className="xl-group">
                <td className="xl-rn">{i + 1}</td>
                <td colSpan={7} className="text-[12px]">
                  {it.name}
                </td>
              </tr>
            ) : (
              <tr key={it.id}>
                <td className="xl-rn">{i + 1}</td>
                <td className="mono text-neutral-500">{it.code}</td>
                <td className="max-w-72 truncate" title={it.name}>{it.name}</td>
                <td className="max-w-56 truncate text-neutral-500" title={it.rawFeature}>
                  {it.rawFeature}
                </td>
                <td className="text-neutral-500">{it.unit}</td>
                {(["quantity", "unitPrice"] as const).map((f) => (
                  <td
                    key={f}
                    className={cn(
                      "xl-edit mono text-right",
                      editing?.id === it.id && editing.field === f && "xl-active"
                    )}
                    title="双击编辑"
                    onDoubleClick={() => {
                      setEditing({ id: it.id, field: f });
                      setDraft(it[f]);
                    }}
                  >
                    {editing?.id === it.id && editing.field === f ? (
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={commit}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commit();
                          if (e.key === "Escape") setEditing(null);
                        }}
                        className="w-20 border-0 bg-transparent px-0 py-0 text-right text-[12.5px] outline-none"
                      />
                    ) : (
                      it[f]
                    )}
                  </td>
                ))}
                <td className="mono text-right">{fmtMoney(it.totalPrice)}</td>
              </tr>
            )
          )}
        </tbody>
      </table>
      {sorted.length > shown.length && (
        <button
          onClick={() => setLimit((l) => l + 500)}
          className="mx-auto my-3 block rounded border border-neutral-200 bg-[var(--surface)] px-4 py-1.5 text-[11.5px] text-neutral-500 hover:border-neutral-300"
        >
          加载更多（还有 {sorted.length - shown.length} 行）
        </button>
      )}
      {!items.length && (
        <div className="flex h-40 items-center justify-center text-xs text-neutral-400">
          清单为空 — 在左侧上传 Excel 清单文件
        </div>
      )}
      </div>
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
                    <td colSpan={6}>
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
                      <tr key={it.id}>
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
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {!view.rows.length && (
        <div className="flex h-40 items-center justify-center text-xs text-neutral-400">
          未发现异常 ✓
        </div>
      )}
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
  return (
    <div className="h-full overflow-auto p-4">
      <div className="xl-sheet overflow-hidden rounded-lg">
      <table className="xl-table">
        <thead>
          <tr>
            <th className="xl-rn"></th>
            <th>询价材料</th>
            <th>规格</th>
            <th>品牌</th>
            <th className="text-right">询价</th>
            <th>匹配清单项</th>
            <th className="w-20">置信度</th>
            <th className="w-20">状态</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((r: QuotationMatchRow, ri) => (
            <tr key={r.quotationItemId}>
              <td className="xl-rn">{ri + 1}</td>
              <td className="max-w-48 truncate" title={r.materialName}>{r.materialName}</td>
              <td className="mono text-neutral-500">{r.spec || "—"}</td>
              <td className="text-neutral-500">{r.brand || "—"}</td>
              <td className="mono text-right">{fmtMoney(r.price)}</td>
              <td className="max-w-64 truncate text-neutral-600">
                {r.matchedNames.join("、") || "—"}
              </td>
              <td>
                <div className="h-1 w-16 rounded bg-neutral-100">
                  <div
                    className={cn("h-1 rounded", r.confidence >= 60 ? "bg-green-500" : r.confidence >= 30 ? "bg-amber-400" : "bg-neutral-300")}
                    style={{ width: `${Math.min(r.confidence, 100)}%` }}
                  />
                </div>
              </td>
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
    </div>
  );
}

/* ---------------- 占比图 ---------------- */

const PALETTE = ["#171717", "#525252", "#a3a3a3", "#2563eb", "#60a5fa", "#93c5fd", "#d4d4d4", "#b45309", "#f59e0b", "#dc2626"];

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
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-3 text-[11.5px] text-neutral-400">
        综合单价 = 人工+辅材+机械 + 主材价×耗量 + (人工+机械)×(管理费{(view.mgmtRate * 100).toFixed(0)}%+利润{(view.profitRate * 100).toFixed(0)}%)
        <span className="ml-2">· 内置参考定额，接入正式定额库后自动替换</span>
      </div>
      <div className="xl-sheet overflow-hidden rounded-lg">
      <table className="xl-table">
        <thead>
          <tr>
            <th className="xl-rn"></th>
            <th>清单项</th>
            <th>定额子目</th>
            <th className="text-right">人工</th>
            <th className="text-right">辅材</th>
            <th className="text-right">机械</th>
            <th className="text-right">主材</th>
            <th className="text-right">管+利</th>
            <th className="text-right">测算价</th>
            <th className="text-right">清单价</th>
            <th className="text-right">偏差</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((r, ri) => (
            <tr key={r.itemId}>
              <td className="xl-rn">{ri + 1}</td>
              <td className="max-w-40 truncate" title={r.name}>{r.name}</td>
              <td className="text-neutral-500">
                {r.quotaCode ? <span className="mono text-[11px]">{r.quotaCode}</span> : "—"}
              </td>
              <td className="mono text-right">{r.labor ?? "—"}</td>
              <td className="mono text-right">{r.materialAux ?? "—"}</td>
              <td className="mono text-right">{r.machine ?? "—"}</td>
              <td className="mono text-right">
                {r.needsMainPrice ? <span className="text-amber-600">缺主材价</span> : r.mainMaterial ?? "—"}
              </td>
              <td className="mono text-right">{r.fee ?? "—"}</td>
              <td className="mono text-right font-medium">{r.calcPrice ?? "—"}</td>
              <td className="mono text-right text-neutral-500">{fmtMoney(r.listPrice)}</td>
              <td className={cn(
                "mono text-right",
                r.deviation !== null && Math.abs(Number(r.deviation)) > 20 && "font-medium text-red-600"
              )}>
                {r.deviation !== null ? `${Number(r.deviation) > 0 ? "+" : ""}${r.deviation}%` : "—"}
              </td>
            </tr>
          ))}
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
      <div className="flex items-center gap-2 border-b border-neutral-200 bg-[var(--surface)] px-4 py-2 text-[12px]">
        <span className="text-neutral-500">
          差额合计 <b className="mono text-neutral-800">{fmtMoney(s.totalDelta)}</b> 元
        </span>
        <div className="ml-auto flex gap-1">
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
      <div className="w-80 rounded-xl border border-neutral-200 bg-[var(--surface)] p-5">
        <FileSpreadsheet size={20} className="text-neutral-400" />
        <div className="mt-3 text-[13px] font-medium">{view.filename}</div>
        <div className="mt-1 text-xs text-neutral-500">{view.summary}</div>
        <a
          href={`/api/artifacts/${view.artifactId}/download`}
          className="mt-4 flex h-8 items-center justify-center gap-1.5 rounded-md bg-neutral-900 text-xs text-white hover:bg-neutral-700"
        >
          <Download size={13} /> 下载
        </a>
      </div>
    </div>
  );
}

export function FileList() {
  const { files, refreshMeta, reloadBoq } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const remove = async (id: string, name: string) => {
    if (!confirm(`删除「${name}」及其导入的全部数据？`)) return;
    setBusy(id);
    await fetch(`/api/files/${id}`, { method: "DELETE" });
    await Promise.all([refreshMeta(), reloadBoq()]);
    setBusy(null);
  };
  return (
    <div className="h-full overflow-auto p-4">
      <div className="xl-sheet overflow-hidden rounded-lg">
        <table className="xl-table">
          <thead>
            <tr>
              <th className="xl-rn"></th>
              <th>文件名</th>
              <th className="w-28">类型</th>
              <th className="w-24">状态</th>
              <th className="w-16"></th>
            </tr>
          </thead>
          <tbody>
            {files.map((f, fi) => (
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
                <td className="text-[11.5px] text-neutral-500">{f.status}</td>
                <td className="text-center">
                  <button
                    onClick={() => remove(f.id, f.filename)}
                    disabled={busy === f.id}
                    className="invisible rounded px-1.5 py-0.5 text-[11px] text-red-500 hover:bg-red-50 group-hover:visible disabled:opacity-40"
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!files.length && (
        <div className="flex h-40 items-center justify-center text-xs text-neutral-400">还没有文件</div>
      )}
    </div>
  );
}
