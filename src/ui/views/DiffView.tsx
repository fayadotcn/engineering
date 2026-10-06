"use client";
import { EmptyState } from "@/components/ui/empty-state";
import type { WorkspaceView } from "@shared/types";
import { Badge, type BadgeVariant } from "@/components/ui/badge";

import { FIELD_LABEL, Tip } from "./shared";

/* ---------------- Diff ---------------- */

export function DiffView({ view }: { view: Extract<WorkspaceView, { kind: "diff" }> }) {
  return (
    <div className="view-content">
      <div className="xl-sheet overflow-auto rounded-lg">
        <table className="xl-table xl-pin-last">
          <thead>
            <tr>
              <th className="xl-rn"></th>
              <th className="w-28">编码</th>
              <th>名称</th>
              <th className="w-20">字段</th>
              <th className="w-32 text-right">修改前</th>
              <th className="w-32 text-right">修改后</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r, i) => (
              <tr key={i}>
                <td className="xl-rn">{i + 1}</td>
                <td className="mono text-muted-foreground">{r.code || "—"}</td>
                <td className="max-w-56 truncate"><Tip tip={r.name}>{r.name}</Tip></td>
                <td className="text-muted-foreground">{FIELD_LABEL[r.field] ?? r.field}</td>
                <td className="mono text-right">
                  <Badge variant="danger" className="line-through" >{r.before}</Badge>
                </td>
                <td className="mono text-right">
                  <Badge variant="success" >{r.after}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!view.rows.length && <EmptyState title="无变化" />}
    </div>
  );
}
