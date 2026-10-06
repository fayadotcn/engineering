"use client";
import { EmptyState } from "@/components/ui/empty-state";
import { useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { useStore } from "../store";
import { FileSpreadsheet } from "lucide-react";
import { toast } from "../primitives";
import { Button } from "@/components/ui/button";
import { cn, Tip, TipEl } from "./shared";

/* ---------------- 变更记录 ----------------
   回执聚合面板：每一次数据修改可追溯、可撤销 */

const ACTION_LABEL: Record<string, string> = {
  BOQ_UPDATE: "清单修改", PRICE_APPLY: "价格写回", QUANTITY_ADJUST: "总价调整", PRICE_ADJUST: "总价调整",
  FILE_IMPORT: "文件导入", FILE_DELETE: "文件删除", EXPORT: "导出",
  USER_EDIT: "手动编辑", FACT_SET: "台账写入", REVERT: "撤销", SETTINGS_UPDATE: "计价设置", PROJECT_CREATE: "新建工程",
  PROJECT_RENAME: "工程改名",
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
    <div className="view-content">
      <header className="view-heading"><div><span className="page-eyebrow">每次修改，有据可查</span><h2>操作记录</h2><p>查看修改来源，定位相关清单，或撤销可还原的操作。</p></div></header>
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
              <TipEl key={r.id} tip={jumpable ? "点击定位到清单中的相关行" : undefined}>
              <tr
                className={cn("group", jumpable && "cursor-pointer")}
                onClick={jumpable ? () => focusBoqRows?.(r.affectedIds!) : undefined}
              >
                <td className="xl-rn">{i + 1}</td>
                <td className="mono text-2xs text-muted-foreground">
                    {new Date(r.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}
                </td>
                <td>
                  <Badge variant="secondary" className={cn(r.reverted && "opacity-60")}>
                    {ACTION_LABEL[r.actionType] ?? r.actionType}
                  </Badge>
                </td>
                <td className={`max-w-96 truncate ${r.reverted ? "text-muted-foreground line-through decoration-border" : "text-muted-foreground"} ${jumpable ? "group-hover:text-foreground group-hover:underline decoration-border underline-offset-2" : ""}`}><Tip tip={r.summary}>{r.summary}</Tip></td>
                <td className="text-2xs text-muted-foreground">{r.createdBy === "user" ? "手动" : "助手"}</td>
                <td className="text-center" onClick={(e) => e.stopPropagation()}>
                  {r.actionType === "REVERT" ? null : r.reverted ? (
                    <span className="text-2xs text-muted-foreground">已撤销</span>
                  ) : r.reversible ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => revert(r.id)}
                      disabled={!!busy || running || agentRunning || importRunning}
                    >
                      {busy === r.id ? "…" : "撤销"}
                    </Button>
                  ) : (
                    <span className="text-2xs text-muted-foreground">不可撤销</span>
                  )}
                </td>
              </tr>
              </TipEl>
              );
            })}
          </tbody>
        </table>
      </div>
      {!receipts.length && <EmptyState icon={<FileSpreadsheet size={22} />} title="暂无变更记录" hint="所有数据修改都会在这里留痕" />}
    </div>
  );
}
