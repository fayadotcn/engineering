"use client";
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useStore } from "../store";
import type { WorkspaceView } from "@shared/types";
import { cn, fmtMoney, Tip } from "./shared";
import { FeeWaterfall } from "../FeeWaterfall";

/* ---------------- 费用汇总表（取费） ---------------- */

export function FeeSummaryView({ view }: { view: Extract<WorkspaceView, { kind: "feeSummary" }> }) {
  const { send } = useStore();
  const [details, setDetails] = useState(false);
  return (
    <div className="view-content">
      {view.unpricedCount > 0 && (
        <Alert variant="warning" className="mb-3">
          <AlertTriangle />
          <AlertTitle>还有 {view.unpricedCount} 项未报价，以下总价尚不完整</AlertTitle>
          <AlertDescription>在清单页补齐未报价项，或让助手一键报价。</AlertDescription>
        </Alert>
      )}
      {view.issues?.filter((i) => i.label !== "清单未定价").map((i) => (
        <Alert key={i.label} variant={i.level === "error" ? "destructive" : "warning"} className="mb-3">
          <AlertTriangle />
          <AlertTitle>{i.label}</AlertTitle>
          <AlertDescription>{i.detail}</AlertDescription>
        </Alert>
      ))}
      <div className="xl-sheet mb-3 rounded-lg px-4 pb-2.5 pt-3">
        <FeeWaterfall rows={view.rows} grandTotal={view.grandTotal}
          onFix={() => void send?.("帮我完善计价设置，把还没计取的费用（措施费、规费、税金等）算出来，重新汇总费用")} />
      </div>
      <details className="cost-simple-more mb-3">
        <summary>更多信息</summary>
        <div className="cost-more-body">
          <Label className="text-xs">
            <Checkbox checked={details} onCheckedChange={(v) => setDetails(v === true)} />
            显示计算基础和费率
          </Label>
        </div>
      </details>
      <div className="xl-sheet overflow-auto rounded-lg">
        <table className="xl-table table-fixed">
          <thead>
            <tr>
              <th className="w-16 text-center">序号</th>
              <th>费用名称</th>
              {details && <><th>计算基础</th><th className="w-20 text-right">费率</th></>}
              <th className="w-32 text-right">金额（元）</th>
              <th className="w-40">备注</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r) => (
              <tr
                key={r.seq}
                style={
                  r.level === "total"
                    ? { background: "color-mix(in srgb, var(--primary) 8%, var(--card))" }
                    : r.level === "subtotal"
                      ? { background: "var(--muted)" }
                      : undefined
                }
              >
                <td className="text-center text-muted-foreground">{r.seq}</td>
                <td className={cn("truncate", r.level !== "leaf" && "font-medium")}><Tip tip={r.name}>{r.name}</Tip></td>
                {details && <><td className="truncate text-muted-foreground"><Tip tip={r.basis}>{r.basis}</Tip></td><td className="mono text-right">{r.rate ?? "—"}</td></>}
                <td className={cn("mono text-right", r.level === "total" && "text-sm font-semibold", r.level === "subtotal" && "font-medium")}>
                  {fmtMoney(r.amount)}
                </td>
                <td className="truncate text-2xs text-muted-foreground"><Tip tip={r.note}>{r.note ?? ""}</Tip></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {view.indicators?.length ? (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {view.indicators.map((i) => (
            <Badge variant="secondary" key={i.label} >{i.label} <b className="mono font-medium">{i.value}</b></Badge>
          ))}
        </div>
      ) : null}
      <div className="mt-3 flex items-baseline justify-end gap-2 text-xs text-muted-foreground">
        含税工程造价
        <span className="font-[var(--font-display)] text-xl font-medium tabular-nums" style={{ color: "var(--foreground)" }}>
          {fmtMoney(view.grandTotal)}
        </span>
        元
      </div>
    </div>
  );
}
