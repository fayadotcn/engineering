"use client";
import { useRef, useState } from "react";
import { ChevronDown, FileSpreadsheet, Loader2, Trash2, Upload } from "lucide-react";

interface DatasetDTO {
  id: string;
  kind: string;
  kindLabel: string;
  name: string;
  filename: string;
  status: string;
  rowCount: number;
  createdAt: string;
}

interface Preview {
  columns: string[];
  rows: string[][];
  total: number;
}

const KINDS = [
  { k: "MATERIAL_PRICE", label: "材料价格库", hint: "信息价/市场价/供应商报价，定额测算与材料匹配会引用" },
  { k: "QUOTA", label: "定额库", hint: "消耗量定额子目（定额编号/名称/人工费/材料费/机械费）" },
  { k: "GENERIC", label: "通用数据", hint: "其他参考资料，仅存储与画像，不导入行" },
] as const;

const cn = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(" ");

function DatasetCard({ d, onDeleted }: { d: DatasetDTO; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (!open && !preview && d.kind !== "GENERIC") {
      const res = await fetch(`/api/admin/datasets/${d.id}`);
      if (res.ok) setPreview(await res.json());
    }
    setOpen(!open);
  };

  const remove = async () => {
    if (!confirm(`删除数据集「${d.name}」及其导入的全部 ${d.rowCount} 行数据？`)) return;
    setBusy(true);
    await fetch(`/api/admin/datasets/${d.id}`, { method: "DELETE" });
    onDeleted();
  };

  return (
    <div className="overflow-hidden rounded-xl border border-neutral-200 bg-[var(--surface)]">
      <div className="flex items-center gap-3 px-4 py-3">
        <FileSpreadsheet size={15} className="shrink-0 text-neutral-400" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{d.name}</div>
          <div className="mt-0.5 text-[11px] text-neutral-400">
            {d.filename} · {d.status === "FAILED" ? "解析失败" : `${d.rowCount} 行`} · {d.createdAt.slice(0, 10)}
          </div>
        </div>
        <span className="rounded bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-500">{d.kindLabel}</span>
        {d.kind !== "GENERIC" && (
          <button
            onClick={toggle}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] text-neutral-500 hover:bg-[var(--hover)]"
          >
            预览
            <ChevronDown size={11} className={cn("transition-transform", open && "rotate-180")} />
          </button>
        )}
        <button
          onClick={remove}
          disabled={busy}
          className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
          title="删除数据集"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={13} />}
        </button>
      </div>
      {open && preview && (
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
    </div>
  );
}

export function DatasetManager({ initial }: { initial: DatasetDTO[] }) {
  const [datasets, setDatasets] = useState(initial);
  const [kind, setKind] = useState<(typeof KINDS)[number]["k"]>("MATERIAL_PRICE");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    const res = await fetch("/api/admin/datasets");
    if (res.ok) setDatasets(await res.json());
  };

  const upload = async (f: File) => {
    setBusy(true);
    const fd = new FormData();
    fd.append("file", f);
    fd.append("filename", f.name);
    fd.append("kind", kind);
    const res = await fetch("/api/admin/datasets", { method: "POST", body: fd });
    setBusy(false);
    if (!res.ok) { alert("上传失败"); return; }
    await refresh();
  };

  const grouped = KINDS.map((k) => ({
    ...k,
    items: datasets.filter((d) => d.kind === k.k),
  }));

  return (
    <div className="mt-8 space-y-8">
      {/* 上传区 */}
      <div className="rounded-xl border border-neutral-200 bg-[var(--surface)] p-4">
        <div className="flex flex-wrap items-center gap-2">
          {KINDS.map((k) => (
            <button
              key={k.k}
              onClick={() => setKind(k.k)}
              className={cn(
                "rounded-full border px-3.5 py-1.5 text-[12.5px] transition-colors",
                kind === k.k
                  ? "border-transparent text-white"
                  : "border-neutral-200 text-neutral-600 hover:bg-[var(--hover)]"
              )}
              style={kind === k.k ? { background: "var(--brand-accent)" } : undefined}
            >
              {k.label}
            </button>
          ))}
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
            className="ml-auto flex h-9 items-center gap-1.5 rounded-full px-4 text-[12.5px] font-medium text-white transition-all enabled:active:translate-y-px disabled:opacity-50"
            style={{ background: "var(--brand-accent)" }}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            上传{KINDS.find((k) => k.k === kind)?.label}
          </button>
        </div>
        <p className="mt-2.5 text-[11.5px] text-neutral-400">
          {KINDS.find((k) => k.k === kind)?.hint}
        </p>
      </div>

      {/* 分组列表 */}
      {grouped.map((g) => (
        <section key={g.k}>
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="text-[13.5px] font-medium">{g.label}</h2>
            <span className="text-[11px] text-neutral-400">{g.items.length} 个数据集</span>
          </div>
          <div className="space-y-2">
            {g.items.map((d) => (
              <DatasetCard key={d.id} d={d} onDeleted={refresh} />
            ))}
            {!g.items.length && (
              <div className="rounded-xl border border-dashed border-neutral-300 px-4 py-6 text-center text-[12px] text-neutral-400">
                暂无数据
              </div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
