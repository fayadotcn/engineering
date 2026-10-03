"use client";
import type { WorkspaceView } from "@shared/types";
import { EmptyState } from "../primitives";
import { FIELD_LABEL } from "./shared";

/* ---------------- Diff ---------------- */

export function DiffView({ view }: { view: Extract<WorkspaceView, { kind: "diff" }> }) {
  return (
    <div className="h-full overflow-auto p-4">
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
                <td className="mono text-neutral-500">{r.code || "—"}</td>
                <td className="max-w-56 truncate" title={r.name}>{r.name}</td>
                <td className="text-neutral-500">{FIELD_LABEL[r.field] ?? r.field}</td>
                <td className="mono text-right">
                  <span className="chip danger line-through">{r.before}</span>
                </td>
                <td className="mono text-right">
                  <span className="chip ok">{r.after}</span>
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
