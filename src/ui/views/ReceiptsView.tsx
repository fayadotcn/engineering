"use client";
import { useState } from "react";
import { useStore } from "../store";
import { FileSpreadsheet } from "lucide-react";
import { EmptyState, toast } from "../primitives";
import { cn } from "./shared";

/* ---------------- 变更记录 ----------------
   回执聚合面板：每一次数据修改可追溯、可撤销 */

const ACTION_LABEL: Record<string, string> = {
  BOQ_UPDATE: "清单修改", PRICE_APPLY: "价格写回", QUANTITY_ADJUST: "总价调整", PRICE_ADJUST: "总价调整",
  FILE_IMPORT: "文件导入", FILE_DELETE: "文件删除", EXPORT: "导出",
  USER_EDIT: "手动编辑", FACT_SET: "台账写入", REVERT: "撤销", SETTINGS_UPDATE: "计价设置", PROJECT_CREATE: "新建工程",
};

export function ReceiptsView() {
  const { receipts, reloadBoq, running, agentRunning, importRunning, focusBoqRows } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const revert = async (id: string) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/receipts/${id}/revert`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error ?? "撤销失败，请重试");
      await reloadBoq();
      await useStore.getState().refreshMeta();
      toast.success("已撤销该修改");
    } catch (error) { toast.error(error instanceof Error ? error.message : "撤销失败，请重试"); }
    finally { setBusy(null); }
  };
  return (
    <div className="h-full overflow-auto p-4">
      <div className="xl-sheet overflow-auto rounded-lg">
        <table className="xl-table xl-pin-last">
          <thead>
            <tr>
              <th className="xl-rn"></th>
              <th className="w-32">时间</th>
              <th className="w-24">类型</th>
              <th>内容</th>
              <th className="w-16">来源</th>
              <th className="w-16"></th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((r, i) => {
              const jumpable = !!r.affectedIds?.length;
              return (
              <tr
                key={r.id}
                className={cn("group", jumpable && "cursor-pointer")}
                title={jumpable ? "点击定位到清单中的相关行" : undefined}
                onClick={jumpable ? () => focusBoqRows?.(r.affectedIds!) : undefined}
              >
                <td className="xl-rn">{i + 1}</td>
                <td className="mono text-[11px] text-neutral-400">
                    {new Date(r.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}
                </td>
                <td>
                  <span className={cn("chip", r.reverted && "opacity-60")}>
                    {ACTION_LABEL[r.actionType] ?? r.actionType}
                  </span>
                </td>
                <td className={`max-w-96 truncate ${r.reverted ? "text-neutral-400 line-through decoration-neutral-300" : "text-neutral-600"} ${jumpable ? "group-hover:text-neutral-800 group-hover:underline decoration-neutral-300 underline-offset-2" : ""}`} title={r.summary}>{r.summary}</td>
                <td className="text-[11px] text-neutral-400">{r.createdBy === "user" ? "手动" : "Agent"}</td>
                <td className="text-center" onClick={(e) => e.stopPropagation()}>
                  {r.actionType === "REVERT" ? null : r.reverted ? (
                    <span className="text-[10.5px] text-neutral-400">已撤销</span>
                  ) : r.reversible ? (
                    <button
                      onClick={() => revert(r.id)}
                      disabled={!!busy || running || agentRunning || importRunning}
                      className="cost-btn sm ghost"
                    >
                      {busy === r.id ? "…" : "撤销"}
                    </button>
                  ) : (
                    <span className="text-[10.5px] text-neutral-300">不可撤销</span>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!receipts.length && <EmptyState icon={<FileSpreadsheet size={22} />} title="暂无变更记录" hint="所有数据修改都会在这里留痕" />}
    </div>
  );
}
