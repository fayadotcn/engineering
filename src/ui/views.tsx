"use client";
import { useMemo, useState } from "react";
import { useStore } from "./store";
import type {
  AnomalyRow,
  BreakdownSlice,
  DiffRow,
  QuotaResultRow,
  QuotationMatchRow,
  WorkspaceView,
} from "@shared/types";
import { DISCIPLINE_LABEL } from "@shared/types";
import { Download, FileSpreadsheet, AlertTriangle, GitCompareArrows } from "lucide-react";

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

/* ---------------- 清单表 ---------------- */

export function BoqTable() {
  const { items, patchItem } = useStore();
  const [editing, setEditing] = useState<{ id: string; field: "unitPrice" | "quantity" } | null>(null);
  const [draft, setDraft] = useState("");

  const commit = async () => {
    if (!editing) return;
    await patchItem(editing.id, { [editing.field]: draft });
    setEditing(null);
  };

  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-[12.5px]">
        <thead className="sticky top-0 z-10 bg-white">
          <tr className="border-b border-neutral-200 text-left text-neutral-500">
            <th className="w-10 px-2 py-1.5 font-normal">#</th>
            <th className="w-28 px-2 py-1.5 font-normal">项目编码</th>
            <th className="px-2 py-1.5 font-normal">项目名称</th>
            <th className="px-2 py-1.5 font-normal">项目特征</th>
            <th className="w-12 px-2 py-1.5 font-normal">单位</th>
            <th className="w-20 px-2 py-1.5 text-right font-normal">工程量</th>
            <th className="w-24 px-2 py-1.5 text-right font-normal">综合单价</th>
            <th className="w-28 px-2 py-1.5 text-right font-normal">合价</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) =>
            it.isHeader ? (
              <tr key={it.id} className="bg-neutral-50/80">
                <td colSpan={8} className="px-2 py-1.5 text-[12px] font-medium text-neutral-600">
                  {it.name}
                </td>
              </tr>
            ) : (
              <tr key={it.id} className="border-b border-neutral-100 hover:bg-neutral-50/60">
                <td className="px-2 py-1 text-neutral-400">{i + 1}</td>
                <td className="mono px-2 py-1 text-neutral-500">{it.code}</td>
                <td className="px-2 py-1">{it.name}</td>
                <td className="max-w-56 truncate px-2 py-1 text-neutral-500" title={it.rawFeature}>
                  {it.rawFeature}
                </td>
                <td className="px-2 py-1 text-neutral-500">{it.unit}</td>
                {(["quantity", "unitPrice"] as const).map((f) => (
                  <td
                    key={f}
                    className="mono cursor-pointer px-2 py-1 text-right hover:bg-blue-50/60"
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
                        className="w-20 rounded border border-blue-300 px-1 py-0 text-right text-[12px] outline-none"
                      />
                    ) : (
                      it[f]
                    )}
                  </td>
                ))}
                <td className="mono px-2 py-1 text-right">{fmtMoney(it.totalPrice)}</td>
              </tr>
            )
          )}
        </tbody>
      </table>
      {!items.length && (
        <div className="flex h-40 items-center justify-center text-xs text-neutral-400">
          清单为空 — 在左侧上传 Excel 清单文件
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
  return (
    <div className="h-full space-y-3 overflow-auto p-4">
      {view.rows.map((g: AnomalyRow, gi) => {
        const min = Math.min(...g.items.map((i) => Number(i.unitPrice)));
        const max = Math.max(...g.items.map((i) => Number(i.unitPrice)));
        return (
          <div key={gi} className="overflow-hidden rounded-md border border-neutral-200 bg-white">
            <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-2">
              <AlertTriangle size={13} className="text-amber-600" />
              <span className="text-[12.5px] font-medium">{g.label}</span>
              {g.spread && (
                <span className={cn("rounded px-1.5 py-0.5 text-[11px]", ANOMALY_BADGE[view.anomalyType])}>
                  价差 {fmtMoney(g.spread)}
                </span>
              )}
              <span className="ml-auto text-[11px] text-neutral-400">{g.reason}</span>
            </div>
            <table className="w-full text-[12px]">
              <tbody>
                {g.items.map((it) => {
                  const p = Number(it.unitPrice);
                  return (
                    <tr key={it.id} className="border-b border-neutral-50 last:border-0">
                      <td className="mono w-28 px-3 py-1.5 text-neutral-500">{it.code || "—"}</td>
                      <td className="px-2 py-1.5">{it.name}</td>
                      <td className="max-w-48 truncate px-2 py-1.5 text-neutral-500" title={it.feature}>
                        {it.feature}
                      </td>
                      <td className="w-10 px-2 py-1.5 text-neutral-500">{it.unit}</td>
                      <td className="mono w-16 px-2 py-1.5 text-right">{it.quantity}</td>
                      <td
                        className={cn(
                          "mono w-24 px-3 py-1.5 text-right font-medium",
                          p === max && max !== min && "text-red-600",
                          p === min && max !== min && "text-green-700"
                        )}
                      >
                        {fmtMoney(it.unitPrice)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
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
      <table className="w-full border-collapse text-[12.5px]">
        <thead className="sticky top-0 bg-white">
          <tr className="border-b border-neutral-200 text-left text-neutral-500">
            <th className="px-2 py-1.5 font-normal">询价材料</th>
            <th className="px-2 py-1.5 font-normal">规格</th>
            <th className="px-2 py-1.5 font-normal">品牌</th>
            <th className="px-2 py-1.5 text-right font-normal">询价</th>
            <th className="px-2 py-1.5 font-normal">匹配清单项</th>
            <th className="w-20 px-2 py-1.5 font-normal">置信度</th>
            <th className="w-20 px-2 py-1.5 font-normal">状态</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((r: QuotationMatchRow) => (
            <tr key={r.quotationItemId} className="border-b border-neutral-100">
              <td className="px-2 py-1.5">{r.materialName}</td>
              <td className="mono px-2 py-1.5 text-neutral-500">{r.spec || "—"}</td>
              <td className="px-2 py-1.5 text-neutral-500">{r.brand || "—"}</td>
              <td className="mono px-2 py-1.5 text-right">{fmtMoney(r.price)}</td>
              <td className="max-w-64 truncate px-2 py-1.5 text-neutral-600">
                {r.matchedNames.join("、") || "—"}
              </td>
              <td className="px-2 py-1.5">
                <div className="h-1 w-16 rounded bg-neutral-100">
                  <div
                    className={cn("h-1 rounded", r.confidence >= 60 ? "bg-green-500" : r.confidence >= 30 ? "bg-amber-400" : "bg-neutral-300")}
                    style={{ width: `${Math.min(r.confidence, 100)}%` }}
                  />
                </div>
              </td>
              <td className="px-2 py-1.5">
                <span className={cn("rounded px-1.5 py-0.5 text-[11px]", MATCH_STYLE[r.status])}>
                  {MATCH_LABEL[r.status]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
  const byItem = useMemo(() => {
    const m = new Map<string, DiffRow[]>();
    view.rows.forEach((r) => {
      const arr = m.get(r.itemId) ?? [];
      arr.push(r);
      m.set(r.itemId, arr);
    });
    return [...m.entries()];
  }, [view.rows]);

  return (
    <div className="h-full space-y-3 overflow-auto p-4">
      {byItem.map(([itemId, rows]) => (
        <div key={itemId} className="overflow-hidden rounded-md border border-neutral-200 bg-white">
          <div className="border-b border-neutral-100 px-3 py-1.5 text-[12px] font-medium">
            {rows[0].code && <span className="mono mr-2 text-neutral-400">{rows[0].code}</span>}
            {rows[0].name}
          </div>
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-1 text-[12px]">
              <GitCompareArrows size={12} className="text-neutral-400" />
              <span className="w-16 text-neutral-500">{FIELD_LABEL[r.field] ?? r.field}</span>
              <span className="mono rounded bg-red-50 px-1.5 text-red-700 line-through">{r.before}</span>
              <span className="text-neutral-300">→</span>
              <span className="mono rounded bg-green-50 px-1.5 text-green-700">{r.after}</span>
            </div>
          ))}
        </div>
      ))}
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
      <table className="w-full border-collapse text-[12.5px]">
        <thead className="sticky top-0 bg-white">
          <tr className="border-b border-neutral-200 text-left text-neutral-500">
            <th className="px-2 py-1.5 font-normal">清单项</th>
            <th className="px-2 py-1.5 font-normal">定额子目</th>
            <th className="px-2 py-1.5 text-right font-normal">人工</th>
            <th className="px-2 py-1.5 text-right font-normal">辅材</th>
            <th className="px-2 py-1.5 text-right font-normal">机械</th>
            <th className="px-2 py-1.5 text-right font-normal">主材</th>
            <th className="px-2 py-1.5 text-right font-normal">管+利</th>
            <th className="px-2 py-1.5 text-right font-normal">测算价</th>
            <th className="px-2 py-1.5 text-right font-normal">清单价</th>
            <th className="px-2 py-1.5 text-right font-normal">偏差</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((r) => (
            <tr key={r.itemId} className="border-b border-neutral-100">
              <td className="max-w-40 truncate px-2 py-1.5" title={r.name}>{r.name}</td>
              <td className="px-2 py-1.5 text-neutral-500">
                {r.quotaCode ? <span className="mono text-[11px]">{r.quotaCode}</span> : "—"}
              </td>
              <td className="mono px-2 py-1.5 text-right">{r.labor ?? "—"}</td>
              <td className="mono px-2 py-1.5 text-right">{r.materialAux ?? "—"}</td>
              <td className="mono px-2 py-1.5 text-right">{r.machine ?? "—"}</td>
              <td className="mono px-2 py-1.5 text-right">
                {r.needsMainPrice ? <span className="text-amber-600">缺主材价</span> : r.mainMaterial ?? "—"}
              </td>
              <td className="mono px-2 py-1.5 text-right">{r.fee ?? "—"}</td>
              <td className="mono px-2 py-1.5 text-right font-medium">{r.calcPrice ?? "—"}</td>
              <td className="mono px-2 py-1.5 text-right text-neutral-500">{fmtMoney(r.listPrice)}</td>
              <td className={cn(
                "mono px-2 py-1.5 text-right",
                r.deviation !== null && Math.abs(Number(r.deviation)) > 20 && "font-medium text-red-600"
              )}>
                {r.deviation !== null ? `${Number(r.deviation) > 0 ? "+" : ""}${r.deviation}%` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!view.rows.length && (
        <div className="flex h-40 items-center justify-center text-xs text-neutral-400">
          没有可测算的清单项
        </div>
      )}
    </div>
  );
}

/* ---------------- 事实台账 ---------------- */

export function FactList() {
  const { facts } = useStore();
  return (
    <div className="h-full overflow-auto p-4">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-neutral-500">
            <th className="px-2 py-1.5 font-normal">类型</th>
            <th className="px-2 py-1.5 font-normal">键</th>
            <th className="px-2 py-1.5 font-normal">值</th>
            <th className="px-2 py-1.5 font-normal">来源</th>
          </tr>
        </thead>
        <tbody>
          {facts.map((f) => (
            <tr key={f.id} className="border-b border-neutral-100">
              <td className="px-2 py-1.5 text-neutral-500">{f.factType}</td>
              <td className="px-2 py-1.5">{f.key}</td>
              <td className="px-2 py-1.5">{f.value}</td>
              <td className="px-2 py-1.5">
                <span className={cn("rounded px-1.5 py-0.5 text-[11px]", f.source === "INFERRED" ? "bg-amber-50 text-amber-700" : "bg-neutral-100 text-neutral-500")}>
                  {SOURCE_LABEL[f.source] ?? f.source}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
      <div className="w-80 rounded-lg border border-neutral-200 bg-white p-5">
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
  const { files } = useStore();
  return (
    <div className="h-full space-y-px overflow-auto p-4">
      {files.map((f) => (
        <div key={f.id} className="flex items-center gap-3 rounded-md border border-neutral-100 bg-white px-3 py-2 text-[12.5px]">
          <FileSpreadsheet size={14} className="text-neutral-400" />
          <span>{f.filename}</span>
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500">{f.kindLabel}</span>
          <span className="ml-auto text-[11px] text-neutral-400">{f.status}</span>
        </div>
      ))}
      {!files.length && (
        <div className="flex h-40 items-center justify-center text-xs text-neutral-400">还没有文件</div>
      )}
    </div>
  );
}
