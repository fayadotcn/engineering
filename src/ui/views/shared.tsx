"use client";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Funnel } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn as cx } from "@/lib/utils";

export const cn = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(" ");

export const fmtMoney = (v: string | number) => {
  const n = Number(v);
  if (isNaN(n)) return String(v);
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const FIELD_LABEL: Record<string, string> = {
  unitPrice: "综合单价",
  mainMaterialPrice: "主材暂估价",
  laborUnitPrice: "人工单价",
  machineUnitPrice: "机械单价",
  quantity: "工程量",
  totalPrice: "合价",
  name: "项目名称",
  rawFeature: "项目特征",
};

export const SOURCE_LABEL: Record<string, string> = {
  USER_PROVIDED: "用户提供",
  FILE_EXTRACTED: "文件提取",
  CONTRACT_DEFINED: "合同定义",
  HISTORICAL: "历史",
  INFERRED: "推断",
  MARKET_REFERENCE: "市场参考",
};

/* ---------------- 提示：原生 title → Radix Tooltip ----------------
   原生 title 只能鼠标悬停、样式不可控、长文本还会被系统截断；说明性提示统一走 Tooltip
   （Provider 挂在 src/app/layout.tsx）。两种形态：
   · <Tip>   包一层可截断 span 作 trigger —— 表格单元格里的长文本；
   · <TipEl> 直接把传入元素当 trigger —— Badge / Button / tr，不给 DOM 加壳；
             被禁用的按钮不吃指针事件，传 focusable 包一层可聚焦 span（Radix 官方范式），
             顺带让键盘 Tab 也能读到提示（原生 title 做不到）。
   纯装饰性的提示已直接删除，不再保留 title。 */

type TipSide = "top" | "right" | "bottom" | "left";
const noTip = (tip: ReactNode) => tip === undefined || tip === null || tip === false || tip === "";

export function Tip({
  tip,
  children,
  className,
  side = "top",
}: {
  tip?: ReactNode;
  children: ReactNode;
  className?: string;
  side?: TipSide;
}) {
  if (noTip(tip)) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cx("inline-block max-w-full truncate", className)}>{children}</span>
      </TooltipTrigger>
      <TooltipContent side={side}>{tip}</TooltipContent>
    </Tooltip>
  );
}

export function TipEl({
  tip,
  children,
  side = "top",
  focusable,
}: {
  tip?: ReactNode;
  children: ReactElement;
  side?: TipSide;
  focusable?: boolean;
}) {
  if (noTip(tip)) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {focusable ? (
          <span tabIndex={0} className="inline-flex">
            {children}
          </span>
        ) : (
          children
        )}
      </TooltipTrigger>
      <TooltipContent side={side}>{tip}</TooltipContent>
    </Tooltip>
  );
}

/* ---------------- Excel 列头：排序 + 筛选下拉 ---------------- */

export type SortDir = "asc" | "desc";

export function ExcelHead({
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
          <TipEl tip="排序与筛选">
            <button
              ref={btnRef}
              onClick={toggle}
              className={cn(
                "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                filtered || sortDir
                  ? "border-transparent bg-[var(--secondary)] text-[var(--foreground)]"
                  : "border-input/70 text-muted-foreground hover:border-input hover:bg-[var(--accent)] hover:text-foreground",
                open && "border-[var(--foreground)] bg-[var(--secondary)] text-[var(--foreground)]"
              )}
              aria-label={`${label}排序与筛选`}
              aria-expanded={open}
            >
              <Icon size={11} strokeWidth={2.2} />
            </button>
          </TipEl>
        )}
      </div>
      {open && pos && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            data-excel-menu
            aria-label={`${label}筛选与排序`}
            className="menu-in fixed z-40 w-52 overflow-auto rounded-[12px] border border-border bg-[var(--card)] p-1 text-left font-normal shadow-[var(--shadow-md)]"
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
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-[var(--accent)]",
                      sortDir === d && "font-medium text-[var(--foreground)]"
                    )}
                  >
                    <Icon size={12} /> {l}
                    {sortDir === d && <span className="ml-auto text-2xs">✓</span>}
                  </button>
                ))}
                <Separator className="my-1 bg-muted" />
              </>
            )}
            {onText && (
              <div className="px-1.5 py-1">
                <Input
                  aria-label={`筛选${label}`}
                  autoFocus={!options}
                  value={text ?? ""}
                  onChange={(e) => onText(e.target.value)}
                  placeholder="包含文本…"
                />
              </div>
            )}
            {options && (
              <>
                {/* 勾选行整行（含文字）都是 Label 的点击范围，与原先 label 包 input 一致；
                    Radix Checkbox 是 button，Label 的标签关联照旧把点击转发过去。 */}
                <Label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-[var(--accent)]">
                  <Checkbox
                    checked={!selected || selected.size === options.length}
                    onCheckedChange={() => onAll?.()}
                  />
                  <span className="text-muted-foreground">（全选）</span>
                </Label>
                <div className="max-h-48 overflow-auto">
                  {options.map((o) => (
                    <Label
                      key={o.v}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-[var(--accent)]"
                    >
                      <Checkbox
                        checked={!selected || selected.has(o.v)}
                        onCheckedChange={() => onToggle?.(o.v)}
                      />
                      <span className="min-w-0 flex-1 truncate">{o.v || "（空白）"}</span>
                      <span className="text-2xs text-muted-foreground">{o.n}</span>
                    </Label>
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

/**
 * 显示用特征文本：真实造价 Excel 常把整行写成「1、名称：X\n2、型号规格：Y…」，
 * 直接展示会重复主名且带编号噪声。剥离编号、名称段只保留主名之外的余量（如箱号），
 * 其余字段保留「字段：值」。无编号/冒号格式的原文原样返回。
 */
/** 搜索词命中高亮：查找框过滤后仍要让用户一眼看到命中在哪（Excel 查找同款） */
export function Hl({ text, q }: { text: string; q: string }) {
  if (!q || !text.includes(q)) return <>{text}</>;
  const parts: (string | ReactElement)[] = [];
  let rest = text, k = 0;
  for (;;) {
    const idx = rest.indexOf(q);
    if (idx < 0) { parts.push(rest); break; }
    if (idx > 0) parts.push(rest.slice(0, idx));
    parts.push(<mark key={k++} className="xl-hit">{q}</mark>);
    rest = rest.slice(idx + q.length);
  }
  return <>{parts}</>;
}

export function displayFeature(raw: string, name: string): string {
  if (!raw || (!/\d+\s*[、.．]/.test(raw) && !/[：:]/.test(raw))) return raw;
  const segs = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const seg0 of segs) {
    const seg = seg0.replace(/^\d+\s*[、.．]\s*/, "");
    if (!seg) continue;
    const m = seg.match(/^([^：:]{1,10}?)[：:]\s*(.+)$/);
    if (!m) { if (seg !== name) out.push(seg); continue; }
    const label = m[1].trim();
    const value = m[2].trim();
    if (/^(项目)?名称$/.test(label)) {
      if (value === name) continue;
      out.push(value.startsWith(name) ? value.slice(name.length).trim() || value : value);
      continue;
    }
    out.push(`${label}：${value}`);
  }
  return out.length ? out.join(" · ") : raw;
}

// 暖纸系 muted 调色板：深松绿为主，递推到浅灰绿，语义色只点缀。
// 走 CSS 变量，深色主题下由 globals.css 整体提亮。
export const PALETTE = [
  "var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)",
  "var(--chart-6)", "var(--chart-7)", "var(--chart-8)", "var(--chart-9)", "var(--chart-10)",
];
