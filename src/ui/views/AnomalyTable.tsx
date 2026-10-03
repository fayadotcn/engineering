"use client";
import { Fragment } from "react";
import { useStore } from "../store";
import type { AnomalyRow, WorkspaceView } from "@shared/types";
import { AlertTriangle } from "lucide-react";
import { EmptyState } from "../primitives";
import { cn, fmtMoney, displayFeature } from "./shared";

/* ---------------- 异常表 ---------------- */

const ANOMALY_BADGE: Record<string, string> = {
  SAME_ITEM_DIFF_PRICE: "danger",
  PRICE_ANOMALY: "warn",
  FEATURE_MISMATCH: "info",
  DUPLICATE: "",
};

export function AnomalyTable({ view }: { view: Extract<WorkspaceView, { kind: "anomalyTable" }> }) {
  const { gotoBoqItem } = useStore();
  let rn = 0;
  return (
    <div className="h-full overflow-auto p-4">
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
                        <AlertTriangle size={12} className="shrink-0 text-amber-600" />
                        <span className="shrink-0">{g.label}</span>
                        {g.spread && (
                          <span className={cn("chip shrink-0", ANOMALY_BADGE[view.anomalyType])}>
                            价差 {fmtMoney(g.spread)}
                          </span>
                        )}
                        <span className="ml-auto truncate pr-1 text-[11px] font-normal text-neutral-400" title={g.reason}>{g.reason}</span>
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
                        <td className="mono truncate text-neutral-500" title={it.code ?? ""}>{it.code || "—"}</td>
                        <td className="overflow-hidden">
                          <div className="truncate" title={it.name}>{it.name}</div>
                          {feature && <div className="truncate text-[11px] text-neutral-400" title={feature}>{feature}</div>}
                        </td>
                        <td className="truncate text-neutral-500" title={it.unit}>{it.unit}</td>
                        <td className="mono text-right">{it.quantity}</td>
                        <td
                          className={cn(
                            "mono text-right font-medium",
                            p === max && max !== min && "text-red-600",
                            p === min && max !== min && "text-green-700"
                          )}
                        >
                          {fmtMoney(it.unitPrice)}
                        </td>
                        <td className="w-12 text-center">
                          <button
                            onClick={() => gotoBoqItem(it.code || it.name)}
                            className="cost-btn sm ghost"
                            title="在清单中定位"
                          >
                            定位
                          </button>
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
