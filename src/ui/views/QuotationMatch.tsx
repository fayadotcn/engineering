"use client";
import { useState } from "react";
import type { QuotationMatchRow, WorkspaceView } from "@shared/types";
import { EmptyState } from "../primitives";
import { cn, fmtMoney } from "./shared";

/* ---------------- 询价匹配 ---------------- */

const MATCH_STYLE: Record<string, string> = {
  MATCHED: "ok",
  LOW_CONFIDENCE: "warn",
  UNMATCHED: "",
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
      <div className="xl-sheet overflow-auto rounded-lg">
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
              <td className="max-w-64 truncate text-neutral-600" title={r.matchedNames.join("、")}>
                {r.matchedNames.join("、") || "—"}
              </td>
              {details && <td className="mono text-neutral-500">{r.confidence}</td>}
              <td>
                <span className={cn("chip", MATCH_STYLE[r.status])}>{MATCH_LABEL[r.status]}</span>
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
