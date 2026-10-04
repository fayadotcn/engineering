"use client";
import { useEffect, useRef, useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Database, FileSpreadsheet, Search, Upload } from "lucide-react";
import { EmptyState, toast } from "../primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readResponse } from "../api";

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

const PRICE_TYPE_LABEL: Record<string, string> = {
  INFO: "信息价",
  MARKET: "市场价",
  SUPPLY: "供应价",
  LABOR: "人工费",
};

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
  const [rows, setRows] = useState<PriceRow[]>([]);
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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "加载数据集失败");
      setDatasets([]);
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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "搜索失败");
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
    <div className="h-full overflow-auto p-4">
      <p className="cost-file-hint">
        这里是大家共用的材料价和人工费，上传一次，所有人的项目组价都能用上它。
      </p>

      <div className="xl-sheet mb-4 rounded-lg p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Database size={15} className="text-muted-foreground" />
          <span className="text-[13px] font-medium">贡献一份价格表</span>
          <span className="text-[11px] text-muted-foreground">Excel / CSV 都行，系统自动识别列</span>
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
        <span className="text-[11px] text-muted-foreground">
          库里共 {priceCount.toLocaleString()} 条价格{quotaCount ? `、${quotaCount.toLocaleString()} 条定额` : ""}
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
                  <td className="max-w-56 truncate" title={r.name}>{r.name}</td>
                  <td className="max-w-48 truncate text-muted-foreground" title={r.spec}>{r.spec === r.name ? "" : r.spec}</td>
                  <td className="text-muted-foreground">{r.unit}</td>
                  <td className="max-w-24 truncate text-muted-foreground" title={r.brand}>{r.brand}</td>
                  <td className="mono text-right font-medium">{fmtMoney(r.price)}</td>
                  <td className="max-w-20 truncate text-muted-foreground" title={r.region}>{r.region}</td>
                  <td className="text-muted-foreground">{r.period}</td>
                  <td>
                    <Badge variant="secondary" className="!py-px !text-[10px]" >
                      {PRICE_TYPE_LABEL[r.priceType] ?? r.priceType ?? "—"}
                    </Badge>
                  </td>
                  <td className="max-w-40 truncate text-[11px] text-muted-foreground" title={r.source}>{r.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length === 0 && !searching && datasets !== null && (
        <EmptyState
          icon={<Search size={22} />}
          title={q ? "没搜到相关价格" : "价格库还是空的"}
          hint={q ? "换个关键词试试，或者上传一份包含它的价格表" : "上传第一份价格表，后面的项目就能直接用它组价"}
        />
      )}

      {(datasets ?? []).length > 0 && (
        <>
          <div className="mb-2 mt-5 flex items-center justify-between">
            <span className="text-[12px] font-medium text-muted-foreground">已收集的数据表</span>
            {pendingCount > 0 && (
              <a href="/admin" className="text-[11.5px] text-[var(--foreground)] hover:underline">
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
                        <span className="max-w-72 truncate" title={d.filename}>{d.name}</span>
                        {!d.active && <span className="text-[10px] text-muted-foreground">（已停用）</span>}
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
                    <td className="text-[11px] text-muted-foreground">
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
