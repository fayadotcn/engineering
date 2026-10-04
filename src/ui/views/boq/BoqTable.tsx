"use client";
import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { useStore } from "../../store";
import type { BoqItemDTO, WorkspaceView } from "@shared/types";
import { DISCIPLINE_LABEL, isPricableItem, type Discipline } from "@shared/types";
import { ChevronDown, Download, FileSpreadsheet, Funnel, Plus, X } from "lucide-react";
import { ConfirmDialog, EmptyState, toast } from "../../primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { projectTotals } from "@cost-engine/aggregate";
import { evalExpr } from "@cost-engine/calcExpr";
import { cn, fmtMoney, FIELD_LABEL, type SortDir, ExcelHead, Hl, displayFeature } from "../shared";
import { PriceComposition } from "./PriceComposition";
import { MANUAL_GROUP_ID, MANUAL_GROUP_ROW, ADJ_FIELD, type BoqSortKey, type BoqEditField } from "./constants";
import { copyRowsToExcel } from "./clipboard";
import { BoqStatusBar } from "./BoqStatusBar";
import { RowContextMenu } from "./RowContextMenu";
import { AddRowDialog } from "./AddRowDialog";
import { BatchAdjustDialog } from "./BatchAdjustDialog";
import { PastePreviewDialog } from "./PastePreviewDialog";

/* ---------------- 清单表 ---------------- */

export function BoqTable({ view }: { view?: Extract<WorkspaceView, { kind: "boqTable" }> }) {
  const { items, patchItem, deleteItem, deleteItems, adjustItems, pasteItems, revertReceipt, createItem, boqQuery, boqOnlyUnpriced, setBoqQuery, running, agentRunning, importRunning, saving, files, projectId, receipts = [], flashIds = [], flashSeq } = useStore();
  const query = boqQuery;
  const [discipline, setDiscipline] = useState<string>(view?.filter?.discipline ?? "");
  const [onlyItems, setOnlyItems] = useState(!!view?.filter?.onlyItems);
  const previousQuery = useRef(view?.filter?.query);
  useEffect(() => {
    if (view?.filter?.query !== undefined || previousQuery.current !== undefined) setBoqQuery(view?.filter?.query ?? "");
    previousQuery.current = view?.filter?.query;
  }, [view?.filter?.query, setBoqQuery]);
  useEffect(() => { setDiscipline(view?.filter?.discipline ?? ""); setOnlyItems(!!view?.filter?.onlyItems); setLimit(300); }, [view?.filter?.discipline, view?.filter?.onlyItems]);
  // 「只看未定价」是 store 级开关（状态栏按钮同一口径）——会话筛选把 unpriced 写进来两边就同步
  useEffect(() => { if (view?.filter?.unpriced !== undefined) { useStore.setState({ boqOnlyUnpriced: view.filter.unpriced }); setLimit(300); } }, [view?.filter?.unpriced]);
  const [editing, setEditing] = useState<{ id: string; field: BoqEditField } | null>(null);
  const [draft, setDraft] = useState("");
  const [limit, setLimit] = useState(300);
  const [selected, setSelected] = useState<string | null>(null);
  const [colText, setColText] = useState({ code: "", name: "", feature: "" });
  const [unitSel, setUnitSel] = useState<Set<string> | null>(null); // null = 全选
  const [sort, setSort] = useState<{ key: BoqSortKey; dir: SortDir } | null>(null);
  const [details, setDetails] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null); // 展开价格构成的行
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; id: string } | null>(null); // 右键行菜单
  const [selIds, setSelIds] = useState<ReadonlySet<string>>(new Set()); // 多选集合；selected 仍是键盘/闪烁用的锚点行
  const [pendingDelRows, setPendingDelRows] = useState<BoqItemDTO[] | null>(null);
  const [addOpen, setAddOpen] = useState(false); // 手工补录弹窗
  const [adjRows, setAdjRows] = useState<BoqItemDTO[] | null>(null); // 批量调价弹窗的目标行
  const [pastePlan, setPastePlan] = useState<{ it: BoqItemDTO; patch: { quantity?: string; unitPrice?: string; mainMaterialPrice?: string } }[] | null>(null); // Ctrl+V 粘回预览
  const [adjForm, setAdjForm] = useState<{ field: "unitPrice" | "quantity" | "mainMaterialPrice"; mode: "percent" | "value"; value: string }>({ field: "unitPrice", mode: "percent", value: "" });
  const [addForm, setAddForm] = useState({ name: "", code: "", unit: "", quantity: "", unitPrice: "", totalPrice: "", feeType: "分部分项", feature: "", unitProject: "" });
  const committing = useRef(false);
  const editRef = useRef<typeof editing>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // 行级改动痕迹：回执快照里带行 id，把「这行被谁怎么改过」挂到行号槽上（琥珀点 + 悬浮明细）
  const rowAudit = useMemo(() => {
    const map = new Map<string, { time: string; text: string; reverted: boolean }[]>();
    for (const r of receipts) {
      if (!r.affectedIds?.length) continue;
      const time = new Date(r.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
      const text = r.summary.replace(/用户在工作区/, "");
      for (const id of r.affectedIds) {
        const arr = map.get(id) ?? [];
        if (arr.length < 3) arr.push({ time, text, reverted: !!r.reverted });
        map.set(id, arr);
      }
    }
    return map;
  }, [receipts]);
  // 工程量计算式实时预览：非纯数字草稿用 evalExpr 试算，合法则出「= 结果」气泡
  const exprPreview = useMemo(() => {
    if (editing?.field !== "quantity") return null;
    const t = draft.trim();
    if (!t || Number.isFinite(Number(t))) return null;
    try {
      return { ok: true as const, value: Number(evalExpr(t).toFixed(6)) };
    } catch {
      return { ok: false as const, value: null };
    }
  }, [editing, draft]);
  useEffect(() => {
    useStore.setState({ boqDirty: !!editing && draft !== items.find(i => i.id === editing.id)?.[editing.field] });
    return () => { useStore.setState({ boqDirty: false }); };
  }, [editing, draft, items]);
  const cancelEdit = () => { if (committing.current) return; editRef.current = null; setEditing(null); };
  /** 行号槽悬浮说明：来源文件 + 最近改动记录（含是否已撤销） */
  const rnTitle = (it: BoqItemDTO) => {
    const src = (files ?? []).find((f) => f.id === it.fileId)?.filename
      ? `来源：${files!.find((f) => f.id === it.fileId)!.filename} · ${it.sheetName} · 第 ${it.rowIndex + 1} 行`
      : it.sheetName === "手工补录" ? "来源：手工补录" : "";
    const up = it.unitProject ? `单位工程：${it.unitProject}` : "";
    const audit = rowAudit.get(it.id);
    const head = [up, src].filter(Boolean).join("\n");
    if (!audit?.length) return head || undefined;
    const lines = audit.map((a) => `· ${a.time} ${a.text}${a.reverted ? "（已撤销）" : ""}`).join("\n");
    return `${head ? head + "\n" : ""}改动痕迹：\n${lines}`;
  };
  const beginEdit = (item: BoqItemDTO, field: BoqEditField) => {
    if (running || agentRunning || importRunning || saving || committing.current || editRef.current) return;
    editRef.current = { id: item.id, field };
    setEditing({ id: item.id, field });
    // 有计算式的工程量编辑源式而不是结果数，保证式与值始终对应
    setDraft(field === "quantity" && item.quantityExpr ? item.quantityExpr : item[field]);
  };

  const cellsOf = (id: string): { id: string; field: BoqEditField }[] => {
    const it = items.find(i => i.id === id);
    if (!it) return [];
    return isPricableItem(it)
      ? [{ id, field: "quantity" }, { id, field: "unitPrice" }]
      : [{ id, field: "totalPrice" }];
  };

  const commit = async (move?: 1 | -1 | "down" | "up") => {
    if (!editing || !editRef.current || committing.current) return;
    const v = draft.trim();
    // 工程量格允许直接输计算式（3层×12个+15）；其余格只收数字
    let num = v;
    let expr: string | undefined;
    if (!Number.isFinite(Number(v))) {
      if (editing.field === "quantity" && v) {
        try {
          num = String(evalExpr(v));
          expr = v;
        } catch (e) {
          toast.error(`计算式无效：${e instanceof Error ? e.message : e}`);
          return;
        }
      } else {
        toast.error(editing.field === "quantity" ? "请输入数字或计算式（如 3×12+5）" : "请输入有效数字，零金额请填写 0");
        return;
      }
    }
    if (!num) {
      toast.error(editing.field === "quantity" ? "请输入数字或计算式（如 3×12+5）" : "请输入有效数字，零金额请填写 0");
      return;
    }
    const cur = editing;
    committing.current = true;
    setEditing(null);
    const payload: Partial<BoqItemDTO> = { [cur.field]: num };
    if (expr !== undefined) payload.quantityExpr = expr;
    const ok = (!expr && num === items.find(i => i.id === cur.id)?.[cur.field]) || await patchItem(cur.id, payload);
    committing.current = false;
    if (!ok) { setEditing(cur); return; }
    editRef.current = null;
    if (!move) { setSelected(cur.id); return; }
    let next: { id: string; field: BoqEditField } | undefined;
    if (move === 1 || move === -1) {
      const cells = leafIds.flatMap(cellsOf);
      const idx = cells.findIndex(cell => cell.id === cur.id && cell.field === cur.field);
      next = idx >= 0 ? cells[idx + move] : undefined;
    } else {
      // Enter：同字段跳到下/上一行（Excel 习惯），目标行不可编该字段时取它的可编字段
      const dir = move === "down" ? 1 : -1;
      const nextId = leafIds[leafIds.indexOf(cur.id) + dir];
      const it = nextId ? items.find(x => x.id === nextId) : undefined;
      if (it) {
        const fields = cellsOf(it.id);
        next = fields.find(f => f.field === cur.field) ?? fields[0];
      }
    }
    if (next) {
      const it = items.find((x) => x.id === next.id);
      if (it) {
        editRef.current = next;
        setEditing(next);
        setDraft(it[next.field]);
        setSelected(next.id); // 高亮跟随活动单元格走
      } else setSelected(cur.id);
    } else setSelected(cur.id);
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
    if (q && !(i.name.includes(q) || i.code.includes(q) || i.rawFeature.includes(q) || i.sectionPath.includes(q) || (i.unitProject ?? "").includes(q))) return false;
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
  // 手工补录段前补一条伪标题行（筛选/排序时不注入，避免干扰结果列表）
  const shownRows = (() => {
    if (filtering) return shown;
    const idx = shown.findIndex(i => !i.isHeader && i.sheetName === "手工补录");
    return idx < 0 ? shown : [...shown.slice(0, idx), MANUAL_GROUP_ROW, ...shown.slice(idx)];
  })();
  // 有序叶子行（Tab 跳格沿当前排序/筛选顺序走）
  const leafIds = shown.filter((i) => !i.isHeader).map((i) => i.id);

  /** 单选：锚点 + 多选集合一起回到这一行 */
  const selectOnly = (id: string) => { setSelected(id); setSelIds(new Set([id])); };
  /** 行点击（Excel 习惯）：Shift 连选区间、Ctrl/Cmd 加选/减选、裸点单选 */
  const pickRow = (e: RMouseEvent, id: string) => {
    if (e.shiftKey && selected && leafIds.includes(selected)) {
      const a = leafIds.indexOf(selected);
      const b = leafIds.indexOf(id);
      if (b < 0) return;
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      setSelIds(new Set(leafIds.slice(lo, hi + 1)));
    } else if (e.ctrlKey || e.metaKey) {
      setSelIds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
      setSelected(id);
    } else selectOnly(id);
  };
  const dataTotal = items.reduce((n, i) => n + (i.isHeader ? 0 : 1), 0);
  const dataShown = sorted.reduce((n, i) => n + (i.isHeader ? 0 : 1), 0);
  // 造价师视角：合价合计随筛选联动，未定价项计数常显
  const sumShown = projectTotals(sorted).totalAmount;
  // 多选时状态栏给所选行合计（Excel 状态栏口径）：复核几行加总不用再拉计算器
  const selTotal = selIds.size > 1 ? items.reduce((n, i) => n + (selIds.has(i.id) && !i.isHeader ? Number(i.totalPrice) || 0 : 0), 0) : 0;
  const unpriced = items.reduce((n, i) => n + (isPricableItem(i) && Number(i.unitPrice) === 0 ? 1 : 0), 0);
  // 金额列内嵌数据条（Excel 条件格式口径）：随当前筛选联动，扫一眼就知道钱集中在哪里
  const maxTotal = sorted.reduce((m, i) => (i.isHeader ? m : Math.max(m, Number(i.totalPrice) || 0)), 0);

  // 分部小计：标题行右侧汇总其正下方到下一标题之间的清单合价（嵌套父标题无直接子项时不显示）
  // 手工补录行不属于任何导入分部，单独聚到「手工补录」伪标题，不污染上一个分部的小计
  const headerSubtotal = useMemo(() => {
    const m = new Map<string, number>();
    let cur: string | null = null;
    for (const it of items) {
      if (it.isHeader) { cur = it.id; m.set(cur, 0); continue; }
      if (it.sheetName === "手工补录") { cur = MANUAL_GROUP_ID; if (!m.has(cur)) m.set(cur, 0); }
      if (cur) m.set(cur, (m.get(cur) ?? 0) + Number(it.totalPrice));
    }
    return m;
  }, [items]);

  // 键盘习惯（Excel 工作表）：/ 聚焦搜索，↑↓ 移动选中行，Enter 就地编辑，Esc 取消选中
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
      if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); return; }
      if (editing || !leafIds.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = selected ? leafIds.indexOf(selected) : -1;
        const next = leafIds[idx + (e.key === "ArrowDown" ? 1 : -1)] ?? (idx < 0 && e.key === "ArrowDown" ? leafIds[0] : undefined);
        if (next) selectOnly(next);
      } else if (e.key === "Enter" && selected) {
        const it = items.find(i => i.id === selected);
        if (it && !it.isHeader) { e.preventDefault(); beginEdit(it, isPricableItem(it) ? "quantity" : "totalPrice"); }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !e.shiftKey) {
        // Excel 习惯：Ctrl+A 全选数据行（配合批量调价/复制/删除用）
        e.preventDefault();
        setSelIds(new Set(leafIds));
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && (selIds.size > 0 || selected)) {
        // Excel 习惯：Ctrl+C 把所选清单行复制成 TSV（带表头），可直接粘进 Excel/WPS
        const targets = shown.filter((i) => !i.isHeader && (selIds.size > 0 ? selIds.has(i.id) : i.id === selected));
        if (targets.length) { e.preventDefault(); void copyRowsToExcel(targets); }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && (selIds.size > 0 || selected)) {
        // Ctrl+V 粘回：剪贴板 TSV 的工程量/综合单价按行写回所选行，先预览再落库
        e.preventDefault();
        void pasteFromClipboard();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        const targets = selIds.size > 1
          ? items.filter((i) => selIds.has(i.id) && !i.isHeader)
          : [items.find((i) => i.id === selected)].filter((x): x is BoqItemDTO => !!x && !x.isHeader);
        if (targets.length) { e.preventDefault(); setPendingDelRows(targets); }
      } else if (e.key === "Escape") {
        // 先关浮层再取消选中：右键菜单开着时 Esc 只负责收菜单
        if (ctxMenu) { setCtxMenu(null); return; }
        if (selected) { setSelected(null); setSelIds(new Set()); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // 键盘选中行时滚入可视区
  useEffect(() => {
    if (!selected) return;
    document.querySelector(`[data-boq-row="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // 补录/撤销/修改落地的行：清单刷新到位后自动选中该行（顺带滚入可视区），让用户看清数据落点
  useEffect(() => {
    if (!flashIds.length) return;
    const first = flashIds.find((id) => items.some((i) => i.id === id));
    if (first) selectOnly(first);
  }, [flashSeq, flashIds, items]);

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

  /** 专业筛选写回 view.filter（单一事实源），总览图例点进来的筛选同样能在这里改掉。 */
  const setViewFilter = (patch: { discipline?: string; onlyItems?: boolean }) => {
    useStore.setState(st => ({ views: st.views.map(v => v.id === view?.id && v.kind === "boqTable" ? { ...v, filter: { ...v.filter, discipline: ((patch.discipline ?? v.filter?.discipline) || undefined) as Discipline | undefined, onlyItems: patch.onlyItems ?? v.filter?.onlyItems } } : v) }));
  };

  const clearAll = () => {
    setBoqQuery("");
    setColText({ code: "", name: "", feature: "" });
    setUnitSel(null);
    setSort(null);
    setDiscipline(""); setOnlyItems(false); useStore.setState({ boqOnlyUnpriced: false });
    setViewFilter({ discipline: "", onlyItems: false });
    setLimit(300);
  };

  const addLumpSum = addForm.feeType === "总价措施" || addForm.feeType === "其他项目";
  const addQtyPreview = (() => {
    const t = addForm.quantity.trim();
    if (!t || Number.isFinite(Number(t))) return null;
    try { return `= ${Number(evalExpr(t).toFixed(6))}`; } catch { return "计算式无效"; }
  })();
  const openAdd = () => {
    if (running || agentRunning || importRunning || saving) return;
    setAddForm({ name: "", code: "", unit: "", quantity: "", unitPrice: "", totalPrice: "", feeType: "分部分项", feature: "", unitProject: "" });
    setAddOpen(true);
  };
  const submitAdd = async () => {
    const name = addForm.name.trim();
    if (!name) { toast.error("请填写项目名称"); return; }
    let quantity: string | undefined;
    let quantityExpr: string | undefined;
    if (!addLumpSum && addForm.quantity.trim()) {
      const raw = addForm.quantity.trim();
      if (Number.isFinite(Number(raw))) quantity = raw;
      else {
        try { quantity = String(evalExpr(raw)); quantityExpr = raw; }
        catch (e) { toast.error(`工程量计算式无效：${e instanceof Error ? e.message : e}`); return; }
      }
    }
    const receiptId = await createItem({
      name,
      code: addForm.code.trim() || undefined,
      unit: addForm.unit.trim() || undefined,
      rawFeature: addForm.feature.trim() || undefined,
      unitProject: addForm.unitProject.trim() || undefined,
      feeType: addForm.feeType,
      ...(addLumpSum
        ? { totalPrice: addForm.totalPrice.trim() || undefined }
        : { quantity, quantityExpr, unitPrice: addForm.unitPrice.trim() || undefined }),
    });
    if (receiptId) {
      setAddOpen(false);
      toast.success(`已补录「${name}」`, {
        label: "撤销",
        onClick: () => void revertReceipt(receiptId).then((ok) => { if (ok) toast.success("已撤销补录"); }),
      });
    }
  };

  // 复制行：新行紧随源行插入（同表同分部同专业），组价方案/人材机分解/原文特征一并带走
  const duplicateRow = async (it: BoqItemDTO) => {
    const receiptId = await createItem({
      name: it.name,
      code: it.code || undefined,
      unit: it.unit || undefined,
      quantity: String(it.quantity),
      quantityExpr: it.quantityExpr || undefined,
      unitPrice: String(it.unitPrice),
      mainMaterialPrice: String(it.mainMaterialPrice),
      laborUnitPrice: String(it.laborUnitPrice),
      machineUnitPrice: String(it.machineUnitPrice),
      totalPrice: String(it.totalPrice),
      feeType: it.feeType,
      insertAfter: it.id,
      rawFeature: it.rawFeature || undefined,
      pricingPlan: it.pricingPlan?.length ? JSON.stringify(it.pricingPlan) : undefined,
    });
    if (receiptId) {
      toast.success(`已复制「${it.name}」到下一行`, {
        label: "撤销",
        onClick: () => void revertReceipt(receiptId).then((ok) => { if (ok) toast.success("已撤销复制"); }),
      });
    }
  };

  /**
   * Ctrl+V 粘回：剪贴板 TSV（本工具 Ctrl+C/导出 的列序，或带同名表头）按行覆盖所选行的
   * 工程量/综合单价/主材暂估价。只认数字列，名称编码不参与覆盖，先出预览再落库。
   */
  const pasteFromClipboard = async () => {
    let text = "";
    try { text = await navigator.clipboard.readText(); }
    catch { toast.error("读取剪贴板失败：浏览器未授权"); return; }
    const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.split("\t")).filter((l) => l.some((c) => c.trim() !== ""));
    if (!lines.length) { toast.info("剪贴板是空的"); return; }
    let header: string[] | null = null;
    if (/项目编码|项目名称|工程量|综合单价/.test(lines[0].join("\t"))) header = lines.shift()!;
    const col = (...keys: string[]) => header ? header.findIndex((h) => keys.some((k) => h.includes(k))) : -1;
    // 有表头按表头定位列；无表头按本工具复制格式固定列序（编码/名称/特征/单位/量/价/合价）
    const qi = header ? col("工程量", "数量") : 4;
    const pi = header ? col("综合单价", "单价") : 5;
    const mi = header ? col("主材暂估价", "主材") : -1;
    if (qi < 0 && pi < 0 && mi < 0) { toast.info("剪贴板里没有可写入的工程量/综合单价列"); return; }
    const pool = selIds.size > 1
      ? shown.filter((i) => selIds.has(i.id) && !i.isHeader)
      : (() => {
          const a = selected ? leafIds.indexOf(selected) : -1;
          return a >= 0 ? leafIds.slice(a).map((id) => items.find((i) => i.id === id)!).filter((x): x is BoqItemDTO => !!x) : [];
        })();
    const plan: { it: BoqItemDTO; patch: { quantity?: string; unitPrice?: string; mainMaterialPrice?: string } }[] = [];
    const n = Math.min(pool.length, lines.length);
    for (let k = 0; k < n; k++) {
      const it = pool[k], cells = lines[k];
      const patch: { quantity?: string; unitPrice?: string; mainMaterialPrice?: string } = {};
      for (const [ci, f] of [[qi, "quantity"], [pi, "unitPrice"], [mi, "mainMaterialPrice"]] as const) {
        if (ci < 0) continue;
        const v = (cells[ci] ?? "").replace(/,/g, "").trim();
        if (v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0) patch[f] = v;
      }
      if (Object.keys(patch).length) plan.push({ it, patch });
    }
    if (!plan.length) { toast.info("没有可粘贴的数字（工程量/综合单价）"); return; }
    setPastePlan(plan);
  };

  const submitPaste = async () => {
    const plan = pastePlan;
    if (!plan?.length) return;
    const receiptId = await pasteItems(plan.map((p) => ({ id: p.it.id, ...p.patch })));
    if (receiptId) {
      setPastePlan(null);
      toast.success(`已粘贴更新 ${plan.length} 行清单`, {
        label: "撤销",
        onClick: () => void revertReceipt(receiptId).then((ok) => { if (ok) toast.success("已撤销粘贴"); }),
      });
    }
  };

  const submitAdjust = async () => {
    const rows = adjRows;
    if (!rows?.length) return;
    const v = adjForm.value.trim();
    if (!v || !Number.isFinite(Number(v))) { toast.error("请输入有效数字"); return; }
    if (adjForm.mode === "value" && Number(v) < 0) { toast.error("不能设为负数"); return; }
    const desc = adjForm.mode === "percent"
      ? `${ADJ_FIELD[adjForm.field]}统一${Number(v) < 0 ? "下浮" : "上浮"} ${Math.abs(Number(v))}%`
      : `${ADJ_FIELD[adjForm.field]}统一设为 ${v}`;
    const res = await adjustItems(rows.map(r => r.id), { field: adjForm.field, mode: adjForm.mode, value: v });
    if (!res) return;
    setAdjRows(null);
    setSelIds(new Set());
    toast.success(`已调整 ${res.updated} 行：${desc}`, {
      label: "撤销",
      onClick: () => void revertReceipt(res.receiptId!).then((ok) => { if (ok) toast.success("已撤销批量调整"); }),
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="cost-table-toolbar flex flex-wrap items-center gap-2 border-b border-border bg-[var(--muted)] px-3 py-1.5">
        <Funnel size={12} className="shrink-0 text-muted-foreground" />
        <Input
          ref={searchRef}
          disabled={!!editing || saving}
          value={query}
          onChange={(e) => { setBoqQuery(e.target.value); setLimit(300); }}
          onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); setBoqQuery(""); } }}
          placeholder="查找清单项目（/）"
          aria-label="搜索工程清单"
          className="w-56 h-8"
        />
        <Button variant="outline" size="sm" aria-pressed={!!boqOnlyUnpriced} className="aria-pressed:bg-secondary" disabled={!!editing || saving} onClick={() => { useStore.setState({ boqOnlyUnpriced: !boqOnlyUnpriced }); setLimit(300); }}>只看未报价{unpriced ? `（${unpriced}）` : ""}</Button>
        <details className="cost-simple-more"><summary>更多筛选</summary><div className="cost-more-body"><select aria-label="筛选清单专业" disabled={!!editing || saving} value={discipline} className="cost-input" onChange={e => { setDiscipline(e.target.value); setViewFilter({ discipline: e.target.value }); setLimit(300); }}><option value="">全部专业</option>{Object.entries(DISCIPLINE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><label><input type="checkbox" checked={details} disabled={!!editing || saving} onChange={e => setDetails(e.target.checked)} />显示编码、特征和列筛选</label></div></details>
        {filtering && (
          <Button variant="ghost" size="xs" onClick={clearAll} disabled={!!editing || saving}>
            <X size={11} /> 清除筛选
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={!!editing || saving || running || agentRunning || importRunning} onClick={openAdd} title="清单里漏掉的项目可以手工补一行，会记入操作记录"><Plus size={13} />补一行</Button>
        <Button variant="outline" size="sm" asChild
          className={cn((!dataTotal || saving || running || agentRunning || importRunning) && "pointer-events-none opacity-40")}
        >
          <a
            href={projectId ? `/api/projects/${projectId}/export` : undefined}
            download
            title="把当前清单直接下载为 Excel（含计算式与来源，不经过助手）"
          >
            <Download size={12} />导出
          </a>
        </Button>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {dataShown === dataTotal
            ? `${dataTotal} 行`
            : `已筛选 ${dataShown} / ${dataTotal} 行`}
          {sort && " · 已排序"}
        </span>
      </div>
      {editing && <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><span>Enter 保存并移到下一行，Tab 移到下一格，Esc 取消。</span><Button size="sm" disabled={saving} onPointerDown={e => e.preventDefault()} onClick={() => void commit()}>保存修改</Button><Button variant="outline" size="sm" disabled={saving} onPointerDown={e => e.preventDefault()} onClick={cancelEdit}>取消</Button></div>}
      {!editing && <p className="px-3 py-2 text-[11px] text-muted-foreground">点击数量、单价或金额即可修改，数量可输计算式（如 3×12+5）；选中行可 Ctrl+C/V 与 Excel 互粘，Shift/Ctrl 点选多行批量调价。按 <kbd className="kbd">?</kbd> 查看全部快捷键。</p>}
      <div className="xl-scroll flex-1 overflow-auto">
      <table className="xl-table xl-pin-last">
        <thead inert={!!editing || saving}>
          <tr>
            <th className="xl-rn"></th>
            {details && <th className="group/th relative w-28">
              <ExcelHead label="项目编码" sortDir={sort?.key === "code" ? sort.dir : null} onSort={(d) => setSort(d ? { key: "code", dir: d } : null)} text={colText.code} onText={setText("code")} />
            </th>}
            <th className="group/th relative xl-name">
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
          {shownRows.map((it, i) =>
            it.isHeader ? (
              <tr key={it.id} className="xl-group"
                onContextMenu={it.id === MANUAL_GROUP_ID ? undefined : (e) => { e.preventDefault(); setSelected(it.id); setCtxMenu({ x: e.clientX, y: e.clientY, id: it.id }); }}
              >
                <td className="xl-rn">{i + 1}</td>
                <td colSpan={details ? 7 : 5} className="text-[12px]">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate">{it.name}</span>
                    {(headerSubtotal.get(it.id) ?? 0) > 0 && (
                      <span className="mono shrink-0 text-[11px] font-normal text-muted-foreground">
                        小计 {fmtMoney(headerSubtotal.get(it.id)!)}
                      </span>
                    )}
                  </span>
                </td>
              </tr>
            ) : (
              <Fragment key={it.id}>
              <tr
                className={cn(
                  isPricableItem(it) && Number(it.quantity) === 0 && "opacity-45",
                  (selIds.has(it.id) || selected === it.id) && "xl-sel",
                  flashIds.includes(it.id) && "boq-flash"
                )}
                title={isPricableItem(it) && Number(it.quantity) === 0 ? "工程量为 0" : undefined}
                data-boq-row={it.id}
                onClick={(e) => pickRow(e, it.id)}
                onContextMenu={(e) => { e.preventDefault(); if (!selIds.has(it.id)) selectOnly(it.id); setCtxMenu({ x: e.clientX, y: e.clientY, id: it.id }); }}
              >
                <td className="xl-rn" title={rnTitle(it)}>
                  {i + 1}
                  {rowAudit.has(it.id) && <i className="xl-audit" aria-label="该行有改动记录" />}
                </td>
                {details && <td className="mono text-muted-foreground"><Hl text={it.code} q={query.trim()} /></td>}
                <td className="xl-name max-w-72 truncate" title={it.name}>
                  <Hl text={it.name} q={query.trim()} />
                  {!details && it.rawFeature && <div className="max-w-64 truncate text-[11px] text-muted-foreground" title={it.rawFeature}><Hl text={displayFeature(it.rawFeature, it.name)} q={query.trim()} /></div>}
                  {it.feeType && it.feeType !== "分部分项" && (
                    <Badge variant="secondary" className="ml-1 !py-px !text-[10px]" >{it.feeType}</Badge>
                  )}
                </td>
                {details && <td className="max-w-56 truncate text-muted-foreground" title={it.rawFeature}>
                  <Hl text={displayFeature(it.rawFeature, it.name)} q={query.trim()} />
                </td>}
                <td className="text-muted-foreground">{it.unit}</td>
                {(["quantity", "unitPrice", "totalPrice"] as const).map((f) => {
                  const editable = isPricableItem(it) ? f !== "totalPrice" : f === "totalPrice";
                  return (
                  <td
                    key={f}
                    className={cn(
                      "mono text-right", editable && "xl-edit",
                      f === "totalPrice" && "relative",
                      editing?.id === it.id && editing.field === f && "xl-active relative",
                      f === "unitPrice" && Number(it.unitPrice) === 0 && isPricableItem(it) &&
                        "bg-[var(--warning-soft)] font-medium",
                      f === "unitPrice" && Number(it.unitPrice) === 0 && isPricableItem(it) &&
                        "text-[var(--warning-soft-fg)]"
                    )}
                    title={
                      !editable ? isPricableItem(it) ? "工程量×综合单价自动计算" : "总额计价行，请编辑合价"
                        : f === "unitPrice" && Number(it.unitPrice) === 0 ? "未报价 — 点击填写"
                        : f === "quantity" && it.quantityExpr ? `计算式：${it.quantityExpr} = ${it.quantity} — 点击修改`
                        : f === "quantity" ? "点击或按 Enter 修改，可输计算式（如 3×12+5）"
                        : "点击或按 Enter 修改"
                    }
                    tabIndex={editable ? 0 : undefined}
                    onKeyDown={e => { if (editable && e.target === e.currentTarget && e.key === "Enter") { e.preventDefault(); beginEdit(it, f); } }}
                    onClick={e => {
                      // 带修饰键的点击放行给行级多选（Shift 连选 / Ctrl 加选），不进编辑
                      if (editable && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.stopPropagation(); selectOnly(it.id); beginEdit(it, f); }
                    }}
                  >
                    {editing?.id === it.id && editing.field === f ? (
                      <>
                      <input
                        autoFocus
                        aria-label={`${it.name} ${FIELD_LABEL[f]}`}
                        inputMode="decimal"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.nativeEvent.isComposing) return;
                          if (e.key === "Enter") { e.preventDefault(); void commit(e.shiftKey ? "up" : "down"); }
                          if (e.key === "Tab") {
                            e.preventDefault();
                            void commit(e.shiftKey ? -1 : 1);
                          }
                          if (e.key === "Escape") cancelEdit();
                        }}
                        className="w-20 border-0 bg-transparent px-0 py-0 text-right text-[12.5px] outline-none"
                      />
                      {f === "quantity" && exprPreview && (
                        <span
                          className={cn(
                            "pointer-events-none absolute -top-5 right-0 z-10 whitespace-nowrap rounded px-1.5 py-px text-[10px] font-medium shadow-[var(--shadow-sm)]",
                            exprPreview.ok
                              ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                              : "bg-[var(--destructive)] text-white"
                          )}
                        >
                          {exprPreview.ok ? `= ${exprPreview.value!.toLocaleString("zh-CN", { maximumFractionDigits: 3 })}` : "式无效"}
                        </span>
                      )}
                      </>
                    ) : f === "totalPrice" ? (
                      <>
                        {Number(it.totalPrice) > 0 && maxTotal > 0 && (
                          <span
                            aria-hidden
                            className="pointer-events-none absolute inset-y-0 right-0"
                            style={{
                              width: `${Math.min(100, (Number(it.totalPrice) / maxTotal) * 100)}%`,
                              background: "linear-gradient(to left, color-mix(in srgb, var(--chart-3) 30%, transparent), transparent)",
                            }}
                          />
                        )}
                        <span className="relative">{fmtMoney(it.totalPrice)}</span>
                      </>
                    ) : f === "unitPrice" ? (
                      <>
                        {isPricableItem(it) ? fmtMoney(it[f]) : (
                          <span className="text-muted-foreground" title="总额计价行没有单价，金额填在合价列">—</span>
                        )}
                        {details && Number(it.mainMaterialPrice ?? 0) > 0 && (
                          <div
                            className="text-[10px] font-normal text-muted-foreground"
                            title="主材暂估价（组价输入）"
                          >
                            材 {fmtMoney(it.mainMaterialPrice)}
                          </div>
                        )}
                        {(it.pricingPlan?.filter((l) => !l.suggested).length ?? 0) > 0 && (
                          <button
                            type="button"
                            className="block w-full text-right text-[10px] font-normal text-[var(--foreground)] underline-offset-2 hover:underline"
                            aria-expanded={expandedId === it.id}
                            title={
                              `综合单价由 ${it.pricingPlan!.filter((l) => !l.suggested).length} 条定额子目组成 — 点击展开构成明细\n` +
                              it.pricingPlan!.filter((l) => !l.suggested).map((l) => `${l.quotaCode} ${l.quotaName}`).join("\n")
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelected(it.id);
                              setExpandedId(expandedId === it.id ? null : it.id);
                            }}
                          >
                            <ChevronDown size={10} className={cn("inline transition-transform", expandedId === it.id && "rotate-180")} /> 组价×{it.pricingPlan!.filter((l) => !l.suggested).length}
                          </button>
                        )}
                      </>
                    ) : f === "quantity" && it.quantityExpr ? (
                      // 点状下划线 = 该数由计算式得出，悬停见原式（审计留痕）
                      <span className="underline decoration-dotted decoration-muted-foreground underline-offset-[3px]">{it[f]}</span>
                    ) : (
                      it[f]
                    )}
                  </td>
                ); })}
              </tr>
              {expandedId === it.id && (
                <tr className="xl-expand">
                  <td colSpan={details ? 8 : 6}>
                    <PriceComposition item={it} />
                  </td>
                </tr>
              )}
              </Fragment>
            )
          )}
          {!shownRows.length && (
            <tr>
              <td colSpan={(details ? 7 : 5) + 1}>
                <div className="flex flex-col items-center gap-2 py-10 text-[12px] text-muted-foreground">
                  {dataTotal === 0 ? "清单还是空的——先把 Excel 清单传进来，或点「补一行」" : "没有匹配的清单项"}
                  {dataTotal > 0 && <Button type="button" variant="outline" size="xs" onClick={clearAll}>清除筛选</Button>}
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {items.length > 0 && dataShown === 0 && <EmptyState title="没有符合筛选条件的清单项" hint="清除筛选或更换关键词后再查看。" />}
      {sorted.length > shown.length && (
        <Button variant="outline" size="xs" onClick={() => setLimit((l) => l + 500)} className="mx-auto my-3">
          加载更多（还有 {sorted.length - shown.length} 行）
        </Button>
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
        <BoqStatusBar sumShown={sumShown} filtering={filtering} unpriced={unpriced} selCount={selIds.size} selTotal={selTotal} dataShown={dataShown} dataTotal={dataTotal} />
      )}
      {ctxMenu && (
        <RowContextMenu
          ctxMenu={ctxMenu}
          items={items}
          selIds={selIds}
          onClose={() => setCtxMenu(null)}
          onDuplicate={duplicateRow}
          onBatchAdjust={(targets) => { setAdjForm({ field: "unitPrice", mode: "percent", value: "" }); setAdjRows(targets); }}
          onDelete={(targets) => setPendingDelRows(targets)}
        />
      )}
      <ConfirmDialog
        open={!!pendingDelRows}
        danger
        title={(pendingDelRows?.length ?? 0) > 1 ? `删除所选 ${pendingDelRows!.length} 行清单？` : `删除清单行「${pendingDelRows?.[0]?.name ?? ""}」？`}
        description={(pendingDelRows?.length ?? 0) > 1
          ? `所选的 ${pendingDelRows!.length} 行将一起从清单中移除；删除后可在提示条上直接撤销，一次恢复全部，也可在「操作记录」里恢复。`
          : "此行将从清单中移除；删除后可在提示条上直接撤销，也可在「操作记录」里恢复。"}
        confirmText="删除"
        busy={saving}
        onConfirm={() => {
          const rows = pendingDelRows;
          setPendingDelRows(null);
          if (!rows?.length) return;
          if (rows.length === 1) {
            const row = rows[0];
            void deleteItem(row.id).then((receiptId) => {
              if (!receiptId) return;
              setSelIds(new Set());
              toast.success(`已删除「${row.name}」`, {
                label: "撤销",
                onClick: () => void revertReceipt(receiptId).then((ok) => { if (ok) toast.success("已恢复删除的行"); }),
              });
            });
          } else {
            void deleteItems(rows.map((r) => r.id)).then((receiptId) => {
              if (!receiptId) return;
              setSelIds(new Set());
              toast.success(`已删除 ${rows.length} 行清单`, {
                label: "撤销",
                onClick: () => void revertReceipt(receiptId).then((ok) => { if (ok) toast.success(`已恢复删除的 ${rows.length} 行`); }),
              });
            });
          }
        }}
        onCancel={() => setPendingDelRows(null)}
      />
      <AddRowDialog addOpen={addOpen} saving={saving} addForm={addForm} setAddForm={setAddForm} addLumpSum={addLumpSum} addQtyPreview={addQtyPreview} unitProjects={[...new Set(items.map((i) => i.unitProject).filter((u): u is string => !!u))]} onClose={() => setAddOpen(false)} onSubmit={submitAdd} />
      <BatchAdjustDialog adjRows={adjRows} saving={saving} adjForm={adjForm} setAdjForm={setAdjForm} onClose={() => setAdjRows(null)} onSubmit={submitAdjust} />
      <PastePreviewDialog pastePlan={pastePlan} saving={saving} onClose={() => setPastePlan(null)} onSubmit={submitPaste} />
    </div>
  );
}
