"use client";
import { EmptyState } from "@/components/ui/empty-state";
import { useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { QuotationMatchRow, WorkspaceView } from "@shared/types";

import { cn, fmtMoney, Tip } from "./shared";

/* ---------------- 询价匹配 ---------------- */

const MATCH_STYLE: Record<string, BadgeVariant> = {
  MATCHED: "success",
  LOW_CONFIDENCE: "warning",
  UNMATCHED: "secondary",
};
const MATCH_LABEL: Record<string, string> = {
  MATCHED: "已匹配",
  LOW_CONFIDENCE: "低置信",
  UNMATCHED: "未询到价",
};

export function QuotationMatch({ view }: { view: Extract<WorkspaceView, { kind: "quotationMatch" }> }) {
  const [details, setDetails] = useState(false);
  return (
    <div className="view-content">
      <details className="cost-simple-more mb-3">
        <summary>更多信息</summary>
        <div className="cost-more-body">
          <Label className="text-xs">
            <Checkbox checked={details} onCheckedChange={(v) => setDetails(v === true)} />
            显示品牌和匹配评分
          </Label>
        </div>
      </details>
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
              <td className="max-w-48 truncate">
                <Tip tip={r.materialName}>{r.materialName}</Tip>
                {!details && (r.spec || r.brand) && (
                  <div className="truncate text-2xs text-muted-foreground">
                    <Tip tip={[r.spec, r.brand].filter(Boolean).join(" · ")}>
                      {[r.spec, r.brand].filter(Boolean).join(" · ")}
                    </Tip>
                  </div>
                )}
              </td>
              {details && <><td className="mono text-muted-foreground">{r.spec || "—"}</td><td className="text-muted-foreground">{r.brand || "—"}</td></>}
              <td className="mono text-right">{fmtMoney(r.price)}</td>
              <td className="max-w-64 truncate text-muted-foreground">
                <Tip tip={r.matchedNames.join("、")}>{r.matchedNames.join("、") || "—"}</Tip>
              </td>
              {details && <td className="mono text-muted-foreground">{r.confidence}</td>}
              <td>
                <Badge variant={MATCH_STYLE[r.status] ?? "secondary"}>{MATCH_LABEL[r.status]}</Badge>
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
