"use client";
import { EmptyState } from "@/components/ui/empty-state";
import { useEffect, useRef, useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { AlertTriangle, Database, FileSpreadsheet, Search, Upload } from "lucide-react";
import { toast } from "../primitives";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readResponse } from "../api";
import { priceTypeLabel } from "../terms";
import { Tip, TipEl } from "./shared";

interface DatasetRow {
  id: string;
  kind: string;
  kindLabel: string;
  name: string;
  filename: string;
  status: string;
  active: boolean;
  rowCount: number;
  materialRows: number;
  quotaRows: number;
  createdAt: string;
}

interface PriceRow {
  name: string;
  spec: string;
  unit: string;
  brand: string;
  price: string;
  priceType: string;
  region: string;
  period: string;
  source: string;
}

const STATUS_LABEL: Record<string, { label: string; cls: BadgeVariant }> = {
  PARSED: { label: "已入库", cls: "success" },
  PENDING: { label: "待核对", cls: "warning" },
  FAILED: { label: "失败", cls: "danger" },
};

const fmtMoney = (v: string | number) => {
  const n = Number(v);
  if (isNaN(n)) return String(v);
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** 共享价格库：所有用户上传的材料价/人工费都进这一个池子，每个项目的组价都从这里取。 */
export function PriceLibraryView() {
  const [datasets, setDatasets] = useState<DatasetRow[] | null>(null);
  /** 加载失败与「空库」是两件事：失败时 datasets 保持 null（未知），错误单独记，
   *  否则界面会显示「价格库还是空的 / 上传第一份价格表」，把故障伪装成没数据。 */
  const [listError, setListError] = useState<string | null>(null);
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [rowError, setRowError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [region, setRegion] = useState("");
  const [period, setPeriod] = useState("");
  const [brand, setBrand] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = async () => {
    try {
      const list = await readResponse<DatasetRow[]>(await fetch("/api/admin/datasets"), "加载数据集失败");
      setDatasets(list);
      setListError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : "加载数据集失败";
      setListError(message);
      toast.error(message);
    }
  };

  const search = async (query: string) => {
    setSearching(true);
    try {
      const res = await readResponse<{ rows: PriceRow[] }>(
        await fetch(`/api/prices?q=${encodeURIComponent(query)}`),
        "搜索失败，请重试"
      );
      setRows(res.rows);
      setRowError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : "搜索失败";
      setRowError(message);
      toast.error(message);
    } finally {
      setSearching(false);
    }
  };

  useEffect(() => {
    void refresh();
    void search("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => void search(q), 300);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const upload = async (file: File) => {
    if (uploading) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("filename", file.name);
      fd.set("kind", "MATERIAL_PRICE");
      if (region.trim()) fd.set("region", region.trim());
      if (period.trim()) fd.set("period", period.trim());
      if (brand.trim()) fd.set("brand", brand.trim());
      const res = await readResponse<{ id: string; rowCount: number; status: string; duplicate?: boolean }>(
        await fetch("/api/admin/datasets", { method: "POST", body: fd }),
        "上传失败，请重试"
      );
      if (res.duplicate) toast.info("这份表格的内容已经在库里了，没有重复导入");
      else if (res.status === "PARSED") toast.success(`已入库 ${res.rowCount} 条价格，所有项目都能用`);
      else toast.info("已收到表格，还差一步确认列识别，请到「数据管理」核对一下");
      await Promise.all([refresh(), search(q)]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "上传失败，请重试");
    } finally {
      setUploading(false);
    }
  };

  const priceCount = (datasets ?? []).reduce((n, d) => n + d.materialRows, 0);
  const quotaCount = (datasets ?? []).reduce((n, d) => n + d.quotaRows, 0);
  const pendingCount = (datasets ?? []).filter((d) => d.status === "PENDING").length;

  return (
    <div className="view-content">
      <header className="view-heading"><div><span className="page-eyebrow">各工程共享的价格依据</span><h2>材料价格</h2><p>按名称、规格或品牌搜索，核对价格来源与期次。</p></div></header>

      <div className="library-upload mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <Database size={15} className="text-muted-foreground" />
          <span className="text-sm font-medium">贡献一份价格表</span>
          <span className="text-2xs text-muted-foreground">Excel / CSV 都行，系统自动识别列</span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            aria-label="地区（可选）"
            placeholder="地区，如 四川"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            className="w-28"
          />
          <Input
            aria-label="期次（可选）"
            placeholder="期次，如 2026-09"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="w-32"
          />
          <Input
            aria-label="品牌（可选）"
            placeholder="品牌（可选）"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            className="w-28"
          />
          <Button
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            <Upload size={13} />
            {uploading ? "正在上传…" : "选择价格表上传"}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".xls,.xlsx,.csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="搜索材料价格"
            placeholder="搜材料名、规格或品牌，如 电缆、DN100"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-72 pl-7"
          />
        </div>
        <span className="text-2xs text-muted-foreground">
          {listError ? (
            "价格库统计暂时读不出来"
          ) : (
            <>库里共 {priceCount.toLocaleString()} 条价格{quotaCount ? `、${quotaCount.toLocaleString()} 条定额` : ""}</>
          )}
          {searching ? " · 搜索中…" : ""}
        </span>
      </div>

      {rows.length > 0 && (
        <div className="xl-sheet mb-4 overflow-auto rounded-lg">
          <table className="xl-table">
            <thead>
              <tr>
                <th className="xl-rn"></th>
                <th>名称</th>
                <th>规格型号</th>
                <th className="w-14">单位</th>
                <th className="w-24">品牌</th>
                <th className="w-24 text-right">价格（元）</th>
                <th className="w-20">地区</th>
                <th className="w-20">期次</th>
                <th className="w-16">类型</th>
                <th>来源</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="xl-rn">{i + 1}</td>
                  <td className="max-w-56 truncate"><Tip tip={r.name}>{r.name}</Tip></td>
                  <td className="max-w-48 truncate text-muted-foreground"><Tip tip={r.spec === r.name ? undefined : r.spec}>{r.spec === r.name ? "" : r.spec}</Tip></td>
                  <td className="text-muted-foreground">{r.unit}</td>
                  <td className="max-w-24 truncate text-muted-foreground"><Tip tip={r.brand}>{r.brand}</Tip></td>
                  <td className="mono text-right font-medium">{fmtMoney(r.price)}</td>
                  <td className="max-w-20 truncate text-muted-foreground"><Tip tip={r.region}>{r.region}</Tip></td>
                  <td className="text-muted-foreground">{r.period}</td>
                  <td>
                    <Badge size="xs" variant="secondary">
                      {priceTypeLabel(r.priceType) || "—"}
                    </Badge>
                  </td>
                  <td className="max-w-40 truncate text-2xs text-muted-foreground"><Tip tip={r.source}>{r.source}</Tip></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rowError && (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangle />
          <AlertTitle>价格搜索失败，下面不是搜索结果</AlertTitle>
          <AlertDescription>
            {rowError}
            <Button variant="outline" size="xs" onClick={() => void search(q)}>
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {listError ? (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangle />
          <AlertTitle>价格库加载失败</AlertTitle>
          <AlertDescription>
            {listError}——这不代表库里没有数据，重试一次再看。
            <Button variant="outline" size="xs" onClick={() => void refresh()}>
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        rows.length === 0 &&
        !searching &&
        !rowError &&
        datasets !== null && (
          <EmptyState
            icon={<Search size={22} />}
            title={q ? "没搜到相关价格" : datasets.length ? "这些表还没解析出价格行" : "价格库还是空的"}
            hint={
              q
                ? "换个关键词试试，或者上传一份包含它的价格表"
                : datasets.length
                  ? "表已收到但还没有价格行入库——去「数据管理」核对列识别后重导"
                  : "上传第一份价格表，后面的项目就能直接用它组价"
            }
          />
        )
      )}

      {(datasets ?? []).length > 0 && (
        <>
          <div className="mb-2 mt-5 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">已收集的数据表</span>
            {pendingCount > 0 && (
              <a href="/admin" className="text-2xs text-[var(--foreground)] hover:underline">
                {pendingCount} 份待核对列识别，去数据管理处理 →
              </a>
            )}
          </div>
          <div className="xl-sheet overflow-auto rounded-lg">
            <table className="xl-table">
              <thead>
                <tr>
                  <th className="xl-rn"></th>
                  <th>数据表</th>
                  <th className="w-24">类型</th>
                  <th className="w-20 text-right">行数</th>
                  <th className="w-20">状态</th>
                  <th className="w-28">上传时间</th>
                </tr>
              </thead>
              <tbody>
                {(datasets ?? []).map((d, i) => (
                  <tr key={d.id} className={!d.active ? "opacity-50" : undefined}>
                    <td className="xl-rn">{i + 1}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <FileSpreadsheet size={13} className="shrink-0 text-muted-foreground" />
                        <span className="max-w-72 truncate"><Tip tip={d.filename}>{d.name}</Tip></span>
                        {!d.active && <span className="text-2xs text-muted-foreground">（已停用）</span>}
                      </div>
                    </td>
                    <td>
                      <Badge variant="secondary" >{d.kindLabel}</Badge>
                    </td>
                    <td className="mono text-right text-muted-foreground">
                      {(d.materialRows || d.quotaRows || d.rowCount).toLocaleString()}
                    </td>
                    <td>
                      <Badge variant={STATUS_LABEL[d.status]?.cls ?? "secondary"}>
                        {STATUS_LABEL[d.status]?.label ?? d.status}
                      </Badge>
                    </td>
                    <td className="text-2xs text-muted-foreground">
                      {new Date(d.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
