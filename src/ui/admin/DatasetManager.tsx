"use client";
import { useEffect, useRef, useState } from "react";
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
  { k: "MATERIAL_PRICE", label: "材料价格库", hint: "支持任意格式价格表——系统自动识别列，低置信会暂停等你确认" },
  { k: "QUOTA", label: "定额库", hint: "消耗量定额子目（定额编号/名称/人工费/材料费/机械费）" },
  { k: "GENERIC", label: "通用数据", hint: "其他参考资料，仅存储与画像，不导入行" },
] as const;

const cn = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(" ");

type CardPanel = "preview" | "prices" | "mapping";

const toggleBtn =
  "flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] text-neutral-500 hover:bg-[var(--hover)]";

function DatasetCard({
  d,
  onRefresh,
  autoPanel,
}: {
  d: DatasetDTO;
  onRefresh: () => void;
  autoPanel?: CardPanel;
}) {
  const [panel, setPanel] = useState<CardPanel | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  // 上传后低置信自动展开映射面板
  useEffect(() => {
    if (autoPanel) setPanel(autoPanel);
  }, [autoPanel]);

  const togglePanel = (p: CardPanel) => setPanel((cur) => (cur === p ? null : p));

  const togglePreview = async () => {
    if (panel !== "preview" && !preview) {
      const res = await fetch(`/api/admin/datasets/${d.id}`);
      if (res.ok) setPreview(await res.json());
    }
    togglePanel("preview");
  };

  const toggleActive = async () => {
    setBusy(true);
    try {
    const res = await fetch(`/api/admin/datasets/${d.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: !d.active }),
    });
    if (res.ok) {
      toast.success(d.active ? `已停用「${d.name}」— 匹配/测算不再引用` : `已启用「${d.name}」`);
      onRefresh();
    } else throw new Error("操作失败");
    } catch (error) { toast.error(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try {
    const res = await fetch(`/api/admin/datasets/${d.id}`, { method: "DELETE" });
    if (res.ok) {
      setConfirmDel(false);
      toast.success(`已删除数据集「${d.name}」`);
      onRefresh();
    } else {
      throw new Error("删除失败，请重试");
    }
    } catch (error) { toast.error(error instanceof Error ? error.message : "删除失败，请重试"); }
    finally { setBusy(false); }
  };

  const chevron = (p: CardPanel) => (
    <ChevronDown
      size={11}
      className={cn("transition-transform", panel === p && "rotate-180")}
    />
  );

  return (
    <div className={cn("overflow-hidden rounded-md border border-neutral-200 bg-[var(--surface)]", !d.active && "opacity-55")}>
      <div className="cost-dataset-row flex flex-wrap items-center gap-3 px-4 py-3">
        <FileSpreadsheet size={15} className="shrink-0 text-neutral-400" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{d.name}</div>
          <div className="mt-0.5 text-[11px] text-neutral-400">
            {d.filename} ·{" "}
            {d.status === "FAILED"
              ? "解析失败"
              : d.status === "PENDING"
                ? "待确认映射"
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
        <span className="rounded bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-500">{d.kindLabel}</span>
        {d.kind === "MATERIAL_PRICE" && d.status === "PENDING" && (
          <button
            onClick={() => togglePanel("mapping")}
            className="flex h-7 items-center gap-1 rounded-md px-3 text-[11.5px] font-medium text-white"
            style={{ background: "var(--brand-accent)" }}
          >
            <Check size={12} /> 确认映射
          </button>
        )}
        {d.kind === "MATERIAL_PRICE" && d.status === "PARSED" && (
          <>
            <button onClick={() => togglePanel("prices")} className={toggleBtn}>
              <Table size={11} /> 价格数据 {chevron("prices")}
            </button>
            <button onClick={() => togglePanel("mapping")} className={toggleBtn}>
              <Columns3 size={11} /> 列映射 {chevron("mapping")}
            </button>
          </>
        )}
        {d.kind === "QUOTA" && (
          <button onClick={togglePreview} className={toggleBtn}>
            预览 {chevron("preview")}
          </button>
        )}
        <button
          onClick={toggleActive}
          disabled={busy}
          role="switch"
          aria-checked={d.active}
          aria-label={`${d.name}参与匹配与测算`}
          className="flex h-5 w-9 items-center rounded-full px-0.5 transition-colors"
          style={{ background: d.active ? "var(--brand-accent)" : "var(--hairline-strong)" }}
          title={d.active ? "已启用 — 点击停用" : "已停用 — 点击启用"}
        >
          <span
            className={cn(
              "h-4 w-4 rounded-full bg-white shadow transition-transform",
              d.active && "translate-x-4"
            )}
          />
        </button>
        <button
          onClick={() => setConfirmDel(true)}
          disabled={busy}
          className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
          title="删除数据集"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={13} />}
        </button>
      </div>
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
                {preview.columns.map((c) => (
                  <th key={c}>{c}</th>
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
          {preview.total > preview.rows.length && (
            <div className="px-3 py-2 text-[11px] text-neutral-400">
              显示前 {preview.rows.length} 行，共 {preview.total} 行
            </div>
          )}
        </div>
      )}
      {panel === "prices" && d.kind === "MATERIAL_PRICE" && (
        <PriceRowsPanel datasetId={d.id} />
      )}
      {panel === "mapping" && (
        <DatasetMappingPanel
          datasetId={d.id}
          filename={d.filename}
          kind={d.kind}
          onClose={() => setPanel(null)}
          onIngested={onRefresh}
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

  const refresh = async () => {
    const res = await fetch("/api/admin/datasets");
    if (res.ok) setDatasets(await res.json());
  };

  const upload = async (f: File) => {
    if (busy) return;
    setBusy(true);
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
    finally { setBusy(false); }
  };

  const grouped = KINDS.filter(k => k.k === kind).map((k) => ({
    ...k,
    items: datasets.filter((d) => d.kind === k.k && `${d.name} ${d.filename}`.toLowerCase().includes(query.trim().toLowerCase())),
  }));

  return (
    <div className="cost-datasets mt-8 space-y-8">
      <nav className="cost-library-tabs" aria-label="共享数据类型">{KINDS.map(k => <button key={k.k} aria-current={kind === k.k ? "page" : undefined} className={kind === k.k ? "active" : ""} disabled={busy} onClick={() => { setKind(k.k); setQuery(""); }}><strong>{k.label}</strong><span>{datasets.filter(d => d.kind === k.k).length}</span></button>)}</nav>
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
            disabled={busy}
            className="ml-auto flex h-9 items-center gap-1.5 rounded-md px-4 text-[12.5px] font-medium text-white transition-all enabled:active:translate-y-px disabled:opacity-50"
            style={{ background: "var(--brand-accent)" }}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            上传{KINDS.find((k) => k.k === kind)?.label}
          </button>
        </div>
        {kind === "MATERIAL_PRICE" && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span className="text-[11.5px] text-neutral-400">整表默认值（可选）</span>
            <select
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
              value={defRegion}
              onChange={(e) => setDefRegion(e.target.value)}
              placeholder="地区"
              className="h-7 w-24 rounded-md border border-neutral-200 bg-white px-2 text-[11.5px] outline-none focus:border-[var(--brand-accent)]"
            />
            <input
              value={defPeriod}
              onChange={(e) => setDefPeriod(e.target.value)}
              placeholder="如 2024-06，留空自动从表/文件名识别"
              className="h-7 w-64 rounded-md border border-neutral-200 bg-white px-2 text-[11.5px] outline-none focus:border-[var(--brand-accent)]"
            />
            <input
              value={defBrand}
              onChange={(e) => setDefBrand(e.target.value)}
              placeholder="品牌（整表默认）"
              className="h-7 w-32 rounded-md border border-neutral-200 bg-white px-2 text-[11.5px] outline-none focus:border-[var(--brand-accent)]"
            />
          </div>
        )}
        <p className="mt-2.5 text-[11.5px] text-neutral-400">
          {KINDS.find((k) => k.k === kind)?.hint}
        </p>
      </div>

      {/* 分组列表 */}
      <label className="cost-search"><input aria-label="搜索数据集" placeholder="搜索数据集名称或文件名" value={query} onChange={e => setQuery(e.target.value)} /></label>
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
