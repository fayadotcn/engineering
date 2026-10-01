"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Columns3,
  FileSpreadsheet,
  Loader2,
  Table,
  Trash2,
  Upload,
} from "lucide-react";
import { ConfirmDialog, toast } from "../primitives";
import { DatasetMappingPanel } from "./DatasetMappingPanel";
import { PriceRowsPanel } from "./PriceRowsPanel";
import { readResponse } from "../http";

interface DatasetDTO {
  id: string;
  kind: string;
  kindLabel: string;
  name: string;
  filename: string;
  status: string;
  active: boolean;
  rowCount: number;
  createdAt: string;
}

interface Preview {
  columns: string[];
  rows: string[][];
  total: number;
}

const KINDS = [
  { k: "MATERIAL_PRICE", label: "材料价格", hint: "上传 Excel 价格表，系统自动整理；不确定的地方会请你核对。" },
  { k: "QUOTA", label: "定额", hint: "上传定额表，供各工程计算安装费用。" },
  { k: "GENERIC", label: "参考资料", hint: "上传其他 Excel 资料，方便以后查看。" },
] as const;

const cn = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(" ");

type CardPanel = "preview" | "prices" | "mapping";

const toggleBtn =
  "flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] text-neutral-500 hover:bg-[var(--hover)]";

function DatasetCard({
  d,
  onRefresh,
  autoPanel,
  onDirtyChange,
}: {
  d: DatasetDTO;
  onRefresh: () => Promise<void>;
  onDirtyChange: (id: string, dirty: boolean) => void;
  autoPanel?: CardPanel;
}) {
  const [panel, setPanel] = useState<CardPanel | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  const reportDirty = useCallback((value: boolean) => { setDirty(value); onDirtyChange(d.id, value); }, [d.id, onDirtyChange]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onDirtyChange(d.id, false); }; }, [d.id, onDirtyChange]);

  // 上传后低置信自动展开映射面板
  useEffect(() => {
    if (autoPanel) setPanel(autoPanel);
  }, [autoPanel]);

  const togglePanel = (p: CardPanel) => { if (!dirty && !busy && !previewLoading) setPanel((cur) => (cur === p ? null : p)); };

  const togglePreview = async (retry = false) => {
    if (dirty || busy || previewLoading) return;
    if (panel === "preview" && !retry) { setPanel(null); return; }
    setPanel("preview");
    if (preview) return;
    setPreviewLoading(true); setPreviewError("");
    try {
      const result = await readResponse<Preview>(await fetch(`/api/admin/datasets/${d.id}`), "预览加载失败，请重试");
      if (mounted.current) setPreview(result);
    } catch (error) { if (mounted.current) setPreviewError(error instanceof Error ? error.message : "预览加载失败"); }
    finally { if (mounted.current) setPreviewLoading(false); }
  };

  const toggleActive = async () => {
    if (lock.current || dirty) return;
    lock.current = true; setBusy(true);
    try {
    const res = await fetch(`/api/admin/datasets/${d.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: !d.active }),
    });
    await readResponse(res, "操作失败");
    toast.success(d.active ? `已停用「${d.name}」— 匹配/测算不再引用` : `已启用「${d.name}」`);
    await onRefresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : "操作失败"); }
    finally { lock.current = false; setBusy(false); }
  };

  const remove = async () => {
    if (lock.current || dirty) return;
    lock.current = true; setBusy(true);
    try {
    const res = await fetch(`/api/admin/datasets/${d.id}`, { method: "DELETE" });
    await readResponse(res, "删除失败，请重试");
    setConfirmDel(false);
    toast.success(`已删除数据集「${d.name}」`);
    await onRefresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : "删除失败，请重试"); }
    finally { lock.current = false; setBusy(false); }
  };

  const chevron = (p: CardPanel) => (
    <ChevronDown
      size={11}
      className={cn("transition-transform", panel === p && "rotate-180")}
    />
  );

  return (
    <div className="overflow-hidden rounded-md border border-neutral-200 bg-[var(--surface)]">
      <div className="cost-dataset-row flex flex-wrap items-center gap-3 px-4 py-3">
        <FileSpreadsheet size={15} className="shrink-0 text-neutral-400" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{d.name}</div>
          <div className="mt-0.5 break-words text-[11px] text-neutral-500">
            {d.filename} ·{" "}
            {d.status === "FAILED"
              ? "解析失败"
              : d.status === "PENDING"
                ? "需要核对表格"
                : `${d.rowCount} 行`}{" "}
            · {d.createdAt.slice(0, 10)}
          </div>
        </div>
        {d.status === "FAILED" && (
          <span
            className="rounded px-1.5 py-0.5 text-[11px]"
            style={{ background: "var(--danger-soft-bg)", color: "var(--danger-soft-fg)" }}
          >
            失败
          </span>
        )}
        {d.status === "PENDING" && (
          <span
            className="rounded px-1.5 py-0.5 text-[11px]"
            style={{ background: "var(--warning-soft-bg)", color: "var(--warning-soft-fg)" }}
          >
            待确认
          </span>
        )}
        {!d.active && <span className="text-xs text-neutral-500">已停用</span>}
        {d.kind === "MATERIAL_PRICE" && (d.status === "PENDING" || d.status === "FAILED") && (
          <button
            onClick={() => togglePanel("mapping")}
            disabled={dirty || busy}
            aria-expanded={panel === "mapping"}
            className="flex h-7 items-center gap-1 rounded-md px-3 text-[11.5px] font-medium text-white"
            style={{ background: "var(--brand-accent)" }}
          >
            <Check size={12} /> 核对表格
          </button>
        )}
        {d.kind === "MATERIAL_PRICE" && d.status === "PARSED" && (
          <button disabled={dirty || busy} aria-expanded={panel === "prices"} onClick={() => togglePanel("prices")} className="cost-btn">
            <Table size={12} /> {panel === "prices" ? "收起数据" : "打开数据"}
          </button>
        )}
        {d.kind !== "MATERIAL_PRICE" && (
          <button disabled={busy || previewLoading} aria-expanded={panel === "preview"} onClick={() => void togglePreview()} className={toggleBtn}>
            {panel === "preview" ? "收起数据" : "打开数据"} {chevron("preview")}
          </button>
        )}
        <details className="cost-simple-more cost-dataset-more"><summary>更多</summary><div className="cost-more-body">
        {d.kind === "MATERIAL_PRICE" && d.status === "PARSED" && <button disabled={dirty || busy} aria-expanded={panel === "mapping"} onClick={() => togglePanel("mapping")} className={toggleBtn}><Columns3 size={12} />调整表格识别</button>}
        <button
          onClick={toggleActive}
          disabled={busy || dirty}
          role="switch"
          aria-checked={d.active}
          aria-label={`${d.name}参与匹配与测算`}
          className={toggleBtn}
          title={d.active ? "已启用 — 点击停用" : "已停用 — 点击启用"}
        >
          {d.active ? "停用这份数据" : "启用这份数据"}
        </button>
        <button
          onClick={() => setConfirmDel(true)}
          disabled={busy || dirty}
          aria-label={`删除数据集${d.name}`}
          className={toggleBtn}
          title="删除数据集"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={13} />}删除
        </button>
        </div></details>
      </div>
      {dirty && <p className="px-4 pb-2 text-xs text-neutral-500" role="status">请先保存或取消编辑，再切换面板、筛选或停用数据集。</p>}
      {panel === "preview" && previewLoading && <div className="cost-empty" role="status"><Loader2 size={14} className="animate-spin" />正在加载预览</div>}
      {panel === "preview" && previewError && <div className="cost-error" role="alert">{previewError}<button className="cost-btn" onClick={() => void togglePreview(true)}>重试</button></div>}
      <ConfirmDialog
        open={confirmDel}
        danger
        title={`删除数据集「${d.name}」？`}
        description={`将删除导入的全部 ${d.rowCount} 行数据与源文件，所有项目立即失去该数据。`}
        confirmText="删除"
        busy={busy}
        onConfirm={remove}
        onCancel={() => setConfirmDel(false)}
      />
      {panel === "preview" && preview && (
        <div className="max-h-72 overflow-auto border-t border-neutral-100">
          <table className="xl-table text-[12px]">
            <thead>
              <tr>
                <th className="xl-rn"></th>
                {preview.columns.map((c, i) => (
                  <th key={i}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((r, i) => (
                <tr key={i}>
                  <td className="xl-rn">{i + 1}</td>
                  {r.map((c, ci) => (
                    <td key={ci} className="max-w-56 truncate" title={c}>{c || "—"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!preview.rows.length && <p className="px-3 py-5 text-center text-xs text-neutral-500">暂无可预览的行数据</p>}
          {preview.total > preview.rows.length && (
            <div className="px-3 py-2 text-[11px] text-neutral-400">
              显示前 {preview.rows.length} 行，共 {preview.total} 行
            </div>
          )}
        </div>
      )}
      {panel === "prices" && d.kind === "MATERIAL_PRICE" && (
        <PriceRowsPanel datasetId={d.id} onDirtyChange={reportDirty} />
      )}
      {panel === "mapping" && (
        <DatasetMappingPanel
          datasetId={d.id}
          filename={d.filename}
          kind={d.kind}
          onClose={() => setPanel(null)}
          onIngested={onRefresh}
          onDirtyChange={reportDirty}
        />
      )}
    </div>
  );
}

export function DatasetManager({ initial }: { initial: DatasetDTO[] }) {
  const [datasets, setDatasets] = useState(initial);
  const [kind, setKind] = useState<(typeof KINDS)[number]["k"]>("MATERIAL_PRICE");
  const [busy, setBusy] = useState(false);
  const [defPriceType, setDefPriceType] = useState("");
  const [defRegion, setDefRegion] = useState("");
  const [defPeriod, setDefPeriod] = useState("");
  const [defBrand, setDefBrand] = useState("");
  const [autoMappingId, setAutoMappingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [dirtyIds, setDirtyIds] = useState<string[]>([]);
  const [loadError, setLoadError] = useState("");
  const uploadLock = useRef(false);
  const reportDirty = useCallback((id: string, dirty: boolean) => setDirtyIds(ids => dirty ? ids.includes(id) ? ids : [...ids, id] : ids.filter(x => x !== id)), []);
  const blocked = busy || dirtyIds.length > 0;

  const refresh = async () => {
    try {
      const result = await readResponse<DatasetDTO[]>(await fetch("/api/admin/datasets"), "数据集列表刷新失败");
      setDatasets(result); setLoadError("");
    } catch (error) { setLoadError(error instanceof Error ? error.message : "数据集列表刷新失败"); }
  };

  const upload = async (f: File) => {
    if (uploadLock.current || dirtyIds.length) return;
    uploadLock.current = true; setBusy(true);
    try {
    const fd = new FormData();
    fd.append("file", f);
    fd.append("filename", f.name);
    fd.append("kind", kind);
    if (kind === "MATERIAL_PRICE") {
      if (defPriceType) fd.append("priceType", defPriceType);
      if (defRegion.trim()) fd.append("region", defRegion.trim());
      if (defPeriod.trim()) fd.append("period", defPeriod.trim());
      if (defBrand.trim()) fd.append("brand", defBrand.trim());
    }
    const res = await fetch("/api/admin/datasets", { method: "POST", body: fd });
    if (!res.ok) {
      throw new Error((await res.json()).error ?? `「${f.name}」上传失败`);
    }
    const ds = (await res.json()) as {
      id: string;
      rowCount: number;
      status: string;
      duplicate?: boolean;
    };
    if (ds.duplicate) toast.info("内容与已有数据集一致，未重复导入");
    else if (ds.status === "FAILED") toast.error(`「${f.name}」解析失败 — 请检查表头格式`);
    else if (ds.status === "PENDING") {
      toast.info("已识别，待确认映射后导入");
      setAutoMappingId(ds.id);
    } else toast.success(`已导入 ${ds.rowCount} 行`);
    await refresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : "上传失败，请重试"); }
    finally { uploadLock.current = false; setBusy(false); }
  };

  const grouped = KINDS.filter(k => k.k === kind).map((k) => ({
    ...k,
    items: datasets.filter((d) => d.kind === k.k && `${d.name} ${d.filename}`.toLowerCase().includes(query.trim().toLowerCase())),
  }));

  return (
    <div className="cost-datasets mt-8 space-y-8">
      <nav className="cost-library-tabs" aria-label="共享数据类型">{KINDS.map(k => <button key={k.k} aria-current={kind === k.k ? "page" : undefined} className={kind === k.k ? "active" : ""} disabled={blocked} onClick={() => { setKind(k.k); setQuery(""); }}><strong>{k.label}</strong><span>{datasets.filter(d => d.kind === k.k).length}</span></button>)}</nav>
      {loadError && <div className="cost-error" role="alert">{loadError}<button className="cost-btn" disabled={busy} onClick={() => void refresh()}>重试</button></div>}
      {/* 上传区 */}
      <div className="rounded-md border border-neutral-200 bg-[var(--surface)] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div><strong className="text-sm">导入{KINDS.find(k => k.k === kind)?.label}</strong><p className="text-xs text-neutral-500">各工程共用，启用后参与匹配与测算</p></div>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = "";
            }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={blocked}
            className="ml-auto flex h-9 items-center gap-1.5 rounded-md px-4 text-[12.5px] font-medium text-white transition-all enabled:active:translate-y-px disabled:opacity-50"
            style={{ background: "var(--brand-accent)" }}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            上传{KINDS.find((k) => k.k === kind)?.label}
          </button>
        </div>
        {kind === "MATERIAL_PRICE" && (
          <details className="cost-simple-more mt-2.5"><summary>补充地区、日期或品牌（可选）</summary><div className="cost-more-body">
            <select
              disabled={busy}
              aria-label="整表默认价格类型"
              value={defPriceType}
              onChange={(e) => setDefPriceType(e.target.value)}
              className="h-7 rounded-md border border-neutral-200 bg-white px-1.5 text-[11.5px] text-neutral-600"
              title="整表默认价格类型"
            >
              <option value="">价格类型：自动</option>
              <option value="INFO">信息价</option>
              <option value="MARKET">市场价</option>
              <option value="SUPPLY">供应商价</option>
              <option value="LABOR">人工价</option>
            </select>
            <input
              disabled={busy}
              aria-label="整表默认地区"
              value={defRegion}
              onChange={(e) => setDefRegion(e.target.value)}
              placeholder="地区"
              className="h-7 w-24 rounded-md border border-neutral-200 bg-white px-2 text-[11.5px] outline-none focus:border-[var(--brand-accent)]"
            />
            <input
              disabled={busy}
              aria-label="整表默认期次"
              value={defPeriod}
              onChange={(e) => setDefPeriod(e.target.value)}
              placeholder="如 2024-06，留空自动从表/文件名识别"
              className="h-7 w-64 rounded-md border border-neutral-200 bg-white px-2 text-[11.5px] outline-none focus:border-[var(--brand-accent)]"
            />
            <input
              disabled={busy}
              aria-label="整表默认品牌"
              value={defBrand}
              onChange={(e) => setDefBrand(e.target.value)}
              placeholder="品牌（整表默认）"
              className="h-7 w-32 rounded-md border border-neutral-200 bg-white px-2 text-[11.5px] outline-none focus:border-[var(--brand-accent)]"
            />
          </div></details>
        )}
        <p className="mt-2.5 text-[11.5px] text-neutral-400">
          {KINDS.find((k) => k.k === kind)?.hint}
        </p>
      </div>

      {/* 分组列表 */}
      <label className="cost-search"><input disabled={blocked} aria-label="搜索数据集" placeholder="搜索数据集名称或文件名" value={query} onChange={e => setQuery(e.target.value)} /></label>
      {grouped.map((g) => (
        <section key={g.k}>
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="text-[13.5px] font-medium">{g.label}</h2>
            <span className="text-[11px] text-neutral-400">{g.items.length} 个数据集</span>
          </div>
          <div className="space-y-2">
            {g.items.map((d) => (
              <DatasetCard
                key={d.id}
                d={d}
                onRefresh={refresh}
                onDirtyChange={reportDirty}
                autoPanel={d.id === autoMappingId ? "mapping" : undefined}
              />
            ))}
            {!g.items.length && (
              <div className="rounded-xl border border-dashed border-neutral-300 px-4 py-6 text-center text-[12px] text-neutral-400">
                {query.trim() ? "没有匹配的数据集" : "还没有数据集，上传 Excel 开始整理"}
              </div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
