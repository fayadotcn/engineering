"use client";
import { EmptyState } from "@/components/ui/empty-state";
import { Fragment, type ComponentProps } from "react";
import { useStore } from "../store";
import type { AnomalyRow, WorkspaceView } from "@shared/types";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn, fmtMoney, displayFeature, Tip, TipEl } from "./shared";

/* ---------------- 异常表 ---------------- */

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>["variant"]>;
const ANOMALY_BADGE: Record<string, BadgeVariant> = {
  SAME_ITEM_DIFF_PRICE: "danger",
  PRICE_ANOMALY: "warning",
  FEATURE_MISMATCH: "info",
  DUPLICATE: "secondary",
  ARITHMETIC: "danger",
  UNIT_INCONSISTENT: "danger",
  CODE_MISMATCH: "warning",
  INVALID_CODE: "warning",
  MISSING_CODE: "warning",
  DATA_QUALITY: "danger",
  OWNER_SUPPLIED: "danger",
};

export function AnomalyTable({ view }: { view: Extract<WorkspaceView, { kind: "anomalyTable" }> }) {
  const { gotoBoqItem } = useStore();
  let rn = 0;
  return (
    <div className="view-content">
      <div className="xl-sheet overflow-auto rounded-lg">
        <table className="xl-table xl-pin-last table-fixed">
          <thead>
            <tr>
              <th className="xl-rn"></th>
              <th className="w-24">项目编码</th>
              <th>项目名称 / 特征</th>
              <th className="w-10">单位</th>
              <th className="w-16 text-right">工程量</th>
              <th className="w-24 text-right">综合单价</th>
              <th className="w-12"></th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((g: AnomalyRow, gi) => {
              const min = Math.min(...g.items.map((i) => Number(i.unitPrice)));
              const max = Math.max(...g.items.map((i) => Number(i.unitPrice)));
              return (
                <Fragment key={gi}>
                  <tr className="xl-group">
                    <td className="xl-rn"></td>
                    <td colSpan={6}>
                      <div className="flex items-center gap-2">
                        <AlertTriangle size={12} className="shrink-0 text-[var(--warning-soft-fg)]" />
                        <span className="shrink-0">{g.label}</span>
                        {g.spread && (
                          <Badge variant={ANOMALY_BADGE[view.anomalyType] ?? "secondary"} className="shrink-0">
                            价差 {fmtMoney(g.spread)}
                          </Badge>
                        )}
                        <span className="ml-auto truncate pr-1 text-2xs font-normal text-muted-foreground"><Tip tip={g.reason}>{g.reason}</Tip></span>
                      </div>
                    </td>
                  </tr>
                  {g.items.map((it) => {
                    const p = Number(it.unitPrice);
                    const feature = displayFeature(it.feature, it.name);
                    rn += 1;
                    return (
                      <tr key={it.id} className="group">
                        <td className="xl-rn">{rn}</td>
                        <td className="mono truncate text-muted-foreground"><Tip tip={it.code}>{it.code || "—"}</Tip></td>
                        <td className="overflow-hidden">
                          <div className="truncate"><Tip tip={it.name}>{it.name}</Tip></div>
                          {feature && <div className="truncate text-2xs text-muted-foreground"><Tip tip={feature}>{feature}</Tip></div>}
                        </td>
                        <td className="truncate text-muted-foreground"><Tip tip={it.unit}>{it.unit}</Tip></td>
                        <td className="mono text-right">{it.quantity}</td>
                        <td
                          className={cn(
                            "mono text-right font-medium",
                            p === max && max !== min && "text-[var(--destructive-soft-fg)]",
                            p === min && max !== min && "text-[var(--success-soft-fg)]"
                          )}
                        >
                          {fmtMoney(it.unitPrice)}
                        </td>
                        <td className="w-12 text-center">
                          <TipEl tip="在清单中定位">
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() => gotoBoqItem(it.code || it.name)}
                            >
                              定位
                            </Button>
                          </TipEl>
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {!view.rows.length && <EmptyState title="未发现异常" />}
    </div>
  );
}
